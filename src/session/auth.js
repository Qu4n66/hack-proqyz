/**
 * Authentication & session management.
 *
 * Strategy:
 *   1. If storageState.json exists and is fresh, load it.
 *   2. If auto-login credentials are provided, attempt auto-login.
 *   3. Otherwise, open the login page in headed mode and wait for manual login.
 *
 * Security: credentials are kept in memory only. Never saved to disk,
 * never logged, never written to storageState.
 */

import { existsSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { config } from "../config.js";
import { log } from "../logger.js";
import { ensureProfileDir } from "./profile.js";

/** How long a saved storageState is considered fresh (24h). */
const STORAGE_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Decide whether to load a saved storageState or force a fresh login.
 * Returns:
 *   - "fresh": storageState is missing or stale; we need a fresh login.
 *   - "load":  storageState is present and fresh; we can load it.
 *
 * @returns {Promise<"fresh" | "load">}
 */
export async function checkStorageState() {
  if (!existsSync(config.storageStatePath)) return "fresh";

  try {
    const raw = await readFile(config.storageStatePath, "utf8");
    const state = JSON.parse(raw);
    const cookies = state.cookies || [];
    if (cookies.length === 0) return "fresh";

    // If the newest cookie expires in the past, the state is stale.
    const now = Date.now() / 1000;
    const hasLive = cookies.some((c) => !c.expires || c.expires > now + 60);
    if (!hasLive) {
      log.auth.info("storageState cookies all expired; will re-login");
      return "fresh";
    }

    log.auth.debug({ path: config.storageStatePath, cookies: cookies.length }, "using saved storageState");
    return "load";
  } catch (err) {
    log.auth.warn({ err: err.message }, "storageState unreadable; will re-login");
    return "fresh";
  }
}

/**
 * Save the current browser context's storage state to disk.
 * @param {import("playwright").BrowserContext} context
 */
export async function saveStorageState(context) {
  const state = await context.storageState();
  await writeFile(config.storageStatePath, JSON.stringify(state, null, 2));
  log.auth.info({ path: config.storageStatePath }, "saved storageState");
}

/**
 * Attempt automatic login using email/password credentials.
 * Credentials are used in-memory only and never saved to disk.
 *
 * @param {import("playwright").Page} page
 * @param {string} loginUrl
 * @param {RegExp} loggedInPattern
 * @param {string} email
 * @param {string} password
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<boolean>} true if login succeeded
 */
export async function autoLogin(page, loginUrl, loggedInPattern, email, password, timeoutMs = 30000) {
  log.auth.info({ url: loginUrl, email }, "auto login enabled");

  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    log.auth.info("auto login page loaded");

    // Fill email/username — ProQyz uses placeholder "Enter you email"
    const emailInput = page.locator(
      'input[placeholder*="email" i], input[type="email"], input[name*="email" i], input[name="username"]'
    ).first();
    await emailInput.waitFor({ state: "visible", timeout: 15000 });
    log.auth.info("email input found");
    await emailInput.fill(email);
    log.auth.info("credentials filled");

    // Fill password — ProQyz uses placeholder "Enter your password"
    const passwordInput = page.locator(
      'input[placeholder*="password" i], input[type="password"], input[name*="password" i]'
    ).first();
    await passwordInput.waitFor({ state: "visible", timeout: 15000 });
    log.auth.info("password input found");
    await passwordInput.fill(password);

    // Click login/submit — ProQyz button text is "Signin with Email" (no space)
    const submitButton = page.locator(
      'button:has-text("Signin with Email"), button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in"), button[type="submit"]'
    ).first();
    await submitButton.waitFor({ state: "visible", timeout: 15000 });
    log.auth.info("submit button found");
    await submitButton.click();
    log.auth.info("login submitted");

    // Wait for login success — check URL OR body text (client-side routing may not change URL)
    await page.waitForFunction(() => {
      const text = (document.body?.innerText || "").toLowerCase();
      return (
        location.href.includes("dashboard") ||
        location.href.includes("get-started") ||
        location.href.includes("pro-qyz") ||
        text.includes("my quizzes") ||
        text.includes("import quiz") ||
        text.includes("quiz library")
      );
    }, { timeout: timeoutMs });

    log.auth.info({ url: page.url() }, "auto login success");
    return true;
  } catch (err) {
    log.auth.warn({ err: err.message }, "auto login failed — falling back to manual login");
    return false;
  }
}

/**
 * Wait for the user to log in manually. The login is considered complete
 * when the URL no longer matches the login URL pattern AND a session
 * cookie is present.
 *
 * @param {import("playwright").Page} page
 * @param {string} loginUrl   The URL of the login page.
 * @param {RegExp} loggedInPattern URL pattern that indicates a successful login.
 * @param {number} timeoutMs
 */
export async function waitForManualLogin(page, loginUrl, loggedInPattern, timeoutMs) {
  log.auth.info(
    { url: loginUrl, timeoutMs },
    "waiting for manual login — please log in inside the browser window",
  );
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

  const start = Date.now();
  // Poll every 1s up to the timeout.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Manual login timed out after ${timeoutMs / 1000}s`);
    }
    if (loggedInPattern.test(page.url())) {
      log.auth.info({ url: page.url() }, "manual login detected");
      return;
    }
    await page.waitForTimeout(1000);
  }
}

/**
 * High-level: get an authenticated browser context.
 *
 * @param {import("playwright").Browser} browser
 * @param {object} opts
 * @param {string} opts.loginUrl
 * @param {RegExp} opts.loggedInPattern
 * @param {string} [opts.autoLoginEmail]   — email for auto-login (optional)
 * @param {string} [opts.autoLoginPassword] — password for auto-login (optional)
 * @param {boolean} [opts.useAutoLogin]     — attempt auto-login first (optional)
 * @returns {Promise<import("playwright").BrowserContext>}
 */
export async function getAuthenticatedContext(browser, { loginUrl, loggedInPattern, useAutoLogin, autoLoginEmail, autoLoginPassword }) {
  await ensureProfileDir();
  const status = await checkStorageState();

  if (status === "load") {
    const context = await browser.newContext({ storageState: config.storageStatePath });
    return context;
  }

  // Fresh login flow.
  const context = await browser.newContext();
  const page = await context.newPage();

  // Log decision
  if (useAutoLogin && autoLoginEmail && autoLoginPassword) {
    log.auth.info("auto login enabled — attempting automatic login");
  } else {
    log.auth.info({ useAutoLogin: !!useAutoLogin }, "waiting for manual login — please log in inside the browser window");
  }

  // Try auto-login first if credentials provided
  if (useAutoLogin && autoLoginEmail && autoLoginPassword) {
    const autoLoginOk = await autoLogin(page, loginUrl, loggedInPattern, autoLoginEmail, autoLoginPassword);
    if (autoLoginOk) {
      await saveStorageState(context);
      log.auth.info({ path: config.storageStatePath }, "saved storageState");
      await page.close();
      return context;
    }
    // Auto-login failed — fall through to manual login
    log.auth.info("falling back to manual login");
    // Navigate back to login page for manual login
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  }

  await waitForManualLogin(page, loginUrl, loggedInPattern, config.manualLoginTimeoutMs);
  await saveStorageState(context);
  await page.close();
  return context;
}
