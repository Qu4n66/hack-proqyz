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

    /**
     * Human-readable group card title shown in ProQyz UI.
     * Used to match a UI group card to a JSON entry. Optional but
     * recommended for `fullPassage` mode so the uploader can detect
     * ordering mismatches before editing.
     */
    groupTitle: z.string().min(1).optional(),

    /** Inclusive start of the question number range. */
    questionNumberStart: z.number().int().positive(),

    /** Inclusive end of the question number range. */
    questionNumberEnd: z.number().int().positive(),

    /**
     * 1-based order of the group card in the UI list. Optional —
     * used as a fallback identifier when `groupTitle` matching is
     * ambiguous. Must be >= 1 when provided.
     */
    slotIndex: z.number().int().positive().optional(),

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

    // range should match questionNumberStart/questionNumberEnd if it
    // follows the X-Y convention. We do NOT fail when range is something
    // else (e.g. "Q36-37") — just accept it. If it is X-Y, validate.
    const rangeMatch = String(g.range).match(/(\d+)\s*[-–]\s*(\d+)/);
    if (rangeMatch) {
      const rStart = Number(rangeMatch[1]);
      const rEnd = Number(rangeMatch[2]);
      if (rStart !== g.questionNumberStart || rEnd !== g.questionNumberEnd) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["range"],
          message: `range "${g.range}" (${rStart}-${rEnd}) does not match questionNumberStart/End (${g.questionNumberStart}-${g.questionNumberEnd})`,
        });
      }
    }

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

  /**
   * Human-readable passage title shown in ProQyz UI. Optional —
   * used as a fallback identifier for the uploader.
   */
  passageTitle: z.string().min(1).optional(),

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

    /**
     * Quiz type. Required for fullPassage mode so the uploader can
     * pick the correct passage dropdown ("Reading passage 1" vs
     * "Listening section 1"). Optional in single-group mode but
     * recommended.
     */
    quizType: z.enum(["reading", "listening"]).optional(),

    /** Quiz title as it appears in ProQyz (used for search). */
    testTitle: z.string().min(1),

    /**
     * Optional direct URL to the quiz edit page.
     * If provided, skips the search step and opens this URL directly.
     */
    existingQuizUrl: z.string().url().optional(),

    /**
     * When true, the uploader processes ALL question groups in the
     * selected passage from top to bottom, opening one modal at a
     * time. When false (or omitted), only the first group is uploaded
     * (single-group mode — backward compatible).
     */
    fullPassage: z.boolean().optional(),

    /**
     * Passage number to upload when `fullPassage: true`. Ignored
     * otherwise. Must reference a `passage` in `passages`.
     */
    targetPassage: z.number().int().positive().optional(),

    /**
     * Number of question groups expected to be visible in the UI for
     * `targetPassage`. The uploader compares the actual UI count
     * against this number and the JSON's `questionGroups.length`
     * BEFORE editing anything.
     */
    expectedGroupCount: z.number().int().positive().optional(),

    /** Passages to process. */
    passages: z.array(ExplanationPassageSchema).min(1),
  })
  .superRefine((d, ctx) => {
    if (!d.fullPassage) return;

    // fullPassage-specific validation
    if (d.targetPassage == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetPassage"],
        message: "fullPassage=true requires targetPassage",
      });
      return;
    }
    if (d.expectedGroupCount == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedGroupCount"],
        message: "fullPassage=true requires expectedGroupCount",
      });
      return;
    }

    const passage = d.passages.find((p) => p.passage === d.targetPassage);
    if (!passage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetPassage"],
        message: `targetPassage=${d.targetPassage} does not match any passage in passages[]`,
      });
      return;
    }

    if (passage.questionGroups.length !== d.expectedGroupCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedGroupCount"],
        message: `expectedGroupCount=${d.expectedGroupCount} but passages[passage=${d.targetPassage}].questionGroups.length=${passage.questionGroups.length}`,
      });
    }

    // Every group must have slotIndex + groupTitle for fullPassage mode.
    // The uploader needs them to detect ordering mismatches.
    passage.questionGroups.forEach((g, gi) => {
      if (g.slotIndex == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["passages", String(d.passages.indexOf(passage)), "questionGroups", String(gi), "slotIndex"],
          message: `fullPassage mode requires slotIndex on group ${g.range}`,
        });
      }
      if (!g.groupTitle) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["passages", String(d.passages.indexOf(passage)), "questionGroups", String(gi), "groupTitle"],
          message: `fullPassage mode requires groupTitle on group ${g.range}`,
        });
      }
    });
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
    fullPassage: !!data.fullPassage,
    passages: data.passages.map((p) => ({
      ...p,
      questionGroups: p.questionGroups
        .map((g, gi) => ({
          ...g,
          // Default slotIndex to 1-based JSON position when missing
          slotIndex: g.slotIndex ?? gi + 1,
          explanations: g.explanations
            .map((e) => ({
              ...e,
              slot: e.slot ?? e.questionNumber - g.questionNumberStart + 1,
              // Preserve blank flag; if blank=true, clear content to avoid confusion
              blank: !!e.blank,
              content: e.blank ? "" : (e.content ?? ""),
            }))
            .sort((a, b) => a.slot - b.slot),
        }))
        .sort((a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0)),
    })),
  };
}

/**
 * Get the question groups for the targeted passage in `fullPassage` mode.
 * Throws if not in fullPassage mode or if targetPassage doesn't match.
 * @param {object} data  Normalized explanation data
 * @returns {{passage: object, groups: Array<object>}}
 */
export function getTargetPassageGroups(data) {
  if (!data.fullPassage) {
    throw new Error("getTargetPassageGroups requires fullPassage=true");
  }
  const passage = data.passages.find((p) => p.passage === data.targetPassage);
  if (!passage) {
    throw new Error(
      `targetPassage=${data.targetPassage} not found in passages[]`,
    );
  }
  return { passage, groups: passage.questionGroups };
}
