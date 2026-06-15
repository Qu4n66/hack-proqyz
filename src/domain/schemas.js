/**
 * Domain schemas for IELTS quizzes.
 *
 * Pure, no I/O. Single source of truth for what a valid quiz looks like.
 *
 * Top-level shape (new model):
 *   {
 *     title:     string,
 *     quizType:  "reading" | "listening",
 *     time:      positive integer (minutes),
 *     status:    "draft" | "published",
 *     source:    { name: string, url: string } | undefined,
 *     passages:  [ { title, content, questions: [...] }, ... ]
 *   }
 *
 * Questions are NESTED inside each passage. There is no top-level
 * `questions` array. A passage's `questions` is the source of truth
 * for which questions belong to it.
 *
 * Per question, every type field is filled in:
 *   - ieltsType  — one of 13 IELTS Reading types (provenance).
 *   - proqyzType — one of 4 ProQyz editor types (upload strategy).
 *   - content    — HTML. For fill_up (single), must contain exactly
 *                  one `{answer}` placeholder. For fill_up (grouped),
 *                  must contain exactly N `{answer}` placeholders
 *                  where N = numberEnd - numberStart + 1. The inner
 *                  placeholder text is NOT required to match the
 *                  answer value — generic `{answer}` is accepted.
 *   - answer     — single answer, for radio / fill_up / select.
 *   - answers    — array of correct labels, for checkbox ONLY.
 *                  For grouped fill_up, the array of correct answers
 *                  (one per placeholder, in order).
 *   - options    — required for radio / checkbox.
 *   - defaultOptions — required for select (the named option set).
 *
 * Validation rules:
 *   - fill_up (single): content has exactly 1 `{...}` placeholder.
 *     `answer` is required by the top-level rule. Placeholder text
 *     is not checked against `answer`.
 *   - fill_up (grouped): content has exactly N placeholders
 *     (N = numberEnd - numberStart + 1), and `answers.length === N`.
 *     Placeholder text is not checked against `answers[i]`.
 *   - radio: must have options, and `answer` must match a label
 *     (case-insensitive).
 *   - checkbox: must have options, and every entry in `answers` must
 *     match a label (case-insensitive). `answers` must be non-empty.
 *   - select: must have defaultOptions. (select content has no
 *     placeholder requirement — the answer is picked from the
 *     Default Options dropdown.)
 */
import { z } from "zod";

// -----------------------------------------------------------------------------
// Option
// -----------------------------------------------------------------------------
export const OptionSchema = z.object({
  label: z.string().min(1),
  text: z.string().min(1),
});

// -----------------------------------------------------------------------------
// IELTS question type — 13 Reading types
// -----------------------------------------------------------------------------
export const IeltsQuestionTypeSchema = z.enum([
  "note_completion",
  "sentence_completion",
  "summary_completion",
  "table_completion",
  "flow_chart_completion",
  "short_answer",
  "true_false_not_given",
  "yes_no_not_given",
  "matching_headings",
  "matching_information",
  "matching_features",
  "multiple_choice_single",
  "multiple_choice_multiple",
]);

// -----------------------------------------------------------------------------
// ProQyz question type — 4 editor types
// -----------------------------------------------------------------------------
export const ProqyzTypeSchema = z.enum([
  "fill_up",
  "select",
  "radio",
  "checkbox",
]);

// -----------------------------------------------------------------------------
// Default-options codes for proqyzType=select.
//
// These are STABLE codes; the human-readable label shown in the
// "Default Options" dropdown is a presentation concern that may
// change. Codes never change.
// -----------------------------------------------------------------------------
export const DefaultOptionsSchema = z.enum([
  "roman_lower",            // i, ii, iii
  "roman_upper",            // I, II, III
  "capital_letters",        // A, B, C, D
  "lowercase_letters",      // a, b, c, d
  "numeric",                // 1, 2, 3, 4
  "true_false_not_given",   // TRUE / FALSE / NOT GIVEN
  "yes_no_not_given",       // YES / NO / NOT GIVEN
]);

/**
 * Reverse mapping: option-set code → the value to send in the
 * `Default Options` select on ProQyz. The real ProQyz labels are
 * guessed; on first real run, if these don't match, update this
 * function and bump `Selectors.version`.
 */
