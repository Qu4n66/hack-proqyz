/**
 * Explanation upload pipeline.
 *
 * Two modes:
 *   - SINGLE GROUP (legacy, default when `fullPassage !== true`):
 *     Processes exactly one questionGroup per upload.
 *   - FULL PASSAGE (when `fullPassage === true`):
 *     Uploads all question groups in the targeted passage, one modal
 *     at a time, top to bottom.
 *
 * Both modes share: load + validate JSON, launch browser + auth,
 * search/open quiz, navigate to Questions tab.
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

  // Track current step for error reporting
  let _currentStep = "init";
  const step = (name) => {
    _currentStep = name;
    log.pipeline.info({ step: name }, `[step] ${name}`);
  };

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

  // --- Dispatch on fullPassage flag ---
  const totalGroups = data.passages.reduce(
    (acc, p) => acc + p.questionGroups.length,
    0,
  );
  const totalSlots = data.passages.reduce(
    (acc, p) => acc + p.questionGroups.reduce((a, g) => a + g.explanations.length, 0),
    0,
  );

  // 2a. Launch browser + auth. We launch here so both modes share the
  //     same browser/session lifecycle and failure-capture path.
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
    step("open quiz");
    await uploader.searchAndOpenQuiz(data.testTitle, data.existingQuizUrl);

    step("wait quiz edit page");
    await waitForQuizEditPageReady(page, { timeoutMs: 30000 });

    if (data.fullPassage) {
      // ─── FULL PASSAGE MODE ─────────────────────────────────
      step("select passage");
      await _clickQuestionsTab(page);
      log.pipeline.info("Questions tab clicked; waiting for content to load");
      await page.waitForTimeout(800);
      await _verifyQuestionsPageReady(page);

      const { passage, groups } = (() => {
        const p = data.passages.find((p) => p.passage === data.targetPassage);
        return { passage: p, groups: p.questionGroups };
      })();

      const passageTitle = passage.passageTitle || `Reading Passage ${passage.passage}`;
      await _selectPassageInTab(page, passageTitle, passage.passage - 1);

      step("wait for real question groups");
      // Don't verify groups until the XHR after passage-select has
      // actually painted at least one real group card.
      await _waitForRealQuestionGroups(page);

      step("verify question groups");
      const uiGroups = await getVisibleQuestionGroups(page);
      log.pipeline.info(
        { expected: data.expectedGroupCount, found: uiGroups.length, uiTitles: uiGroups.map((g) => g.title) },
        "[fullPassage] groups read from UI",
      );
      verifyQuestionGroupsAgainstJson(uiGroups, groups, data.expectedGroupCount);

      // Process each group top-to-bottom: open → fill → save → close → next.
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];
        const uiGroup = uiGroups[gi];
        const label = `[fullPassage] group ${gi + 1}/${groups.length}: ${group.groupTitle || group.range}`;

        step(`open group ${gi + 1}`);
        await openQuestionGroupBySlot(page, uiGroup);
        log.pipeline.info({ step: "open" }, label);

        step(`fill group ${gi + 1}`);
        const fillResult = await uploader.fillExplanationsSlot(group.explanations);
        slotsFilled += fillResult.slotsFilled;
        log.pipeline.info({ filled: fillResult.slotsFilled }, `${label} explanations filled`);

        step(`save group ${gi + 1}`);
        await uploader.saveQuestionEdit();
        log.pipeline.info({}, `${label} save clicked`);

        step(`close modal ${gi + 1}`);
        await saveAndCloseQuestionGroupModal(page);
        log.pipeline.info({}, `${label} modal closed`);

        step(`wait question list ${gi + 1}`);
        await waitForQuestionList(page);
      }

      log.pipeline.info({ groups: groups.length }, `[fullPassage] completed ${groups.length}/${groups.length} groups`);
    } else {
      // ─── SINGLE GROUP MODE (legacy) ────────────────────────
      if (totalGroups > 1) {
        const msg = `Single-group mode only supports one questionGroup. Found ${totalGroups} groups. ` +
          `Either remove extra groups from the JSON, or set "fullPassage": true.`;
        log.pipeline.error({ totalGroups }, msg);
        throw new Error(msg);
      }

      // Find the single group
      const passage = data.passages[0];
      const group = passage.questionGroups[0];

      step("click Questions tab");
      await _clickQuestionsTab(page);
      log.pipeline.info("Questions tab clicked; waiting for content to load");
      await page.waitForTimeout(800);
      await _verifyQuestionsPageReady(page);

      await _dumpQuestionsPageState(page, passage.passageTitle || `Reading Passage ${passage.passage}`);

      step("select passage");
      const passageTitle = passage.passageTitle || `Reading Passage ${passage.passage}`;
      await _selectPassageInTab(page, passageTitle, passage.passage - 1);

      step("wait question rows");
      const rangeLabel = normalizeRangeLabel(group.range);
      await _waitForQuestionRows(page, rangeLabel);

      await _verifyQuestionListVisible(page, rangeLabel);

      step("open question edit");
      await uploader.openQuestionForEdit(rangeLabel, group.explanations.length);
      log.pipeline.info(`opened ${rangeLabel}`);

      step("fill explanations");
      const fillResult = await uploader.fillExplanationsSlot(group.explanations);
      slotsFilled = fillResult.slotsFilled;
      log.pipeline.info(
        { filled: fillResult.slotsFilled, verified: fillResult.slotsVerified },
        `filled ${fillResult.slotsFilled}/${group.explanations.length} slots`,
      );

      step("save changes");
      await uploader.saveQuestionEdit();
      log.pipeline.info(`saved ${rangeLabel}`);

      step("close modal");
      await uploader.closeQuestionModalAfterSave();
      log.pipeline.info("closed modal");
    }

    log.pipeline.info({ slotsFilled }, "explanation upload complete");
    log.pipeline.info("[step] exit 0");
  } catch (err) {
    failure = err;
    log.pipeline.error(
      {
        step: _currentStep,
        err: err.message,
        stack: (err.stack || "").split("\n").slice(0, 8).join("\n"),
        url: page ? page.url() : "(no page)",
      },
      "explanation upload failed",
    );
    try {
      if (page) {
        const screenshotPath = `failures/explanation-fatal-${Date.now()}.png`;
        const htmlPath = `failures/explanation-fatal-${Date.now()}.html`;
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        await page.evaluate(async (p) => {
          const { writeFileSync } = await import("node:fs");
          return writeFileSync(p, document.documentElement.outerHTML, "utf8");
        }, htmlPath).catch(() => {});
        log.pipeline.error(
          {
            step: _currentStep,
            err: err.message,
            url: page.url(),
            screenshot: screenshotPath,
            html: htmlPath,
          },
          "fatal failure captured",
        );
      }
      await captureFailure(page, `explanation-fatal-${_currentStep}`).catch(() => {});
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

// ---------------------------------------------------------------------------
// Full-passage mode helpers
// ---------------------------------------------------------------------------

/**
 * Read the question group cards currently rendered on the Questions tab.
 *
 * Returns an array of `{ title, slotIndex, editButton }` objects in the
 * order they appear top-to-bottom on the page. Used by fullPassage mode
 * to verify that the UI shows the same groups (count + order) as the
 * JSON before editing anything.
 *
 * Extraction rules (must all hold to accept a card as a real group):
 *   1. The card is one of the structural question-group containers — a
 *      `.d-flex.flex-stack` row OR a `.question-row` / `.question-item`
 *      fallback. We do NOT accept `div.card` or `div.card__hover`
 *      because those wrappers also enclose the "Total (N)" header and
 *      the "Add Question" button — accepting them causes the "Add
 *      Question" container to be picked up as a fake group.
 *   2. The card contains a title whose trimmed text matches the strict
 *      regex `/^Question\s+\d+\s*[-–]\s*\d+$/i`. Plain "Add Question",
 *      "Total (3)", and "List of Questions" all fail this match.
 *   3. The card contains at least one pencil edit button
 *      (`button:has(.fa-pencil)`) — distinguishes a real group row
 *      from a stray container.
 *   4. The card does NOT itself look like an "Add Question" button
 *      container (defensive — even if a parent slipped through).
 *
 * Accepted groups are sorted by numeric start question so that
 * `slotIndex` matches the visual top-to-bottom order even if the DOM
 * traversal order ever differs.
 *
 * @param {import("playwright").Page} page
 * @returns {Promise<Array<{title: string, slotIndex: number, rangeKey: string|null, editButton: import("playwright").Locator}>>}
 */
