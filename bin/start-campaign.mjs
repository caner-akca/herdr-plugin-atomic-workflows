#!/usr/bin/env node

import { createCampaign } from "./task-store.mjs";
import { launchQueueTask } from "./task-launcher.mjs";

function invocationContext() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

const context = invocationContext();
const workspaceId = process.env.HERDR_WORKSPACE_ID || context.workspace_id;
const repoRoot = context.workspace_cwd || context.focused_pane_cwd || process.cwd();

if (!workspaceId) {
  console.error("Start issue campaign must be invoked from a Herdr workspace.");
  process.exit(1);
}

try {
  const campaign = createCampaign({ repoRoot, workspaceId, shortlistSize: 15 });
  const task = launchQueueTask(campaign, { focus: true });
  console.log(`issue campaign ${campaign.campaign_id} started in ${task.title}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

