/**
 * Business invariants — checks that go beyond Zod schema validation.
 * Zod validates *shape*; invariants validate *semantics*.
 *
 * New model: questions are nested inside passages. We check:
 *  1. Each passage's question numbers, expanded through grouped
 *     ranges, cover exactly 1..N contiguously with no gaps and no
 *     duplicates. A single-blank question contributes its `number`;
 *     a grouped question contributes `numberStart..numberEnd`.
 *  2. For content-based questions, log a debug line with the resolved
 *     answer so author typos are visible at a glance.
 */

import { log } from "../logger.js";

/**
 * Expand a question into the set of IELTS numbers it covers.
 * Single-blank → [number]. Grouped (numberStart..numberEnd) →
 * [numberStart, numberStart+1, …, numberEnd]. We trust the schema's
 * superRefine to have ensured numberStart <= numberEnd and that
 * `number` either exists (single) or both numberStart/numberEnd
 * exist (grouped).
 *
 * @param {import("./schemas.js").Question} q
 * @returns {number[]}
 */
function expandQuestion(q) {
  if (
    typeof q.numberStart === "number" &&
    typeof q.numberEnd === "number"
  ) {
    const out = [];
    for (let n = q.numberStart; n <= q.numberEnd; n++) out.push(n);
    return out;
  }
  return [q.number];
}

/**
 * Run all semantic checks on a normalized quiz.
 * Throws an Error with a human-readable message on the first failure.
 * @param {import("./schemas.js").Quiz} quiz
 */
export function checkInvariants(quiz) {
  if (quiz.quizType !== "reading") return; // Phase 1 + 3 only

  for (let pIdx = 0; pIdx < quiz.passages.length; pIdx++) {
    const p = quiz.passages[pIdx];

    // 1. Range-coverage: expanding each question's numbers (single or
    //    grouped range) must yield a contiguous set with no gaps and
    //    no duplicates. The set does NOT have to start at 1 — each
    //    IELTS Reading passage has its own question range (Passage 1
    //    = Q1-13, Passage 2 = Q14-26, Passage 3 = Q27-40), so the
    //    check is "contiguous, not necessarily 1-based".
    const seen = new Set();
    const covered = [];
    for (const q of p.questions) {
      for (const n of expandQuestion(q)) {
        if (seen.has(n)) {
          throw new Error(
            `Passage ${pIdx + 1}: duplicate question number ${n} (from question ${q.number ?? `${q.numberStart}-${q.numberEnd}`})`,
          );
        }
        seen.add(n);
        covered.push(n);
      }
    }
    if (covered.length === 0) continue;
    covered.sort((a, b) => a - b);
    const first = covered[0];
    const last = covered[covered.length - 1];
    const expectedCount = last - first + 1;
    if (covered.length !== expectedCount) {
      throw new Error(
        `Passage ${pIdx + 1}: question numbers must be contiguous. ` +
          `Covered = [${covered.join(", ")}] (count ${covered.length}, ` +
          `expected ${expectedCount} = ${first}..${last}).`,
      );
    }

    // 2. Log content-based answers.
    for (const q of p.questions) {
      if (q.proqyzType === "fill_up" || q.proqyzType === "select") {
        log.uploader.debug(
          {
            passageIdx: pIdx,
            number: q.number,
            numberStart: q.numberStart ?? null,
            numberEnd: q.numberEnd ?? null,
            proqyzType: q.proqyzType,
            defaultOptions: q.defaultOptions ?? null,
            answer: q.answer,
            answers: q.answers ?? null,
          },
          "content-based question answer resolved",
        );
      }
    }
  }
}