export function defaultOptionsToSelectValue(code) {
  switch (code) {
    case "roman_lower":
      return "i";
    case "roman_upper":
      return "I";
    case "capital_letters":
      return "A";
    case "lowercase_letters":
      return "a";
    case "numeric":
      return "1";
    case "true_false_not_given":
      // Live 2026-06-09 dump: the <select id="default-options"> option
      // value is "true-false-notgiven" (hyphenated, no underscores or
      // spaces). Map our underscore-coded enum to the wire value.
      return "true-false-notgiven";
    case "yes_no_not_given":
      return "yes-no-notgiven";
    default:
      return code;
  }
}

// -----------------------------------------------------------------------------
// Question
// -----------------------------------------------------------------------------
export const QuestionSchema = z
  .object({
    /** 1-based question number, contiguous within a passage. */
    number: z.number().int().positive(),

    ieltsType: IeltsQuestionTypeSchema,
    proqyzType: ProqyzTypeSchema,
    defaultOptions: DefaultOptionsSchema.optional(),

    /**
     * Master Spec: `instruction` is REQUIRED on every question. It is
     * the line shown to the test-taker above the question (e.g.
     * "Choose the correct answer.", "Do the following statements
     * agree with the information given?"). Empty string is allowed
     * for questions without a separate instruction.
     */
    instruction: z.string(),

    /**
     * Question content as HTML. For fill_up, this must contain
     * `{answer}` placeholders — exactly 1 in single-blank mode,
     * or exactly N in grouped mode where N = numberEnd-numberStart+1.
     * The placeholder text is not required to match the answer
     * value; generic `{answer}` is accepted. (select does NOT
     * require a placeholder.)
     */
    content: z.string().min(1),

    /**
     * Single correct answer. Used for radio / fill_up / select.
     * NOT allowed for checkbox (use `answers` instead).
     */
    answer: z.string().min(1).optional(),

    /**
     * Array of correct labels. Used for checkbox ONLY.
     * NOT allowed for other types (use `answer` instead).
     */
    answers: z.array(z.string().min(1)).optional(),

    /** Required for radio and checkbox. */
    options: z.array(OptionSchema).optional(),

    /**
     * Index of the question type in the ProQyz "Add Question" modal
     * dropdown. Stable mapping: 0 = Fill-up, 1 = Radio, 2 = Select,
     * 3 = Checkbox. Required by the uploader's index-only type picker;
     * preserved by the loader so the value in the fixture survives
     * Zod parse + normalize and reaches _pickQuestionTypeInEditor.
     */
    questionTypeIndex: z.number().int().min(0).max(3).optional(),

    // -------------------------------------------------------------------
    // Grouped-question fields (IELTS "Questions 1-6" → one ProQyz
    // Fill-up with N placeholders). All optional; legacy single-blank
    // fixtures omit them and continue to validate unchanged.
    // -------------------------------------------------------------------

    /**
     * Inclusive start of a grouped-question number range (IELTS:
     * "Questions 1-6" → numberStart=1). Omit for single-blank
     * questions. When both numberStart and numberEnd are set, the
     * question represents `numberEnd - numberStart + 1` IELTS blanks
     * packed into one ProQyz question block.
     */
    numberStart: z.number().int().positive().optional(),

    /**
     * Inclusive end of a grouped-question number range. See
     * `numberStart` for semantics.
     */
    numberEnd: z.number().int().positive().optional(),

    /**
     * Title rendered on the ProQyz Finish tab. Derived by
     * `normalizeQuestion` when omitted: single → `Question ${number}`,
     * grouped → `Questions ${numberStart}-${numberEnd}`. Optional in
     * the input fixture; always present after normalization.
     */
    displayTitle: z.string().min(1).optional(),

    // -------------------------------------------------------------------
    // Grouped radio MCQ (IELTS MCQ "Questions 36-40" → one ProQyz
    // Radio with N sub-question blocks). Each sub-question has its
    // own number, text, options, and correct answer label. Used
    // ONLY when proqyzType === "radio" and numberStart/numberEnd
    // are set; legacy single-radio questions omit it and use the
    // top-level `options` + `answer` fields.
    // -------------------------------------------------------------------
    subQuestions: z
      .array(
        z.object({
          /** 1-based sub-question number within the group. */
          number: z.number().int().positive(),

          /**
           * Plain-text question stem. Rendered into the question
           * input on the ProQyz "List of Questions" section. NOT
           * HTML — ProQyz renders it as plain text in a labelled
           * input.
           */
          text: z.string().min(1),

          /**
           * Option list for this sub-question. Same shape as the
           * top-level `options` field on a single radio question.
           * For IELTS MCQ this is exactly 4 options (A/B/C/D).
           */
          options: z.array(OptionSchema).min(2),

          /**
           * Correct option label (case-insensitive match against
           * `options[i].label`).
           */
          answer: z.string().min(1),
        }),
      )
      .optional(),
  })
  .superRefine((q, ctx) => {
    // -------------------------------------------------------------------
    // answer/answers exclusivity
    // -------------------------------------------------------------------
    const hasAnswer = q.answer !== undefined;
    const hasAnswers = Array.isArray(q.answers) && q.answers.length > 0;

    if (q.proqyzType === "checkbox") {
      if (!hasAnswers) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["answers"],
          message: "checkbox questions require an `answers` array (one or more labels)",
        });
      }
      if (hasAnswer) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["answer"],
          message: "checkbox questions must use `answers` (plural), not `answer`",
        });
      }
    } else {
      // fill_up / radio / select: a question may have either a single
      // `answer` (single-blank mode) or, for fill_up in grouped mode,
      // an `answers` array. The grouped-mode check is below in the
      // fill_up branch.
      const isGroupedFillUp =
        q.proqyzType === "fill_up" &&
        typeof q.numberStart === "number" &&
        typeof q.numberEnd === "number";

      const isGroupedRadio =
        q.proqyzType === "radio" &&
        typeof q.numberStart === "number" &&
        typeof q.numberEnd === "number" &&
        Array.isArray(q.subQuestions) &&
        q.subQuestions.length > 0;

      const isGrouped = isGroupedFillUp || isGroupedRadio;

      if (isGrouped) {
        if (hasAnswer) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["answer"],
            message: `grouped ${q.proqyzType} questions must not define top-level \`answer\`; use ${isGroupedFillUp ? "`answers[]`" : "`subQuestions[].answer`"} instead`,
          });
        }
        if (isGroupedFillUp && !hasAnswers) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["answers"],
            message:
              "grouped fill_up questions require an `answers` array (one entry per placeholder)",
          });
        }
        if (!isGroupedFillUp && hasAnswers) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["answers"],
            message: `grouped ${q.proqyzType} questions must not define \`answers\`; use ${isGroupedFillUp ? "`answers[]`" : "`subQuestions[].answer`"} instead`,
          });
        }
      } else {
        if (!hasAnswer) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["answer"],
            message: `${q.proqyzType} questions require an \`answer\` field`,
          });
        }
        if (hasAnswers) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["answers"],
            message: `${q.proqyzType} questions must use \`answer\` (singular), not \`answers\` (plural)`,
          });
        }
      }
    }

    // -------------------------------------------------------------------
    // radio: two modes
    //   - Legacy single-blank: top-level `options` + `answer`.
    //   - Grouped MCQ (numberStart && numberEnd set): top-level
    //     `subQuestions` array; each entry has its own options+answer.
    //     Top-level `options` and `answer` are forbidden in this mode.
    // -------------------------------------------------------------------
    if (q.proqyzType === "radio") {
      const isGroupedMCQ =
        typeof q.numberStart === "number" &&
        typeof q.numberEnd === "number" &&
        Array.isArray(q.subQuestions) &&
        q.subQuestions.length > 0;

      if (isGroupedMCQ) {
        if (q.numberStart > q.numberEnd) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["numberEnd"],
            message: `numberEnd (${q.numberEnd}) must be >= numberStart (${q.numberStart})`,
          });
        }
        const expected = q.numberEnd - q.numberStart + 1;
        if (q.subQuestions.length !== expected) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["subQuestions"],
            message: `subQuestions length (${q.subQuestions.length}) must equal numberEnd - numberStart + 1 (${expected})`,
          });
        }
        if (q.options !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options"],
            message:
              "grouped radio MCQ must not define top-level `options`; use `subQuestions[].options` instead",
          });
        }
        if (q.answer !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["answer"],
            message:
              "grouped radio MCQ must not define top-level `answer`; use `subQuestions[].answer` instead",
          });
        }
        // Per-sub-question validation: each must have options that
        // match its answer, and the sub-question number must fall
        // within numberStart..numberEnd.
        for (let i = 0; i < q.subQuestions.length; i++) {
          const sq = q.subQuestions[i];
          if (
            sq.number < q.numberStart ||
            sq.number > q.numberEnd
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["subQuestions", i, "number"],
              message: `subQuestion number ${sq.number} must be within ${q.numberStart}..${q.numberEnd}`,
            });
          }
          const labels = sq.options.map((o) => o.label.trim().toUpperCase());
          if (!labels.includes(String(sq.answer).trim().toUpperCase())) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["subQuestions", i, "answer"],
              message: `subQuestion ${sq.number} answer "${sq.answer}" must match one of the option labels (${labels.join(", ")})`,
            });
          }
        }
      } else {
        // Legacy single-radio path.
        if (!q.options || q.options.length < 2) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options"],
            message: "radio requires at least 2 options",
          });
        } else {
          const labels = q.options.map((o) => o.label.trim().toUpperCase());
          if (
            hasAnswer &&
            !labels.includes(String(q.answer).trim().toUpperCase())
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["answer"],
              message: `answer "${q.answer}" must match one of the option labels (${labels.join(", ")})`,
            });
          }
        }
        if (q.subQuestions !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["subQuestions"],
            message:
              "single-radio questions must not define `subQuestions`; use top-level `options` + `answer`",
          });
        }
      }
    }

    // -------------------------------------------------------------------
    // checkbox: options required, every answer must be a label
    // -------------------------------------------------------------------
    if (q.proqyzType === "checkbox") {
      if (!q.options || q.options.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "checkbox requires at least 2 options",
        });
      } else if (hasAnswers) {
        const labels = q.options.map((o) => o.label.trim().toUpperCase());
        const upperAnswers = q.answers.map((a) => a.trim().toUpperCase());
        const missing = upperAnswers.filter((a) => !labels.includes(a));
        if (missing.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["answers"],
            message: `answers [${missing.join(", ")}] not found in option labels (${labels.join(", ")})`,
          });
        }
      }
    }

    // -------------------------------------------------------------------
    // select: requires defaultOptions
    // -------------------------------------------------------------------
    if (q.proqyzType === "select" && !q.defaultOptions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultOptions"],
        message: "select questions require a `defaultOptions` code",
      });
    }

    // -------------------------------------------------------------------
    // fill_up: content must contain one or more {answer} placeholders.
    //   - Single mode (no numberStart/numberEnd): exactly 1 placeholder.
    //   - Grouped mode (numberStart + numberEnd set): exactly N
    //     placeholders where N = numberEnd - numberStart + 1.
    //
    // The inner text of each placeholder is NOT required to match the
    // corresponding `answer` / `answers[i]` value. Generic `{answer}`
    // placeholders are accepted; the uploader reads the answer values
    // from the `answer` / `answers[]` fields and writes them into the
    // per-blank inputs in ProQyz, regardless of what the placeholder
    // text says. (This is intentional — IELTS authors don't need to
    // pre-populate placeholder text with the answer, and legacy fixtures
    // that do are still accepted because the brace count still matches.)
    //
    // select does NOT require a placeholder — the answer is picked from
    // the Default Options dropdown (defaultOptions field).
    // -------------------------------------------------------------------
    if (q.proqyzType === "fill_up") {
      const braces = q.content.match(/\{([^}]+)\}/g) ?? [];

      const isGrouped =
        typeof q.numberStart === "number" && typeof q.numberEnd === "number";

      if (isGrouped) {
        const expected = q.numberEnd - q.numberStart + 1;

        if (q.numberStart > q.numberEnd) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["numberEnd"],
            message: `numberEnd (${q.numberEnd}) must be >= numberStart (${q.numberStart})`,
          });
        }

        if (braces.length !== expected) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["content"],
            message: `grouped fill_up (Q${q.numberStart}-${q.numberEnd}) must contain exactly ${expected} {answer} placeholders (found ${braces.length})`,
          });
        }

        if (hasAnswers && q.answers.length !== expected) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["answers"],
            message: `answers array length (${q.answers.length}) must equal numberEnd - numberStart + 1 (${expected})`,
          });
        }
      } else {
        // Legacy single-blank mode.
        if (braces.length !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["content"],
            message: `content must contain exactly one {answer} placeholder (found ${braces.length})`,
          });
        }
      }
    }
  });

