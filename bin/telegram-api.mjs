// Thin Telegram Bot API client. The base URL and fetch are injectable so
// tests run against a local HTTP server; nothing here interprets content.

import { readFileSync } from "node:fs";
import path from "node:path";

export const MESSAGE_LIMIT = 4096;
export const UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

/** Split text on line boundaries into chunks Telegram accepts. */
export function splitMessage(text, limit = MESSAGE_LIMIT) {
  const chunks = [];
  let current = "";
  for (const line of String(text).split("\n")) {
    // A single overlong line is hard-split.
    let rest = line;
    while (rest.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    const candidate = current ? `${current}\n${rest}` : rest;
    if (candidate.length > limit) {
      chunks.push(current);
      current = rest;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [""];
}

export function createApi({ token, baseUrl = "https://api.telegram.org", fetchImpl = fetch }) {
  const root = `${baseUrl}/bot${token}`;

  async function call(method, payload) {
    const response = await fetchImpl(`${root}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!body.ok) throw new Error(`telegram ${method} failed: ${body.description ?? response.status}`);
    return body.result;
  }

  async function upload(method, fieldName, filePath, payload) {
    const bytes = readFileSync(filePath);
    if (bytes.byteLength > UPLOAD_LIMIT_BYTES) {
      throw new Error(`file exceeds the 50 MB bot upload limit: ${filePath}`);
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(payload ?? {})) {
      if (value !== undefined && value !== null) form.append(key, String(value));
    }
    form.append(fieldName, new Blob([bytes]), path.basename(filePath));
    const response = await fetchImpl(`${root}/${method}`, { method: "POST", body: form });
    const body = await response.json().catch(() => ({}));
    if (!body.ok) throw new Error(`telegram ${method} failed: ${body.description ?? response.status}`);
    return body.result;
  }

  return {
    getUpdates: (offset, timeoutSeconds = 50) =>
      call("getUpdates", { offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] }),
    /** Sends plain text, split into ≤4096-char chunks; markup goes on the last chunk. */
    sendMessage: async (chatId, text, { replyMarkup, replyTo } = {}) => {
      const chunks = splitMessage(text);
      let last;
      for (let index = 0; index < chunks.length; index += 1) {
        last = await call("sendMessage", {
          chat_id: chatId,
          text: chunks[index],
          ...(index === 0 && replyTo ? { reply_to_message_id: replyTo } : {}),
          ...(index === chunks.length - 1 && replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      }
      return last;
    },
    sendDocument: (chatId, filePath, caption = "") =>
      upload("sendDocument", "document", filePath, { chat_id: chatId, ...(caption ? { caption: caption.slice(0, 1024) } : {}) }),
    sendAnimation: (chatId, filePath, caption = "") =>
      upload("sendAnimation", "animation", filePath, { chat_id: chatId, ...(caption ? { caption: caption.slice(0, 1024) } : {}) }),
    answerCallbackQuery: (callbackQueryId, text = "") =>
      call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text: text.slice(0, 200) } : {}) }),
  };
}
