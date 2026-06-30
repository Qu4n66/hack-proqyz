#!/usr/bin/env node
/**
 * Validate every *.json in fixtures/ against the appropriate schema.
 *
 * Routes by the JSON's `mode` field:
 *   - "explanation" → ExplanationDataSchema (explanation uploads)
 *   - anything else → QuizSchema (quiz creation)
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
import {
  ExplanationDataSchema,
  normalizeExplanationData,
} from "../src/domain/explanationSchema.js";

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

/** Recursively collect all *.json under `dir`. */
async function collectJsonFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip the legacy subdirectory — it predates the current schema and
    // is intentionally not part of CI validation.
    if (entry.isDirectory() && entry.name === "legacy") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectJsonFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "fixtures");

const files = await collectJsonFiles(fixturesDir);

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

    if (parsed && parsed.mode === "explanation") {
      // ─── Explanation-mode fixture ───
      const result = ExplanationDataSchema.safeParse(parsed);
      if (!result.success) {
        hadError = true;
        console.log("INVALID (explanation)");
        for (const issue of result.error.issues) {
          console.log(`    - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
        }
        continue;
      }
      const normalized = normalizeExplanationData(result.data);
      let totalSlots = 0;
      for (const p of normalized.passages) {
        for (const g of p.questionGroups) totalSlots += g.explanations.length;
      }
      console.log(
        `OK (explanation: ${totalSlots} slots across ${normalized.passages.length} passage(s)` +
          (normalized.fullPassage
            ? `, fullPassage target=${normalized.targetPassage} expectedGroups=${normalized.expectedGroupCount}`
            : "") +
          `)`,
      );
      continue;
    }

    // ─── Quiz-mode fixture ───
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
