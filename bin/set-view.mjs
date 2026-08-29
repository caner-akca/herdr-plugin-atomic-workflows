#!/usr/bin/env node
// Action entrypoint: toggle the workflows-only agent view.
// Logic lives in lib/set-view.mjs so the watcher can reapply it on startup.

import { toggle } from "../lib/set-view.mjs";

toggle().catch((err) => {
  console.error(`agent view toggle failed: ${err.message}`);
  process.exit(1);
});
