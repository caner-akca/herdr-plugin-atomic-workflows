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
