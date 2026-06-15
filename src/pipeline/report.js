/**
 * Per-quiz summary report. Used by both single-quiz and bulk-folder runs.
 */

import { log } from "../logger.js";

/**
 * @typedef {object} RunResult
 * @property {string} title
 * @property {"ok" | "skipped" | "failed" | "resumed" | "capped"} status
 * @property {string} [reviewUrl]
 * @property {string} [error]
 * @property {number} questionsUploaded
 * @property {number} questionsTotal
 * @property {number} durationMs
 */

/**
 * Pretty-print a single result to the console.
 * @param {RunResult} r
 */
export function printResult(r) {
  const statusIcon = {
    ok: "[OK]",
    skipped: "[SKIP]",
    failed: "[FAIL]",
    resumed: "[RESUME]",
    capped: "[CAPPED]",
  }[r.status];
  log.pipeline.info(
    `${statusIcon} ${r.title}  ${r.questionsUploaded}/${r.questionsTotal} questions  (${r.durationMs}ms)`,
  );
  if (r.reviewUrl) {
    log.pipeline.info(`        review: ${r.reviewUrl}`);
  }
  if (r.error) {
    log.pipeline.error(`        error: ${r.error}`);
  }
}

/**
 * Print a final summary across multiple results.
 * @param {RunResult[]} results
 */
export function printSummary(results) {
  const ok = results.filter((r) => r.status === "ok" || r.status === "resumed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;
  log.pipeline.info("=========================================");
  log.pipeline.info(`Summary: ${ok} ok, ${skipped} skipped, ${failed} failed`);
  log.pipeline.info("=========================================");
}
