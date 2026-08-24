#!/usr/bin/env node
// Action entrypoint: open the workflow board popup.

import { spawnSync } from "node:child_process";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const r = spawnSync(
  HERDR,
  ["plugin", "pane", "open", "--plugin", "atomic.workflows", "--entrypoint", "board"],
  { stdio: "inherit" },
);
process.exit(r.status ?? 1);
