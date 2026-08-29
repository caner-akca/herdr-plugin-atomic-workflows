import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createApi } from "../lib/telegram-api.mjs";

const TOKEN = "12345:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function mockTelegram(onCall) {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const method = request.url.split("/").pop();
      const result = onCall(method, body, request.headers) ?? {};
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: result.error === undefined, description: result.error, result: result.value ?? true }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test("the api client sends json calls, splits long messages, and uploads multipart", async () => {
  const calls = [];
  const { server, url } = await mockTelegram((method, body, headers) => {
    calls.push({ method, body, headers });
    if (method === "getUpdates") return { value: [{ update_id: 7 }] };
    if (method === "sendMessage") return { value: { message_id: calls.length } };
    return { value: {} };
  });
  const api = createApi({ token: TOKEN, baseUrl: url });
  const updates = await api.getUpdates(5, 1);
  assert.deepEqual(updates, [{ update_id: 7 }]);
  assert.equal(JSON.parse(calls[0].body).offset, 5);

  await api.sendMessage(1, `${"x".repeat(5000)}`, { replyMarkup: { inline_keyboard: [] } });
  const sends = calls.filter((call) => call.method === "sendMessage").map((call) => JSON.parse(call.body));
  assert.equal(sends.length, 2);
  assert.ok(sends.every((send) => send.text.length <= 4096));
  assert.ok(!sends[0].reply_markup && sends[1].reply_markup, "markup rides the last chunk");

  const dir = mkdtempSync(path.join(tmpdir(), "tg-api-"));
  const file = path.join(dir, "report.md");
  writeFileSync(file, "hello");
  await api.sendDocument(2, file, "cap");
  const upload = calls.at(-1);
  assert.equal(upload.method, "sendDocument");
  assert.match(upload.headers["content-type"], /^multipart\/form-data/);
  const raw = upload.body.toString("latin1");
  assert.match(raw, /name="chat_id"/);
  assert.match(raw, /filename="report.md"/);
  assert.match(raw, /hello/);

  server.close();
});

test("api errors carry telegram's description", async () => {
  const { server, url } = await mockTelegram(() => ({ error: "chat not found" }));
  const api = createApi({ token: TOKEN, baseUrl: url });
  await assert.rejects(() => api.sendMessage(1, "x"), /chat not found/);
  server.close();
});

test("the daemon answers /status end-to-end against a mock server", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tg-daemon-"));
  const stateDir = path.join(root, "state");
  const configDir = path.join(root, "config");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, ".env"), `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_COCKPIT_CHAT_ID=42\n`);
  writeFileSync(path.join(configDir, "telegram.json"), JSON.stringify({ users: [{ id: 9, role: "owner" }] }));
  writeFileSync(path.join(stateDir, "board.json"), JSON.stringify({
    updatedAt: Date.now(), mode: "events",
    tasks: [{ title: "#42 fix", kind: "issue-fix", target: 42, status: "running", phase: "implement", cost: 1.5, runs: [] }],
  }));
  let served = false;
  const sent = [];
  const { server, url } = await mockTelegram((method, body) => {
    if (method === "getUpdates") {
      if (served) return { value: [] };
      served = true;
      return { value: [{ update_id: 1, message: { message_id: 5, from: { id: 9 }, chat: { id: 42 }, text: "/status" } }] };
    }
    if (method === "sendMessage") {
      sent.push(JSON.parse(body));
      return { value: { message_id: sent.length } };
    }
    return { value: {} };
  });
  const daemon = spawn(process.execPath, [path.join("bin", "telegram.mjs")], {
    env: {
      ...process.env,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      TELEGRAM_API_BASE: url,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  daemon.stdout.on("data", (chunk) => { logs += chunk; });
  daemon.stderr.on("data", (chunk) => { logs += chunk; });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !sent.some((message) => /Cockpit: 1 task/.test(message.text))) await delay(100);
  daemon.kill("SIGTERM");
  server.close();
  const status = sent.find((message) => /Cockpit: 1 task/.test(message.text));
  assert.ok(status, `daemon never answered /status; sent=${JSON.stringify(sent)}; logs=${logs}`);
  assert.equal(status.chat_id, 42);
  assert.match(status.text, /t1 #42 fix — running · implement/);
});
