/**
 * JSON input loader.
 * Reads a quiz JSON file from disk and validates it through Zod.
 * Throws a typed error on validation failure with a useful message.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { QuizSchema } from "../domain/schemas.js";
import { normalizeQuiz } from "../domain/normalize.js";
import { checkInvariants } from "../domain/invariants.js";
import { log } from "../logger.js";

/**
 * @typedef {import("../domain/schemas.js").Quiz} Quiz
 */

/**
 * Load, validate, normalize, and check invariants for a single quiz JSON.
 * @param {string} filePath Path to the quiz.json file.
 * @returns {Promise<Quiz>}
 */
export async function loadQuizFromJson(filePath) {
  const abs = resolve(filePath);
  log.input.info({ file: abs }, "loading quiz JSON");

  const raw = await readFile(abs, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${abs}: ${err.message}`);
  }

  const result = QuizSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Quiz validation failed for ${abs}:\n${issues}`);
  }

  const normalized = normalizeQuiz(result.data);
  checkInvariants(normalized);
  log.input.info(
    {
      title: normalized.quizTitle,
      quizType: normalized.quizType,
      questions: countQuestions(normalized),
    },
    "quiz loaded and validated",
  );
  return normalized;
}

/** Count questions across passages (reading) or sections (listening). */
function countQuestions(quiz) {
  if (quiz.quizType === "reading") {
    return quiz.passages.reduce((acc, p) => acc + p.questions.length, 0);
  }
  if (quiz.quizType === "listening") {
    return quiz.sections.reduce((acc, s) => acc + s.questions.length, 0);
  }
  return 0;
}

/**
 * Load every *.json in a directory as a quiz. Used by bulk folder mode
 * (Phase 3 — kept here as a stub for Phase 1 callers that point at a
 * directory).
 * @param {string} dirPath
 * @returns {Promise<Quiz[]>}
 */
export async function loadQuizzesFromDir(dirPath) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => resolve(dirPath, e.name));
  return Promise.all(files.map(loadQuizFromJson));
}