async function getVisibleQuestionGroups(page) {
  const STRICT_TITLE_RE = /^Question\s+\d+\s*[-–]\s*\d+$/i;
  // Real group-card structural selectors. We deliberately do NOT
  // include `div.card` / `div.card__hover` — those wrappers enclose
  // both the "Total (N)" header and the "Add Question" button, and
  // the old loose regex `/question/i` would pick "Add Question" up
  // as the title of that whole card.
  const candidateSelectors = [
    '.d-flex.flex-stack',
    '.question-row',
    '.question-item',
    '[data-question-id]',
    '[data-testid="question-row"]',
  ];

  const extracted = await page.evaluate((args) => {
    const STRICT = new RegExp(args.titleSrc, "i");
    const candidateSelectors = args.selectors;
    const REJECT_TEXTS = ["Add Question", "Total (", "List of Questions"];

    const out = [];
    const seen = new Set();

    for (const sel of candidateSelectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        const key =
          (node.innerText || node.textContent || "").trim().slice(0, 200);
        if (!key) continue;

        // Reject: explicitly forbidden text anywhere in the row.
        const lowerKey = key.toLowerCase();
        const hitReject = REJECT_TEXTS.find((r) =>
          lowerKey.includes(r.toLowerCase()),
        );
        if (hitReject) {
          out.push({
            selector: sel,
            text: key,
            reason: `contains forbidden text "${hitReject}"`,
            accepted: false,
          });
          continue;
        }

        // Must contain an edit pencil button — distinguishes a real
        // group row from any stray container.
        const pencil = node.querySelector(
          'button:has(i.fa-pencil), button:has(.fa-pencil), i.fa-pencil',
        );
        if (!pencil) {
          out.push({
            selector: sel,
            text: key,
            reason: "no pencil edit button inside",
            accepted: false,
          });
          continue;
        }

        // Find the title text — must strictly match "Question X-Y".
        // We scan every text node inside the row, normalize whitespace,
        // and accept only those whose trimmed text matches the strict
        // pattern. This rejects "Add Question", "Order: 1", and any
        // other line noise.
        const walker = document.createTreeWalker(
          node,
          NodeFilter.SHOW_TEXT,
          null,
        );
        let titleNodeText = null;
        let titleNode = null;
        while (walker.nextNode()) {
          const raw = walker.currentNode.textContent || "";
          const norm = raw.trim().replace(/\s+/g, " ");
          if (STRICT.test(norm)) {
            titleNodeText = norm;
            titleNode = walker.currentNode;
            break;
          }
        }

        if (!titleNodeText) {
          out.push({
            selector: sel,
            text: key,
            reason:
              "no text node matches /^Question\\s+\\d+\\s*[-–]\\s*\\d+$/i",
            accepted: false,
          });
          continue;
        }

        if (seen.has(key)) {
          // Duplicate across selectors — skip silently.
          continue;
        }
        seen.add(key);

        const textEl = titleNode.parentElement;
        const textBox = textEl ? textEl.getBoundingClientRect() : null;
        out.push({
          selector: sel,
          text: key,
          title: titleNodeText,
          accepted: true,
          centerY: textBox ? textBox.y + textBox.height / 2 : null,
        });
      }
    }

    return out;
  }, { titleSrc: STRICT_TITLE_RE.source, selectors: candidateSelectors });

  // Diagnostics: counts + accepted/rejected detail so mis-selectors or
  // stale DOM are visible in the log without a screenshot.
  const accepted = extracted.filter((c) => c.accepted);
  const rejected = extracted.filter((c) => !c.accepted);
  log.pipeline.info(
    {
      candidateCount: extracted.length,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      rejectedSamples: rejected.slice(0, 8).map((r) => ({
        selector: r.selector,
        reason: r.reason,
        textPreview: (r.text || "").slice(0, 80),
      })),
    },
    "getVisibleQuestionGroups: scan summary",
  );
  log.pipeline.info(
    { titles: accepted.map((c) => c.title) },
    "getVisibleQuestionGroups: accepted group titles",
  );

  // Sort accepted groups by numeric start question so slotIndex matches
  // visual top-to-bottom order even if DOM traversal order differs.
  accepted.sort((a, b) => {
    const aMatch = (a.title || "").match(/(\d+)\s*[-–]\s*(\d+)/);
    const bMatch = (b.title || "").match(/(\d+)\s*[-–]\s*(\d+)/);
    const aStart = aMatch ? parseInt(aMatch[1], 10) : Infinity;
    const bStart = bMatch ? parseInt(bMatch[1], 10) : Infinity;
    if (aStart !== bStart) return aStart - bStart;
    const aEnd = aMatch ? parseInt(aMatch[2], 10) : 0;
    const bEnd = bMatch ? parseInt(bMatch[2], 10) : 0;
    return aEnd - bEnd;
  });

  const uiGroups = accepted.map((g, i) => {
    const rangeKey = extractRangeKey(g.title);
    const out = {
      title: g.title,
      slotIndex: i + 1,
      rangeKey,
    };
    if (g.centerY != null) out._centerY = g.centerY;
    return out;
  });

  // Attach edit-button locators using geometric Y-matching against each
  // accepted title's vertical center. We rebuild pencil buttons in the
  // page context and pick the one closest to each title.
  if (uiGroups.length > 0) {
    const titles = uiGroups.map((g) => g.title);
    const enriched = await page.evaluate((ts) => {
      const out = [];
      for (const t of ts) {
        let titleNode = null;
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null,
        );
        while (walker.nextNode()) {
          const norm = (walker.currentNode.textContent || "")
            .trim()
            .replace(/\s+/g, " ");
          if (norm === t) {
            titleNode = walker.currentNode;
            break;
          }
        }
        if (!titleNode) {
          out.push({ title: t, hasMatch: false });
          continue;
        }
        const textEl = titleNode.parentElement;
        const textBox = textEl ? textEl.getBoundingClientRect() : null;
        if (!textBox) {
          out.push({ title: t, hasMatch: false });
          continue;
        }
        const centerY = textBox.y + textBox.height / 2;

        const pencils = document.querySelectorAll(
          'button:has(i.fa-pencil), button:has(.fa-pencil)',
        );
        let closestBtn = null;
        let minDist = Infinity;
        for (const p of pencils) {
          const btn = p.closest('button') || p;
          const rect = btn.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const cy = rect.y + rect.height / 2;
          const d = Math.abs(cy - centerY);
          if (d < minDist) {
            minDist = d;
            closestBtn = btn;
          }
        }
        out.push({
          title: t,
          hasMatch: !!closestBtn,
          centerY,
          minDist,
          closestBtnClass: closestBtn
            ? (closestBtn.className || "").slice(0, 80)
            : null,
        });
      }
      return out;
    }, titles);

    const pencilLocator = page.locator(
      'button:has(i.fa-pencil), button:has(.fa-pencil)',
    );
    for (let i = 0; i < uiGroups.length; i++) {
      const ui = uiGroups[i];
      const m = enriched[i];
      if (m && m.hasMatch) {
        ui.editButton = pencilLocator.nth(i);
        ui._centerY = m.centerY;
        ui._pencilMinDist = m.minDist;
      }
    }
  }

  log.pipeline.info(
    {
      groups: uiGroups.map((g) => ({
        title: g.title,
        slotIndex: g.slotIndex,
        hasEditButton: !!g.editButton,
      })),
    },
    "getVisibleQuestionGroups result",
  );
  return uiGroups;
}

