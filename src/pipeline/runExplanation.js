/**
 * Explanation upload pipeline — SINGLE GROUP MODE.
 *
 * Processes exactly one questionGroup per upload:
 *   1. Load + validate explanation JSON
 *   2. Launch browser + auth
 *   3. Search/open quiz
 *   4. Open Questions tab → select passage → open one question → fill → save → close
 *
 * Throws if the JSON contains more than one questionGroup.
 */

import { chromium } from "playwright";
import { config } from "../config.js";
import { log } from "../logger.js";
import { loadExplanationFromJson } from "../input/explanationLoader.js";
import { getAuthenticatedContext } from "../session/auth.js";
import { Selectors } from "../uploader/ui/selectors.js";
import { UiQuizUploader } from "../uploader/ui/UiQuizUploader.js";
import { captureFailure } from "../uploader/ui/screenshots.js";
import { printResult } from "./report.js";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * @typedef {object} RunExplanationOptions
 * @property {string} inputPath
 * @property {boolean} [dryRun]
 */

/**
 * Run an explanation upload — single group mode.
 * @param {RunExplanationOptions} opts
 * @returns {Promise<import("./report.js").RunResult>}
 */
export async function runExplanation(opts) {
  const startedAt = Date.now();
  const dryRun = !!opts.dryRun;

  // 1. Load auto-login config.
  //    Strategy A: read _autoLogin from the raw JSON file (UI injects it).
  //    Strategy B: fallback to env vars (from server spawn or CLI flags).
  //    After reading from file, IMMEDIATELY scrub credentials from disk.
  let autoLoginConfig = { useAutoLogin: false, email: "", password: "" };

  // Strategy A: read from JSON file
  try {
    const rawText = readFileSync(opts.inputPath, "utf8");
    const rawObj = JSON.parse(rawText);
    const al = rawObj._autoLogin;
    if (al && al.useAutoLogin && al.email && al.password) {
      autoLoginConfig = { useAutoLogin: true, email: al.email, password: al.password };
      log.pipeline.info({ email: al.email }, "auto-login config loaded from JSON");
      // Scrub immediately — password must not stay on disk
      delete rawObj._autoLogin;
      writeFileSync(opts.inputPath, JSON.stringify(rawObj, null, 2) + "\n", "utf8");
      log.pipeline.info("scrubbed _autoLogin from JSON file");
    }
  } catch { /* file not readable — try env vars */ }

  // Strategy B: fallback to env vars
  if (!autoLoginConfig.useAutoLogin) {
    const rawAutoLogin = process.env.PROQYZ_AUTO_LOGIN;
    const rawEmail = process.env.PROQYZ_LOGIN_EMAIL;
    const rawPassword = process.env.PROQYZ_LOGIN_PASSWORD;
    if ((rawAutoLogin === "1" || rawAutoLogin === "true") && rawEmail && rawPassword) {
      autoLoginConfig = { useAutoLogin: true, email: rawEmail, password: rawPassword };
      log.pipeline.info({ email: rawEmail }, "auto-login config loaded from env vars");
    }
  }

  // 2. Load + validate explanation data.
  const data = await loadExplanationFromJson(opts.inputPath);

  // --- Single-group guard ---
  // Count total questionGroups across all passages
  let totalGroups = 0;
  for (const p of data.passages) {
    totalGroups += p.questionGroups.length;
  }
  if (totalGroups > 1) {
    const msg = `Single-group mode only supports one questionGroup. Found ${totalGroups} groups. Remove extra groups from the JSON.`;
    log.pipeline.error({ totalGroups }, msg);
    throw new Error(msg);
  }

  // Find the single group
  const passage = data.passages[0];
  const group = passage.questionGroups[0];
  const totalSlots = group.explanations.length;

  const passageTitle =
    passage.passageTitle ||
    passage.title ||
    `Reading Passage ${passage.passage}`;
  const rangeLabel = normalizeRangeLabel(group.range);
  const expectedSlots = group.explanations.length;

  log.pipeline.info(
    { testTitle: data.testTitle, passage: passage.passage, passageTitle, range: rangeLabel, slots: totalSlots },
    "starting explanation upload (single group mode)",
  );

  // 2. Launch browser + auth.
  const browser = await chromium.launch({ headless: false });
  log.pipeline.info({
    useAutoLogin: autoLoginConfig.useAutoLogin,
    email: autoLoginConfig.email || "(none)",
    hasPassword: !!autoLoginConfig.password,
  }, "auto-login config check");
  const ctx = await getAuthenticatedContext(browser, {
    loginUrl: `${config.baseUrl}${Selectors.login.loginUrl}`,
    loggedInPattern: Selectors.login.postLoginUrl,
    useAutoLogin: autoLoginConfig.useAutoLogin,
    autoLoginEmail: autoLoginConfig.email,
    autoLoginPassword: autoLoginConfig.password,
  });
  const page = await ctx.newPage();

  const uploader = new UiQuizUploader({ browserContext: ctx, page, dryRun });

  let failure = null;
  let slotsFilled = 0;

  try {
    // 3. Open quiz — direct URL or search.
    await uploader.searchAndOpenQuiz(data.testTitle, data.existingQuizUrl);

    // 3b. Wait for the quiz edit page to fully render.
    await waitForQuizEditPageReady(page, { timeoutMs: 30000 });

    // 4. Click the Questions tab.
    await _clickQuestionsTab(page);
    log.pipeline.info("Questions tab clicked; waiting for content to load");

    await page.waitForTimeout(800);
    await _verifyQuestionsPageReady(page);

    // 5. Debug dump.
    await _dumpQuestionsPageState(page, passageTitle);

    // 6. Select the correct passage.
    await _selectPassageInTab(page, passageTitle, passage.passage - 1);

    // 7. Wait for question rows to load after passage selection.
    await _waitForQuestionRows(page, rangeLabel);

    // 8. Verify we're on the Question list.
    await _verifyQuestionListVisible(page, rangeLabel);

    // 9. Open the question for edit.
    await uploader.openQuestionForEdit(rangeLabel, expectedSlots);
    log.pipeline.info(`opened ${rangeLabel}`);

    // 10. Fill explanation slots (write + verify).
    const fillResult = await uploader.fillExplanationsSlot(group.explanations);
    slotsFilled = fillResult.slotsFilled;
    log.pipeline.info({ filled: fillResult.slotsFilled, verified: fillResult.slotsVerified }, `filled ${fillResult.slotsFilled}/${expectedSlots} slots`);

    // 11. Save.
    await uploader.saveQuestionEdit();
    log.pipeline.info(`saved ${rangeLabel}`);

    // 12. Close modal.
    await uploader.closeQuestionModalAfterSave();
    log.pipeline.info("closed modal");

    log.pipeline.info({ slotsFilled }, "explanation upload complete");
  } catch (err) {
    failure = err;
    log.pipeline.error({ err: err.message }, "explanation upload failed");
    try {
      await captureFailure(page, `explanation-${data.testTitle}`);
    } catch {
      /* noop */
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const result = failure
    ? {
        title: data.testTitle,
        status: "failed",
        error: failure.message,
        questionsUploaded: slotsFilled,
        questionsTotal: totalSlots,
        durationMs: Date.now() - startedAt,
      }
    : {
        title: data.testTitle,
        status: "ok",
        questionsUploaded: slotsFilled,
        questionsTotal: totalSlots,
        durationMs: Date.now() - startedAt,
      };

  printResult(result);
  if (failure) process.exitCode = 1;
  return result;
}

// ---------------------------------------------------------------------------
// Explanation-mode helpers
// ---------------------------------------------------------------------------

/**
 * Wait for the quiz edit page UI to fully render.
 *
 * For newly created quizzes, the URL changes to /quiz/edit/... but the
 * React SPA may not have rendered the actual edit UI yet (nav tabs, sidebar,
 * select dropdowns, etc.). This function polls for visible UI signals
 * before allowing the pipeline to proceed.
 *
 * @param {import("playwright").Page} page
 * @param {{timeoutMs?: number}} [opts]
 * @throws {Error} if no signal appears within timeoutMs
 */
async function waitForQuizEditPageReady(page, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const start = Date.now();

  const signals = [
    page.locator('text=/Basic Edit/i').first(),
    page.locator('text=/Passages/i').first(),
    page.locator('text=/Questions/i').first(),
    page.locator('text=/PROQYZ EDIT/i').first(),
    page.locator('select').first(),
    page.locator('button:has-text("Add Question")').first(),
    page.locator('a:has-text("Basic Edit")').first(),
    page.locator('a:has-text("Passages")').first(),
    page.locator('a:has-text("Questions")').first(),
    page.locator('.subchild[type="button"]').first(),
  ];

  log.pipeline.info({ timeoutMs }, "waiting for quiz edit page to render");

  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    if (!/quiz\/edit/i.test(url)) {
      await page.waitForTimeout(500);
      continue;
    }

    for (const signal of signals) {
      const count = await signal.count().catch(() => 0);
      if (count > 0) {
        const visible = await signal.isVisible().catch(() => false);
        if (visible) {
          log.pipeline.info(
            { url, ms: Date.now() - start },
            "quiz edit page ready signal detected",
          );
          return;
        }
      }
    }

    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(500);
  }

  // --- Timeout: dump diagnostics and throw ---
  const bodyText = await page.locator("body").innerText().catch(() => "");
  log.pipeline.error(
    { url: page.url(), bodySnippet: bodyText.slice(0, 1000) },
    "quiz edit page did not become ready",
  );
  await captureFailure(page, "quiz-edit-page-not-ready").catch(() => {});
  throw new Error(
    `Quiz edit page did not become ready within ${timeoutMs}ms. URL: ${page.url()}`,
  );
}
async function _clickQuestionsTab(page) {
  log.pipeline.info("attempting to click Questions tab");

  // --- Step 0: Wait for the top quiz nav container ---
  // ProQyz renders the quiz edit page tabs as <a type="button" class="nav-link text-active-primary">
  // inside a <ul class="nav nav-stretch nav-line-tabs ...">.
  // Scoped selector: must have nav-line-tabs to avoid matching sidebar <ul.nav>
  const navContainer = page.locator("ul.nav.nav-stretch.nav-line-tabs").first();
  if (!(await navContainer.isVisible({ timeout: 30000 }).catch(() => false))) {
    throw new Error("_clickQuestionsTab: quiz edit page nav never appeared (30s timeout)");
  }
  log.pipeline.info("quiz edit page nav visible");

  // --- Step 0b: Wait for React to render tab text (up to 5s) ---
  // ProQyz renders tabs with <a type="button"> and text appears lazily.
  // We wait until at least one tab has visible text content.
  let tabTextsReady = false;
  for (let w = 0; w < 10; w++) {
    const anyText = await navContainer.evaluate((ul) => {
      const links = ul.querySelectorAll("a");
      return Array.from(links).some((a) => (a.textContent || "").trim().length > 0);
    }).catch(() => false);
    if (anyText) { tabTextsReady = true; break; }
    await page.waitForTimeout(500);
  }
  log.pipeline.info({ tabTextsReady }, "tab text readiness");

  // --- Step 1: Collect full metadata of every tab for diagnostics ---
  const allTabs = navContainer.locator("a.nav-link, a[type='button']");
  const tabCount = await allTabs.count().catch(() => 0);

  // Use evaluate to get rich metadata from ALL tabs at once (most reliable).
  const tabMeta = await navContainer.evaluate((ul) => {
    const links = ul.querySelectorAll("a");
    return Array.from(links).map((a, i) => ({
      index: i,
      text: (a.textContent || "").trim(),
      innerText: (a.innerText || "").trim(),
      className: a.className || "",
      hasActive: a.classList.contains("active"),
      type: a.getAttribute("type") || "",
      href: a.getAttribute("href") || "",
      ariaLabel: a.getAttribute("aria-label") || "",
      title: a.getAttribute("title") || "",
      role: a.getAttribute("role") || "",
      dataAttrs: Object.keys(a.dataset || {}),
      outerHTML: a.outerHTML.slice(0, 300),
    }));
  }).catch(() => []);
  log.pipeline.info({ tabs: tabMeta }, "top quiz nav tabs (full metadata)");

  // --- Step 2: Build a rich fallback chain ---
  // We try multiple strategies because ProQyz tab text may be empty (React lazy render)
  // or may contain extra whitespace/classes. Position-based fallback is last resort.

  let clicked = false;

  // Strategy A: text-based matching (primary)
  const textCandidates = [
    navContainer.locator("a").filter({ hasText: /^Questions$/ }),
    navContainer.locator("a.nav-link").filter({ hasText: /Questions/ }),
    page.locator('ul.nav.nav-stretch.nav-line-tabs a').filter({ hasText: /Questions/i }),
    page.locator('a.nav-link.text-active-primary').filter({ hasText: /^Questions$/ }),
    page.locator('a[type="button"]').filter({ hasText: /^Questions$/ }),
    page.locator('a:has-text("Questions")'),
  ];

  for (let ci = 0; ci < textCandidates.length; ci++) {
    const loc = textCandidates[ci];
    const first = loc.first();
    if (await first.isVisible({ timeout: 2000 }).catch(() => false)) {
      log.pipeline.info({ strategy: "text", selectorIndex: ci }, "clicking Questions tab");
      await first.click({ force: true });
      clicked = true;
      break;
    }
  }

  // Strategy B: position-based (Questions is the 3rd tab in [Basic Edit, Passages, Questions])
  if (!clicked && tabMeta.length >= 3) {
    const thirdTab = navContainer.locator("a").nth(2);
    if (await thirdTab.isVisible({ timeout: 1000 }).catch(() => false)) {
      log.pipeline.info({ strategy: "position", index: 2 }, "clicking 3rd tab (position fallback)");
      await thirdTab.click({ force: true });
      clicked = true;
    }
  }

  // Strategy C: sidebar subchild fallback
  if (!clicked) {
    const sidebarQuestion = page.locator('div.subchild[type="button"]').filter({ hasText: /Question/i }).first();
    if (await sidebarQuestion.isVisible({ timeout: 1000 }).catch(() => false)) {
      log.pipeline.info({ strategy: "sidebar" }, "clicking sidebar subchild (Question)");
      await sidebarQuestion.click({ force: true });
      clicked = true;
    }
  }

  // Strategy D: href-based navigation (last resort)
  if (!clicked) {
    for (const hrefPattern of ["?tab=question", "?tab=questions"]) {
      try {
        const currentUrl = new URL(page.url());
        currentUrl.search = hrefPattern;
        log.pipeline.info({ strategy: "url", url: currentUrl.toString() }, "navigating via URL param");
        await page.goto(currentUrl.toString(), { waitUntil: "domcontentloaded" });
        clicked = true;
        break;
      } catch { /* continue */ }
    }
  }

  if (!clicked) {
    // --- Exhaustive diagnostics before throwing ---
    const diag = await _collectTabDiagnostics(page);
    log.pipeline.error({ diagnostics: diag }, "Questions tab not found by any strategy");
    await captureFailure(page, "questions-tab-not-found").catch(() => {});
    throw new Error(
      `_clickQuestionsTab: Questions tab not found by any strategy. ` +
      `Diagnostics: ${JSON.stringify(diag).slice(0, 500)}`,
    );
  }

  await page.waitForTimeout(500);

  // --- Step 3: Verify Questions tab is now active ---
  const afterMeta = await navContainer.evaluate((ul) => {
    const links = ul.querySelectorAll("a");
    return Array.from(links).map((a, i) => ({
      index: i,
      text: (a.textContent || "").trim(),
      hasActive: a.classList.contains("active"),
    }));
  }).catch(() => []);
  let questionsActive = afterMeta.some((t) => /questions/i.test(t.text) && t.hasActive);

  // Cross-check: even if the tab's classList says active, verify page content is actually Questions, not Passages.
  // The user reported cases where all tabs had text-active-primary but content was still Passages.
  const pageContentCheck = await _checkPageIsQuestions(page).catch(() => ({ isQuestions: false }));
  log.pipeline.info({ tabs: afterMeta, questionsActive, pageContentCheck }, "after clicking Questions tab");

  if (!questionsActive || !pageContentCheck.isQuestions) {
    // Retry: click sidebar subchild OR position-based
    log.pipeline.warn("Questions tab not active or page content doesn't match; retrying");
    const retryStrategies = [
      () => page.locator('div.subchild[type="button"]').filter({ hasText: /Question/i }).first().click({ force: true }),
      () => navContainer.locator("a").nth(2).click({ force: true }),
    ];
    for (const retry of retryStrategies) {
      try { await retry(); } catch { continue; }
    }
    await page.waitForTimeout(500);

    const retryMeta = await navContainer.evaluate((ul) => {
      const links = ul.querySelectorAll("a");
      return Array.from(links).map((a, i) => ({
        index: i,
        text: (a.textContent || "").trim(),
        hasActive: a.classList.contains("active"),
      }));
    }).catch(() => []);
    questionsActive = retryMeta.some((t) => /questions/i.test(t.text) && t.hasActive);
    const retryCheck = await _checkPageIsQuestions(page).catch(() => ({ isQuestions: false }));
    log.pipeline.info({ tabs: retryMeta, questionsActive, retryCheck }, "after retry");
    if (!questionsActive && retryCheck.isQuestions) questionsActive = true;
  }

  if (!questionsActive) {
    const diag = await _collectTabDiagnostics(page);
    log.pipeline.error({ diagnostics: diag }, "Questions tab not active after click+retry");
    await captureFailure(page, "questions-tab-not-active").catch(() => {});
    throw new Error(
      `_clickQuestionsTab: Questions tab not active after click+retry. ` +
      `Diagnostics: ${JSON.stringify(diag).slice(0, 500)}`,
    );
  }
}

/**
 * Check if the current page content is the Questions tab, not Passages or Basic Edit.
 * Uses multiple content signals: "List of Questions", "Add Question", sidebar active, etc.
 *
 * @param {import("playwright").Page} page
 * @returns {Promise<{isQuestions: boolean, signal: string}>}
 */
async function _checkPageIsQuestions(page) {
  // Check sidebar subchild active state
  const activeSidebar = await page.evaluate(() => {
    const el = document.querySelector('.subchild.active .text-gray-800, .subchild.active p');
    return (el?.textContent || "").trim();
  }).catch(() => "");

  // Check for Questions-specific content
  const hasListOfQuestions = await page.locator('text="List of Questions"').first().isVisible().catch(() => false);
  const hasAddQuestion = await page.locator('button:has-text("Add Question")').first().isVisible().catch(() => false);
  const hasQuestionRows = await page.locator('.card__hover').count().catch(() => 0);

  const isQuestions = /questions/i.test(activeSidebar) || hasListOfQuestions || hasAddQuestion || hasQuestionRows > 0;
  const signal = isQuestions
    ? (activeSidebar || (hasListOfQuestions ? "List of Questions" : hasAddQuestion ? "Add Question" : "question rows"))
    : `activeSidebar="${activeSidebar}"`;

  return { isQuestions, signal };
}

/**
 * Verify that the Question list is visible and the target row exists.
 * Called before each openQuestionForEdit to ensure we're on the right page
 * after saving the previous question.
 *
 * @param {import("playwright").Page} page
 * @param {string} rangeLabel - e.g. "Question 4-7"
 */
async function _verifyQuestionListVisible(page, rangeLabel) {
  const deadline = Date.now() + 10000;
  const rangeKey = extractRangeKey(rangeLabel);

  while (Date.now() < deadline) {
    // Check 1: no modal visible
    const modalVisible = await page.locator('.modal.show, .modal-backdrop.show').first().isVisible({ timeout: 200 }).catch(() => false);
    if (modalVisible) {
      await page.waitForTimeout(300);
      continue;
    }

    // Check 2: "List of Questions" header visible
    const listVisible = await page.locator('text="List of Questions"').first().isVisible({ timeout: 200 }).catch(() => false);

    // Check 3: Add Question button visible (confirms Questions tab is active)
    const addBtnVisible = await page.locator('button:has-text("Add Question")').first().isVisible({ timeout: 200 }).catch(() => false);

    // Check 4: passage select is not "not-selected" (passage is still bound)
    const selectValue = await page.locator('select').first().inputValue().catch(() => "not-selected");

    // Check 5: the target range text exists on the page
    let rangeExists = false;
    if (rangeKey) {
      rangeExists = await page.evaluate((rk) => {
        return document.body.innerText.includes(rk);
      }, rangeKey).catch(() => false);
    }

    if ((listVisible || addBtnVisible) && rangeExists) {
      log.pipeline.info(
        { rangeLabel, listVisible, addBtnVisible, selectValue, rangeExists },
        "question list verified — ready to open next question",
      );
      return;
    }

    await page.waitForTimeout(300);
  }

  // Timeout — dump state for debugging
  log.pipeline.warn(
    { rangeLabel, url: page.url() },
    "_verifyQuestionListVisible: question list not ready within 10s; proceeding anyway",
  );
}

/**
 * Collect exhaustive tab diagnostics before throwing.
 * Dumps ALL navigation structures on the page.
 */
async function _collectTabDiagnostics(page) {
  const url = page.url();
  const activeTopTab = await _getActiveTopTab(page);

  // All <ul> elements with their text content
  const ulElements = await page.evaluate(() => {
    const uls = document.querySelectorAll("ul");
    return Array.from(uls).slice(0, 20).map((ul, i) => ({
      index: i,
      className: ul.className || "",
      role: ul.getAttribute("role") || "",
      childCount: ul.children.length,
      text: (ul.textContent || "").trim().slice(0, 200),
    }));
  }).catch(() => []);

  // All <a> elements with role="tab"
  const roleTabLinks = await page.evaluate(() => {
    const links = document.querySelectorAll('a[role="tab"], [role="tab"]');
    return Array.from(links).map((a, i) => ({
      index: i,
      tag: a.tagName,
      text: (a.textContent || "").trim().slice(0, 50),
      className: (a.className || "").slice(0, 100),
      href: a.getAttribute("href") || "",
      type: a.getAttribute("type") || "",
      title: a.getAttribute("title") || "",
      hasActive: a.classList.contains("active"),
    }));
  }).catch(() => []);

  // All sidebar subchild divs
  const subchildren = await page.evaluate(() => {
    const els = document.querySelectorAll('div.subchild[type="button"]');
    return Array.from(els).map((el, i) => ({
      index: i,
      text: (el.textContent || "").trim().slice(0, 100),
      hasActive: el.classList.contains("active"),
    }));
  }).catch(() => []);

  return { url, activeTopTab, ulElements, roleTabLinks, subchildren };
}

/**
 * Wait for the Questions-tab content to render after the tab click.
 * Throws if the content never appears — never silently continues.
 *
 * Signals: Add Question button, "List of Questions" header, question
 * rows, passage picker <select>, or "Choose Passage" empty state.
 *
 * @param {import("playwright").Page} page
 * @param {number} [timeoutMs]
 * @throws {Error} if no signal appears within timeoutMs
 */
async function _verifyQuestionsPageReady(page, timeoutMs = 15000) {
  const signals = [
    page.locator(Selectors.questionList.addButton).first(),
    page.locator(Selectors.questionList.container).first(),
    page.locator('h3:has-text("List of Questions")').first(),
    page.locator(Selectors.explanation.questionRowLabel).first(),
    page.locator(Selectors.questionList.emptyState).first(),
    page.locator('select').first(),
  ];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const signal of signals) {
      const vis = await signal.isVisible().catch(() => false);
      if (vis) {
        log.pipeline.info("Questions page ready: content signal detected");
        return;
      }
    }
    await page.waitForTimeout(200);
  }

  // --- Dump diagnostic state and throw ---
  const activeTopTab = await _getActiveTopTab(page);
  log.pipeline.error(
    { timeoutMs, activeTopTab, url: page.url() },
    "Questions page never loaded",
  );
  await captureFailure(page, "questions-page-not-ready").catch(() => {});
  throw new Error(
    `_verifyQuestionsPageReady: Questions page did not load within ${timeoutMs}ms. ` +
      `Active top tab: "${activeTopTab}". URL: ${page.url()}`,
  );
}

