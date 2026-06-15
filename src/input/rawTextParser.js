/**
 * Raw-text parser seed (Phase 2).
 *
 * This file ships with the function signature, the Zod schema dispatcher,
 * and a clear "not implemented" message so callers fail loud if they
 * invoke it before Phase 2 lands. The actual parsing rules for each
 * IELTS Reading type will be filled in then.
 *
 * Phase 2 entry points (all TODO):
 *   - parseCambridgeText(text)         -> ReadingQuiz
 *   - parseQuestionBlock(text, type)   -> Question
 *   - parseInstructions(text)          -> string
 *
 * Supported question types (from schemas.js): see QuestionTypeSchema.
 */

import { QuizSchema } from "../domain/schemas.js";

/**
 * Parse a raw IELTS text dump into a Quiz.
 * @param {string} text
 * @returns {Promise<import("../domain/schemas.js").ReadingQuiz>}
 * @throws Always in Phase 1. The real implementation lands in Phase 2.
 */
export async function parseRawTextToQuiz(text) {
  throw new Error(
    "parseRawTextToQuiz: not implemented yet (Phase 2). " +
      "Use the JSON input path for now.",
  );
}

/**
 * Best-effort type detection for a question block, by looking at its
 * instruction line. Phase 2 implements this fully.
 * @param {string} instruction
 * @returns {string} one of the values in QuestionTypeSchema
 */
export function detectQuestionType(instruction) {
  const i = instruction.toLowerCase();
  if (i.includes("yes") && i.includes("no") && i.includes("not given")) return "yes_no_not_given";
  if (i.includes("true") && i.includes("false")) return "true_false_not_given";
  if (i.includes("choose") && i.includes("letter")) return "multiple_choice";
  if (i.includes("matching") && i.includes("heading")) return "matching_headings";
  if (i.includes("matching") && i.includes("information")) return "matching_information";
  if (i.includes("matching") && i.includes("feature")) return "matching_features";
  if (i.includes("sentence completion") || i.includes("complete the sentence")) return "sentence_completion";
  if (i.includes("summary completion") || i.includes("complete the summary")) return "summary_completion";
  if (i.includes("table completion") || i.includes("complete the table")) return "table_completion";
  if (i.includes("flow") && i.includes("chart")) return "flow_chart_completion";
  if (i.includes("short answer") || i.includes("answer the questions")) return "short_answer";
  return "short_answer";
}

/**
 * Re-export the schema so the parser can validate its own output.
 */
export { QuizSchema };
