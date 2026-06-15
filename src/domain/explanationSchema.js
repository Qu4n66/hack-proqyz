/**
 * Zod schema for the Explanation Upload JSON format.
 *
 * This is a SEPARATE schema from the quiz schema. Explanation mode
 * only edits existing questions — it does NOT create quizzes,
 * passages, or questions.
 *
 * Slot mapping (calculated by the normalizer, not by Zod):
 *   slot = questionNumber - questionNumberStart + 1
 *
 * Example:
 *   Questions 36-37 → Q36 = slot 1, Q37 = slot 2
 *
 * Blank explanations:
 *   Some IELTS questions intentionally have no explanation.
 *   Set `blank: true` to skip writing content and verify the
 *   editor remains empty after save. `blank: true` takes
 *   precedence over `content` — if both are provided, content
 *   is ignored and the editor is expected to be empty.
 */
import { z } from "zod";

// ──────────────────────────────────────────────────────────────
// Explanation Slot
// ──────────────────────────────────────────────────────────────
const ExplanationSlotBaseSchema = z.object({
  /**
   * Slot number inside the ProQyz Explanation tab.
   * Auto-calculated by normalizeExplanationData() if omitted:
   *   slot = questionNumber - questionNumberStart + 1
   */
  slot: z.number().int().positive().optional(),

  /** The IELTS question number (e.g. 36, 37). */
  questionNumber: z.number().int().positive(),

  /**
   * Explanation HTML/text content. Replaces existing content.
   * Required unless `blank` is true.
   */
  content: z.string().optional(),

  /**
   * When true, this question has intentionally no explanation.
   * The uploader will NOT paste any content and will verify
   * the editor remains empty. `blank: true` takes precedence
   * over `content` — if both are provided, content is ignored.
   */
  blank: z.boolean().optional(),
});

export const ExplanationSlotSchema = ExplanationSlotBaseSchema.superRefine(
  (slot, ctx) => {
    if (slot.blank) {
      // blank=true: content is ignored, can be omitted or empty
      return;
    }
    // Not blank: content must be present and non-empty
    if (!slot.content || slot.content.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content"],
        message: "content is required when blank is not true",
      });
    }
  },
);

// ──────────────────────────────────────────────────────────────
// Explanation Group (e.g. "Questions 36-37")
// ──────────────────────────────────────────────────────────────
export const ExplanationGroupSchema = z
  .object({
    /** Human-readable range label, e.g. "36-37". */
    range: z.string().min(1),

    /** Inclusive start of the question number range. */
    questionNumberStart: z.number().int().positive(),

    /** Inclusive end of the question number range. */
    questionNumberEnd: z.number().int().positive(),

    /** Array of explanation slots for this group. */
    explanations: z.array(ExplanationSlotSchema).min(1),
  })
  .superRefine((g, ctx) => {
    if (g.questionNumberStart > g.questionNumberEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questionNumberEnd"],
        message: `questionNumberEnd (${g.questionNumberEnd}) must be >= questionNumberStart (${g.questionNumberStart})`,
      });
    }

    const expectedCount = g.questionNumberEnd - g.questionNumberStart + 1;

    // Validate each explanation (without mutating — slot check uses
    // auto-calculated value, not the raw input)
    const seenSlots = new Set();
    for (let i = 0; i < g.explanations.length; i++) {
      const exp = g.explanations[i];

      // Calculate what the slot would be (don't mutate)
      const autoSlot = exp.slot ?? exp.questionNumber - g.questionNumberStart + 1;

      // Slot must be within range
      if (autoSlot < 1 || autoSlot > expectedCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["explanations", i, "slot"],
          message: `slot ${autoSlot} must be within 1..${expectedCount} for range ${g.questionNumberStart}-${g.questionNumberEnd}`,
        });
      }

      // Question number must be within range
      if (
        exp.questionNumber < g.questionNumberStart ||
        exp.questionNumber > g.questionNumberEnd
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["explanations", i, "questionNumber"],
          message: `questionNumber ${exp.questionNumber} must be within ${g.questionNumberStart}..${g.questionNumberEnd}`,
        });
      }

      // No duplicate slots
      if (seenSlots.has(autoSlot)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["explanations", i, "slot"],
          message: `duplicate slot ${autoSlot} in group ${g.range}`,
        });
      }
      seenSlots.add(autoSlot);
    }
  });

// ──────────────────────────────────────────────────────────────
// Explanation Passage
// ──────────────────────────────────────────────────────────────
export const ExplanationPassageSchema = z.object({
  /** 1-based passage number (matches ProQyz passage dropdown). */
  passage: z.number().int().positive(),

  /** Question groups within this passage. */
  questionGroups: z.array(ExplanationGroupSchema).min(1),
});

// ──────────────────────────────────────────────────────────────
// Top-level Explanation Data
// ──────────────────────────────────────────────────────────────
export const ExplanationDataSchema = z
  .object({
    /** Must be "explanation" for this schema. */
    mode: z.literal("explanation"),

    /** Quiz title as it appears in ProQyz (used for search). */
    testTitle: z.string().min(1),

    /**
     * Optional direct URL to the quiz edit page.
     * If provided, skips the search step and opens this URL directly.
     */
    existingQuizUrl: z.string().url().optional(),

    /** Passages to process. */
    passages: z.array(ExplanationPassageSchema).min(1),
  });

// ──────────────────────────────────────────────────────────────
// Normalizer — fills in missing slots
// ──────────────────────────────────────────────────────────────
/**
 * Normalize explanation data: calculate missing slots, sort
 * explanations by slot within each group. Returns a new object.
 * @param {object} data  Parsed ExplanationDataSchema
 * @returns {object}  Normalized copy with all slots filled
 */
export function normalizeExplanationData(data) {
  return {
    ...data,
    passages: data.passages.map((p) => ({
      ...p,
      questionGroups: p.questionGroups.map((g) => ({
        ...g,
        explanations: g.explanations
          .map((e) => ({
            ...e,
            slot: e.slot ?? e.questionNumber - g.questionNumberStart + 1,
            // Preserve blank flag; if blank=true, clear content to avoid confusion
            blank: !!e.blank,
            content: e.blank ? "" : (e.content ?? ""),
          }))
          .sort((a, b) => a.slot - b.slot),
      })),
    })),
  };
}