/**
 * Read the active top quiz nav tab from ul.nav.nav-stretch.
 * Returns the trimmed text of whichever tab has "active" in its class, or "(unknown)".
 *
 * @param {import("playwright").Page} page
 * @returns {Promise<string>}
 */
async function _getActiveTopTab(page) {
  try {
    const tabs = page.locator("ul.nav.nav-stretch a.nav-link");
    const n = await tabs.count();
    for (let i = 0; i < n; i++) {
      const isActive = await tabs.nth(i).evaluate((el) => el.classList.contains("active")).catch(() => false);
      if (isActive) {
        const t = (await tabs.nth(i).textContent().catch(() => "")) || "";
        return t.trim();
      }
    }
  } catch { /* noop */ }
  return "(unknown)";
}

/**
 * Normalize text for case-insensitive, whitespace-collapsed comparison.
 * @param {string} s
 * @returns {string}
 */
function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract passage number from a title string.
 * "Reading Passage 1" → 1, "passage 3" → 3, "random text" → null
 * @param {string} s
 * @returns {number|null}
 */
function extractPassageNumber(s) {
  const m = String(s || "").match(/passage\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * Find the passage <select> on the Questions tab.
 * Looks for a select whose options include "Reading passage N" or "--SELECT PASSAGE--".
 *
 * @param {import("playwright").Page} page
 * @returns {Promise<{select: import("playwright").Locator, options: Array<{text: string, value: string}>, index: number}>}
 * @throws if no passage select found
 */
async function _findPassageSelect(page) {
  const selects = page.locator("select");
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    const sel = selects.nth(i);
    if (!(await sel.isVisible({ timeout: 500 }).catch(() => false))) continue;
    const options = await sel.locator("option").evaluateAll((opts) =>
      opts.map((o) => ({
        text: (o.textContent || "").trim(),
        value: o.value || "",
      })),
    ).catch(() => []);
    const hasPassageOptions = options.some(
      (o) => /reading\s*passage\s*\d+/i.test(o.text) || /not-selected/i.test(o.value),
    );
    if (hasPassageOptions) {
      return { select: sel, options, index: i };
    }
  }
  throw new Error("_findPassageSelect: no passage select found on Questions tab");
}

/**
 * Select a passage from the Questions-tab passage picker.
 * Handles single-passage and multi-passage quizzes with case-insensitive matching.
 *
 * Strategy:
 *   1. Find the correct <select> element
 *   2. Skip if passage is already selected
 *   3. Match by normalized title text (case-insensitive)
 *   4. Fallback: match by passage number
 *   5. Select by option value
 *   6. Verify selection is not "not-selected"
 *
 * @param {import("playwright").Page} page
 * @param {string} passageTitle
 * @param {number} passageIdx - 0-based index
 */
async function _selectPassageInTab(page, passageTitle, passageIdx) {
  const { select, options } = await _findPassageSelect(page);
  log.pipeline.info(
    { passageTitle, options: options.map((o) => o.text) },
    "passage select found",
  );

  // Skip if passage is already selected
  const currentValue = await select.inputValue().catch(() => "not-selected");
  if (currentValue && currentValue !== "not-selected") {
    const currentOpt = options.find((o) => o.value === currentValue);
    if (currentOpt && normalizeText(currentOpt.text) === normalizeText(passageTitle)) {
      log.pipeline.info(
        { passageTitle, currentValue, currentText: currentOpt.text },
        "passage already selected; skipping",
      );
      return;
    }
  }

  // Strategy 1: match by normalized title text
  const normalizedTarget = normalizeText(passageTitle);
  let target = options.find((o) => normalizeText(o.text) === normalizedTarget);

  // Strategy 2: match by passage number
  if (!target) {
    const targetNum = extractPassageNumber(passageTitle) || passageIdx + 1;
    target = options.find((o) => extractPassageNumber(o.text) === targetNum);
    if (target) {
      log.pipeline.info(
        { passageTitle, targetNum, matchedText: target.text },
        "matched passage by number fallback",
      );
    }
  }

  if (!target) {
    log.pipeline.error(
      { passageTitle, passageIdx, options },
      "no matching passage option found",
    );
    throw new Error(
      `_selectPassageInTab: no option matched "${passageTitle}". ` +
      `Available: ${options.map((o) => o.text).join(", ")}`,
    );
  }

  // Select by value
  await select.selectOption(target.value, { force: true });
  await page.waitForTimeout(1000); // let XHR load question rows

  // Verify selection
  const selectedValue = await select.inputValue().catch(() => "");
  if (selectedValue === "not-selected" || !selectedValue) {
    log.pipeline.error(
      { passageTitle, selectedValue, target },
      "passage selection failed — select still shows not-selected",
    );
    throw new Error(
      `_selectPassageInTab: selection of "${passageTitle}" failed. ` +
      `selectOption returned but inputValue is still "${selectedValue}"`,
    );
  }

  log.pipeline.info(
    { passageTitle, selectedText: target.text, selectedValue: target.value },
    "selected passage in Questions tab",
  );
}

/**
 * Debug dump: log what's actually visible on the Questions page.
 * Logs:
 *   - Current page URL
 *   - Active top quiz nav tab
 *   - All visible selects and their options
 *   - Whether Add Question button is visible
 *   - Question rows found
 *   - Visible page content (first 20 lines)
 *
 * @param {import("playwright").Page} page
 * @param {string} passageTitle
 */
async function _dumpQuestionsPageState(page, passageTitle) {
  const url = page.url();
  log.pipeline.info({ url }, "current page URL");

  // Active top quiz nav tab
  const activeTopTab = await _getActiveTopTab(page);
  log.pipeline.info({ activeTopTab }, "active top quiz nav tab");

  // All visible selects + their options
  try {
    const selects = page.locator("select");
    const n = await selects.count();
    for (let i = 0; i < n; i++) {
      const sel = selects.nth(i);
      if (!(await sel.isVisible().catch(() => false))) continue;
      const name = await sel.getAttribute("name").catch(() => "?");
      const opts = await sel.locator("option").allTextContents().catch(() => []);
      log.pipeline.info(
        { selectIndex: i, name, options: opts.map((o) => o.trim()).slice(0, 10) },
        "visible select",
      );
    }
  } catch { /* noop */ }

  // Add Question button
  const addBtnVisible = await page
    .locator(Selectors.questionList.addButton)
    .first()
    .isVisible()
    .catch(() => false);
  log.pipeline.info({ addBtnVisible }, "Add Question button visible");

  // Question rows
  try {
    const rows = page.locator(Selectors.explanation.questionRowLabel);
    const rowCount = await rows.count();
    const rowTexts = [];
    for (let i = 0; i < Math.min(rowCount, 10); i++) {
      const t = (await rows.nth(i).textContent().catch(() => "")) || "";
      rowTexts.push(t.trim().slice(0, 80));
    }
    log.pipeline.info({ rowCount, rowTexts }, "question rows found");
  } catch { /* noop */ }

  // Available page content
  try {
    const bodyText = await page.locator(".content, .card-body, .container-xxl").first().innerText().catch(() => "");
    const lines = bodyText.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
    log.pipeline.info({ visibleContentLines: lines.map((l) => l.trim().slice(0, 100)) }, "visible page content (first 20 lines)");
  } catch { /* noop */ }
}

/**
 * Normalize text for comparison: trim, collapse whitespace, lowercase.
 * @param {string} text
 * @returns {string}
 */
/**
 * Normalize a range label to "Question X-Y" format.
 * Always uses singular "Question", never "Questions".
 *
 * @param {string} range - e.g. "36-37", "Questions 36-37", "Question 1-10"
 * @returns {string} Normalized label, e.g. "Question 36-37"
 */
function normalizeRangeLabel(range) {
  const raw = String(range || "").trim();
  const match = raw.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (!match) return raw;
  return `Question ${match[1]}-${match[2]}`;
}

/**
 * Extract the "X-Y" key from a range label for flexible matching.
 * @param {string} text
 * @returns {string|null} e.g. "1-10", or null if not found
 */
function extractRangeKey(text) {
  const m = String(text).match(/(\d+)\s*[-–]\s*(\d+)/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/**
 * Normalize text for comparison: trim, collapse whitespace, lowercase.
 * @param {string} text
 * @returns {string}
 */
function _normalize(text) {
  return (text || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Wait for question rows to load after selecting a passage.
 *
 * After `_selectPassageInQuestionsTab` fires the native <select> change,
 * ProQyz fetches the question list via XHR and re-renders. The list may
 * take 1–10 seconds to populate. We poll until:
 *   1. A visible row/container whose text matches `rangeLabel` appears, OR
 *   2. Any visible question row/container appears (fallback — the row may
 *      use a different title), OR
 *   3. An empty state appears (e.g. "Add First Question").
 *
 * On timeout: captureFailure + dump + throw.
 *
 * @param {import("playwright").Page} page
 * @param {string} rangeLabel — e.g. "Questions 36-37"
 * @param {number} [timeoutMs] — default 15000
 */
async function _waitForQuestionRows(page, rangeLabel, timeoutMs = 15000) {
  const normalizedLabel = normalizeRangeLabel(rangeLabel);
  const rangeKey = extractRangeKey(normalizedLabel);

  log.pipeline.info(
    { rangeLabel: normalizedLabel, rangeKey, timeoutMs },
    "waiting for question rows after passage selection",
  );

  // Row/container selectors — tried in priority order
  const rowSelectors = [
    '[data-question-id]',
    '[data-testid="question-row"]',
    ".question-row",
    ".question-item",
    ".card",
    "tr",
    '[class*="question"]',
    '[class*="list"]',
    '[class*="row"]',
  ];

  // Empty-state selectors
  const emptyStateSelectors = [
    ':text("Add First Question")',
    ':text("add your first reading question")',
    ':text("Click on")',
    '.empty-state',
    '[data-testid="empty-state"]',
  ];

  const start = Date.now();
  let lastRowCount = 0;
  let lastRowTexts = [];

  while (Date.now() - start < timeoutMs) {
    // Strategy 1: check if any row contains the exact rangeLabel text.
    for (const sel of rowSelectors) {
      const rows = page.locator(sel);
      const n = await rows.count().catch(() => 0);
      if (n === 0) continue;

      for (let i = 0; i < Math.min(n, 30); i++) {
        const row = rows.nth(i);
        const vis = await row.isVisible().catch(() => false);
        if (!vis) continue;
        const rawText = (await row.innerText().catch(() => "")) || "";
        const norm = _normalize(rawText);

        // Match by rangeKey (e.g. "1-10") — most reliable
        if (rangeKey && norm.includes(rangeKey)) {
          log.pipeline.info(
            { rangeLabel: normalizedLabel, rangeKey, selector: sel, ms: Date.now() - start },
            "question row found (range key match)",
          );
          return;
        }

        // Fallback: match by full normalized label
        if (norm.includes(normalizedLabel.toLowerCase())) {
          log.pipeline.info(
            { rangeLabel: normalizedLabel, selector: sel, ms: Date.now() - start },
            "question row found (label match)",
          );
          return;
        }
      }

      // Even if no exact match, record how many rows we see for debug.
      if (n > 0 && n !== lastRowCount) {
        lastRowCount = n;
        // Collect first few row texts for logging.
        lastRowTexts = [];
        for (let i = 0; i < Math.min(n, 10); i++) {
          const t = (await rows.nth(i).innerText().catch(() => "")) || "";
          lastRowTexts.push(t.trim().replace(/\s+/g, " ").slice(0, 100));
        }
      }
    }

    // Strategy 2: check for empty state (no questions for this passage).
    for (const sel of emptyStateSelectors) {
      const es = page.locator(sel).first();
      if (await es.isVisible({ timeout: 200 }).catch(() => false)) {
        log.pipeline.warn(
          { rangeLabel, emptyState: sel, ms: Date.now() - start },
          "empty state detected — no questions exist for this passage",
        );
        // Still throw — we can't edit a question that doesn't exist.
        await _throwQuestionRowTimeout(page, rangeLabel, lastRowTexts, "empty-state");
      }
    }

    await page.waitForTimeout(300);
  }

  // Timeout — dump everything and throw.
  await _throwQuestionRowTimeout(page, rangeLabel, lastRowTexts, "timeout");
}

/**
 * Capture diagnostics and throw when question rows don't appear.
 * @param {import("playwright").Page} page
 * @param {string} rangeLabel
 * @param {string[]} rowTexts
 * @param {string} reason
 */
async function _throwQuestionRowTimeout(page, rangeLabel, rowTexts, reason) {
  try {
    await captureFailure(page, `wait-rows-${rangeLabel.replace(/\s+/g, "-")}`);
  } catch { /* noop */ }

  // Dump all visible texts from row-like containers.
  const allRowTexts = [];
  const rowSelectors = [
    ".card", "tr", ".question-row", ".question-item",
    '[data-question-id]', '[class*="question"]',
  ];
  for (const sel of rowSelectors) {
    const n = await page.locator(sel).count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 20); i++) {
      const t = (await page.locator(sel).nth(i).innerText().catch(() => "")) || "";
      const trimmed = t.trim().replace(/\s+/g, " ").slice(0, 120);
      if (trimmed) allRowTexts.push(trimmed);
    }
  }

  // Active sidebar item.
  let activeSidebar = "";
  try {
    const el = page.locator('.subchild.active .text-gray-800, .subchild.active p').first();
    activeSidebar = ((await el.textContent().catch(() => "")) || "").trim();
  } catch { /* noop */ }

  // Active passage select value.
  let passageSelectValue = "";
  try {
    const sel = page.locator(Selectors.questionList.passageSelect).first();
    if (await sel.isVisible({ timeout: 500 }).catch(() => false)) {
      passageSelectValue = await sel.inputValue().catch(() => "");
    }
  } catch { /* noop */ }

  // Visible page content lines.
  let contentLines = [];
  try {
    const body = await page.locator(".content, .card-body, .container-xxl").first().innerText().catch(() => "");
    contentLines = body.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30).map((l) => l.trim().slice(0, 120));
  } catch { /* noop */ }

  log.pipeline.error(
    {
      rangeLabel,
      reason,
      availableRowTexts: allRowTexts,
      rowTexts,
      activeSidebar,
      passageSelectValue,
      contentLines,
    },
    `_waitForQuestionRows FAILED: "${rangeLabel}" not found`,
  );

  throw new Error(
    `_waitForQuestionRows: question row "${rangeLabel}" not found (${reason}). ` +
      `Available rows: ${JSON.stringify(allRowTexts.slice(0, 10))}`,
  );
}
