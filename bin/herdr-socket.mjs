// Minimal NDJSON client for herdr's raw socket API ($HERDR_SOCKET_PATH).
// Needed because some surfaces (agent.view.set/clear) have no CLI wrapper.
// One request per connection: connect, send one line, await the matching
// response id, close. Fail soft — callers treat errors as "feature off".

import net from "node:net";
import os from "node:os";
import path from "node:path";

function socketPath() {
  return (
    process.env.HERDR_SOCKET_PATH ||
    path.join(os.homedir(), ".config", "herdr", "herdr.sock")
  );
}

// Persistent push subscription (events.subscribe): one long-lived NDJSON
// connection; every pushed line after the ack goes to onEvent. Reconnects
// with backoff forever until .close(). onState("connected"|"disconnected")
// lets callers adapt (the watcher falls back to fast polling while down).
export function subscribe(subscriptions, onEvent, onState = () => {}) {
  let sock = null;
  let closed = false;
  let retryTimer = null;

  function connect() {
    if (closed) return;
    const id = `atomic.workflows:sub:${Date.now()}`;
    let acked = false;
    let buf = "";
    const s = net.createConnection(socketPath());
    sock = s;
    const drop = () => {
      if (sock === s) sock = null;
      s.destroy();
      if (acked) onState("disconnected");
      if (!closed && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connect();
        }, 5000);
        retryTimer.unref?.();
      }
    };
    s.on("error", drop);
    s.on("close", drop);
    s.on("connect", () => {
      s.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`);
    });
    s.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === id) {
          if (msg.error) {
            // Server refused the subscription (old herdr?) — stay in
            // disconnected mode; the retry may hit an upgraded server.
            drop();
            return;
          }
          acked = true;
          onState("connected");
          continue;
        }
        if (acked) onEvent(msg);
      }
    });
  }

  connect();
  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      sock?.destroy();
    },
  };
}

export function request(method, params = {}, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = `atomic.workflows:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
    const sock = net.createConnection(socketPath());
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`herdr socket timeout for ${method}`));
    }, timeoutMs);
    const fail = (err) => {
      clearTimeout(timer);
      reject(err);
    };
    sock.on("error", fail);
    sock.on("connect", () => {
      sock.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== id) continue; // pushed events / other traffic
        clearTimeout(timer);
        sock.end();
        if (msg.error) fail(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result ?? null);
        return;
      }
    });
  });
}
