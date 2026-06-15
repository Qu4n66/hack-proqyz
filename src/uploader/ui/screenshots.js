/**
 * Failure capture helpers.
 *
 * On any thrown error during upload, capture a full-page screenshot and
 * the page's outerHTML into ./failures/. The path is logged so the user
 * can review it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config.js";
import { log } from "../../logger.js";

/**
 * @typedef {object} FailureCapture
 * @property {string} screenshotPath
 * @property {string} htmlPath
 */

/**
 * Capture a screenshot and HTML dump. Returns the paths.
 * @param {import("playwright").Page} page
 * @param {string} label Short human-readable label for this failure.
 * @returns {Promise<FailureCapture>}
 */
export async function captureFailure(page, label) {
  if (!existsSync(config.paths.failuresDir)) {
    await mkdir(config.paths.failuresDir, { recursive: true });
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = label.replace(/[^a-z0-9-]+/gi, "-").slice(0, 40);
  const baseName = `${ts}-${safeLabel}`;
  const screenshotPath = join(config.paths.failuresDir, `${baseName}.png`);
  const htmlPath = join(config.paths.failuresDir, `${baseName}.html`);

  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (err) {
    log.uploader.warn({ err: err.message }, "screenshot capture failed");
  }
  try {
    const html = await page.content();
    await writeFile(htmlPath, html, "utf8");
  } catch (err) {
    log.uploader.warn({ err: err.message }, "html dump failed");
  }

  log.uploader.error({ screenshotPath, htmlPath }, "FAILURE CAPTURED");
  return { screenshotPath, htmlPath };
}