/**
 * Wait until at least one real question-group card is rendered on the
 * Questions tab. Polls the DOM until a title matching
 * `^Question\s+\d+\s*[-–]\s*\d+$` appears, with a timeout. Used after
 * `_selectPassageInTab` so we don't try to enumerate group rows before
 * the XHR re-render has actually painted them.
 *
 * @param {import("playwright").Page} page
 * @param {number} [timeoutMs] - default 15000
 * @returns {Promise<{firstTitle: string, elapsedMs: number}>}
 * @throws if no real group row appears within timeoutMs
 */
async function _waitForRealQuestionGroups(page, timeoutMs = 15000) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const STRICT_RE = /^Question\s+\d+\s*[-–]\s*\d+$/i;

  while (Date.now() < deadline) {
    const found = await page
      .evaluate((reSrc) => {
        const re = new RegExp(reSrc, "i");
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null,
        );
        while (walker.nextNode()) {
          const norm = (walker.currentNode.textContent || "")
            .trim()
            .replace(/\s+/g, " ");
          if (re.test(norm)) return norm;
        }
        return null;
      }, STRICT_RE.source)
      .catch(() => null);

    if (found) {
      const elapsedMs = Date.now() - startedAt;
      log.pipeline.info(
        { firstTitle: found, elapsedMs },
        "_waitForRealQuestionGroups: at least one real group rendered",
      );
      return { firstTitle: found, elapsedMs };
    }
    await page.waitForTimeout(250);
  }

  const elapsedMs = Date.now() - startedAt;
  log.pipeline.error(
    { elapsedMs, timeoutMs },
    "_waitForRealQuestionGroups: no real group rendered within timeout",
  );
  throw new Error(
    `_waitForRealQuestionGroups: no question-group card matching ` +
      `/^Question\\s+\\d+\\s*[-–]\\s*\\d+$/i appeared within ${timeoutMs}ms ` +
      `after passage selection. Check failures/ dump for DOM state.`,
  );
}