// -----------------------------------------------------------------------------
// Passage — questions are NESTED here.
// -----------------------------------------------------------------------------
export const PassageSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  images: z.array(z.string().url()).optional(),
  questions: z.array(QuestionSchema).min(1),
});

// -----------------------------------------------------------------------------
// Source provenance
// -----------------------------------------------------------------------------
export const SourceSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
});

// -----------------------------------------------------------------------------
// Reading quiz — the new model
//
// Master Spec: top-level field is `quizTitle` (camelCase), not `title`.
// All callers (CLI, fixture, web UI) MUST use `quizTitle`.
// -----------------------------------------------------------------------------
export const ReadingQuizSchema = z.object({
  quizTitle: z.string().min(1),
  quizType: z.literal("reading"),
  time: z.number().int().positive().default(60),
  status: z.enum(["draft", "published"]).default("draft"),
  source: SourceSchema.optional(),
  passages: z.array(PassageSchema).min(1),

  // -------------------------------------------------------------------
  // Upload mode. Default "full" — create quiz + passage + questions.
  // "questionsOnly" — skip createQuiz + addPassage, open an existing
  // quiz by URL and only add questions against the existing passage.
  // Optional; absent means full mode (legacy fixtures unchanged).
  // -------------------------------------------------------------------
  mode: z.enum(["full", "questionsOnly"]).optional(),

  /**
   * ProQyz edit URL of an EXISTING quiz. Required when mode ===
   * "questionsOnly". Ignored in full mode. The uploader opens this URL
   * via openExisting() and then runs the question loop against the
   * passage whose title matches `passages[0].title`.
   */
  existingQuizUrl: z.string().url().optional(),
});

