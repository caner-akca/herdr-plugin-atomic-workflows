import assert from "node:assert/strict";
import test from "node:test";
import {
  authorize,
  decisionCallback,
  launchCallback,
  parseCallback,
  parseCommand,
} from "../bin/telegram-commands.mjs";
import { parseEnvFile, roleOf } from "../bin/telegram-config.mjs";

test("the command grammar is closed and typed", () => {
  assert.deepEqual(parseCommand("/status"), { command: "status" });
  assert.deepEqual(parseCommand("/task t2"), { command: "task", taskIndex: 2 });
  assert.deepEqual(parseCommand("/artifacts 3220"), { command: "artifacts", issue: 3220 });
  assert.deepEqual(parseCommand("/get a3"), { command: "get", artifactIndex: 3 });
  assert.deepEqual(parseCommand("/gif 3220 replay"), { command: "gif", which: "replay", issue: 3220 });
  assert.deepEqual(parseCommand("/fix 42"), { command: "fix", number: 42 });
  assert.deepEqual(parseCommand("/queue"), { command: "queue", size: 15 });
  assert.deepEqual(parseCommand("/help@my_bot"), { command: "help" });
  // Anything outside the grammar is an error, never an execution.
  assert.ok(parseCommand("/fix 42; rm -rf /").error);
  assert.ok(parseCommand("/fix $(id)").error);
  assert.ok(parseCommand("/unknown").error);
  assert.ok(parseCommand("hello").error);
  assert.ok(parseCommand("/gif 1 huge").error);
  assert.ok(parseCommand("/queue 99").error);
});

test("roles gate launching and controls to the owner", () => {
  for (const cmd of ["status", "artifacts", "get", "gif", "cost"]) {
    assert.ok(authorize("observer", cmd), cmd);
    assert.ok(authorize("owner", cmd), cmd);
  }
  for (const cmd of ["queue", "fix", "review", "handoff", "halt", "mute"]) {
    assert.ok(!authorize("observer", cmd), cmd);
    assert.ok(authorize("owner", cmd), cmd);
  }
  assert.ok(!authorize(null, "status"));
  const config = { users: [{ id: 1, role: "owner" }, { id: 2, role: "observer" }] };
  assert.equal(roleOf(config, 1), "owner");
  assert.equal(roleOf(config, "2"), "observer");
  assert.equal(roleOf(config, 3), null);
});

test("callback data round-trips and rejects everything else", () => {
  const launch = launchCallback("fix", 42, "0123456789abcdef");
  assert.deepEqual(parseCallback(launch), { type: "launch", kind: "fix", number: 42, nonce: "0123456789abcdef" });
  const decision = decisionCallback(7, "changes");
  assert.deepEqual(parseCallback(decision), { type: "decision", issue: 7, decision: "changes" });
  assert.equal(parseCallback("l:fix:42:zz").type, "unknown");
  assert.equal(parseCallback("d:7:merge").type, "unknown");
  assert.equal(parseCallback("x").type, "unknown");
  assert.throws(() => decisionCallback(7, "merge"));
});

test("env parsing takes only well-formed uppercase keys", () => {
  const env = parseEnvFile('TELEGRAM_BOT_TOKEN="123:abc"\n# comment\nbad key=1\nTELEGRAM_COCKPIT_CHAT_ID=99\n');
  assert.equal(env.TELEGRAM_BOT_TOKEN, "123:abc");
  assert.equal(env.TELEGRAM_COCKPIT_CHAT_ID, "99");
  assert.equal(Object.keys(env).length, 2);
});
