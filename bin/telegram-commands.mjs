// Closed command grammar for the Telegram cockpit. Message text never
// reaches a shell, a model, or an argv: every command resolves to a typed
// action object with validated integer/enum fields, and unknown input is an
// error the daemon answers with /help.

const INT = /^\d{1,7}$/;
const TASK_REF = /^t(\d{1,3})$/;
const ARTIFACT_REF = /^a(\d{1,3})$/;
const GIF_KINDS = ["repro", "replay", "fixed"];

export const OBSERVER_COMMANDS = new Set([
  "help", "status", "runs", "history", "cost", "task", "artifacts",
  "get", "report", "evidence", "driver", "diff", "gif",
]);
export const OWNER_ONLY_COMMANDS = new Set([
  "queue", "fix", "review", "handoff", "mute", "unmute", "halt",
]);

export function authorize(role, command) {
  if (role === "owner") return OBSERVER_COMMANDS.has(command) || OWNER_ONLY_COMMANDS.has(command);
  if (role === "observer") return OBSERVER_COMMANDS.has(command);
  return false;
}

function issueOrTask(word, command) {
  if (INT.test(word)) return { issue: Number(word) };
  const task = word.match(TASK_REF);
  if (task) return { taskIndex: Number(task[1]) };
  return { error: `/${command} needs an issue number (e.g. 3220) or a task reference (e.g. t2)` };
}

/** Parse one message into an action object, or { error }. */
export function parseCommand(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("/")) return { error: "not a command" };
  const [head, ...args] = trimmed.split(/\s+/);
  const command = head.slice(1).replace(/@[A-Za-z0-9_]+$/, "").toLowerCase();
  switch (command) {
    case "help": case "start":
      return { command: "help" };
    case "status": case "runs": case "history": case "cost": case "mute": case "unmute": case "halt":
      return { command: command === "start" ? "help" : command };
    case "task": {
      if (args.length !== 1) return { error: "/task needs one reference, e.g. /task t1 or /task 3220" };
      return { command, ...issueOrTask(args[0], command) };
    }
    case "artifacts": case "report": case "evidence": case "driver": case "diff": {
      if (args.length !== 1) return { error: `/${command} needs an issue number or task reference` };
      return { command, ...issueOrTask(args[0], command) };
    }
    case "gif": {
      if (args.length < 1 || args.length > 2) return { error: "/gif <issue|tN> [repro|replay|fixed]" };
      const which = args[1] ? String(args[1]).toLowerCase() : "repro";
      if (!GIF_KINDS.includes(which)) return { error: `gif kind must be one of ${GIF_KINDS.join(", ")}` };
      return { command, which, ...issueOrTask(args[0], command) };
    }
    case "get": {
      const ref = args[0]?.match(ARTIFACT_REF);
      if (args.length !== 1 || !ref) return { error: "/get needs an artifact id from /artifacts, e.g. /get a3" };
      return { command, artifactIndex: Number(ref[1]) };
    }
    case "queue": {
      if (args.length > 1) return { error: "/queue [shortlist size]" };
      const size = args[0] ? Number(args[0]) : 15;
      if (!Number.isInteger(size) || size < 1 || size > 30) return { error: "shortlist size must be 1-30" };
      return { command, size };
    }
    case "fix": case "review": case "handoff": {
      if (args.length !== 1 || !INT.test(args[0])) return { error: `/${command} needs one ${command === "review" ? "PR" : "issue"} number` };
      return { command, number: Number(args[0]) };
    }
    default:
      return { error: `unknown command /${command}` };
  }
}

// Callback data is compact and fully typed; nonces bind launch confirms to
// the exact prompt the owner saw.
export function launchCallback(kind, number, nonce) {
  return `l:${kind}:${number}:${nonce}`;
}

export const DECISIONS = ["approved", "changes", "wontfix", "info"];

export function decisionCallback(issue, decision) {
  if (!DECISIONS.includes(decision)) throw new Error(`invalid decision ${decision}`);
  return `d:${issue}:${decision}`;
}

export function parseCallback(data) {
  const text = String(data ?? "");
  const launch = text.match(/^l:(queue|fix|review):(\d{1,7}):([a-f0-9]{16})$/);
  if (launch) return { type: "launch", kind: launch[1], number: Number(launch[2]), nonce: launch[3] };
  const decision = text.match(/^d:(\d{1,7}):(approved|changes|wontfix|info)$/);
  if (decision) return { type: "decision", issue: Number(decision[1]), decision: decision[2] };
  return { type: "unknown" };
}

export const HELP_TEXT = [
  "Observe:",
  "/status — board summary   /task <tN|issue> — one task",
  "/runs /history /cost — active runs, ledger history, spend",
  "Artifacts (by issue number or task ref):",
  "/artifacts <n> — list   /get aK — fetch one",
  "/report /evidence /driver /diff <n> — common files",
  "/gif <n> [repro|replay|fixed] — cast as GIF",
  "Run (owner):",
  "/queue [size] — rank issues   /fix <issue>   /review <pr>",
  "Maintainer handoff (owner): /handoff <issue>",
  "Controls (owner): /mute /unmute /halt (until restart)",
].join("\n");