// -----------------------------------------------------------------------------
// Listening quiz (Phase 3 — schema only; not used by Phase 1 driver)
// -----------------------------------------------------------------------------
export const ListeningQuizSchema = z.object({
  quizTitle: z.string().min(1),
  quizType: z.literal("listening"),
  time: z.number().int().positive().default(30),
  status: z.enum(["draft", "published"]).default("draft"),
  source: SourceSchema.optional(),
  audio: z.object({
    source: z.enum(["local", "url"]),
    path: z.string().min(1).optional(),
    url: z.string().url().optional(),
  }),
  sections: z
    .array(
      z.object({
        title: z.string().min(1),
        questions: z.array(QuestionSchema).min(1),
      }),
    )
    .min(1),
});

// -----------------------------------------------------------------------------
// Top-level: discriminated by quizType
// -----------------------------------------------------------------------------
export function underlyingObject(s) {
  return s?._def?.typeName === "ZodEffects" ? s._def.schema : s;
}
export const QuizSchema = z.discriminatedUnion("quizType", [
  underlyingObject(ReadingQuizSchema),
  underlyingObject(ListeningQuizSchema),
]);

// -----------------------------------------------------------------------------
// Inferred types
// -----------------------------------------------------------------------------
/**
 * @typedef {z.infer<typeof OptionSchema>} Option
 * @typedef {z.infer<typeof IeltsQuestionTypeSchema>} IeltsQuestionType
 * @typedef {z.infer<typeof ProqyzTypeSchema>} ProqyzType
 * @typedef {z.infer<typeof DefaultOptionsSchema>} DefaultOptions
 * @typedef {z.infer<typeof QuestionSchema>} Question
 * @typedef {z.infer<typeof PassageSchema>} Passage
 * @typedef {z.infer<typeof SourceSchema>} Source
 * @typedef {z.infer<typeof ReadingQuizSchema>} ReadingQuiz
 * @typedef {z.infer<typeof ListeningQuizSchema>} ListeningQuiz
 * @typedef {z.infer<typeof QuizSchema>} Quiz
 */
