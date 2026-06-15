/**
 * Normalization helpers — pure functions that take a validated Quiz and
 * return a normalized copy. The orchestrator calls these after Zod
 * validation, before handing off to the uploader.
 *
 * Normalization rules (new model):
 *  - Trim whitespace from string fields.
 *  - Sort questions within each passage by number.
 *  - Drop duplicate question numbers within a passage (with a warning).
 *  - For radio: uppercase `answer` and option labels. The schema
 *    enforces that the answer label exists in options.
 *  - For checkbox: uppercase `answers` array and option labels.
 *  - For fill_up: the schema enforces that the count of {answer}
 *    placeholders equals the number of blanks (single mode: 1
 *    placeholder; grouped mode: numberEnd-numberStart+1 placeholders).
 *    The placeholder text is NOT required to match the answer value —
 *    generic `{answer}` placeholders are accepted. We do NOT uppercase
 *    `answer` / `answers[]`; case is preserved end-to-end.
 *  - For select: do NOT uppercase `answer`.
 */

import { log } from "../logger.js";

/**
 * Derive the Finish-tab display title for a question.
 *
 *   - Explicit input `displayTitle` wins.
 *   - Grouped fill_up (numberStart..numberEnd present) → "Questions S-E"
 *   - Single (has `number`)                       → "Question N"
 *   - Otherwise                                   → undefined
 *
 * For grouped fill_up, "S-E" is only emitted when S !== E; a degenerate
 * range (S === E) is treated as a single question.
 *
 * @param {import("./schemas.js").Question} q
 * @returns {string | undefined}
 */
function deriveDisplayTitle(q) {
  if (q.displayTitle) return q.displayTitle;
  const hasRange =
    typeof q.numberStart === "number" && typeof q.numberEnd === "number";
  if (hasRange && q.numberStart !== q.numberEnd) {
    return `Questions ${q.numberStart}-${q.numberEnd}`;
  }
  if (typeof q.number === "number") {
    return `Question ${q.number}`;
  }
  return undefined;
}

/**
 * Normalize a single question. Returns a new object — does not mutate.
 * @param {import("./schemas.js").Question} q
 * @returns {import("./schemas.js").Question}
 */
function normalizeQuestion(q) {
  /** @type {any} */
  const base = {
    ...q,
    content: q.content.trim(),
    displayTitle: deriveDisplayTitle(q),
  };

  if (q.proqyzType === "radio") {
    // Grouped MCQ: subQuestions array. Each entry gets options
    // uppercased and answer uppercased.
    if (Array.isArray(q.subQuestions) && q.subQuestions.length > 0) {
      const subQuestions = q.subQuestions.map((sq) => ({
        number: sq.number,
        text: String(sq.text ?? "").trim(),
        options: (sq.options ?? []).map((o) => ({
          label: o.label.trim().toUpperCase(),
          text: o.text.trim(),
        })),
        answer: String(sq.answer ?? "").trim().toUpperCase(),
      }));
      return { ...base, subQuestions };
    }
    // Legacy single-radio.
    const options = (q.options ?? []).map((o) => ({
      label: o.label.trim().toUpperCase(),
      text: o.text.trim(),
    }));
    return { ...base, options, answer: String(q.answer ?? "").trim().toUpperCase() };
  }

  if (q.proqyzType === "checkbox") {
    const options = (q.options ?? []).map((o) => ({
      label: o.label.trim().toUpperCase(),
      text: o.text.trim(),
    }));
    const answers = (q.answers ?? []).map((a) => a.trim().toUpperCase());
    return { ...base, options, answers };
  }

  // fill_up / select: no options; case-insensitive comparison handles casing.
  // For grouped fill_up, trim each entry of `answers` so the uploader sees
  // clean values to push into the per-blank inputs.
  let normalizedAnswers;
  if (Array.isArray(q.answers)) {
    normalizedAnswers = q.answers.map((a) => String(a).trim());
  }

  return {
    ...base,
    answers: normalizedAnswers ?? q.answers,
    answer: q.answer !== undefined ? String(q.answer).trim() : q.answer,
  };
}

/**
 * Normalize a passage: sort + dedupe + normalize its questions.
 * @param {import("./schemas.js").Passage} p
 * @param {number} passageIdx
 * @returns {import("./schemas.js").Passage}
 */
function normalizePassage(p, passageIdx) {
  const seen = new Set();
  const deduped = [];
  for (const q of p.questions) {
    if (seen.has(q.number)) {
      log.uploader.warn(
        { passageIdx, number: q.number },
        "duplicate question number within passage, dropping",
      );
      continue;
    }
    seen.add(q.number);
    deduped.push(q);
  }
  deduped.sort((a, b) => a.number - b.number);

  return {
    ...p,
    title: p.title.trim(),
    content: p.content.trim(),
    questions: deduped.map(normalizeQuestion),
  };
}

/**
 * Normalize a quiz. Returns a new object — does not mutate.
 * @param {import("./schemas.js").Quiz} quiz
 * @returns {import("./schemas.js").Quiz}
 */
export function normalizeQuiz(quiz) {
  if (quiz.quizType === "reading") {
    return {
      ...quiz,
      quizTitle: quiz.quizTitle.trim(),
      // Default mode to "full" so existing callers (which do not know
      // about mode) keep working. questionsOnly mode is opt-in via
      // { mode: "questionsOnly", existingQuizUrl: "..." } in the JSON.
      mode: quiz.mode ?? "full",
      existingQuizUrl: quiz.existingQuizUrl,
      passages: quiz.passages.map((p, i) => normalizePassage(p, i)),
    };
  }
  // listening
  return {
    ...quiz,
    quizTitle: quiz.quizTitle.trim(),
    sections: quiz.sections.map((s) => ({
      title: s.title.trim(),
      questions: s.questions.map(normalizeQuestion),
    })),
  };
}

/**
 * Slugify a quiz title for use as a checkpoint filename.
 * @param {string} title
 */
export function slugify(title) {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
