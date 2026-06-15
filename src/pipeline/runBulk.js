/**
 * Bulk folder runner.
 *
 * Runs every *.json in a directory through the single-quiz pipeline with
 * per-quiz try/catch. One failed quiz does not block the rest. At the
 * end, prints a summary and writes failures/<timestamp>-summary.json
 * for the record.
 *
 * Phase 3 architecture, ships as a stub-now-complete-later feature: the
 * loop is in place, but Listening support is still pending. If a
 * non-reading quiz is encountered we still try to upload it; if the UI
 * driver can't handle it, the error is captured per-quiz.
 */

import { readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { log } from "../logger.js";
import { config } from "../config.js";
import { runQuiz } from "./run.js";
import { printResult, printSummary } from "./report.js";

/**
 * @typedef {import("./report.js").RunResult} RunResult
 */

/**
 * Run every *.json in a directory.
 * @param {string} dirPath
 * @param {object} opts  Same as RunOptions (minus inputPath).
 * @returns {Promise<RunResult[]>}
 */
export async function runBulkFromDir(dirPath, opts = {}) {
  const abs = resolve(dirPath);
  if (!existsSync(abs)) {
    throw new Error(`Bulk directory not found: ${abs}`);
  }
  const entries = await readdir(abs, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => join(abs, e.name))
    .sort();

  if (files.length === 0) {
    log.pipeline.warn({ dir: abs }, "no *.json files found in directory");
    return [];
  }

  log.pipeline.info(
    { dir: abs, count: files.length },
    `starting bulk run of ${files.length} quizzes`,
  );

  /** @type {RunResult[]} */
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    log.pipeline.info(
      { idx: i + 1, total: files.length, file: basename(file) },
      "starting quiz",
    );
    try {
      const r = await runQuiz({ ...opts, inputPath: file });
      results.push(r);
    } catch (err) {
      // Defensive: runQuiz already handles its own errors, but if it
      // throws (e.g. JSON parse error before the uploader runs), we
      // capture it here so the loop continues.
      log.pipeline.error({ file, err: err.message }, "quiz threw before completing");
      results.push({
        title: basename(file, ".json"),
        status: "failed",
        error: err.message,
        questionsUploaded: 0,
        questionsTotal: 0,
        durationMs: 0,
      });
    }
  }

  printSummary(results);
  await writeBulkSummary(results);
  return results;
}

/**
 * Write a JSON summary of the bulk run for archival.
 * @param {RunResult[]} results
 */
async function writeBulkSummary(results) {
  if (!existsSync(config.paths.failuresDir)) {
    await mkdir(config.paths.failuresDir, { recursive: true });
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(config.paths.failuresDir, `${ts}-bulk-summary.json`);
  const summary = {
    timestamp: new Date().toISOString(),
    total: results.length,
    ok: results.filter((r) => r.status === "ok" || r.status === "resumed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    failures: results.filter((r) => r.status === "failed").map((r) => ({
      title: r.title,
      error: r.error,
    })),
  };
  await writeFile(path, JSON.stringify(summary, null, 2));
  log.pipeline.info({ path }, "bulk summary written");
}
