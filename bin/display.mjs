export function stagePrompt(stage, run) {
  const prompt = stage?.pendingPrompt ?? run?.pendingPrompt;
  if (prompt?.message) {
    return { kind: prompt.kind ?? "input", message: prompt.message, choices: prompt.choices ?? [] };
  }
  const question = stage?.inputRequest?.questions?.[0];
  if (!question?.question) return null;
  return {
    kind: stage.inputRequest.kind ?? "ask_user_question",
    message: question.question,
    choices: (question.options ?? []).map((option) => option.label).filter(Boolean),
  };
}

export function fmtCost(cost) {
  if (!Number.isFinite(cost) || cost <= 0) return "";
  return cost >= 10 ? `$${cost.toFixed(0)}` : `$${cost.toFixed(2)}`;
}

export function taskLabel(task) {
  if (task?.title) return String(task.title);
  if (task?.kind === "issue-fix") return `#${task.target} fix`;
  if (task?.kind === "code-review") return `PR #${task.target} review`;
  return "Issue queue";
}

export function tasksForWorkspace(tasks, workspaceId) {
  if (!workspaceId) return [...tasks];
  return tasks.filter((task) => String(task.workspace_id) === String(workspaceId));
}

/** Review F7: popup panes receive the invoking workspace through
 * HERDR_PLUGIN_CONTEXT_JSON, not HERDR_WORKSPACE_ID. Resolve both. */
export function resolveWorkspaceId(env = process.env) {
  if (env.HERDR_WORKSPACE_ID) return String(env.HERDR_WORKSPACE_ID);
  try {
    const context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
    return context.workspace_id ? String(context.workspace_id) : "";
  } catch {
    return "";
  }
}

/** Review F20: external text (issue titles, model prompts, transcript lines,
 * workflow errors) can carry C0/C1/ESC/OSC bytes that repaint the pane and
 * imitate board output. Strip them; keep tabs and printable text. */
export function sanitizeExternal(text) {
  return String(text ?? "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b\[[0-9;:?]*[ -\/]*[@-~]?/g, "")
    .replace(/\u001b./g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