/**
 * Verify that the UI group cards match the JSON `questionGroups` (count
 * and order). Throws if either doesn't match — the caller is expected
 * to abort before editing anything.
 *
 * Matching rules (per master.md Part 9):
 *   - visibleUiGroups.length must equal expectedGroupCount
 *   - JSON `questionGroups.length` must equal expectedGroupCount
 *     (already enforced by the schema)
 *   - Each UI group's `title` must match the corresponding JSON
 *     group's `groupTitle` OR `range`, in order.
 *
 * @param {Array<{title: string, slotIndex: number, rangeKey: string|null}>} uiGroups
 * @param {Array<{groupTitle?: string, range: string}>} jsonGroups
 * @param {number} expectedGroupCount
 */
function verifyQuestionGroupsAgainstJson(uiGroups, jsonGroups, expectedGroupCount) {
  const errors = [];

  if (uiGroups.length !== expectedGroupCount) {
    errors.push(
      `UI shows ${uiGroups.length} group card(s) but expectedGroupCount=${expectedGroupCount}`,
    );
  }
  if (jsonGroups.length !== expectedGroupCount) {
    errors.push(
      `JSON questionGroups.length=${jsonGroups.length} but expectedGroupCount=${expectedGroupCount}`,
    );
  }
  if (uiGroups.length !== jsonGroups.length) {
    errors.push(
      `UI count (${uiGroups.length}) and JSON count (${jsonGroups.length}) disagree`,
    );
  }

  // Per-group title match.
  const n = Math.min(uiGroups.length, jsonGroups.length);
  for (let i = 0; i < n; i++) {
    const ui = uiGroups[i];
    const jg = jsonGroups[i];
    const candidates = [jg.groupTitle, jg.range ? `Question ${jg.range}` : null, jg.range].filter(Boolean);
    const uiNorm = _normalize(ui.title);
    const matched = candidates.some((c) => {
      if (!c) return false;
      return _normalize(c) === uiNorm || uiNorm.includes(_normalize(c));
    });
    if (!matched) {
      errors.push(
        `Group ${i + 1}: UI title "${ui.title}" does not match JSON groupTitle/range "${candidates.join('" / "')}"`,
      );
    }
  }

  if (errors.length > 0) {
    const expectedList = jsonGroups
      .map((g, i) => `  ${i + 1}. ${g.groupTitle || `Question ${g.range}`}`)
      .join("\n");
    const actualList = uiGroups
      .map((g, i) => `  ${i + 1}. ${g.title}`)
      .join("\n");
    const msg =
      `[fullPassage] group mismatch\n` +
      `Expected:\n${expectedList}\n\n` +
      `Actual:\n${actualList}\n\n` +
      `Errors:\n  - ${errors.join("\n  - ")}\n\n` +
      `Upload stopped before editing.`;
    log.pipeline.error(
      { expectedGroupCount, uiCount: uiGroups.length, jsonCount: jsonGroups.length, errors },
      "[fullPassage] group mismatch — aborting before editing",
    );
    throw new Error(msg);
  }

  log.pipeline.info(
    { expectedGroupCount, uiCount: uiGroups.length },
    "[fullPassage] UI groups match JSON",
  );
}

