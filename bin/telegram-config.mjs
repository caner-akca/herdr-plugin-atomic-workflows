// Telegram daemon configuration. Secrets follow Herdr's plugin convention:
// `.env` in HERDR_PLUGIN_CONFIG_DIR holds the bot token and chat ids; the
// non-secret settings live next to it in telegram.json. The daemon refuses
// to act while no users are configured.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PLUGIN_ID } from "./task-store.mjs";

export const ROLES = ["owner", "observer"];

export function configDir() {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) return process.env.HERDR_PLUGIN_CONFIG_DIR;
  // Matches `herdr plugin config-dir atomic.workflows` on current herdr.
  return path.join(homedir(), ".config", "herdr", "plugins", "config", PLUGIN_ID);
}

/** Minimal .env parser: KEY=VALUE lines, `#` comments, no expansion. */
export function parseEnvFile(text) {
  const values = {};
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) values[key] = value;
  }
  return values;
}

function normalizeUsers(raw) {
  const users = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const id = Number(entry?.id);
    const role = String(entry?.role ?? "");
    if (Number.isInteger(id) && id > 0 && ROLES.includes(role)) users.push({ id, role });
  }
  return users;
}

export const DEFAULT_PUSH = Object.freeze({
  run_start: true,
  run_end: true,
  awaiting_input: true,
  blocked: true,
  stage_change: false,
});

/** Load and validate config from an explicit dir (tests) or the plugin
 * config dir. Throws with a setup hint when the token is missing. */
export function loadTelegramConfig(dir = configDir()) {
  const envPath = path.join(dir, ".env");
  const settingsPath = path.join(dir, "telegram.json");
  const env = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, "utf8")) : {};
  const token = env.TELEGRAM_BOT_TOKEN ?? "";
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
    throw new Error(`TELEGRAM_BOT_TOKEN missing or malformed in ${envPath}; create the bot with @BotFather and put the token there.`);
  }
  let settings = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  }
  const cockpitChatId = Number(env.TELEGRAM_COCKPIT_CHAT_ID ?? 0) || null;
  const maintainerChatId = Number(env.TELEGRAM_MAINTAINER_CHAT_ID ?? 0) || null;
  const repoRoot = String(settings.repo_root ?? "");
  return {
    token,
    cockpitChatId,
    maintainerChatId,
    users: normalizeUsers(settings.users),
    push: { ...DEFAULT_PUSH, ...(settings.push ?? {}) },
    enableLaunch: settings.enable_launch !== false,
    repoRoot,
  };
}

export function roleOf(config, userId) {
  return config.users.find((user) => user.id === Number(userId))?.role ?? null;
}
