/**
 * Listening input (Phase 3).
 *
 * Phase 1 doesn't drive listening quizzes, but the file is here so the
 * orchestrator's import path is stable. Audio file handling (uploading
 * .mp3 to ProQyz's file input) lands with the listening UI driver.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ListeningQuizSchema } from "../domain/schemas.js";
import { normalizeQuiz } from "../domain/normalize.js";
import { log } from "../logger.js";

/**
 * Validate and normalize a listening quiz. Does NOT yet upload audio.
 * @param {object} raw
 * @returns {Promise<import("../domain/schemas.js").ListeningQuiz>}
 */
export async function prepareListeningQuiz(raw) {
  const parsed = ListeningQuizSchema.parse(raw);
  const normalized = normalizeQuiz(parsed);
  if (normalized.audio.source === "local" && normalized.audio.path) {
    const abs = resolve(normalized.audio.path);
    if (!existsSync(abs)) {
      throw new Error(`Listening audio file not found: ${abs}`);
    }
    log.input.info({ audio: abs, size: "see filesystem" }, "audio file verified");
  }
  return normalized;
}