/**
 * Open a question group modal by clicking the edit pencil attached to a
 * UI group returned by `getVisibleQuestionGroups`.
 *
 * @param {import("playwright").Page} page
 * @param {{title: string, slotIndex: number, _centerY?: number, editButton?: import("playwright").Locator}} group
 */
async function openQuestionGroupBySlot(page, group) {
  // Click the edit pencil using geometric Y-matching against the title,
  // mirroring the logic in UiQuizUploader.openQuestionForEdit.
  if (group._centerY != null) {
    await page.evaluate((centerY) => {
      const pencils = document.querySelectorAll('button:has(i.fa-pencil), button:has(.fa-pencil)');
      let closest = null;
      let minDist = Infinity;
      for (const p of pencils) {
        const btn = p.closest('button') || p;
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const cy = rect.y + rect.height / 2;
        const d = Math.abs(cy - centerY);
        if (d < minDist) { minDist = d; closest = btn; }
      }
      if (closest) closest.click();
    }, group._centerY).catch(() => {});
  } else if (group.editButton) {
    await group.editButton.click({ force: true }).catch(() => {});
  } else {
    throw new Error(`openQuestionGroupBySlot: no edit locator for group "${group.title}"`);
  }
  await page.waitForTimeout(800);
  // Wait for modal to appear (reuse helper from UiQuizUploader via
  // selecting any visible .modal.show).
  const modalAppeared = await page.locator('.modal.show').first().isVisible({ timeout: 10000 }).catch(() => false);
  if (!modalAppeared) {
    log.pipeline.warn({ title: group.title }, "openQuestionGroupBySlot: modal did not appear within 10s");
  }
}

