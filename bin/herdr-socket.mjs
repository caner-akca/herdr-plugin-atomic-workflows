// Minimal NDJSON client for herdr's raw socket API ($HERDR_SOCKET_PATH).
// Needed because some surfaces (agent.view.set/clear) have no CLI wrapper.
// One request per connection: connect, send one line, await the matching
// response id, close. Fail soft — callers treat errors as "feature off".

import net from "node:net";
import os from "node:os";
import path from "node:path";

export function socketPath() {
  return (
    process.env.HERDR_SOCKET_PATH ||
    path.join(os.homedir(), ".config", "herdr", "herdr.sock")
  );
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
