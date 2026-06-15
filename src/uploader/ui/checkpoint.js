/**
 * Checkpoint / resume state.
 *
 * A 40-question upload that fails at question 27 must not restart from 0.
 * After every successful question we atomically write a JSON file that
 * records the quiz handle, the IDs of created passages, and the IDs of
 * uploaded questions. On startup, we check for an existing checkpoint and
 * offer to resume.
 *
 * The checkpoint is intentionally simple — no DB, no queue, no transactional
 * rollback. The trade-off: if the process is killed AFTER writing a question
 * to ProQyz but BEFORE updating the checkpoint, the next run may see a
 * "duplicate" question. The --on-duplicate flag handles that gracefully.
 */

import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../../config.js";
import { slugify } from "../../domain/normalize.js";
import { log } from "../../logger.js";

/**
 * @typedef {object} Checkpoint
 * @property {string} title
 * @property {{ url: string, id: string }} quizHandle
 * @property {Array<{ index: number, id: string }>} passages
 * @property {Array<{ number: number, id: string, uploadedAt: string }>} questions
 * @property {{ passageIndex: number, questionNumber: number }} lastCompleted
 * @property {string} updatedAt
 * @property {string} selectorsVersion  The Selectors.version when this
 *   checkpoint was created. If the version changes, the user is warned
 *   that a re-run may not be safe.
 */

function pathFor(quizTitle) {
  const slug = slugify(quizTitle);
  return join(config.paths.checkpointsDir, `${slug}.json`);
}

function tmpPathFor(quizTitle) {
  return pathFor(quizTitle) + ".tmp";
}

async function ensureCheckpointsDir() {
  if (!existsSync(config.paths.checkpointsDir)) {
    await mkdir(config.paths.checkpointsDir, { recursive: true });
  }
}

/**
 * Look for an existing checkpoint for this quiz.
 * @param {string} quizTitle
 * @returns {Promise<Checkpoint | null>}
 */
export async function loadCheckpoint(quizTitle) {
  const p = pathFor(quizTitle);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    log.checkpoint.warn({ err: err.message, path: p }, "checkpoint unreadable");
    return null;
  }
}

/**
 * Atomically save the checkpoint. Write to *.tmp, then rename.
 * @param {Checkpoint} cp
 */
export async function saveCheckpoint(cp) {
  await ensureCheckpointsDir();
  const target = pathFor(cp.title);
  const tmp = tmpPathFor(cp.title);
  await writeFile(tmp, JSON.stringify(cp, null, 2), "utf8");
  await rename(tmp, target);
  log.checkpoint.debug(
    { title: cp.title, last: cp.lastCompleted },
    "checkpoint saved",
  );
}

/**
 * Delete the checkpoint (after a fully successful run or on --fresh).
 * @param {string} quizTitle
 */
export async function clearCheckpoint(quizTitle) {
  const p = pathFor(quizTitle);
  if (existsSync(p)) {
    await unlink(p);
    log.checkpoint.info({ path: p }, "checkpoint cleared");
  }
}

/**
 * Create a fresh empty checkpoint.
 * @param {string} quizTitle
 * @param {string} selectorsVersion
 * @returns {Checkpoint}
 */
export function newCheckpoint(quizTitle, selectorsVersion) {
  return {
    title: quizTitle,
    quizHandle: { url: "", id: "" },
    passages: [],
    questions: [],
    lastCompleted: { passageIndex: -1, questionNumber: 0 },
    updatedAt: new Date().toISOString(),
    selectorsVersion,
  };
}

/**
 * Mark a question as uploaded in the checkpoint.
 * @param {Checkpoint} cp
 * @param {{ number: number, id: string, passageIndex: number }} info
 */
export function recordQuestion(cp, info) {
  cp.questions.push({
    number: info.number,
    id: info.id,
    uploadedAt: new Date().toISOString(),
  });
  cp.lastCompleted = {
    passageIndex: info.passageIndex,
    questionNumber: info.number,
  };
  cp.updatedAt = new Date().toISOString();
}

/**
 * Mark a passage as created.
 * @param {Checkpoint} cp
 * @param {{ index: number, id: string }} info
 */
export function recordPassage(cp, info) {
  cp.passages.push({ index: info.index, id: info.id });
  cp.updatedAt = new Date().toISOString();
}

/**
 * Mark the quiz as created.
 * @param {Checkpoint} cp
 * @param {{ url: string, id: string }} handle
 */
export function recordQuiz(cp, handle) {
  cp.quizHandle = handle;
  cp.updatedAt = new Date().toISOString();
}

/**
 * Convenience: the next question number to upload, or null if done.
 * @param {Checkpoint} cp
 * @param {number} totalQuestions
 */
export function nextQuestionNumber(cp, totalQuestions) {
  if (cp.lastCompleted.questionNumber >= totalQuestions) return null;
  return cp.lastCompleted.questionNumber + 1;
}