/**
 * Save the open question group modal and close it, returning to the
 * questions list. Used by fullPassage mode between groups.
 *
 * Close is multi-strategy because ProQyz uses a custom close control:
 *   - `.btn-close-add-question-modal` (the actual X in this app)
 *   - Bootstrap-style `.btn-close`
 *   - `[data-bs-dismiss="modal"]`
 *   - `button[aria-label="Close"]`
 *   - any `.modal-header button` (last-resort structural)
 *   - pressing Escape
 *   - clicking the backdrop (only if no other strategy worked AND
 *     the backdrop is the topmost overlay)
 *
 * After every strategy we re-check `.modal.show` and stop as soon as
 * the modal is gone. If everything fails we throw — the caller MUST
 * not advance to the next group while a modal is still open.
 *
 * @param {import("playwright").Page} page
 */
async function saveAndCloseQuestionGroupModal(page) {
  log.pipeline.info("saveAndCloseQuestionGroupModal: starting");

  // Step 1: ensure we're on the Finish tab so Save Changes is visible.
  // Per master.md Part 10 the modal has multiple tabs.
  const finishTab = page
    .locator('.modal.show .tablist .tabs, .modal.show [role="tab"]')
    .filter({ hasText: /Finish/i })
    .first();
  if (await finishTab.isVisible({ timeout: 1000 }).catch(() => false)) {
    await finishTab.click().catch(() => {});
    await page.waitForTimeout(200);
  }

  // Step 2: click Save Changes.
  const saveBtn = page
    .locator(
      '.modal.show button:has-text("Save Changes"), .modal.show button:has-text("Save"), .modal.show button[type="submit"]',
    )
    .first();
  if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    log.pipeline.info("saveAndCloseQuestionGroupModal: clicking Save Changes");
    await saveBtn.click({ force: true }).catch(() => saveBtn.click().catch(() => {}));
  } else {
    log.pipeline.warn(
      "saveAndCloseQuestionGroupModal: Save Changes button not visible",
    );
  }

  // Step 3: wait for save to commit (per master.md Part 10).
  log.pipeline.info(
    "saveAndCloseQuestionGroupModal: waiting for save to complete",
  );
  await page.waitForTimeout(1200);

  // Step 4: helper — is any "Edit Reading Question" modal still visible?
  // Returns true only when there is a visible modal element whose text
  // contains "Edit Reading Question". A modal that has been removed from
  // the DOM, hidden via display:none, or whose offsetParent is null is
  // treated as not visible.
  const isModalVisible = async () => {
    return await page
      .evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll(
            ".modal, .question__components, [role='dialog']",
          ),
        );
        for (const m of candidates) {
          if (!m.isConnected) continue;
          const style = getComputedStyle(m);
          if (style.display === "none" || style.visibility === "hidden")
            continue;
          if (m.offsetParent === null && style.position !== "fixed") continue;
          const titleEl = m.querySelector(".modal-title");
          const titleText = titleEl
            ? (titleEl.textContent || "").trim()
            : "";
          if (titleText === "Edit Reading Question") return true;
        }
        return false;
      })
      .catch(() => false);
  };

  if (!(await isModalVisible())) {
    log.pipeline.info(
      "saveAndCloseQuestionGroupModal: modal already gone after save",
    );
    await page.waitForTimeout(300);
    return;
  }

  // Step 5: locate the visible Edit Reading Question modal ONCE and
  // scope every subsequent locator inside it. This guarantees we never
  // accidentally click an X that belongs to a different modal (e.g. a
  // confirmation dialog stacked on top of the question editor).
  //
  // We use `Locator.filter()` (not an ElementHandle) because
  // ElementHandle.locator() was removed in modern Playwright — locators
  // can only be chained from `page` or another locator.
  const editModal = page
    .locator(".modal.show, .question__components.modal.show")
    .filter({
      has: page.locator(".modal-title", {
        hasText: /^Edit Reading Question$/,
      }),
    })
    .first();

  const modalCount = await editModal.count();
  if (modalCount === 0) {
    log.pipeline.error(
      "saveAndCloseQuestionGroupModal: could not locate the Edit Reading Question modal element",
    );
    throw new Error(
      "saveAndCloseQuestionGroupModal: Edit Reading Question modal not found in DOM after save",
    );
  }

  // Step 6: DOM introspection — log every plausible close control
  // inside the modal's header so future selector drift is debuggable
  // from the log alone. Captures tagName, class, id, role, aria-label,
  // title, and outerHTML of:
  //   - the modal-header itself
  //   - each direct child of modal-header
  //   - each element inside modal-header matching common X-button patterns
  const headerInspection = await editModal.evaluate((modal) => {
    const summary = (el) => {
      if (!el) return null;
      return {
        tagName: el.tagName,
        class: el.className || "",
        id: el.id || "",
        role: el.getAttribute("role") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        title: el.getAttribute("title") || "",
        outerHTML: el.outerHTML.slice(0, 400),
      };
    };
    const header = modal.querySelector(".modal-header");
    const headerSummary = summary(header);
    const children = header
      ? Array.from(header.children).map(summary)
      : [];
    const candidateClose = Array.from(
      header
        ? header.querySelectorAll("*")
        : modal.querySelectorAll("*"),
    )
      .filter((el) => {
        const cls = (el.className || "").toString();
        return (
          cls.includes("btn-close") ||
          cls.includes("close") ||
          cls.includes("cross") ||
          el.getAttribute("aria-label") === "Close" ||
          el.getAttribute("data-bs-dismiss") === "modal" ||
          (el.textContent || "").trim() === "×" ||
          (el.textContent || "").trim() === "✕"
        );
      })
      .slice(0, 8)
      .map(summary);
    return { header: headerSummary, children, candidateClose };
  });
  log.pipeline.info(
    { inspection: headerInspection },
    "saveAndCloseQuestionGroupModal: modal-header DOM inspection",
  );

  // Step 7: try close strategies in priority order. Every locator is
  // scoped inside the modal element we resolved above — never a global
  // page selector. Each attempt is logged so failures are diagnosable
  // from the log alone.
  const tried = [];

  const tryClick = async (name, locator) => {
    if (!(await isModalVisible())) return true;
    let visible = false;
    try {
      visible = await locator.isVisible({ timeout: 500 });
    } catch {
      visible = false;
    }
    if (!visible) {
      tried.push({ strategy: name, ok: false, reason: "not visible" });
      log.pipeline.info(
        { strategy: name },
        "saveAndCloseQuestionGroupModal: strategy not visible",
      );
      return false;
    }
    log.pipeline.info(
      { strategy: name },
      "saveAndCloseQuestionGroupModal: attempting modal close via X",
    );
    // Log the resolved element's attributes so we never have to guess
    // whether the click hit a wrapper, an icon, or the real control.
    try {
      const attrs = await locator.evaluate((el) => ({
        tagName: el.tagName,
        class: el.className || "",
        id: el.id || "",
        role: el.getAttribute("role") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        title: el.getAttribute("title") || "",
        outerHTML: el.outerHTML.slice(0, 400),
      }));
      log.pipeline.info(
        { strategy: name, target: attrs },
        "saveAndCloseQuestionGroupModal: resolved click target",
      );
    } catch {
      /* attribute introspection is best-effort */
    }
    try {
      await locator.click({ force: true, timeout: 1500 });
    } catch (e) {
      tried.push({
        strategy: name,
        ok: false,
        reason: `click failed: ${(e && e.message) || e}`,
      });
      log.pipeline.warn(
        { strategy: name, err: (e && e.message) || String(e) },
        "saveAndCloseQuestionGroupModal: click failed",
      );
      return false;
    }
    await page.waitForTimeout(400);
    const stillOpen = await isModalVisible();
    tried.push({ strategy: name, ok: !stillOpen });
    return !stillOpen;
  };

  // The PRIMARY strategy is the actual app-specific X: ProQyz uses a
  // custom `<div class="btn-close-add-question-modal">` inside
  // `.modal-header`. Earlier code missed this because it assumed a
  // Bootstrap `.btn-close` (different class) or a `<button>` (it's a
  // <div>).
  await tryClick(
    "btn-close-add-question-modal (primary)",
    editModal.locator(".btn-close-add-question-modal").first(),
  );
  if (!(await isModalVisible())) {
    log.pipeline.info(
      { tried },
      "saveAndCloseQuestionGroupModal: modal closed",
    );
    await page.waitForTimeout(300);
    return;
  }

  await tryClick(
    "modal-header last child (structural fallback)",
    editModal
      .locator(".modal-header")
      .locator(":scope > *")
      .last(),
  );
  if (!(await isModalVisible())) {
    log.pipeline.info(
      { tried },
      "saveAndCloseQuestionGroupModal: modal closed",
    );
    await page.waitForTimeout(300);
    return;
  }

  await tryClick(
    ".btn-close (Bootstrap-style, in-modal)",
    editModal.locator(".btn-close, .btn-close-white").first(),
  );
  if (!(await isModalVisible())) {
    log.pipeline.info(
      { tried },
      "saveAndCloseQuestionGroupModal: modal closed",
    );
    await page.waitForTimeout(300);
    return;
  }

  await tryClick(
    "[data-bs-dismiss='modal'] (in-modal)",
    editModal.locator('[data-bs-dismiss="modal"]').first(),
  );
  if (!(await isModalVisible())) {
    log.pipeline.info(
      { tried },
      "saveAndCloseQuestionGroupModal: modal closed",
    );
    await page.waitForTimeout(300);
    return;
  }

  await tryClick(
    "button[aria-label='Close'] (in-modal)",
    editModal.locator("button[aria-label='Close']").first(),
  );
  if (!(await isModalVisible())) {
    log.pipeline.info(
      { tried },
      "saveAndCloseQuestionGroupModal: modal closed",
    );
    await page.waitForTimeout(300);
    return;
  }

  // Step 6: if still open, try Escape.
  if (await isModalVisible()) {
    log.pipeline.info(
      "saveAndCloseQuestionGroupModal: attempting modal close via Escape",
    );
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
  }

  // Step 7: if still open, click the backdrop (only if it's the topmost
  // overlay and clicking it is safe — i.e. the modal is the dialog
  // child, not the dialog itself).
  if (await isModalVisible()) {
    const backdropClickable = await page
      .evaluate(() => {
        const dialog = Array.from(
          document.querySelectorAll(".modal.show, [role='dialog']"),
        ).find((m) => {
          const txt = (m.textContent || "").trim();
          return txt.includes("Edit Reading Question");
        });
        if (!dialog) return false;
        // Bootstrap-style: clicking the .modal element itself is treated
        // as a backdrop click in some configs. We only attempt this if
        // there's an explicit .modal-backdrop.
        const backdrop = document.querySelector(".modal-backdrop.show");
        return !!backdrop;
      })
      .catch(() => false);

    if (backdropClickable) {
      log.pipeline.info(
        "saveAndCloseQuestionGroupModal: attempting modal close via backdrop click",
      );
      await page
        .locator(".modal-backdrop.show")
        .first()
        .click({ force: true, timeout: 1500, position: { x: 5, y: 5 } })
        .catch(() => {});
      await page.waitForTimeout(400);
    }
  }

  // Step 8: final wait + verification — modal MUST be gone before
  // returning. Throw so the caller aborts instead of advancing with
  // a stale modal blocking the next group.
  const finalDeadline = Date.now() + 5000;
  while (Date.now() < finalDeadline) {
    if (!(await isModalVisible())) break;
    await page.waitForTimeout(200);
  }

  const stillOpen = await isModalVisible();
  if (stillOpen) {
    log.pipeline.error(
      { tried },
      "saveAndCloseQuestionGroupModal: modal STILL OPEN after all strategies — aborting",
    );
    throw new Error(
      `saveAndCloseQuestionGroupModal: modal did not close after trying ` +
        `${tried.length} X-button strategies + Escape + backdrop. ` +
        `Tried: ${tried.map((t) => t.strategy).join(", ")}. ` +
        `Refusing to advance to the next group with the modal open.`,
    );
  }

  await page.waitForTimeout(300);
  log.pipeline.info(
    { tried },
    "saveAndCloseQuestionGroupModal: modal closed",
  );
}

/**
 * Wait for the Questions tab to be ready for the next group: no modal
 * visible, "List of Questions" header rendered, Add Question button
 * present, passage select still bound (not "not-selected").
 *
 * @param {import("playwright").Page} page
 * @param {number} [timeoutMs]
 */
async function waitForQuestionList(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const modalVisible = await page.locator('.modal.show, .modal-backdrop.show').first().isVisible({ timeout: 200 }).catch(() => false);
    if (modalVisible) {
      await page.waitForTimeout(200);
      continue;
    }
    const listVisible = await page.locator('text="List of Questions"').first().isVisible({ timeout: 200 }).catch(() => false);
    const addBtnVisible = await page.locator('button:has-text("Add Question")').first().isVisible({ timeout: 200 }).catch(() => false);
    if (listVisible && addBtnVisible) {
      log.pipeline.info("waitForQuestionList: ready for next group");
      return;
    }
    await page.waitForTimeout(200);
  }
  log.pipeline.warn({ timeoutMs }, "waitForQuestionList: timed out waiting for next group");
}
