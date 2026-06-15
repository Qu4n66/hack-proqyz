#!/usr/bin/env node
/**
 * Validate every *.json in fixtures/ against the QuizSchema.
 *
 * Catches broken fixtures before they hit CI. Run with:
 *   node scripts/validate-fixtures.js
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QuizSchema } from "../src/domain/schemas.js";
import { normalizeQuiz } from "../src/domain/normalize.js";
import { checkInvariants } from "../src/domain/invariants.js";

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "fixtures");

const entries = await readdir(fixturesDir, { withFileTypes: true });
const files = entries
  .filter((e) => e.isFile() && e.name.endsWith(".json"))
  .map((e) => join(fixturesDir, e.name));

if (files.length === 0) {
  console.log("No fixture files found in", fixturesDir);
  process.exit(0);
}

let hadError = false;
for (const file of files) {
  process.stdout.write(`${file} ... `);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    const result = QuizSchema.safeParse(parsed);
    if (!result.success) {
      hadError = true;
      console.log("INVALID");
      for (const issue of result.error.issues) {
        console.log(`    - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
      continue;
    }
    const normalized = normalizeQuiz(result.data);
    checkInvariants(normalized);
    console.log(
      `OK (${countQuestions(normalized)} questions, ${normalized.passages?.length ?? normalized.sections?.length ?? 0} ${normalized.passages ? "passages" : "sections"})`,
    );
  } catch (err) {
    hadError = true;
    console.log("ERROR:", err.message);
  }
}

if (hadError) {
  process.exit(1);
}
