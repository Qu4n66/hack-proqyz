/**
 * Helpers for waiting on UI state.
 *
 * In Playwright, you can wait on a specific locator. Sometimes you want
 * a higher-level "wait until the page is actually idle and not blocked
 * by a modal or toast". These helpers do that.
 */

import { config } from "../../config.js";
import { log } from "../../logger.js";

/**
 * Generic "the page is still loading" patterns. The ProQyz SPA
 * surfaces initial-route loads via Bootstrap's `.spinner-border` /
 * `.spinner-grow` and its own "Loading…" text node. The dashboard
 * list-page render is a separate async fetch; while that fetch is
 * in-flight the page is half-rendered and any locator we'd try next
 * (`button:has-text("New quiz")`) will time out.
 *
 * `waitForPageCalm` (and `waitForNoLoadingSpinners`) poll for these
 * to become hidden. That's the deterministic readiness signal —
 * `networkidle` is unreliable because the SPA can hold open
 * long-poll/websocket connections that never go idle.
 */
const LOADING_PATTERNS = [
  ".spinner-border",
  ".spinner-grow",
  ".loading",
  ".spinner",
  '[data-testid="loading"]',
  ".modal-backdrop.show",
  // The "Loading…" text node the dashboard renders centered.
  'text="Loading…"',
  'text="Loading..."',
  'text="Loading"',
];

/**
 * Poll for a 500ms window during which none of the known loading
 * patterns are visible. The 500ms continuous-clean window is the
 * anti-flicker guard: it prevents us from declaring the page calm
 * during the brief gap between "spinner up" and "spinner down".
 *
 * Returns `true` if the page reached a clean state within `timeoutMs`,
 * `false` otherwise. Does NOT throw on timeout — callers decide
 * whether to fail or continue.
 *
 * @param {import("playwright").Page} page
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]   Default 8s.
 * @param {number} [opts.cleanWindowMs]  Default 500ms.
 * @returns {Promise<boolean>}
 */
export async function waitForNoLoadingSpinners(page, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const cleanWindowMs = opts.cleanWindowMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let cleanSince = 0;
  while (Date.now() < deadline) {
    let anyVisible = false;
    for (const sel of LOADING_PATTERNS) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count({ timeout: 50 })) > 0 && (await loc.isVisible({ timeout: 50 }).catch(() => false))) {
          anyVisible = true;
          break;
        }
      } catch {
        // selector didn't exist or threw — treat as not-visible
      }
    }
    if (!anyVisible) {
      if (cleanSince === 0) cleanSince = Date.now();
      if (Date.now() - cleanSince >= cleanWindowMs) return true;
    } else {
      cleanSince = 0;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Wait until the page is in a "calm" state.
 *
 * Order of checks:
 *   1. Deterministic: poll for a 500ms window with no loading
 *      spinner visible. If that times out (8s default), log a
 *      warning and continue — but the next caller will see the
 *      spinner and time out on its own locator, so the failure
 *      surfaces cleanly.
 *   2. Best-effort: try `networkidle` for the same budget. The
 *      ProQyz SPA sometimes holds open long-poll / websocket
 *      connections, so this can hang — we warn-and-continue.
 *
 * The fix-vs-previous is that the spinner check is now the
 * primary readiness signal, not `networkidle`. Previously, when
 * `networkidle` timed out we silently continued onto a still-
 * loading page, and the next `waitFor({ state: "visible" })`
 * would time out 15s later with a confusing error. Now the
 * spinner check is mandatory: we always try to wait it out.
 *
 * @param {import("playwright").Page} page
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]   Per-check budget. Default `actionTimeoutMs` (15s).
 */
export async function waitForPageCalm(page, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? config.actionTimeoutMs;
  // 1. Deterministic spinner-clean window.
  const clean = await waitForNoLoadingSpinners(page, { timeoutMs });
  if (!clean) {
    log.uploader.warn(
      { timeoutMs },
      "waitForPageCalm: loading spinner still visible after timeout; page may be partially rendered",
    );
  }
  // 2. Best-effort network idle. ProQyz SPA may keep a long-poll open; we
  //    never fail on this — the spinner check above is the real gate.
  try {
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 5000) });
  } catch (err) {
    log.uploader.warn({ err: err.message }, "networkidle wait timed out; continuing");
  }
}

/**
 * Add a small randomized delay (jitter) to look less bot-like.
 */
export async function jitter() {
  const { min, max } = config.actionJitterMs;
  const ms = min + Math.random() * (max - min);
  await new Promise((r) => setTimeout(r, ms));
}
