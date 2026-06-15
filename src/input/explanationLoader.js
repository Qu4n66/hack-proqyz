/**
 * Explanation JSON loader.
 * Reads an explanation JSON file, validates against ExplanationDataSchema,
 * and normalizes slot values.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ExplanationDataSchema,
  normalizeExplanationData,
} from "../domain/explanationSchema.js";
import { log } from "../logger.js";

/**
 * Load, validate, and normalize an explanation JSON file.
 * @param {string} filePath
 * @returns {Promise<import("../domain/explanationSchema.js").ExplanationData>}
 */
export async function loadExplanationFromJson(filePath) {
  const abs = resolve(filePath);
  log.input.info({ file: abs }, "loading explanation JSON");

  const raw = await readFile(abs, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${abs}: ${err.message}`);
  }

  const result = ExplanationDataSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Explanation validation failed for ${abs}:\n${issues}`);
  }

  const normalized = normalizeExplanationData(result.data);

  // Count total explanation slots
  let totalSlots = 0;
  for (const p of normalized.passages) {
    for (const g of p.questionGroups) {
      totalSlots += g.explanations.length;
    }
  }

  log.input.info(
    {
      testTitle: normalized.testTitle,
      passages: normalized.passages.length,
      totalSlots,
      hasDirectUrl: !!normalized.existingQuizUrl,
    },
    "explanation JSON loaded and validated",
  );

  return normalized;
}
