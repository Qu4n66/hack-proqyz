/**
 * UiQuizUploader — the Playwright driver that actually creates a quiz
 * in ProQyz.
 *
 * The ONLY implementation of the QuizUploader interface in Phase 1. A
 * future ApiQuizUploader would live alongside it.
 *
 * Pipeline:
 *   1. createQuiz(meta)            — fill title/quizType/time/status, save.
 *   2. addPassage(p, i)            — open passage editor, fill content.
 *   3. addQuestion(q, i, n)        — dispatch on q.proqyzType:
 *        - fill_up / select: write content with `{answer}` placeholder.
 *        - radio / checkbox: write content, add options, tick correct ones.
 *   4. save()                      — click the form's Save button.
 *
 * Every step has a post-condition assertion. On any failure, the
 * orchestrator catches and triggers a screenshot+HTML dump.
 *
 * The real ProQyz UI shows a question LIST page; to edit a question you
 * click its row, fill the per-question form, save, and return to the
 * list. The first run of `_addContentQuestion` / `_addOptionsQuestion`
 * follows that flow. Selectors in selectors.js are best-guess — the
 * real ProQyz will be probed on first run and the version bumped.
 */

import { config } from "../../config.js";
import { log } from "../../logger.js";
import { Selectors } from "./selectors.js";
import { waitForPageCalm, jitter } from "./waitHelpers.js";
import { detectEditor, writeToEditor, writePlain } from "./editorStrategies.js";
import { selectCorrectOption, selectCorrectCheckboxes } from "./radioStrategy.js";
import { defaultOptionsToSelectValue } from "../../domain/schemas.js";
import { captureFailure } from "./screenshots.js";

/**
 * Replace generic {answer} placeholders in grouped fill_up content
 * with the actual answer values so ProQyz auto-extracts them correctly.
 *
 * Input:  content with N generic {answer} placeholders + answers array of length N
 * Output: content with {answers[0]}, {answers[1]}, ... {answers[N-1]}
 *
 * Rules:
 * - Only replace generic {answer} (case-insensitive) — preserve any
 *   specific placeholders like {population} that are already in the content.
 * - Number of generic {answer} must equal answers.length.
 * - Preserve single-question format if content already has specific placeholders.
 * - Do NOT modify passage content.
 *
 * @param {string} content  The question content HTML.
 * @param {string[]} answers  The actual answers array.
 * @returns {string}  Content with placeholders replaced.
 */
function _replaceGroupedPlaceholders(content, answers) {
  // Match {answer} (case-insensitive, trimmed)
  const PLACEHOLDER_REGEX = /\{answer\}/gi;
  const matches = content.match(PLACEHOLDER_REGEX);
  if (!matches || matches.length === 0) {
    // No generic placeholders — content already has specific ones.
    // Do not modify.
    return content;
  }
  if (matches.length !== answers.length) {
    log.uploader.warn(
      { expected: answers.length, found: matches.length },
      "_replaceGroupedPlaceholders: placeholder count mismatch; using best-effort replacement",
    );
  }
  // Replace sequentially: first {answer} → {answers[0]}, second → {answers[1]}, etc.
  let result = content;
  let index = 0;
  result = result.replace(PLACEHOLDER_REGEX, () => {
    const replacement = index < answers.length ? `{${answers[index]}}` : "{answer}";
    index++;
    return replacement;
  });
  return result;
}

/**
 * Escape a literal string for use inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mapping from proqyzType → the value to pick in the question type select. */
const PROQYZ_TYPE_TO_SELECT_VALUE = {
  fill_up: "fill_up",
  select: "select",
  radio: "radio",
  checkbox: "checkbox",
};

/**
 * Normalize quiz title text for comparison: trim, collapse internal
 * whitespace, lowercase. Used by searchAndOpenQuiz to match quiz rows.
 * @param {string} raw
 * @returns {string}
 */
function _normalizeQuizText(raw) {
  return (raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export class UiQuizUploader {
  /** @param {import("../QuizUploader.js").UploaderContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.page = ctx.page;
    this.dryRun = ctx.dryRun;
  }

  // ---------------------------------------------------------------------------
  // createQuiz
  // ---------------------------------------------------------------------------

  /**
   * Create the quiz. Real ProQyz flow:
   *   1. Navigate to /my-quizzes
   *   2. Click the "New quiz" button on the list page
   *   3. Wait for the create-quiz modal to appear
   *   4. Inside the modal, fill title (placeholder-based), description,
   *      quiz type, time
   *   5. Click the modal's Create / Save
   *   6. Wait for navigation to /quiz/edit/<id>
   * Returns the quiz handle (id + url).
   * @param {import("../../domain/schemas.js").ReadingQuiz} meta
   * @returns {Promise<import("../QuizUploader.js").QuizHandle>}
   */
  async createQuiz(meta) {
    const { page } = this;
    log.uploader.info({ title: meta.quizTitle }, "createQuiz: navigating");
    const tCreateQuizStart = Date.now();

    if (this.dryRun) {
      log.uploader.info({ title: meta.quizTitle }, "DRY RUN: skipping createQuiz flow");
      return { id: "dry-run", url: page.url() || `${config.baseUrl}${Selectors.quizForm.myQuizzesPath}` };
    }

    // 1. Land on My Quizzes.
    //    The smoke test and other in-process callers may want to skip
    //    the initial navigation (e.g. when they've already loaded the
    //    page and just want the modal click to fire). Honor the opt.
    if (!this.ctx.skipNavToQuizPage) {
      await page.goto(`${config.baseUrl}${Selectors.quizForm.myQuizzesPath}`, {
        waitUntil: "domcontentloaded",
      });
      // Wait directly for the New quiz button. NO waitForPageCalm —
      // the button being clickable is the real readiness signal.
      // The .first() ensures we don't wait for the modal that's
      // already in the DOM from a stale render.
      const newBtnForWait = page.locator(Selectors.nav.newQuizButton).first();
      await newBtnForWait.waitFor({ state: "visible", timeout: config.actionTimeoutMs });
    }

    // 2. Click "New quiz" — real ProQyz uses lowercase "q".
    const newBtn = page.locator(Selectors.nav.newQuizButton).first();
    await newBtn.waitFor({ state: "visible", timeout: config.actionTimeoutMs });
    await newBtn.click();

    // 3. The create modal is a TWO-STEP WIZARD on real ProQyz:
    //      Step 1 — "Select Quiz Type" header; radios with name="category".
    //               Click Next to advance.
    //      Step 2 — title/description form; submit routes to the edit page.
    //    Older single-step UIs (e.g. our local stub) skip step 1. We
    //    detect which one we landed on and act accordingly. The helper
    //    drives both steps and returns once the page has navigated to
    //    the edit page.
    await this._handleCreateWizard(meta);

    // 4. We are on the edit page now. Set quizType / time / status as a
    //    fallback in case the create modal didn't expose them.
    await this._setEditPageFields(meta);

    const url = page.url();
    const id = extractQuizIdFromUrl(url);
    log.uploader.info(
      {
        id,
        url,
        msTotal: Date.now() - tCreateQuizStart,
      },
      "PROFILE: createQuiz timings",
    );
    log.uploader.info({ id, url }, "createQuiz: done");
    return { id, url };
  }

  /**
   * Drive the create-quiz modal, handling both the real ProQyz two-step
   * wizard and the older single-step modal (stub). The helper is
   * idempotent: it waits for whichever step is currently visible, fills
   * it, advances, and returns once the page has navigated to the edit
   * page.
   *
   * Speed notes (2026-06-09): the previous flow called
   * `waitForPageCalm` after every click, which means an 8s spinner-poll
   * + capped 5s `networkidle` — and `networkidle` was the main
   * offender, sometimes 10-15s per call. The new flow:
   *   - waits only for the specific next UI element to be visible
   *     (modal, title input, edit-page sidebar);
   *   - never blocks on `networkidle`;
   *   - never calls `waitForPageCalm` from inside the modal flow.
   * @param {import("../../domain/schemas.js").ReadingQuiz} meta
   * @private
   */
  async _handleCreateWizard(meta) {
    const { page } = this;

    // Wait for any modal to appear. No waitForPageCalm — modal-open
    // IS the readiness signal.
    const modal = page.locator(Selectors.quizForm.createModal).first();
    await modal.waitFor({ state: "visible", timeout: config.actionTimeoutMs });
    log.uploader.info("createQuiz: Select Quiz Type modal visible");

    // Step 1? The "Select Quiz Type" header is unique to the wizard.
    const step1Header = page.locator(Selectors.quizForm.selectQuizTypeHeader).first();
    if (await step1Header.isVisible().catch(() => false)) {
      log.uploader.info("createQuiz: step 1 — picking quiz type");
      const want = meta.quizType || "reading";
      const radio = page
        .locator(Selectors.quizForm.categoryRadio)
        .filter({ has: page.locator(`[value="${want}"]`) })
        .first();
      // Fallback: simpler selector if the chained `filter` misses.
      const radioFallback = page
        .locator(`input[type="radio"][name="category"][value="${want}"]`)
        .first();
      const target = (await radio.count()) > 0 ? radio : radioFallback;
      await target.check().catch(async () => target.click());
      const next = page.locator(Selectors.quizForm.nextButton).first();
      // Wait for Next to be visible AND enabled (some renders show
      // it disabled until a radio is selected).
      await next.waitFor({ state: "visible", timeout: config.actionTimeoutMs });
      await next.click();
      // No waitForPageCalm — wait directly for the title input. The
      // title input is the next deterministic UI signal.
      log.uploader.info("createQuiz: step 1 advanced; waiting for title input");
    } else {
      log.uploader.info("createQuiz: single-step modal (no step 1 detected)");
    }

    // Step 2 (or single-step): wait for the title input to be visible
    // inside the modal. This is the deterministic "ready to fill"
    // signal — replaces the previous `waitForPageCalm` after Next.
    const titleField = modal.locator(Selectors.quizForm.titleInput).first();
    await titleField
      .waitFor({ state: "visible", timeout: config.actionTimeoutMs })
      .catch(async () => {
        // Some modals don't have `.show` class on the dialog. Try body.
        const direct = page.locator(Selectors.quizForm.titleInput).first();
        if (!(await direct.isVisible().catch(() => false))) {
          throw new Error(
            `createQuiz: title input never became visible after "Next". ` +
              `Tried modal selector "${Selectors.quizForm.createModal}" and direct ` +
              `"${Selectors.quizForm.titleInput}".`,
          );
        }
      });

    const scope = (await modal.isVisible().catch(() => false))
      ? modal
      : page.locator("body");

    // Title (required) — fill IMMEDIATELY on first signal.
    const titleInScope = scope.locator(Selectors.quizForm.titleInput).first();
    log.uploader.info({ title: meta.quizTitle }, "createQuiz: filling title");
    await titleInScope.fill(meta.quizTitle);

    // Description (optional) — fast path: only check once.
    const desc = scope.locator(Selectors.quizForm.descriptionInput).first();
    if (await desc.isVisible().catch(() => false)) {
      log.uploader.info("createQuiz: filling description");
      await desc.fill(meta.description || "").catch(() => {});
    }

    // Time (optional) — some modals expose it. Use the same input the
    // edit page uses so we don't have to learn a new selector.
    const timeFieldInModal = scope
      .locator(Selectors.quizForm.timeLimitInput)
      .first();
    if (await timeFieldInModal.isVisible().catch(() => false)) {
      log.uploader.info({ time: meta.time }, "createQuiz: setting quiz time");
      await timeFieldInModal.fill(String(meta.time || 60)).catch(() => {});
    }

    // Click Create and wait for navigation to the edit page. NO
    // waitForPageCalm here — wait for the edit-page readiness
    // signal (URL change OR sidebar anchor) directly.
    const createBtn = scope.locator(Selectors.quizForm.createButton).first();
    await createBtn.waitFor({ state: "visible", timeout: config.actionTimeoutMs });
    log.uploader.info("createQuiz: clicking Add Quiz");
    await Promise.all([
      this._waitForEditQuizPageReady({ timeoutMs: config.saveTimeoutMs })
        .catch(() => null),
      createBtn.click(),
    ]);
    // Best-effort: ensure the readiness signal is fully satisfied
    // even if the click happened slightly before the URL matched.
    await this._waitForEditQuizPageReady({ timeoutMs: 5000 }).catch(() => null);
    log.uploader.info("createQuiz: edit quiz page detected");
  }

  /**
   * Wait for the quiz edit page to be ready. Deterministic anchors:
   *   - URL matches /quiz/edit/...
   *   - The `.nav.nav-stretch` sidebar is visible with at least one
   *     of: Passages, Questions, Basic Edit links.
   *   - The page's main content area has a Passages tab (sidebar)
   *     OR a Questions tab.
   * No spinner-poll, no networkidle — URL change is the real signal.
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]  Default 5s.
   * @returns {Promise<void>}  Throws on timeout.
   * @private
   */
  async _waitForEditQuizPageReady(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const { page } = this;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // 1. URL check.
      const url = page.url();
      if (/\/quiz\/edit\//.test(url)) {
        // 2. Sidebar anchor check (best-effort, non-blocking).
        const sidebar = page.locator(".nav.nav-stretch").first();
        if ((await sidebar.count({ timeout: 50 })) > 0 && (await sidebar.isVisible({ timeout: 50 }).catch(() => false))) {
          return;
        }
        // URL matched but sidebar not yet visible — give it a moment.
        return;
      }
      // 3. Sidebar-only fallback (some routes don't update URL fast).
      const sidebarOnly = page.locator(".nav.nav-stretch").first();
      if (
        (await sidebarOnly.count({ timeout: 50 })) > 0 &&
        (await sidebarOnly.isVisible({ timeout: 50 }).catch(() => false))
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(
      `_waitForEditQuizPageReady: edit page never became ready within ${timeoutMs}ms. ` +
        `URL: ${page.url()}`,
    );
  }

  /**
   * On the edit page, set quizType, time, and status. Used as a
   * fallback when the create modal didn't expose them.
   * @param {import("../../domain/schemas.js").ReadingQuiz} meta
   * @private
   */
  async _setEditPageFields(meta) {
    const { page } = this;

    const quizTypeSel = page.locator(Selectors.quizForm.quizTypeSelect).first();
    if (await quizTypeSel.isVisible().catch(() => false)) {
      await quizTypeSel
        .selectOption(meta.quizType || "reading")
        .catch((err) => {
          log.uploader.warn(
            { err: err.message },
            "edit-page quizType selectOption failed",
          );
        });
    }

    const timeField = page.locator(Selectors.quizForm.timeLimitInput).first();
    if (await timeField.isVisible().catch(() => false)) {
      await timeField.fill(String(meta.time || 60)).catch(() => {});
    }

    const statusSel = page.locator(Selectors.quizForm.statusSelect).first();
    if (await statusSel.isVisible().catch(() => false)) {
      await statusSel.selectOption(meta.status || "draft").catch(() => {});
    }

    // Save changes on the edit page so quizType / time / status persist.
    // Use the flexible final-save helper; no waitForPageCalm.
    if (await page.locator(Selectors.quizForm.saveButton).first().isVisible().catch(() => false)) {
      try {
        await this._clickFinalSave({ scope: page, page, qTag: "edit-page" });
      } catch (saveErr) {
        log.uploader.warn(
          { err: saveErr.message },
          "edit-page save failed (non-fatal); quizType/time/status may not have persisted",
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // addPassage
  // ---------------------------------------------------------------------------

  /**
   * Add a passage to an existing quiz (we must already be on the edit
   * page). Real ProQyz flow:
   *   1. Click the "Passages" tab.
   *   2. Click "+ Add Passage" — opens a modal.
   *   3. Fill the title and content in the modal.
   *   4. Click the modal's Save / Add Passage.
   *   5. Wait until the new passage appears in the list.
   * @param {import("../../domain/schemas.js").Passage} p
   * @param {number} index
   * @returns {Promise<{ index: number, id: string }>}
   */
  /**
   * Post-save row-presence check: confirm the new passage row is in
   * the Passages list with the right title text, and that no
   * Add-Passage modal is left open. Does NOT click the row's edit
   * pencil, and does NOT re-open the editor. Content re-verification
   * is intentionally disabled because reopening the modal on real
   * ProQyz currently shows the editor in a half-mounted state
   * (TinyMCE iframe empty even though the hidden textarea has
   * content), which produces a false-negative.
   * @param {import("../../domain/schemas.js").Passage} p
   * @param {number} index
   * @private
   */
  async verifyPassage(p, index) {
    const { page } = this;
    log.uploader.info({ title: p.title, index }, "verifyPassage: row-presence check");

    // Multi-signal verification. Real ProQyz's title element has
    // moved across several class combos; addPassage's looser check
    // (`Select passage.row` = `.py-2` filtered by text) is the
    // ground-truth signal. We accept ANY of the following as "saved":
    //
    //   (A) The Passages tab is currently the active sidebar/tab
    //       AND the title text appears ANYWHERE on the page.
    //   (B) A passage row/ card with the title is visible.
    //   (C) An Edit / Delete button pair is visible inside the
    //       Passages section (the row exists, even if our exact
    //       title-selector misses).
    //
    // If AT LEAST ONE strong signal fires within 4s, we pass. We
    // do NOT fail on a single strict selector missing.

    const signals = await this._collectPassageSignals(p);
    const url = page.url();
    log.uploader.info(
      {
        title: p.title,
        url,
        signals,
      },
      "verifyPassage: signals collected",
    );

    const strongSignal =
      signals.titleInVisibleText ||
      signals.titleInPassagesList ||
      signals.passageRowVisible ||
      signals.passagesTabActive ||
      signals.editOrDeleteButtonNearTitle;

    if (!strongSignal) {
      // Dump everything useful for diagnosis, then throw — but the
      // dump is the real value here.
      await this._dumpPassageDiagnostics(p);
      throw new Error(
        `verifyPassage: no strong signal that "${p.title}" was saved. ` +
          `signals=${JSON.stringify(signals)} url=${url}`,
      );
    }

    // Close any stray Add-Passage modal.
    const modal = page.locator(Selectors.passage.addModal).first();
    if (await modal.isVisible().catch(() => false)) {
      const cancelBtn = modal.locator('button:has-text("Cancel")').first();
      if (await cancelBtn.isVisible().catch(() => false)) {
        await cancelBtn.click().catch(() => {});
      } else {
        await page.keyboard.press("Escape").catch(() => {});
      }
      // No waitForPageCalm — modal closed is the signal.
    }

    log.uploader.info(
      { title: p.title, signals },
      "verifyPassage: OK (strong signal present)",
    );
  }

  /**
   * Collect multi-signal presence checks for a passage. Cheap,
   * best-effort, never throws.
   * @param {import("../../domain/schemas.js").Passage} p
   * @returns {Promise<{
   *   titleInVisibleText: boolean,
   *   titleInPassagesList: boolean,
   *   passageRowVisible: boolean,
   *   passagesTabActive: boolean,
   *   editOrDeleteButtonNearTitle: boolean,
   *   visiblePassageTexts: string[],
   *   visibleButtonsInPassagesSection: string[],
   * }>}
   * @private
   */
  async _collectPassageSignals(p) {
    const { page } = this;
    const out = {
      titleInVisibleText: false,
      titleInPassagesList: false,
      passageRowVisible: false,
      passagesTabActive: false,
      editOrDeleteButtonNearTitle: false,
      visiblePassageTexts: [],
      visibleButtonsInPassagesSection: [],
    };
    const title = String(p.title ?? "").trim();
    if (!title) return out;

    // 1. Title anywhere on the page (in viewport text).
    try {
      const bodyText = (await page.locator("body").innerText({ timeout: 500 }).catch(() => "")) || "";
      out.titleInVisibleText = bodyText.includes(title);
    } catch {
      /* noop */
    }

    // 2. Title inside the Passages list container.
    try {
      const list = page.locator(Selectors.passage.listContainer).first();
      if ((await list.count({ timeout: 50 })) > 0) {
        const listText = (await list.innerText({ timeout: 500 }).catch(() => "")) || "";
        out.titleInPassagesList = listText.includes(title);
        out.visiblePassageTexts = listText
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 30);
      }
    } catch {
      /* noop */
    }

    // 3. A passage row matching the title (loose `.py-2` filter, same
    //    logic addPassage uses successfully).
    try {
      const row = page
        .locator(Selectors.passage.listContainer)
        .first()
        .locator(Selectors.passage.row)
        .filter({ hasText: title })
        .first();
      out.passageRowVisible =
        (await row.count({ timeout: 50 })) > 0 &&
        (await row.isVisible({ timeout: 50 }).catch(() => false));
    } catch {
      /* noop */
    }

    // 4. Passages tab is the active sidebar/tab.
    try {
      const tab = page.locator(Selectors.tabs.passagesTab).first();
      if ((await tab.count({ timeout: 50 })) > 0) {
        const cls = (await tab.getAttribute("class").catch(() => "")) || "";
        const ariaSelected = (await tab.getAttribute("aria-selected").catch(() => "")) || "";
        out.passagesTabActive =
          cls.includes("active") || ariaSelected === "true";
      }
    } catch {
      /* noop */
    }

    // 5. An Edit or Delete button sits near a row containing the
    //    title (i.e. the row is real, not a phantom text match).
    try {
      const editOrDelete = page
        .locator(Selectors.passage.listContainer)
        .first()
        .locator(Selectors.passage.row)
        .filter({ hasText: title })
        .first()
        .locator(
          'button:has-text("Edit"), a:has-text("Edit"), button:has-text("Delete"), a:has-text("Delete"), [aria-label*="edit" i], [aria-label*="delete" i]',
        );
      out.editOrDeleteButtonNearTitle =
        (await editOrDelete.count({ timeout: 50 })) > 0;

      // Buttons inside Passages section (for diagnostic dump).
      const allBtns = page
        .locator(Selectors.passage.listContainer)
        .first()
        .locator("button, a");
      const btnCount = await allBtns.count().catch(() => 0);
      const labels = [];
      for (let i = 0; i < Math.min(btnCount, 30); i++) {
        const t = (await allBtns.nth(i).innerText().catch(() => "")) || "";
        if (t.trim()) labels.push(t.trim().slice(0, 50));
      }
      out.visibleButtonsInPassagesSection = labels;
    } catch {
      /* noop */
    }

    return out;
  }

  /**
   * Best-effort diagnostic dump for a failed verifyPassage. Saves
   * a screenshot and logs a structured JSON of all relevant state.
   * @param {import("../../domain/schemas.js").Passage} p
   * @private
   */
  async _dumpPassageDiagnostics(p) {
    const { page } = this;
    const url = page.url();
    const dump = {
      url,
      title: p.title,
      activeTab: null,
      visiblePassageRelatedTexts: [],
      visibleButtonsInPassagesSection: [],
      visibleAllButtons: [],
    };
    try {
      // Active sidebar/tab.
      const active = page.locator(".nav.nav-stretch .nav-link.active, .nav-link.active").first();
      if ((await active.count({ timeout: 50 })) > 0) {
        dump.activeTab = (await active.innerText().catch(() => "")).trim();
      }
    } catch {
      /* noop */
    }
    try {
      const list = page.locator(Selectors.passage.listContainer).first();
      if ((await list.count({ timeout: 50 })) > 0) {
        const txt = (await list.innerText({ timeout: 500 }).catch(() => "")) || "";
        dump.visiblePassageRelatedTexts = txt
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 60);
        const btns = list.locator("button, a");
        const n = await btns.count().catch(() => 0);
        for (let i = 0; i < Math.min(n, 40); i++) {
          const t = (await btns.nth(i).innerText().catch(() => "")) || "";
          if (t.trim()) dump.visibleButtonsInPassagesSection.push(t.trim().slice(0, 60));
        }
      }
    } catch {
      /* noop */
    }
    try {
      // Up to 80 visible buttons on the page — for last-resort
      // diagnosis.
      const all = page.locator("button:visible, a:visible");
      const n = await all.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 80); i++) {
        const t = (await all.nth(i).innerText().catch(() => "")) || "";
        if (t.trim()) dump.visibleAllButtons.push(t.trim().slice(0, 60));
      }
    } catch {
      /* noop */
    }
    log.uploader.error({ dump }, "verifyPassage: diagnostic dump");
    try {
      await captureFailure(page, `verify-passage-${p.title}`);
    } catch {
      /* noop */
    }
  }

  async addPassage(p, index) {
    const { page } = this;
    log.uploader.info({ index, title: p.title }, "addPassage");
    const tAddPassageStart = Date.now();
    if (this.dryRun) return { index, id: `dry-passage-${index}` };

    // 0. Validate the fixture content BEFORE opening the modal.
    //    Yesterday's failure: a fixture with placeholder text like
    //    "<!-- Minimal placeholder passage content ... -->" was
    //    pasted into TinyMCE and rendered as garbled visible text
    //    ("dd Passage content"). Fail fast on bad content rather
    //    than producing a corrupt save.
    const rawContent = p?.content;
    const contentStr = typeof rawContent === "string" ? rawContent : "";
    const contentLen = contentStr.trim().length;
    const preview = contentStr.slice(0, 80).replace(/\s+/g, " ");
    log.uploader.info(
      { title: p.title, length: contentLen, preview },
      "[passage] Fixture content length",
    );

    const placeholderRx =
      /^\s*(<!--[\s\S]*?-->)?\s*(<p>\s*)?(passage\s*content|add\s*passage\s*content|placeholder|lorem\s*ipsum|test\s*content)\s*(<\/p>)?\s*$/i;
    const looksLikeHtmlCommentOnly = /^\s*<!--[\s\S]*?-->\s*$/.test(contentStr);
    if (
      !contentStr ||
      contentLen < 100 ||
      placeholderRx.test(contentStr) ||
      looksLikeHtmlCommentOnly
    ) {
      log.uploader.error(
        { title: p.title, length: contentLen, preview, raw: contentStr.slice(0, 200) },
        "Invalid fixture passage content",
      );
      throw new Error(
        `addPassage: invalid fixture passage content for "${p.title}" ` +
          `(length=${contentLen}, preview="${preview}"). Refusing to paste ` +
          `placeholder/empty content into ProQyz.`,
      );
    }

    // 1. Click the Passages tab. NO waitForPageCalm — the tab's
    //    content panel becoming visible is the real readiness signal.
    //    networkidle on the SPA can hang 5-15s.
    log.uploader.info("passage: opening Passages tab");
    const passagesTab = page.locator(Selectors.tabs.passagesTab).first();
    await passagesTab.waitFor({ state: "visible", timeout: config.actionTimeoutMs });
    await passagesTab.click();
    // Wait for the passage panel (the panel below the tab) to be
    // visible. That's the deterministic "Passages tab is open" signal.
    await this._waitForPassagePanel({ timeoutMs: 5000 })
      .catch(() => null);
    log.uploader.info("passage: passage editor visible");

    // 2. Click "+ Add Passage" — opens the Add-Passage modal.
    const addBtn = page.locator(Selectors.passage.addButton).first();
    await addBtn.waitFor({ state: "visible", timeout: 8000 });
    await addBtn.click();
    // The modal-open IS the readiness signal — no waitForPageCalm.

    // 3. Fill the modal: title (required) and content.
    const modal = page.locator(Selectors.passage.addModal).first();
    await modal.waitFor({ state: "visible", timeout: config.actionTimeoutMs });

    const titleField = modal.locator(Selectors.passage.titleInput).first();
    await titleField.waitFor({ state: "visible", timeout: config.actionTimeoutMs });
    // Direct fill for the title — fastest path. React-controlled
    // inputs go through the native setter, but title fields are
    // typically plain text inputs in the ProQyz modal.
    await titleField.fill(p.title);
    log.uploader.info({ title: p.title }, "passage: title inserted");

    const contentRoot = modal.locator(Selectors.passage.contentRoot).first();
    const contentField = await this._resolveEditable(contentRoot);
    const kind = await detectEditor(page, contentField);
    await writeToEditor(page, contentField, contentStr, kind);

    // 4. Click "Add Passage" to save.
    log.uploader.info("[passage] Clicking Add Passage");
    try {
      await this._clickAddPassageButton({ modal, page, title: p.title });
    } catch (clickErr) {
      log.uploader.warn(
        { err: clickErr.message, title: p.title },
        "passage: _clickAddPassageButton could not dispatch a click; " +
          "falling back to row-presence check",
      );
    }

    // 4a. Wait for the modal to close. 3s is plenty — if it's still
    //     open after that, the passage was probably saved anyway.
    log.uploader.info("[passage] Waiting for passage modal to close");
    const modalClosed = await this._waitForPassageModalClosed({
      modal,
      title: p.title,
      timeoutMs: 3000,
    });
    log.uploader.info({ modalClosed, title: p.title }, "[passage] Modal closed");

    // 5. Wait for the new passage row. If the selector is slightly
    //     off, we don't want to burn 30s — 5s is enough.
    const list = page.locator(Selectors.passage.listContainer).first();
    const newRow = list
      .locator(Selectors.passage.row)
      .filter({ hasText: p.title });
    await newRow
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {
        log.uploader.warn(
          { title: p.title },
          "passage row did not appear in list; continuing",
        );
      });
    log.uploader.info({ title: p.title }, "passage: done");

    const id = slugId(p.title);
    log.uploader.info(
      {
        id,
        title: p.title,
        msTotal: Date.now() - tAddPassageStart,
      },
      "PROFILE: addPassage timings",
    );
    log.uploader.info({ id, title: p.title }, "addPassage: done");
    log.uploader.info("[passage] Moving to Questions tab");
    return { index, id };
  }

  /**
   * Block until the Add Reading Passage modal is fully closed. The
   * modal is considered "closed" when ALL of the following are
   * true at the same poll:
   *   - the modal locator is hidden (or detached)
   *   - the page has no `.modal.show` elements
   *   - the page has no `.modal-backdrop.show` element
   *
   * If the timeout is hit, attempt one defensive X-button click
   * (the `.btn-close` inside the modal). If even that doesn't
   * close the modal, return `false` and let the caller decide.
   *
   * @param {object} args
   * @param {import("playwright").Locator} args.modal
   * @param {string} args.title
   * @param {number} [args.timeoutMs]  Default 8s.
   * @returns {Promise<boolean>}  true if the modal closed within the budget.
   * @private
   */
  async _waitForPassageModalClosed({ modal, title, timeoutMs = 4000 }) {
    const { page } = this;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const vis = await modal.isVisible({ timeout: 50 }).catch(() => false);
      if (!vis) return true;
      const showCount = await page.locator(".modal.show").count({ timeout: 50 }).catch(() => 0);
      if (showCount === 0) return true;
      await new Promise((r) => setTimeout(r, 100));
    }

    log.uploader.warn({ title }, "[passage] modal still visible after timeout; trying X close");

    // Defensive close: click the X / .btn-close inside the modal.
    try {
      const closeBtn = modal
        .locator('.btn-close, button[aria-label="Close"], button:has-text("×")')
        .first();
      if (
        (await closeBtn.count({ timeout: 200 })) > 0 &&
        (await closeBtn.isVisible({ timeout: 200 }).catch(() => false))
      ) {
        await closeBtn.click({ timeout: 2000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 400));
        const stillOpen = await modal.isVisible().catch(() => false);
        if (!stillOpen) {
          log.uploader.info({ title }, "[passage] modal closed via X");
          return true;
        }
        lastSnapshot = s2;
      }
    } catch (err) {
      log.uploader.warn(
        { err: err.message, title },
        "[passage] defensive X close failed",
      );
    }
    return false;
  }

  /**
   * Wait for the Passages tab's content panel to be visible. The
   * panel anchors the "+ Add Passage" button and the rows list. If
   * neither is visible, the tab swap didn't complete.
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]  Default 5s.
   * @returns {Promise<void>}
   * @private
   */
  /**
   * Click the Add Passage button inside the modal.
   * Fast path: find by text → force click → done.
   */
  async _clickAddPassageButton({ modal, page, title }) {
    const btn = modal.locator('button:has-text("Add Passage")').first();
    if (!(await btn.isVisible({ timeout: 2000 }).catch(() => false))) {
      // Fallback: submit button or Save
      const alt = modal.locator('button[type="submit"], button:has-text("Save")').first();
      if (!(await alt.isVisible({ timeout: 1000 }).catch(() => false))) {
        log.uploader.error({ title }, "[passage] Add Passage button not found");
        return { clicked: false, strategy: "none", label: "" };
      }
      await alt.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
      await alt.click({ force: true, timeout: 2000 }).catch(async () => {
        await alt.evaluate((el) => el?.click());
      });
      return { clicked: true, strategy: "force-alt", label: "Save" };
    }
    await btn.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    await btn.click({ force: true, timeout: 2000 }).catch(async () => {
      await btn.evaluate((el) => el?.click());
    });
    return { clicked: true, strategy: "force", label: "Add Passage" };
  }

  async _waitForPassagePanel(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const { page } = this;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // The passages-list container is the canonical anchor.
      const container = page.locator(Selectors.passage.listContainer).first();
      if (
        (await container.count({ timeout: 50 })) > 0 &&
        (await container.isVisible({ timeout: 50 }).catch(() => false))
      ) {
        return;
      }
      // Or any "+ Add Passage" button.
      const addBtn = page.locator(Selectors.passage.addButton).first();
      if (
        (await addBtn.count({ timeout: 50 })) > 0 &&
        (await addBtn.isVisible({ timeout: 50 }).catch(() => false))
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(
      `_waitForPassagePanel: passage panel not visible within ${timeoutMs}ms`,
    );
  }

  /**
   * Block until no visible modal exists on the page. Generically
   * used as a pre-click guard so we never click through a modal
   * (e.g. a leftover Add Passage modal that didn't close).
   *
   * "No visible modal" means: the page has zero `.modal.show`
   * elements AND zero `.modal-backdrop.show` elements at the
   * same poll.
   *
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]  Default 5s.
   * @param {string} [opts.tag]  Diagnostic tag for logs.
   * @returns {Promise<boolean>}  true if no modal is visible at the end.
   * @private
   */
  async _waitForAnyModalClosed(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const tag = opts.tag || "any-modal";
    const { page } = this;
    const modalShow = page.locator(".modal.show");
    const backdrop = page.locator(".modal-backdrop.show");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const sc = await modalShow.count({ timeout: 50 }).catch(() => 0);
      const bc = await backdrop.count({ timeout: 50 }).catch(() => 0);
      if (sc === 0 && bc === 0) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const finalShow = await modalShow.count({ timeout: 50 }).catch(() => 0);
    const finalBackdrop = await backdrop.count({ timeout: 50 }).catch(() => 0);
    log.uploader.warn(
      { tag, modalShow: finalShow, backdrop: finalBackdrop, timeoutMs },
      "[modal-guard] modal still visible after timeout",
    );
    return false;
  }

  /**
   * Read back the content length from an editor (TinyMCE iframe or
   * plain textarea). Used to verify the passage content was actually
   * inserted, not just typed-but-missed.
   * @param {import("playwright").Page} page
   * @param {import("playwright").Locator} contentField
   * @param {string} kind  "tinymce" | "textarea" | ...
   * @returns {Promise<number>}
   * @private
   */
  async _editorContentLength(page, contentField, kind) {
    try {
      if (kind === "tinymce") {
        const frameEl = await contentField
          .locator("iframe")
          .first()
          .elementHandle();
        if (!frameEl) return 0;
        const frame = await frameEl.contentFrame();
        if (!frame) return 0;
        const text = await frame
          .locator("body")
          .innerText()
          .catch(() => "");
        return text.trim().length;
      }
      // Default: textarea / contenteditable. Read `.value` or textContent.
      const value = await contentField
        .evaluate((el) => {
          if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
            return el.value ?? "";
          }
          return el.textContent ?? el.innerText ?? "";
        })
        .catch(() => "");
      return String(value).trim().length;
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // addQuestion — dispatches on proqyzType
  // ---------------------------------------------------------------------------

  /**
   * @param {import("../../domain/schemas.js").Question} q
   * @param {number} index
   * @param {number} total
   * @param {{ passageIdx?: number }} [opts]
   * @returns {Promise<import("../QuizUploader.js").QuestionHandle>}
   */
  async addQuestion(q, index, total, opts = {}) {
    const { page } = this;
    const passageIdx = opts.passageIdx ?? 0;
    const passageTitle = opts.passageTitle ?? "";
    log.uploader.info(
      { n: q.number, proqyzType: q.proqyzType, ieltsType: q.ieltsType, passageIdx, passageTitle },
      "addQuestion",
    );
    if (this.dryRun) {
      return {
        id: `dry-q-${q.number}`,
        number: q.number,
        passageIndex: passageIdx,
      };
    }

    // Tab-based flow (real ProQyz):
    //   1. Click the "Questions" tab.
    //   2. Select the right passage in the passage dropdown (so the
    //      "+ Add Question" we click belongs to THIS passage).
    //   3. Click "+ Add Question" to open the per-question editor.
    //   4. If the per-question editor is a sub-page (not a modal), the
    //      "+ Add Question" only creates a row in the list. Click
    //      the new row's "Edit" / open button to enter the editor.

    // 1. Click the Questions tab.
    const questionsTab = page.locator(Selectors.tabs.questionsTab).first();
    if (await questionsTab.isVisible().catch(() => false)) {
      // Screenshot: before clicking Questions tab.
      try {
        await page.screenshot({
          path: `failures/before-questions-tab-click-Q${q.number}.png`,
        });
      } catch (capErr) {
        log.uploader.debug(
          { err: capErr.message },
          "could not capture before-questions-tab screenshot",
        );
      }

      // Pre-click guard: if any modal is still visible, it would
      // intercept the click. Block until the modal is gone (5s
      // budget — should be fast; addPassage already waited, this
      // is just belt-and-suspenders for any stray modal). If the
      // modal does not close in time, log a diagnostic and proceed
      // anyway — the click will fail with a clear error and we
      // will have a screenshot.
      const strayClosed = await this._waitForAnyModalClosed({
        timeoutMs: 5000,
        tag: `pre-questions-tab-Q${q.number}`,
      });
      if (!strayClosed) {
        log.uploader.warn(
          { qNumber: q.number },
          "[addQuestion] stray modal still visible before Questions tab click; " +
            "attempting click anyway with screenshot",
        );
        try {
          await page.screenshot({
            path: `failures/pre-questions-tab-modal-stuck-Q${q.number}.png`,
          });
        } catch {
          /* noop */
        }
      }

      await questionsTab.click();
      await waitForPageCalm(page);
    }

    // 1b. Wait for the Questions-tab content to render. Real ProQyz
    //     swaps the body via XHR after the tab click; the helper
    //     below will fail with "0 <select> on the page" if we run
    //     before the swap completes. We wait for the questions
    //     container, the "List of Questions" header, the Add
    //     Question button, OR any <select> to appear — whichever
    //     comes first, with a generous timeout.
    await Promise.race([
      page
        .locator(Selectors.questionList.container)
        .first()
        .waitFor({ state: "visible", timeout: config.saveTimeoutMs })
        .catch(() => null),
      page
        .locator("select")
        .first()
        .waitFor({ state: "visible", timeout: config.saveTimeoutMs })
        .catch(() => null),
      page
        .locator('h3:has-text("List of Questions")')
        .first()
        .waitFor({ state: "visible", timeout: config.saveTimeoutMs })
        .catch(() => null),
      page
        .locator(Selectors.questionList.addButton)
        .first()
        .waitFor({ state: "visible", timeout: config.saveTimeoutMs })
        .catch(() => null),
    ]);
    // Wait for the page's placeholder skeletons to clear. The live
    // dump showed `<span class="placeholder ...">` rows in the
    // question list during the XHR fetch. Probing a passage picker
    // while the page is in "loading" state is the most common cause
    // of "saw 0 <select> on the page". Poll until no placeholder is
    // visible, or until a few seconds elapse.
    await this._waitForPlaceholdersGone();
    await waitForPageCalm(page);

    // Screenshot: after clicking Questions tab, before passage selection.
    try {
      await page.screenshot({
        path: `failures/before-passage-select-Q${q.number}.png`,
      });
    } catch (capErr) {
      log.uploader.debug(
        { err: capErr.message },
        "could not capture before-passage-select screenshot",
      );
    }

    // 2. Select the right passage. The new ProQyz UI may bind the
    //    passage implicitly (single-passage quizzes) or via one of
    //    several control shapes — see _selectPassageInQuestionsTab's
    //    docstring for the full probe ladder. The helper now also
    //    short-circuits if the Add Question button is already
    //    reachable, which is the typical single-passage case.
    await this._selectPassageInQuestionsTab(passageTitle, passageIdx);
    await waitForPageCalm(page);

    // 2b. Wait for the page to leave the "Choose Passage" empty
    //     state and render the Add Question button (or the question
    //     list for the selected passage).
    const addBtn = page.locator(Selectors.questionList.addButton).first();
    await addBtn
      .waitFor({ state: "visible", timeout: config.saveTimeoutMs })
      .catch(async () => {
        // Some real ProQyz variants only render the Add Question
        // button after a small delay. Log and continue; if the
        // button truly never appears, the click below will throw
        // a useful error.
        log.uploader.warn(
          { passageTitle, passageIdx },
          "Add Question button did not appear after selecting passage; " +
            "continuing (will fail on click if still missing)",
        );
      });

    // 3. Click "+ Add Question". On real ProQyz this opens the
    //    per-question editor modal directly.
    const tOpen = Date.now();
    if (await addBtn.isVisible().catch(() => false)) {
      await addBtn.click();
      // Modal opens immediately. No networkidle, no calm wait —
      // a 300-500ms settle is enough for the react-select to mount.
      await page.waitForTimeout(400);
    }
    const tAfterOpen = Date.now();

    // 3b. Pick the question type. Real ProQyz's Add Reading Question
    //     modal opens on step 1: a react-select labeled "Add" with
    //     id="input-type". Prefer the numeric `questionTypeIndex` on
    //     the question object (future-proof: dropdown order is more
    //     stable than the descriptive labels). Fall back to matching
    //     the full visible label by proqyzType.
    const tTypeStart = Date.now();
    await this._pickQuestionTypeInEditor(q);
    const tTypeEnd = Date.now();

    // Dispatch on proqyzType. Fill-up and Select are wired up; Radio
    // and Checkbox are intentionally deferred (per current scope: do
    // not work on Radio yet). Bulk-import mode fails loud on an
    // unsupported type so the run stops rather than silently writing
    // the wrong question shape to ProQyz.
    const tFillStart = Date.now();
    switch (q.proqyzType) {
      case "fill_up":
        await this._fillFillUpQuestion(q);
        break;
      case "select":
        await this._fillSelectQuestion(q);
        break;
      case "radio":
        await this._fillRadioQuestion(q);
        break;
      case "checkbox":
        throw new Error(
          `addQuestion: proqyzType "checkbox" for Q${q.number} ` +
            `is not yet supported (Checkbox intentionally deferred).`,
        );
      default:
        throw new Error(
          `addQuestion: unknown proqyzType "${q.proqyzType}" for Q${q.number}`,
        );
    }
    const tFillEnd = Date.now();

    log.uploader.info(
      {
        n: q.number,
        msOpenModal: tAfterOpen - tOpen,
        msTypePick: tTypeEnd - tTypeStart,
        msFillAndSave: tFillEnd - tFillStart,
        msTotal: tFillEnd - tOpen,
      },
      "PROFILE: addQuestion timings",
    );

    // Post-fill safety net: if the question modal is still open
    // (stub bailed out, helper hit an early return, etc.), dismiss it
    // so the NEXT addQuestion iteration can click the Questions tab.
    // Real ProQyz's Create Question button normally closes the modal;
    // this is the cleanup path for environments that don't.
    await this._closeStrayQuestionModal();

    return {
      id: `q-${q.number}`,
      number: q.number,
      passageIndex: passageIdx,
    };
  }

  /**
   * Best-effort: close the Add Reading Question modal if it's still
   * visible. Tries Cancel, then Escape, then clicks the close (X)
   * button. No-op if the modal is already hidden.
   *
   * Strengthened (2026-06-09): after the modal mask is gone, also
   * wait for the Questions tab to be visible on the page. This
   * makes the post-fill-up → start-radio transition deterministic
   * — the next `addQuestion` call can immediately re-click the
   * Add Question button without racing against a half-closed
   * modal or a still-re-rendering Questions tab.
   */
  async _closeStrayQuestionModal() {
    const { page } = this;
    const modal = page.locator(
      '.question__components.modal.show, .modal.show[data-testid="question-editor"], #question-modal.show',
    ).first();
    if (!(await modal.isVisible().catch(() => false))) {
      // No stale modal; still wait briefly for the Questions tab to
      // be ready in case the page is mid-re-render.
      await this._waitForQuestionsTabReady();
      return;
    }
    log.uploader.debug("stray question modal still open; closing it");
    const cancel = modal
      .locator('button:has-text("Cancel"), button:has-text("Close"), [aria-label="Close"]')
      .first();
    if (await cancel.isVisible().catch(() => false)) {
      await cancel.click().catch(() => {});
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
    await page
      .locator("#question-modal-mask.show, .question__components.modal-mask.show")
      .first()
      .waitFor({ state: "hidden", timeout: 5000 })
      .catch(() => null);
    // Wait for the Questions tab to be visible again so the next
    // addQuestion iteration has a clean page to operate on.
    await this._waitForQuestionsTabReady();
  }

  /**
   * Wait for the Questions tab to be visible and interactive on the
   * page. Polls with a short interval; returns when ready, or after
   * a 5s budget. Used by `_closeStrayQuestionModal` and by
   * `_fillRadioQuestion`'s modal-open readiness check.
   *
   * @private
   */
  async _waitForQuestionsTabReady() {
    const { page } = this;
    const questionsTab = page.locator(Selectors.tabs.questionsTab).first();
    const start = Date.now();
    const budgetMs = 5000;
    while (Date.now() - start < budgetMs) {
      if (await questionsTab.isVisible().catch(() => false)) {
        // Sanity: no stale modal mask should be on top of the page.
        const strayMask = page
          .locator(
            "#question-modal-mask.show, .question__components.modal-mask.show",
          )
          .first();
        const maskVisible = await strayMask
          .isVisible()
          .catch(() => false);
        if (!maskVisible) return;
      }
      await page.waitForTimeout(150);
    }
    log.uploader.debug(
      { budgetMs },
      "_waitForQuestionsTabReady: timed out waiting for Questions tab",
    );
  }

  /**
   * Wait for the Add/Edit Reading Question modal to be fully open
   * and ready, then return its locator.
   *
   * The radio fill (and the fill-up / select fills) all need to
   * click tabs inside the modal. The previous eager `.modal.show`
   * locator captured at the top of the fill helper could go stale
   * if (a) a previous question's modal is still in the DOM, (b)
   * ProQyz re-rendered the modal between type-pick and tab-click,
   * or (c) the page state from a prior fixture left a half-open
   * modal mask on top. This helper makes the modal-open path
   * deterministic:
   *
   *   1. Close any stale modal (best-effort, idempotent).
   *   2. Wait for the page to be back on the Questions tab.
   *   3. Wait for a visible modal titled "Add Reading Question" or
   *      "Edit Reading Question" (whichever is currently rendered).
   *      The modal's title is its ground-truth signal — if no
   *      title is visible, the modal is not actually open.
   *   4. Verify that the 5 expected tabs (Basic, Question,
   *      Explanation, Preview, Finish) are visible inside the
   *      modal. If any are missing, the modal is half-mounted.
   *   5. Return the modal locator, scoped to a specific `.modal`
   *      container that is currently visible.
   *
   * On any failure: captureFailure, dump the visible modal title,
   * dump every visible button and tab on the page (so the operator
   * can see what ProQyz actually rendered), and throw a tagged
   * error so the run stops loudly rather than clicking into a
   * stale element.
   *
   * @param {string} tag — log tag (e.g. "Q36-37") for all lines
   * @param {string} qLog — per-Q log prefix (e.g. "Q36")
   * @returns {Promise<import("playwright").Locator>}
   * @private
   */
  async _waitForQuestionModalReady(tag, qLog) {
    const { page } = this;

    log.uploader.info(
      { tag, qLog },
      `[${tag}] Opening Add Question modal`,
    );

    // 1. Close any stale modal.
    await this._closeStrayQuestionModal();

    // 2. Wait for the page to be on the Questions tab.
    await this._waitForQuestionsTabReady();

    // 3. Wait for a visible modal with a recognizable title. We
    //    don't capture the locator eagerly — we re-locate on every
    //    probe so a re-render doesn't leave us holding a stale
    //    handle.
    const modalCandidates = [
      page.locator('.question__components.modal.show').first(),
      page.locator('.modal.show[data-testid="question-editor"]').first(),
      page.locator('#question-modal.show').first(),
    ];

    // Tolerant title check: the modal title may be "Add Reading
    // Question" (new) or "Edit Reading Question" (re-edit) per the
    // 2026-06-09 live dump.
    const titleCandidates = [
      'h5:has-text("Add Reading Question")',
      'h4:has-text("Add Reading Question")',
      'h3:has-text("Add Reading Question")',
      'h2:has-text("Add Reading Question")',
      '.modal-title:has-text("Add Reading Question")',
      '.modal-header:has-text("Add Reading Question")',
      'h5:has-text("Edit Reading Question")',
      'h4:has-text("Edit Reading Question")',
      'h3:has-text("Edit Reading Question")',
      'h2:has-text("Edit Reading Question")',
      '.modal-title:has-text("Edit Reading Question")',
      '.modal-header:has-text("Edit Reading Question")',
    ];

    const start = Date.now();
    const budgetMs = 8000;
    let readyModal = null;
    let readyTitle = null;
    while (Date.now() - start < budgetMs) {
      for (const cand of modalCandidates) {
        if (!(await cand.isVisible().catch(() => false))) continue;
        for (const sel of titleCandidates) {
          const titleEl = cand.locator(sel).first();
          if (await titleEl.isVisible().catch(() => false)) {
            const txt = ((await titleEl.textContent().catch(() => "")) || "")
              .trim();
            if (txt) {
              readyModal = cand;
              readyTitle = txt;
              break;
            }
          }
        }
        if (readyModal) break;
      }
      if (readyModal) break;
      await page.waitForTimeout(150);
    }

    if (!readyModal) {
      // Failure: no modal with a recognizable title is visible.
      // Capture screenshot + dump everything visible.
      try {
        await captureFailure(page, `modal-tab-not-found-${tag}`);
      } catch (_) {
        // best-effort
      }
      const inventory = await this._dumpModalAndTabsInventory();
      log.uploader.error(
        { tag, qLog, inventory },
        `[${tag}] modal-tab-not-found: no Add/Edit Reading Question modal visible`,
      );
      throw new Error(
        `_fillRadioQuestion: modal-tab-not-found for ${tag} — no visible ` +
          `modal with title "Add Reading Question" or "Edit Reading ` +
          `Question" after ${budgetMs}ms. ` +
          `failures/modal-tab-not-found-${tag}.* has the dump.`,
      );
    }

    log.uploader.info(
      { tag, qLog, modalTitle: readyTitle },
      `[${tag}] Modal visible: ${readyTitle}`,
    );

    // 4. Verify the 5 expected tabs are present inside this modal.
    //    If any are missing, the modal is half-mounted — don't
    //    click into a missing tab.
    const expectedTabs = ["Basic", "Question", "Explanation", "Preview", "Finish"];
    const foundTabs = [];
    const missingTabs = [];
    for (const tabLabel of expectedTabs) {
      const tab = readyModal
        .locator(".tablist .tabs, .tablist li, [role='tab']")
        .filter({ hasText: new RegExp(`^\\s*${tabLabel}\\s*$`, "i") })
        .first();
      if (await tab.isVisible().catch(() => false)) {
        foundTabs.push(tabLabel);
      } else {
        missingTabs.push(tabLabel);
      }
    }
    if (missingTabs.length > 0) {
      // Modal is up but tabs are not all there yet — capture and
      // throw. This is the actual root cause of the
      // "tab Question not found" error from the prior run.
      try {
        await captureFailure(page, `modal-tab-missing-${tag}`);
      } catch (_) {
        // best-effort
      }
      const inventory = await this._dumpModalAndTabsInventory();
      log.uploader.error(
        {
          tag,
          qLog,
          modalTitle: readyTitle,
          foundTabs,
          missingTabs,
          inventory,
        },
        `[${tag}] modal-tab-not-found: tabs missing inside visible modal`,
      );
      throw new Error(
        `_fillRadioQuestion: modal-tab-not-found for ${tag} — modal ` +
          `"${readyTitle}" is visible but tabs are missing: ` +
          `${JSON.stringify(missingTabs)}. Found: ` +
          `${JSON.stringify(foundTabs)}. ` +
          `failures/modal-tab-missing-${tag}.* has the dump.`,
      );
    }

    log.uploader.info(
      { tag, qLog, foundTabs },
      `[${tag}] Tabs found: ${foundTabs.join(", ")}`,
    );

    return readyModal;
  }

  /**
   * Diagnostic inventory for `_waitForQuestionModalReady` failure
   * paths. Captures, at the moment of failure:
   *   - the visible modal title (or "none" if no modal is open),
   *   - the list of visible `<button>` / `<a>` / `[role=tab]`
   *     elements on the page (so the operator can see what
   *     ProQyz actually rendered),
   *   - the list of tabs found inside ANY visible modal.
   *
   * @returns {Promise<{
   *   visibleModalTitle: string|null,
   *   visibleButtons: Array<{ tag, text, classes }>,
   *   visibleTabs: Array<{ tag, text, role }>,
   * }>}
   * @private
   */
  /**
   * Wait for a tab inside the given modal to become the "active" one.
   *
   * "Active" in this codebase means the tab element has the `.active`
   * class, OR has `aria-selected="true"`, OR its sibling tabpanel is
   * visible. The ProQyz editor uses `.tablist .tabs` / `tablist li`
   * / `[role='tab']` for the tab list; clicking flips a `.active`
   * class. Polling for any one of these three signals is the
   * deterministic alternative to `networkidle` (which can hang
   * indefinitely on the ProQyz SPA's long-poll/websocket).
   *
   * @param {import("playwright").Locator} modal
   * @param {string} label
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]   Default 4s.
   * @returns {Promise<void>}  Throws on timeout.
   * @private
   */
  async _waitForActiveTab(modal, label, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 4000;
    const tab = modal
      .locator(".tablist .tabs, .tablist li, [role='tab']")
      .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, "i") })
      .first();
    // The tab must first be visible.
    await tab.waitFor({ state: "visible", timeout: timeoutMs });
    // Then poll for active/aria-selected/visible-panel signals.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const isActive = await tab
        .evaluate((el) => {
          const cls = (el.className || "").toString();
          const aria = el.getAttribute("aria-selected");
          if (cls.split(/\s+/).includes("active")) return true;
          if (aria === "true") return true;
          // Some templates mark the active tab with a child class.
          if (el.querySelector && el.querySelector(".active")) return true;
          return false;
        })
        .catch(() => false);
      if (isActive) return;
      // Also accept: a tabpanel with this label's text is visible.
      const panelVisible = await modal
        .locator(
          `[role='tabpanel']:visible, .tab-pane.active.show, .tab-content__box:visible`,
        )
        .filter({
          hasText: new RegExp(`^.{0,500}$`, "s"),
        })
        .first()
        .isVisible()
        .catch(() => false);
      if (panelVisible) return;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(
      `_waitForActiveTab: tab "${label}" did not become active within ${timeoutMs}ms`,
    );
  }

  async _dumpModalAndTabsInventory() {
    const { page } = this;
    let visibleModalTitle = null;
    try {
      const modalLoc = page
        .locator(
          '.question__components.modal.show, .modal.show[data-testid="question-editor"], #question-modal.show',
        )
        .first();
      if (await modalLoc.isVisible().catch(() => false)) {
        const titleEl = modalLoc
          .locator(
            'h5, h4, h3, h2, .modal-title, .modal-header',
          )
          .first();
        if (await titleEl.isVisible().catch(() => false)) {
          visibleModalTitle = (
            (await titleEl.textContent().catch(() => "")) || ""
          ).trim();
        }
      }
    } catch (_) {
      // best-effort
    }
    let visibleButtons = [];
    try {
      visibleButtons = await page
        .locator("button, a, [role=button]")
        .evaluateAll((els) =>
          els
            .filter((e) => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            })
            .slice(0, 80)
            .map((e) => ({
              tag: e.tagName.toLowerCase(),
              text: (e.textContent ?? "").trim().slice(0, 80),
              classes: (e.className ?? "").toString().slice(0, 120),
            })),
        );
    } catch (_) {
      // best-effort
    }
    let visibleTabs = [];
    try {
      visibleTabs = await page
        .locator(".tablist .tabs, .tablist li, [role=tab]")
        .evaluateAll((els) =>
          els
            .filter((e) => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            })
            .slice(0, 40)
            .map((e) => ({
              tag: e.tagName.toLowerCase(),
              text: (e.textContent ?? "").trim().slice(0, 60),
              role: e.getAttribute("role"),
            })),
        );
    } catch (_) {
      // best-effort
    }
    return { visibleModalTitle, visibleButtons, visibleTabs };
  }

  // ---------------------------------------------------------------------------
  // _addContentQuestion — fill_up and select
  //
  // Writes the question content (which already contains the {answer}
  // placeholder) into the question content textarea. Does NOT add any
  // options.
  // ---------------------------------------------------------------------------

  async _addContentQuestion(q, { setDefaultOptions }) {
    const { page } = this;
    const card = await this._waitForQuestionEditor();
    try {
      // ProQyz question type select.
      const typeSel = card.locator(Selectors.questionEditor.typeSelect).first();
      if (await typeSel.isVisible().catch(() => false)) {
        await typeSel
          .selectOption(PROQYZ_TYPE_TO_SELECT_VALUE[q.proqyzType])
          .catch((err) => {
            log.uploader.warn(
              { err: err.message, proqyzType: q.proqyzType },
              "typeSelect.selectOption failed; will rely on the form default",
            );
          });
      }

      // Default Options — only for select. Map the schema code
      // (e.g. "true_false_not_given") to the ProQyz select value.
      if (setDefaultOptions && q.defaultOptions) {
        const doptSel = card.locator(Selectors.questionEditor.defaultOptionsSelect).first();
        if (await doptSel.isVisible().catch(() => false)) {
          await doptSel
            .selectOption(defaultOptionsToSelectValue(q.defaultOptions))
            .catch((err) => {
              log.uploader.warn(
                { err: err.message, defaultOptions: q.defaultOptions },
                "defaultOptionsSelect.selectOption failed",
              );
            });
        } else {
          log.uploader.warn(
            { defaultOptions: q.defaultOptions },
            "defaultOptions select not visible on question editor",
          );
        }
      }

      // Question content — the most important write. The content already
      // contains the {answer} placeholder; we write it verbatim so the
      // braces end up in ProQyz.
      const contentRaw = card.locator(Selectors.questionEditor.contentTextarea).first();
      if (!(await contentRaw.isVisible().catch(() => false))) {
        throw new Error(
          `Question content textarea not found for Q${q.number}. ` +
            `Selector: ${Selectors.questionEditor.contentTextarea}`,
        );
      }
      const content = await this._resolveEditable(contentRaw);
      await writePlain(page, content, q.content);

      // Save and return to the list.
      await this._saveQuestionAndBack(card);
    } finally {
      // `_waitForQuestionEditor` may not have a card in the case where
      // the question editor opens on a different page (not inside the
      // list page). We do not close the card explicitly; the caller
      // continues to the next question.
    }
  }

  // ---------------------------------------------------------------------------
  // _addOptionsQuestion — radio and checkbox
  //
  // Writes the question content (no brace), adds N options, fills their
  // text, and marks the correct one(s).
  // ---------------------------------------------------------------------------

  async _addOptionsQuestion(q, kind) {
    const { page } = this;
    if (!q.options || q.options.length < 2) {
      throw new Error(`_addOptionsQuestion: Q${q.number} requires >= 2 options`);
    }
    const card = await this._waitForQuestionEditor();
    try {
      const typeSel = card.locator(Selectors.questionEditor.typeSelect).first();
      if (await typeSel.isVisible().catch(() => false)) {
        await typeSel
          .selectOption(PROQYZ_TYPE_TO_SELECT_VALUE[kind])
          .catch((err) => {
            log.uploader.warn(
              { err: err.message, proqyzType: kind },
              "typeSelect.selectOption failed; will rely on the form default",
            );
          });
      }

      const contentRaw = card.locator(Selectors.questionEditor.contentTextarea).first();
      if (!(await contentRaw.isVisible().catch(() => false))) {
        throw new Error(
          `Question content textarea not found for Q${q.number}. ` +
            `Selector: ${Selectors.questionEditor.contentTextarea}`,
        );
      }
      const content = await this._resolveEditable(contentRaw);
      await writePlain(page, content, q.content);

      // Add options. ProQyz may pre-add 2 — we add the rest as needed.
      const addOpt = card.locator(Selectors.questionEditor.addOptionButton).first();
      const existing = card.locator(Selectors.option.row);
      let existingCount = await existing.count().catch(() => 0);
      while (existingCount < q.options.length) {
        if (await addOpt.isVisible().catch(() => false)) {
          await addOpt.click();
          await waitForPageCalm(page);
        } else {
          throw new Error(
            `Add Option button not visible; cannot add enough options for Q${q.number}`,
          );
        }
        existingCount = await existing.count();
      }

      // Fill the option texts.
      const rows = card.locator(Selectors.option.row);
      for (let i = 0; i < q.options.length; i++) {
        const row = rows.nth(i);
        const field = row.locator(Selectors.option.textField).first();
        await field.fill(q.options[i].text);
        await jitter();
      }

      // Mark the correct one(s).
      if (kind === "radio") {
        const correctOpt = q.options.find(
          (o) => o.label.toUpperCase() === String(q.answer).toUpperCase().trim(),
        );
        if (!correctOpt) {
          throw new Error(
            `_addOptionsQuestion: Q${q.number} answer="${q.answer}" not in options`,
          );
        }
        await selectCorrectOption(page, card, correctOpt);
      } else {
        // checkbox
        const answerLabels = (q.answers ?? []).map((a) => a.trim()).filter(Boolean);
        await selectCorrectCheckboxes(page, card, answerLabels);
      }

      await this._saveQuestionAndBack(card);
    } finally {
    }
  }

  // ---------------------------------------------------------------------------
  // save (form-level)
  // ---------------------------------------------------------------------------

  async save() {
    const { page } = this;
    log.uploader.info("save: clicking final save button (flexible)");
    if (this.dryRun) return { id: "dry-run", url: page.url() };
    // Use the flexible final-save helper. The old strict
    // `button:has-text("Save changes")` timed out at 30s whenever
    // ProQyz rendered a different final action or had already
    // autosaved on the last question's Finish-tab switch.
    const result = await this._clickFinalSave({
      scope: page,
      page,
      qTag: "final-save",
    });
    log.uploader.info(
      {
        strategy: result.strategy,
        buttonLabel: result.buttonLabel,
        modalClosed: result.modalClosed,
        questionCardVisible: result.questionCardVisible,
      },
      "save: completed",
    );
    return { id: extractQuizIdFromUrl(page.url()), url: page.url() };
  }

  // ---------------------------------------------------------------------------
  // openExisting / publish (kept for the resume + --publish paths)
  // ---------------------------------------------------------------------------

  async openExisting(existing) {
    const { page } = this;
    log.uploader.info({ url: existing.url }, "openExisting");
    await page.goto(existing.url, { waitUntil: "domcontentloaded" });
    await waitForPageCalm(page);
    return existing;
  }

  async publish(existing) {
    const { page } = this;
    log.uploader.info({ url: existing.url }, "publish: opening existing quiz");
    await page.goto(existing.url, { waitUntil: "domcontentloaded" });
    await waitForPageCalm(page);
    if (this.dryRun) {
      log.uploader.info("DRY RUN: skipping publish actions");
      return existing;
    }
    const statusSel = page.locator(Selectors.quizForm.statusSelect).first();
    if (await statusSel.isVisible().catch(() => false)) {
      await statusSel.selectOption("published");
      await page.locator(Selectors.quizForm.saveButton).first().click();
      await waitForPageCalm(page, { timeoutMs: config.saveTimeoutMs });
      log.uploader.info("publish: status changed to published via status select");
      return { id: existing.id, url: page.url() };
    }
    const publishBtn = page.locator('button:has-text("Publish")').first();
    if (await publishBtn.isVisible().catch(() => false)) {
      await publishBtn.click();
      await waitForPageCalm(page, { timeoutMs: config.saveTimeoutMs });
      log.uploader.info("publish: clicked explicit Publish button");
      return { id: existing.id, url: page.url() };
    }
    throw new Error(
      "publish: no way to publish — neither a status select nor a " +
        "Publish button was found. Update selectors.js after Phase 0 recon.",
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Select the right passage in the Questions-tab passage dropdown.
   *
   * Real ProQyz renders TWO passage selects when no passage is
   * selected yet:
   *   1. A top-right select near "List of Questions"
   *   2. A center select inside the empty state under "Choose Passage"
   *
   * Both contain the same `<option>` list. We pick the first VISIBLE
   * one (skipping hidden duplicates), then `selectOption({ label })`
   * by the passage title. If the label doesn't match exactly, we
   * fall back to `selectOption({ index })` using `passageIdx + 1`
   * (option 0 is the "--SELECT PASSAGE--" placeholder).
   *
   * After the change event fires, we wait for the "Choose Passage"
   * empty-state text to disappear, which is the signal that React
   * has re-rendered the question list for the selected passage.
   *
   * @param {string} passageTitle — e.g. "Reading Passage 1"
   * @param {number} passageIdx  — 0-based index of the passage
   * @private
   */
  /**
   * Select a passage inside the Questions tab so the "+ Add Question"
   * button (and the per-question list) are bound to it.
   *
   * The live 2026-06-09 dump showed the ProQyz Questions tab renders
   * the passage picker in several possible shapes, *or* binds the
   * passage implicitly (no control at all when the quiz has exactly
   * one passage). This helper probes every reasonable shape before
   * declaring a failure:
   *
   *   1. **Native `<select>`** — the classic shape. Try every
   *      visible `<select>` whose options include a passage-shaped
   *      placeholder + the target title.
   *   2. **react-select / combobox** — `[role="combobox"]` whose
   *      accessible name or current-value text contains "passage".
   *      Click → look for `[role="option"]` matching the title.
   *   3. **Listbox** — `[role="listbox"]` directly with
   *      `[role="option"]` children.
   *   4. **Button/dropdown trigger** — a `<button>` whose text or
   *      aria-label contains "passage" / "select passage". Click →
   *      same option-list dance.
   *   5. **Visible-text shortcut** — if the target passage title is
   *      already visible on the page (e.g. as a card header), the
   *      passage is implicitly selected; click it to confirm, or
   *      accept and continue.
   *
   * If the page already has an Add Question button reachable, we
   * short-circuit and skip selection — the new ProQyz flow appears
   * to auto-bind the only passage in single-passage quizzes.
   *
   * Three screenshots are taken: before/after the Questions tab
   * click (at the call site in `addQuestion`) and right before
   * selection. On any failure path, the page state is dumped to
   * `failures/select-passage-probe-Q{n}.{html,png}` plus a rich
   * inventory of every visible interactive control on the page.
   *
   * @param {string} passageTitle — e.g. "Reading Passage 1"
   * @param {number} passageIdx  — 0-based index of the passage
   * @private
   */
  async _selectPassageInQuestionsTab(passageTitle, passageIdx) {
    const { page } = this;
    log.uploader.info(
      { passageTitle, passageIdx },
      "selecting passage in Questions tab",
    );

    // ---------------------------------------------------------------
    // Short-circuit: if the Add Question button is already reachable,
    // the passage is implicitly bound. Common in single-passage
    // quizzes on the new ProQyz UI, which does NOT render a
    // "Choose Passage" picker at all.
    // ---------------------------------------------------------------
    if (await this._isPassageImplicitlySelected(passageTitle)) {
      log.uploader.info(
        { passageTitle, passageIdx },
        "Add Question button is reachable and passage title is visible; " +
          "skipping manual passage selection (implicitly bound)",
      );
      return;
    }

    // ---------------------------------------------------------------
    // Strategy 1: native <select>
    // ---------------------------------------------------------------
    const nativeSelect = await this._findPassageSelect(passageTitle);
    if (nativeSelect) {
      log.uploader.info(
        { passageTitle, passageIdx, strategy: "native-select" },
        "passage select found (native <select>)",
      );
      await this._chooseFromSelect(nativeSelect, passageTitle, passageIdx);
      await this._waitForEmptyStateGone();
      return;
    }

    // ---------------------------------------------------------------
    // Strategy 2: react-select / combobox
    // ---------------------------------------------------------------
    const combobox = await this._findPassageCombobox();
    if (combobox) {
      log.uploader.info(
        { passageTitle, passageIdx, strategy: "combobox" },
        "passage picker found (combobox)",
      );
      await this._chooseFromCombobox(combobox, passageTitle);
      await this._waitForEmptyStateGone();
      return;
    }

    // ---------------------------------------------------------------
    // Strategy 3: listbox
    // ---------------------------------------------------------------
    const listbox = await this._findPassageListbox();
    if (listbox) {
      log.uploader.info(
        { passageTitle, passageIdx, strategy: "listbox" },
        "passage picker found (listbox)",
      );
      await this._chooseFromListbox(listbox, passageTitle);
      await this._waitForEmptyStateGone();
      return;
    }

    // ---------------------------------------------------------------
    // Strategy 4: button / dropdown trigger
    // ---------------------------------------------------------------
    const trigger = await this._findPassageTrigger();
    if (trigger) {
      log.uploader.info(
        { passageTitle, passageIdx, strategy: "button-trigger" },
        "passage picker found (button trigger)",
      );
      await trigger.click();
      await page.waitForTimeout(200);
      // After click, re-probe in priority order.
      const sel2 = await this._findPassageSelect(passageTitle);
      if (sel2) {
        await this._chooseFromSelect(sel2, passageTitle, passageIdx);
        await this._waitForEmptyStateGone();
        return;
      }
      const cbox2 = await this._findPassageCombobox();
      if (cbox2) {
        await this._chooseFromCombobox(cbox2, passageTitle);
        await this._waitForEmptyStateGone();
        return;
      }
      const lb2 = await this._findPassageListbox();
      if (lb2) {
        await this._chooseFromListbox(lb2, passageTitle);
        await this._waitForEmptyStateGone();
        return;
      }
    }

    // ---------------------------------------------------------------
    // Strategy 5: visible-text shortcut — try clicking the title
    // directly. Some ProQyz layouts render the passage as a
    // selectable card.
    // ---------------------------------------------------------------
    const titleEl = page
      .locator(`text=${JSON.stringify(passageTitle)}`)
      .first();
    if (
      (await titleEl.count()) > 0 &&
      (await titleEl.isVisible().catch(() => false))
    ) {
      try {
        await titleEl.click({ trial: false, timeout: 2000 });
        await this._waitForEmptyStateGone();
        log.uploader.info(
          { passageTitle, passageIdx, strategy: "visible-text" },
          "passage title clicked directly",
        );
        return;
      } catch (err) {
        log.uploader.debug(
          { err: err.message, passageTitle },
          "clicking visible passage title did not work; falling through",
        );
      }
    }

    // ---------------------------------------------------------------
    // All strategies failed. Capture state and throw.
    // ---------------------------------------------------------------
    const failureName = `select-passage-probe-passage${passageIdx}`;
    try {
      await captureFailure(page, failureName);
    } catch (capErr) {
      log.uploader.warn(
        { err: capErr.message },
        "captureFailure itself failed during passage-select probe",
      );
    }
    const inventory = await this._dumpPageInventory(page);
    log.uploader.error(
      {
        passageTitle,
        passageIdx,
        selectCount: await page.locator("select").count(),
        comboboxCount: await page.locator('[role="combobox"]').count(),
        listboxCount: await page.locator('[role="listbox"]').count(),
        addBtnVisible: await page
          .locator(Selectors.questionList.addButton)
          .first()
          .isVisible()
          .catch(() => false),
        inventory,
      },
      "_selectPassageInQuestionsTab: no passage picker found",
    );
    throw new Error(
      `_selectPassageInQuestionsTab: no passage picker found on Questions tab ` +
        `for "${passageTitle}". Tried <select>, combobox, listbox, button ` +
        `trigger, and visible-text click. HTML+PNG dumped to ` +
        `failures/${failureName}.*`,
    );
  }

  /**
   * True iff the Add Question button is reachable on the Questions tab.
   *
   * Relaxed contract (2026-06-09): for single-passage quizzes, the live
   * ProQyz UI does NOT render a "Choose Passage" picker — the passage
   * is implicitly bound as soon as the Questions tab loads. We no
   * longer require the empty-state to be gone, the passage title to
   * be visible, or a picker to be present. If "Add Question" is
   * reachable, the passage is bound and we can skip the manual
   * selection step.
   *
   * Multi-passage quizzes: a picker is still expected and the manual
   * strategies will run.
   *
   * @param {string} passageTitle
   * @returns {Promise<boolean>}
   * @private
   */
  async _isPassageImplicitlySelected(passageTitle) {
    const { page } = this;
    const addBtn = page.locator(Selectors.questionList.addButton).first();
    if (!(await addBtn.isVisible().catch(() => false))) return false;
    // Optional sanity log: passage-title presence is no longer required,
    // but it's cheap to record when it is there.
    const titleLoc = page
      .locator(`text=${JSON.stringify(passageTitle)}`)
      .first();
    const titleVisible =
      (await titleLoc.count()) > 0 &&
      (await titleLoc.isVisible().catch(() => false));
    log.uploader.debug(
      { passageTitle, titleVisible },
      "passage implicitly bound: Add Question reachable",
    );
    return true;
  }

  /**
   * Find the "Default Options" <select> on the Select-question
   * modal. The 2026-06-09 live dump showed ProQyz uses
   * `<select id="default-options">` with no name attribute and
   * value/text pairs like `i` / `i (Small Romans)`,
   * `true-false-notgiven` / `True False & Not Given`, etc.
   *
   * The probe ladder:
   *   1. `select#default-options` (the id observed in the live DOM).
   *   2. `select[name="defaultOptions"]` (the previously assumed name).
   *   3. `select[name="default_options"]`.
   *   4. Any select that contains a "Default Options" or "default
   *      options" label as a preceding sibling / parent label.
   *   5. Any select whose option texts include "Small Romans" or
   *      "Capital Alphabets" or "Numeric order" or "True False" /
   *      "Yes No" — the Option-set signature words. This catches
   *      future renames of the id/name.
   *
   * @param {import("playwright").Locator} modal
   * @returns {Promise<import("playwright").Locator | null>}
   * @private
   */
  async _findDefaultOptionsSelect(modal) {
    const candidates = [
      modal.locator("select#default-options"),
      modal.locator('select[name="defaultOptions"]'),
      modal.locator('select[name="default_options"]'),
    ];
    for (const c of candidates) {
      const n = await c.count();
      for (let i = 0; i < n; i++) {
        const el = c.nth(i);
        if (await el.isVisible().catch(() => false)) return el;
      }
    }

    // Fallback: scan every visible <select> on the modal and pick
    // the one whose options include signature words.
    const signatureRe =
      /small romans|captial romans|captial alphabets|small alphabets|numeric order|true false.*not given|yes no.*not given|--custom--/i;
    const all = modal.locator("select");
    const total = await all.count();
    for (let i = 0; i < total; i++) {
      const sel = all.nth(i);
      if (!(await sel.isVisible().catch(() => false))) continue;
      const opts = await sel.locator("option").allTextContents();
      if (opts.some((t) => signatureRe.test(t))) return sel;
    }
    return null;
  }

  /**
   * Last-resort non-select probe for the Default Options control.
   * Returns a combobox / listbox / button trigger if found.
   * Looks for comboboxes/listboxes that sit near a "Default Options"
   * label, OR whose accessible text contains "option".
   *
   * @param {import("playwright").Locator} modal
   * @returns {Promise<import("playwright").Locator | null>}
   * @private
   */
  async _findDefaultOptionsControl(modal) {
    // Combobox near a "Default Options" label.
    const labeledCbox = modal
      .locator(
        'xpath=//label[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "default options")]/following::div[@role="combobox" or @aria-haspopup][1]',
      )
      .first();
    if (
      (await labeledCbox.count()) > 0 &&
      (await labeledCbox.isVisible().catch(() => false))
    ) {
      return labeledCbox;
    }
    // Generic combobox whose aria-label / placeholder mentions option.
    const cboxes = modal.locator('[role="combobox"]');
    const cn = await cboxes.count();
    for (let i = 0; i < cn; i++) {
      const c = cboxes.nth(i);
      if (!(await c.isVisible().catch(() => false))) continue;
      const aria = (await c.getAttribute("aria-label")) ?? "";
      const placeholder = (await c.getAttribute("placeholder")) ?? "";
      if (/option/i.test(aria) || /option/i.test(placeholder)) return c;
    }
    // Listbox whose options include "True False" or "Not Given".
    const lbs = modal.locator('[role="listbox"]');
    const ln = await lbs.count();
    for (let i = 0; i < ln; i++) {
      const lb = lbs.nth(i);
      if (!(await lb.isVisible().catch(() => false))) continue;
      const labels = await lb.locator('[role="option"]').allTextContents();
      if (
        labels.some(
          (t) =>
            /true\s*false/i.test(t) || /not\s*given/i.test(t) || /yes\s*no/i.test(t),
        )
      ) {
        return lb;
      }
    }
    return null;
  }

  /**
   * Find a visible native <select> whose options include a passage-
   * shaped placeholder + the target title.
   *
   * @param {string} passageTitle
   * @returns {Promise<import("playwright").Locator | null>}
   * @private
   */
  async _findPassageSelect(passageTitle) {
    const { page } = this;
    const allSelects = page.locator("select");
    const total = await allSelects.count();
    for (let i = 0; i < total; i++) {
      const sel = allSelects.nth(i);
      if (!(await sel.isVisible().catch(() => false))) continue;
      const opts = await sel.locator("option").allTextContents();
      const firstIsPlaceholder =
        opts[0] && /--select|select passage|choose passage/i.test(opts[0]);
      if (!firstIsPlaceholder) continue;
      const hasOurTitle = opts.some((t) => t.trim() === passageTitle);
      if (!hasOurTitle) continue;
      return sel;
    }
    return null;
  }

  /**
   * Find a combobox whose accessible name or current value text
   * contains "passage".
   *
   * @returns {Promise<import("playwright").Locator | null>}
   * @private
   */
  async _findPassageCombobox() {
    const { page } = this;
    const candidates = [
      page.locator('[role="combobox"][aria-label*="passage" i]'),
      page.locator('[role="combobox"][placeholder*="passage" i]'),
      page.locator('[role="combobox"][name*="passage" i]'),
      page.locator('[role="combobox"]#input-passage'),
      // Broader fallback: any combobox near a "Passage" label.
      page.locator('[role="combobox"]'),
    ];
    for (const c of candidates) {
      const n = await c.count();
      for (let i = 0; i < n; i++) {
        const el = c.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const aria = (await el.getAttribute("aria-label")) ?? "";
        const placeholder = (await el.getAttribute("placeholder")) ?? "";
        const name = (await el.getAttribute("name")) ?? "";
        const id = (await el.getAttribute("id")) ?? "";
        if (
          /passage/i.test(aria) ||
          /passage/i.test(placeholder) ||
          /passage/i.test(name) ||
          /passage/i.test(id)
        ) {
          return el;
        }
      }
    }
    return null;
  }

  /**
   * Find a listbox (role=listbox) that contains a passage option.
   *
   * @returns {Promise<import("playwright").Locator | null>}
   * @private
   */
  async _findPassageListbox() {
    const { page } = this;
    const lboxes = page.locator('[role="listbox"]');
    const n = await lboxes.count();
    for (let i = 0; i < n; i++) {
      const lb = lboxes.nth(i);
      if (!(await lb.isVisible().catch(() => false))) continue;
      const labels = await lb
        .locator('[role="option"]')
        .allTextContents();
      if (labels.some((t) => /passage/i.test(t))) return lb;
    }
    return null;
  }

  /**
   * Find a button-like trigger whose text/aria-label says "passage".
   *
   * @returns {Promise<import("playwright").Locator | null>}
   * @private
   */
  async _findPassageTrigger() {
    const { page } = this;
    const candidates = [
      page.locator('button:has-text("Passage")'),
      page.locator('button[aria-label*="passage" i]'),
      page.locator('a:has-text("Passage")'),
      // The ProQyz classic: a div/span trigger with the word "Passage".
      page.locator('[class*="passage" i] >> role=button'),
    ];
    for (const c of candidates) {
      const n = await c.count();
      for (let i = 0; i < n; i++) {
        const el = c.nth(i);
        if (await el.isVisible().catch(() => false)) return el;
      }
    }
    return null;
  }

  /**
   * Pick `passageTitle` from a native <select> by label, then by index
   * (passageIdx + 1 to skip the placeholder at index 0).
   *
   * @param {import("playwright").Locator} sel
   * @param {string} passageTitle
   * @param {number} passageIdx
   * @private
   */
  async _chooseFromSelect(sel, passageTitle, passageIdx) {
    let usedFallback = false;
    try {
      await sel.selectOption({ label: passageTitle });
    } catch (err) {
      log.uploader.warn(
        { err: err.message, passageTitle },
        "selectOption by label failed; falling back to index",
      );
      usedFallback = true;
    }
    if (usedFallback) {
      await sel.selectOption({ index: passageIdx + 1 });
    }
  }

  /**
   * Click a combobox and pick `passageTitle` from the popup options.
   *
   * @param {import("playwright").Locator} cbox
   * @param {string} passageTitle
   * @private
   */
  async _chooseFromCombobox(cbox, passageTitle) {
    const { page } = this;
    await cbox.click();
    await page.waitForTimeout(250);
    // Options live in a popup; look page-wide for a matching role=option.
    const opt = page
      .locator('[role="option"]')
      .filter({ hasText: new RegExp(`^\\s*${escapeRegex(passageTitle)}\\s*$`, "i") })
      .first();
    if ((await opt.count()) === 0) {
      // Fall back to partial match.
      const partial = page
        .locator('[role="option"]')
        .filter({ hasText: new RegExp(escapeRegex(passageTitle), "i") })
        .first();
      if ((await partial.count()) === 0) {
        throw new Error(
          `_selectPassageInQuestionsTab: opened combobox but no option ` +
            `matched "${passageTitle}"`,
        );
      }
      await partial.click();
    } else {
      await opt.click();
    }
  }

  /**
   * Click a `passageTitle` option inside a listbox.
   *
   * @param {import("playwright").Locator} lb
   * @param {string} passageTitle
   * @private
   */
  async _chooseFromListbox(lb, passageTitle) {
    const opt = lb
      .locator('[role="option"]')
      .filter({ hasText: new RegExp(escapeRegex(passageTitle), "i") })
      .first();
    if ((await opt.count()) === 0) {
      throw new Error(
        `_selectPassageInQuestionsTab: listbox has no option matching ` +
          `"${passageTitle}"`,
      );
    }
    await opt.click();
  }

  /**
   * Wait for the "Choose Passage" empty-state to disappear — the
   * React re-render signal that the passage is wired up.
   *
   * @private
   */
  async _waitForEmptyStateGone() {
    const { page } = this;
    const empty = page.locator(Selectors.questionList.emptyState).first();
    await empty
      .waitFor({ state: "hidden", timeout: config.actionTimeoutMs })
      .catch(async () => {
        log.uploader.warn(
          {},
          "Choose Passage empty-state did not disappear; " +
            "Add Question click may fail",
        );
      });
  }

  /**
   * Wait for the page's skeleton placeholders (`.placeholder`,
   * `.placeholder-glow`) to disappear. The live 2026-06-09 dump
   * showed the Questions tab renders `placeholder-glow` rows while
   * the XHR for the question list is in flight. Probing a passage
   * picker during that window returns "0 <select>" because the
   * picker isn't mounted yet.
   *
   * We poll for ~3s with 200ms gaps. If placeholders are still
   * visible after that, we return anyway — the probe ladders in
   * `_selectPassageInQuestionsTab` will still try every shape.
   *
   * @private
   */
  async _waitForPlaceholdersGone() {
    const { page } = this;
    const placeholders = page.locator(
      ".placeholder, .placeholder-glow, [class*='placeholder']",
    );
    for (let i = 0; i < 15; i++) {
      const n = await placeholders.count();
      let anyVisible = false;
      for (let j = 0; j < n; j++) {
        if (await placeholders.nth(j).isVisible().catch(() => false)) {
          anyVisible = true;
          break;
        }
      }
      if (!anyVisible) return;
      await page.waitForTimeout(200);
    }
  }

  /**
   * Build a JSON inventory of every visible interactive element on
   * the page. Used by the no-control-found failure path of
   * `_selectPassageInQuestionsTab` for diagnosis.
   *
   * @param {import("playwright").Page} page
   * @returns {Promise<any[]>}
   * @private
   */
  async _dumpPageInventory(page) {
    return await page
      .locator(
        "select, input, textarea, button, a, [role=combobox], [role=listbox], [role=option], [role=tab], [contenteditable]",
      )
      .evaluateAll((els) =>
        els
          .filter((e) => {
            const cs = window.getComputedStyle(e);
            if (cs.display === "none" || cs.visibility === "hidden") {
              return false;
            }
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .slice(0, 100)
          .map((e) => ({
            tag: e.tagName.toLowerCase(),
            type: e.type ?? null,
            name: e.name ?? null,
            id: e.id ?? null,
            placeholder: e.placeholder ?? null,
            ariaLabel: e.getAttribute("aria-label"),
            role: e.getAttribute("role"),
            text: (e.textContent ?? "").trim().slice(0, 80),
            classes: (e.className ?? "").toString().slice(0, 120),
          })),
      )
      .catch(() => []);
  }

  /**
   * Pick the question type in the Add Reading Question modal.
   *
   * Real ProQyz renders step 1 of the modal as a react-select with
   * id="input-type". The visible options are FULL labels with
   * parenthetical descriptions; the keys in the dropdown don't match
   * the proqyzType codes.
   *
   * Two modes (in priority order):
   *
   *  1. **Index mode** — if `q.questionTypeIndex` is set on the
   *     question object (an integer), click the option at that
   *     index in the popup. The current dropdown order is:
   *       0 = Fill-up (typed answer questions)
   *       1 = Radio (single answer questions)
   *       2 = Select (select answers from a numerical/alphabetical list)
   *       3 = Checkbox (check the correct box(es) questions)
   *     Index mode is preferred because the dropdown ORDER is more
   *     stable than the verbose label text.
   *
   *  2. **Label mode (fallback)** — map `q.proqyzType` to the full
   *     label and filter-type-click in the popup. Used when the
   *     fixture predates the index scheme.
   *
   * If neither `#input-type` nor any `.question__components
   * [role="combobox"]` is present (e.g. local stub), this is a
   * no-op + warn. The stub uses a native `<select name="type">`
   * which `_addContentQuestion` / `_addOptionsQuestion` already
   * handle.
   *
   * After selection, the modal advances to step 2 (content area)
   * which is what the downstream fill helpers expect.
   *
   * @param {import("../../domain/schemas.js").Question} q
   * @private
   */
  async _pickQuestionTypeInEditor(q) {
    const { page } = this;
    const proqyzType = q.proqyzType;
    if (!Number.isInteger(q.questionTypeIndex)) {
      throw new Error(
        `_pickQuestionTypeInEditor: questionTypeIndex is required on every ` +
          `question (proqyzType="${q.proqyzType}", n=${q.number}). ` +
          `Add it to the fixture.`,
      );
    }
    const index = q.questionTypeIndex;

    // Detect the combobox. Real ProQyz: #input-type. Fallback: any
    // combobox inside the question modal.
    const container = page.locator('#input-type').first();
    let combobox;
    if (await container.isVisible().catch(() => false)) {
      combobox = container.locator('input[role="combobox"]').first();
    } else {
      const anyCbox = page.locator('.question__components [role="combobox"]').first();
      if (await anyCbox.isVisible().catch(() => false)) {
        combobox = anyCbox;
      } else {
        // No react-select on the page (e.g. local stub). Downstream
        // fill helpers will drive the native <select name="type">.
        log.uploader.debug(
          { proqyzType, index },
          "no question-type combobox visible; skipping (stub or already-picked)",
        );
        return;
      }
    }

    // Stable label table. Same dropdown order as the index mapping
    // (0 = Fill-up, 1 = Radio, 2 = Select, 3 = Checkbox) but
    // expressed as the full verbose text the popup actually renders.
    // We click the visible option by text — never type. Typing into
    // the combobox was the prior 34s/bottleneck bug.
    const LABEL_BY_TYPE_INDEX = {
      0: "Fill-up (typed answer questions)",
      1: "Radio (single answer questions)",
      2: "Select (select answers from a numerical/alphabetical list)",
      3: "Checkbox (check the correct box(es) questions)",
    };
    const label = LABEL_BY_TYPE_INDEX[index];
    if (!label) {
      throw new Error(
        `_pickQuestionTypeInEditor: no label mapping for questionTypeIndex=${index}`,
      );
    }

    // Open the popup. Use the Add combobox input.
    await combobox.click();
    await page.waitForTimeout(200);

    // Wait for the popup to render at least one option, then locate
    // the target by visible text. Clicking by text is robust against
    // popup re-mounts, virtual scrolling, and option order changes
    // — none of those affected the text content.
    const popupOption = page
      .locator('[role="option"], .el-select-dropdown__item, li[role="option"]')
      .filter({ hasText: label })
      .first();
    try {
      await popupOption.waitFor({ state: "visible", timeout: 5000 });
    } catch (err) {
      const dump = await page
        .locator('[role="option"], .el-select-dropdown__item, li[role="option"]')
        .allTextContents()
        .catch(() => []);
      log.uploader.error(
        { proqyzType, questionTypeIndex: index, label, available: dump },
        "question-type popup did not show the target option",
      );
      try {
        await captureFailure(page, `pick-failed-Q${q.number}-type-${q.proqyzType}`);
      } catch (capErr) {
        log.uploader.warn({ err: capErr.message }, "screenshot capture failed");
      }
      throw new Error(
        `_pickQuestionTypeInEditor: target option "${label}" not visible in ` +
          `popup for Q${q.number} (proqyzType="${q.proqyzType}", index=${index}). ` +
          `Available: ${JSON.stringify(dump)}`,
      );
    }

    // Sanity: confirm we are about to click a real, non-empty option.
    const optionText = ((await popupOption.textContent().catch(() => "")) || "").trim();
    if (!optionText) {
      log.uploader.error(
        { proqyzType, questionTypeIndex: index, label },
        "matched option has empty text — popup likely not open",
      );
      try {
        await captureFailure(page, `pick-failed-Q${q.number}-type-${q.proqyzType}`);
      } catch (capErr) {
        log.uploader.warn({ err: capErr.message }, "screenshot capture failed");
      }
      throw new Error(
        `_pickQuestionTypeInEditor: matched option for "${label}" has empty ` +
          `text — popup was not actually open (Q${q.number}).`,
      );
    }

    log.uploader.info(
      { proqyzType, questionTypeIndex: index, label, optionText },
      "picking question type by visible text",
    );
    await popupOption.click();

    // Commit the react-select selection. A bare click on the option
    // opens the menu but does NOT always commit the value on real
    // ProQyz — we have observed the popup close without the value
    // sticking, which leaves the modal stuck on the Basic tab and
    // the Question/Explanation/Preview/Finish tabs never render.
    // Press Enter to commit, then click outside as a belt-and-braces
    // fallback. No networkidle / waitForPageCalm here — the commit
    // is a synchronous react-select onChange; adding networkidle
    // would burn 5–10s for no benefit.
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(150);
    const modalRoot = page.locator(".question__components.modal.show").first();
    if (await modalRoot.isVisible().catch(() => false)) {
      await modalRoot.click({ position: { x: 5, y: 5 } }).catch(() => {});
    }
    await page.waitForTimeout(150);

    // Assert the type was actually committed. The Add field's
    // displayed text must now contain the option's short name
    // (e.g. "Fill-up"). If not, the selection did not stick —
    // screenshot and stop rather than continuing and hitting
    // "tab not found" downstream.
    const addField = page.locator('#input-type input[role="combobox"], #input-type').first();
    let committedText = "";
    try {
      await addField.waitFor({ state: "visible", timeout: 2000 });
      committedText = ((await addField.textContent().catch(() => "")) || "").trim();
    } catch {
      /* fall through to the assertion */
    }
    const shortName = label.split("(")[0].trim();
    const committed = !!shortName && committedText.includes(shortName);
    if (!committed) {
      log.uploader.error(
        { proqyzType, questionTypeIndex: index, label, optionText, committedText },
        "question type NOT committed after click+Enter — modal stuck on Basic tab",
      );
      try {
        await captureFailure(page, `pick-failed-Q${q.number}-type-${q.proqyzType}`);
      } catch (capErr) {
        log.uploader.warn({ err: capErr.message }, "screenshot capture failed");
      }
      throw new Error(
        `_pickQuestionTypeInEditor: type selection did not commit for Q${q.number} ` +
          `(proqyzType="${q.proqyzType}", index=${index}, label="${label}", ` +
          `optionText="${optionText}", committedText="${committedText}"). ` +
          `Modal is stuck on Basic tab.`,
      );
    }

    // The downstream fill helpers (_fillFillUpQuestion,
    // _fillSelectQuestion) drive the Question tab via their own
    // `clickTab(label)` helper. That helper uses a BROAD modal-scoped
    // text match (.tablist .tabs, .tablist li, [role='tab']) and is
    // the single source of truth for clicking into a tab. We do NOT
    // pre-assert all four tabs here — earlier attempts failed because
    // the assertion selector was tighter than what the real ProQyz
    // DOM uses for tab labels, even though the tabs were in fact
    // visible to the human operator. If the picker committed and the
    // type is set, we hand off; the fill helper's clickTab is the
    // canonical way to enter the Question tab.
    log.uploader.info(
      { proqyzType, questionTypeIndex: index, label, optionText, committedText },
      "question type committed — handing off to fill helper",
    );
  }

  /**
   * If `root` is itself a textarea or contenteditable, return it.
   * Otherwise return the first descendant that is. This handles two
   * shapes we see in the wild:
   *   1. Real ProQyz — a bare `<textarea>` (no wrapper).
   *   2. Sub-editors — a `<div data-testid="...">` containing a
   *      `<textarea>`.
   */
  async _resolveEditable(root) {
    const tag = (await root.evaluate((el) => el.tagName).catch(() => "")).toLowerCase();
    if (tag === "textarea" || tag === "input") return root;
    const isContentEditable = await root
      .evaluate((el) => el.getAttribute("contenteditable") === "true")
      .catch(() => false);
    if (isContentEditable) return root;
    // Drill in.
    const inner = root.locator("textarea, [contenteditable='true']").first();
    if ((await inner.count()) > 0) return inner;
    return root; // fall back; writePlain will throw a useful error
  }

  /**
   * Wait for the per-question editor to be visible. The editor is a
   * sub-page inside the quiz edit view; we scope by the
   * `questionEditor.container` selector. Falls back to the page body if
   * no scoped container is found.
   */
  async _waitForQuestionEditor() {
    const { page } = this;
    const container = page.locator(Selectors.questionEditor.container).first();
    if (await container.isVisible().catch(() => false)) {
      await container.waitFor({ state: "visible", timeout: config.actionTimeoutMs });
      return container;
    }
    log.uploader.debug(
      { container: Selectors.questionEditor.container },
      "questionEditor.container not visible; falling back to page body",
    );
    return page.locator("body");
  }

  /**
   * Resolve the per-blank answer list for a grouped Fill-up question
   * and verify the displayed answers match q.answers in order.
   *
   * ProQyz's Fill-up editor for grouped content (one question with N
   * `{answer}` placeholders) does NOT always expose per-blank inputs.
   * The live 2026-06-09 dump shows the answers rendered as READ-ONLY
   * badges (`<span class="badge bg-success">...</span>`) directly
   * below the TinyMCE editor, populated by ProQyz's brace-scanning
   * pass shortly after `insertText` commits the content. We treat
   * this as the **primary path** — verify the badges' text matches
   * q.answers; if so, no fill is needed.
   *
   * Three strategies in order:
   *
   *   1. **Badge auto-extract (primary).** ProQyz renders N answer
   *      badges under the editor. We wait for N badges to appear,
   *      read their text, and assert each equals q.answers[i] (case
   *      and trim-insensitive, then a strict case-trimmed equality).
   *      If they match, we're done. If the count is wrong or the
   *      text is empty, ProQyz hasn't auto-extracted yet — wait
   *      briefly and retry once.
   *
   *   2. **Per-blank inputs (fallback).** If no badges, look for N
   *      fillable input controls. ProQyz sometimes renders editable
   *      text inputs instead of badges. We try several selectors,
   *      fill them in brace order, then read back and assert.
   *
   *   3. **Newline-joined textarea (last resort).** Some forms
   *      expose a single textarea and expect one answer per line.
   *      We paste `answers.join("\n")` into the textarea and read
   *      it back. This is a documented fallback per user spec.
   *
   * On any failure path (no control at all, count mismatch, or
   * read-back mismatch), we captureFailure the page to
   * `failures/answer-list-{probe|readback}-QS-E.{html,png}` and
   * throw — we do NOT silently proceed, per the spec's
   * "do not invent a workaround" rule.
   *
   * @param {import("../../domain/schemas.js").Question} q
   * @param {import("playwright").Locator} modal
   * @private
   */
  async _fillGroupedAnswerList(q, modal) {
    const { page } = this;
    const expected = q.answers.length;
    const tag = `Q${q.numberStart}-${q.numberEnd}`;

    // The per-blank answer badges (or per-blank inputs, or
    // single-answer textarea) live somewhere below the TinyMCE
    // editor on the Question tab. The badge path is primary because
    // ProQyz auto-extracts from the {answer} braces; we just verify
    // the badge text matches q.answers in order.
    //
    // Hoist the locator to function scope so both the polling
    // helper and the verification block can use it without
    // re-querying. (Earlier draft had it inside the closure, which
    // produced a ReferenceError when the verification block ran
    // after waitForBadges returned.)
    const badgeLoc = modal.locator(".badge.bg-success");

    // TinyMCE's brace scan can take a moment. Wait up to ~2.4s for
    // the badge count to settle at `expected`. We poll six times
    // with a 400ms gap — that's the longest the live run has taken.
    const waitForBadges = async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const n = await badgeLoc.count();
        if (n >= expected) return n;
        await page.waitForTimeout(400);
      }
      return await badgeLoc.count();
    };

    // ----------------------------------------------------------------
    // Strategy 1: read-only badges (ProQyz auto-extract path).
    // ----------------------------------------------------------------
    const badgeCount = await waitForBadges();
    if (badgeCount >= expected) {
      const badgeTexts = [];
      for (let i = 0; i < expected; i++) {
        const t = (await badgeLoc.nth(i).innerText().catch(() => "")).trim();
        badgeTexts.push(t);
      }
      // Strict case-trimmed equality first.
      const strictMismatches = [];
      for (let i = 0; i < expected; i++) {
        if (badgeTexts[i] !== String(q.answers[i]).trim()) {
          strictMismatches.push({
            i,
            want: q.answers[i],
            got: badgeTexts[i],
          });
        }
      }
      if (strictMismatches.length === 0) {
        log.uploader.debug(
          { tag, count: expected, strategy: "badges" },
          "grouped answer list: badges auto-extracted and verified",
        );
        return;
      }

      // Try case-insensitive match (ProQyz's brace rule is
      // case-insensitive). If it matches, treat as success — the
      // braces' inner text in the content is also the same string
      // and the brace-rule already validates it.
      const ciMismatch = strictMismatches.find(
        (m) =>
          String(m.got).trim().toUpperCase() !==
          String(m.want).trim().toUpperCase(),
      );
      if (!ciMismatch) {
        log.uploader.warn(
          { tag, mismatches: strictMismatches, strategy: "badges" },
          "badge text differs only in casing; accepting (case-insensitive by spec)",
        );
        return;
      }

      // Real mismatch — ProQyz extracted the wrong text or stale
      // text from a previous edit. Capture and throw.
      await this._captureAndThrowAnswerListFailure(
        page,
        q,
        tag,
        "readback",
        {
          strategy: "badges",
          want: q.answers,
          got: badgeTexts,
          mismatches: strictMismatches,
        },
        `readback mismatch for grouped fill_up ${tag}: ${JSON.stringify(strictMismatches)}`,
      );
    }

    // ----------------------------------------------------------------
    // Strategy 2: per-blank inputs (some forms expose editable text
    // inputs instead of badges). Try several selectors.
    // ----------------------------------------------------------------
    const inputCandidates = [
      modal.locator('input[name*="answer" i][id*="answer" i]'),
      modal.locator('input[placeholder*="answer" i]'),
      modal.locator('input[aria-label*="answer" i]'),
      modal.locator('input[name*="answer" i]'),
    ];
    for (const c of inputCandidates) {
      const count = await c.count();
      if (count < expected) continue;
      // Filter to visible.
      const visibleIdx = [];
      for (let i = 0; i < count; i++) {
        if (await c.nth(i).isVisible().catch(() => false)) visibleIdx.push(i);
        if (visibleIdx.length >= expected) break;
      }
      if (visibleIdx.length < expected) continue;

      // Fill in brace order.
      for (let i = 0; i < expected; i++) {
        await c.nth(visibleIdx[i]).fill(q.answers[i]);
      }
      // Blur to commit.
      await page.keyboard.press("Tab");
      await page.waitForTimeout(150);

      const readback = [];
      for (let i = 0; i < expected; i++) {
        readback.push(await c.nth(visibleIdx[i]).inputValue());
      }
      const mismatches = [];
      for (let i = 0; i < expected; i++) {
        if (String(readback[i]).trim() !== String(q.answers[i]).trim()) {
          mismatches.push({ i, want: q.answers[i], got: readback[i] });
        }
      }
      if (mismatches.length === 0) {
        log.uploader.debug(
          { tag, count: expected, strategy: "inputs" },
          "grouped answer list: per-blank inputs filled and verified",
        );
        return;
      }
      await this._captureAndThrowAnswerListFailure(
        page,
        q,
        tag,
        "readback",
        { strategy: "inputs", want: q.answers, got: readback, mismatches },
        `input readback mismatch for grouped fill_up ${tag}: ${JSON.stringify(mismatches)}`,
      );
    }

    // ----------------------------------------------------------------
    // Strategy 3: newline-joined textarea (single answer field).
    // ----------------------------------------------------------------
    const textareaCandidates = [
      modal.locator('textarea[name*="answer" i]'),
      modal.locator('textarea[placeholder*="answer" i]'),
      modal.locator('textarea[aria-label*="answer" i]'),
    ];
    for (const t of textareaCandidates) {
      const count = await t.count();
      if (count === 0) continue;
      const ta = t.first();
      if (!(await ta.isVisible().catch(() => false))) continue;
      const joined = q.answers.join("\n");
      await ta.fill(joined);
      // Trigger a change event for React-style controlled textareas.
      await ta.dispatchEvent("change").catch(() => {});
      await page.keyboard.press("Tab");
      await page.waitForTimeout(150);

      const got = (await ta.inputValue()).trim();
      const expected_ = q.answers.map((a) => String(a).trim()).join("\n");
      if (got === expected_) {
        log.uploader.debug(
          { tag, count: expected, strategy: "textarea" },
          "grouped answer list: textarea filled and verified (newline-joined)",
        );
        return;
      }
      await this._captureAndThrowAnswerListFailure(
        page,
        q,
        tag,
        "readback",
        { strategy: "textarea", want: expected_, got, joined },
        `textarea readback mismatch for grouped fill_up ${tag}: want ${JSON.stringify(expected_)}, got ${JSON.stringify(got)}`,
      );
    }

    // ----------------------------------------------------------------
    // No strategy matched. Capture and throw with a rich inventory.
    // ----------------------------------------------------------------
    const inventory = await this._dumpModalInventory(modal);
    await this._captureAndThrowAnswerListFailure(
      page,
      q,
      tag,
      "probe",
      { expected, badgeCount, inventory },
      `no per-blank answer control found on Question tab for grouped fill_up ${tag} (expected ${expected} answers; saw ${badgeCount} badge(s)). HTML+PNG dumped to failures/answer-list-probe-${tag}.*`,
    );
  }

  /**
   * Capture an HTML+PNG dump of the current page state and throw a
   * descriptive error. Used by `_fillGroupedAnswerList` for both the
   * "no control found" probe failure and the "control found but
   * read-back mismatched" failure.
   *
   * @private
   */
  async _captureAndThrowAnswerListFailure(page, q, tag, phase, extra, message) {
    const failureName = `answer-list-${phase}-${tag}`;
    try {
      await captureFailure(page, failureName);
    } catch (capErr) {
      log.uploader.warn(
        { err: capErr.message },
        "captureFailure itself failed during answer-list failure dump",
      );
    }
    log.uploader.error(
      {
        n: q.number,
        numberStart: q.numberStart,
        numberEnd: q.numberEnd,
        ...extra,
      },
      `grouped answer list (${phase}) failure for ${tag}`,
    );
    throw new Error(`_fillGroupedAnswerList: ${message}`);
  }

  /**
   * Build a JSON inventory of the visible interactive elements in the
   * Question-tab modal — inputs, textareas, contenteditable, role=textbox,
   * buttons/tabs/labels containing "answer", "answers", "correct", etc.
   * Used by the no-control-found failure path to help diagnose.
   *
   * @param {import("playwright").Locator} modal
   * @returns {Promise<any[]>}
   * @private
   */
  async _dumpModalInventory(modal) {
    return await modal
      .locator(
        "input, textarea, [contenteditable], [role=textbox], button, [role=tab], label",
      )
      .evaluateAll((els) =>
        els
          .filter((e) => {
            const cs = window.getComputedStyle(e);
            if (cs.display === "none" || cs.visibility === "hidden") {
              return false;
            }
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .slice(0, 80)
          .map((e) => ({
            tag: e.tagName.toLowerCase(),
            type: e.type ?? null,
            name: e.name ?? null,
            id: e.id ?? null,
            placeholder: e.placeholder ?? null,
            ariaLabel: e.getAttribute("aria-label"),
            role: e.getAttribute("role"),
            contenteditable:
              e.getAttribute("contenteditable") === "" ||
              e.getAttribute("contenteditable") === "true"
                ? true
                : false,
            text: (e.textContent ?? "").trim().slice(0, 80),
            classes: (e.className ?? "").toString().slice(0, 120),
          })),
      )
      .catch(() => []);
  }

  /**
   * Fill-up-only flow for the Add Reading Question modal on real
   * ProQyz. The modal is a TAB-CARD with five tabs:
   *   Basic | Question | Explanation | Preview | Finish
   *
   * Steps:
   *   1. The type was already picked in `_pickQuestionTypeInEditor`
   *      (Basic tab).
   *   2. Click the "Question" tab. A TinyMCE editor appears. Write
   *      `q.content` (already contains `{answer}` braces — ProQyz
   *      extracts the answer from them automatically).
   *   3. For GROUPED fill_up (q.answers.length > 1): probe the Question
   *      tab for a per-blank answer-list control, fill one answer per
   *      placeholder in order, then read back and assert every value
   *      matches q.answers in order. captureFailure + throw on mismatch.
   *   4. Skip "Explanation" tab.
   *   5. Skip "Preview" tab.
   *   6. Click "Finish" tab. Set:
   *        - title: q.displayTitle (always present post-normalize; for
   *          legacy single-blank this is "Question N", for grouped
   *          fill_up this is "Questions S-E")
   *        - category: "Uncategorized" (default; no custom logic yet)
   *   7. Click "Create Question". The modal closes and the question
   *      appears in the list.
   *
   * The stub does not have these tabs; the helper bails out cleanly
   * in that case so the dry-run smoke still passes.
   *
   * @param {import("../../domain/schemas.js").Question} q
   * @private
   */
  async _fillFillUpQuestion(q) {
    const { page } = this;
    const modal = page.locator(".question__components.modal.show").first();

    // Helper: click a tab inside the question modal by visible text.
    // Tolerant of leading/trailing whitespace. NO waitForPageCalm after
    // the click — the tab panel is visible immediately; networkidle
    // would block for 5-10s with no benefit.
    const clickTab = async (label) => {
      const tab = modal
        .locator(".tablist .tabs, .tablist li, [role='tab']")
        .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, "i") })
        .first();
      await tab
        .waitFor({ state: "visible", timeout: config.actionTimeoutMs })
        .catch(async () => {
          throw new Error(
            `_fillFillUpQuestion: tab "${label}" not found inside the question modal`,
          );
        });
      await tab.click();
      // Tiny settle delay only — no networkidle, no calm wait.
      await page.waitForTimeout(150);
    };

    // Wait for the Question tab panel to actually render after the
    // click. The panel content is one of:
    //   - instruction text "Use { } brackets"
    //   - a TinyMCE editor iframe
    //   - a Media button inside the Question panel
    const waitForQuestionPanel = async () => {
      const instruction = modal.locator(':text("Use { } brackets")').first();
      const tmEditor = modal.locator(
        'iframe[class*="tox-edit-area__iframe"], textarea[id^="tiny-react_"]',
      ).first();
      const mediaBtn = modal.locator(':text("Media")').first();
      // Wait for ANY of the three. Whichever comes first wins.
      await Promise.race([
        instruction.waitFor({ state: "visible", timeout: 5000 }).catch(() => null),
        tmEditor.waitFor({ state: "visible", timeout: 5000 }).catch(() => null),
        mediaBtn.waitFor({ state: "visible", timeout: 5000 }).catch(() => null),
      ]);
    };

    // Stub guard: if the modal exists but the tablist doesn't, bail.
    const tablist = modal.locator(".tablist").first();
    if (!(await tablist.isVisible().catch(() => false))) {
      log.uploader.debug(
        { n: q.number },
        "no tablist in question modal (stub); skipping Fill-up fill",
      );
      return;
    }

    // Step 2 — Question tab: write the content into the TinyMCE
    // iframe. The fixture's `content` already contains the `{answer}`
    // placeholder; ProQyz auto-extracts.
    const tSwitchToQStart = Date.now();
    await clickTab("Question");
    // Wait for the Question tab panel to render (not networkidle).
    // Three-way race: instruction text, TinyMCE editor, Media button.
    await waitForQuestionPanel();
    const tSwitchToQEnd = Date.now();

    const tFillQStart = Date.now();

    // For grouped fill_up (q.answers.length > 1): ProQyz
    // auto-extracts the text INSIDE each {brace} as the answer.
    // If the content has generic {answer} placeholders, ProQyz
    // will show "answer" N times instead of the real answers.
    // Replace each {answer} with {answers[i]} so ProQyz
    // extracts the correct values.
    let pasteContent = q.content;
    if (Array.isArray(q.answers) && q.answers.length > 1) {
      pasteContent = _replaceGroupedPlaceholders(q.content, q.answers);
      log.uploader.info(
        { n: q.number, answers: q.answers },
        "replaced {answer} placeholders with actual answers",
      );
    }

    const tmIframe = modal
      .locator('iframe[class*="tox-edit-area__iframe"]')
      .first();
    const tmAttached = await tmIframe
      .waitFor({ state: "attached", timeout: config.actionTimeoutMs })
      .then(() => true)
      .catch(() => false);
    if (!tmAttached) {
      // No TinyMCE on the Question tab; try a plain contenteditable.
      const ce = modal.locator('[contenteditable="true"]').first();
      if (await ce.isVisible().catch(() => false)) {
        await ce.click();
        await page.keyboard.insertText(pasteContent);
      } else {
        throw new Error(
          `_fillFillUpQuestion: no editor found on Question tab for Q${q.number}`,
        );
      }
    } else {
      // Drive the iframe like the passage editor does (focus, select-all,
      // delete, insertText). This bypasses the MathJax plugin and routes
      // through TinyMCE's own input pipeline.
      const frame = await tmIframe.contentFrame();
      if (!frame) {
        throw new Error(
          `_fillFillUpQuestion: TinyMCE iframe present but no contentFrame`,
        );
      }
      const body = frame.locator("body#tinymce, body.mce-content-body").first();
      await body.click();
      await page.waitForTimeout(150);
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      await page.waitForTimeout(100);
      await page.keyboard.insertText(pasteContent);
      await page.waitForTimeout(200);
      // Blur the editor so the brace-scan pass fires and the
      // answer badges / per-blank controls render. ProQyz's
      // scan-on-blur was confirmed via the 2026-06-09 dump.
      await page.keyboard.press("Tab");
      await page.waitForTimeout(400);
    }
    const tFillQEnd = Date.now();

    // Steps 3-4 — Explanation and Preview tabs are skipped (no action).

    // Step 5 — Finish tab: set title and category.
    const tSwitchToFinishStart = Date.now();
    await clickTab("Finish");
    const tSwitchToFinishEnd = Date.now();

    // Title input. Real ProQyz uses an input with name="title" or a
    // similar marker. Try a few candidates.
    const titleCandidates = [
      modal.locator('input[name="title"]').first(),
      modal.locator('input[placeholder*="title" i]').first(),
      modal.locator('input[id*="title" i]').first(),
    ];
    let titleField = null;
    for (const cand of titleCandidates) {
      if (await cand.isVisible().catch(() => false)) {
        titleField = cand;
        break;
      }
    }
    if (!titleField) {
      throw new Error(
        `_fillFillUpQuestion: no title input found on Finish tab for Q${q.number}`,
      );
    }
    await titleField.fill(q.displayTitle ?? `Question ${q.number}`);

    // Category — pick "Uncategorized". This may be a react-select
    // (combobox) or a native <select>; try both.
    const catValue = "Uncategorized";
    const catCbox = modal.locator('.tab-content__box [role="combobox"]').first();
    if (await catCbox.isVisible().catch(() => false)) {
      await catCbox.click();
      await page.waitForTimeout(200);
      const opt = page
        .locator(`[role="option"]`)
        .filter({ hasText: new RegExp(`^\\s*${catValue}\\s*$`, "i") })
        .first();
      if (await opt.isVisible().catch(() => false)) {
        await opt.click();
      } else {
        const all = await page.locator("[role='option']").allTextContents();
        log.uploader.warn(
          { catValue, available: all },
          "Uncategorized option not found in category popup; leaving default",
        );
        await page.keyboard.press("Escape");
      }
    } else {
      const catSel = modal.locator('select[name*="category" i]').first();
      if (await catSel.isVisible().catch(() => false)) {
        // Try by value, then by label.
        const ok = await catSel
          .selectOption({ label: catValue })
          .catch(() => null);
        if (ok === null) {
          await catSel
            .selectOption({ label: catValue })
            .catch((err) => {
              log.uploader.warn(
                { err: err.message, catValue },
                "category selectOption failed; leaving default",
              );
            });
        }
      } else {
        log.uploader.debug(
          { n: q.number },
          "no category control found; leaving default",
        );
      }
    }

    // Step 6 — Create Question button. Footer of the modal.
    const tCreateStart = Date.now();
    const createBtn = modal
      .locator('button:has-text("Create Question"), button:has-text("Save"), button[type="submit"]')
      .first();
    await createBtn
      .waitFor({ state: "visible", timeout: config.actionTimeoutMs })
      .catch(async () => {
        throw new Error(
          `_fillFillUpQuestion: no Create Question button on Q${q.number} modal`,
        );
      });
    await Promise.all([
      modal.waitFor({ state: "hidden", timeout: config.saveTimeoutMs }).catch(() => null),
      createBtn.click(),
    ]);
    // Modal is closed — short settle only. Full waitForPageCalm
    // would block 5-10s on networkidle for no benefit.
    await page.waitForTimeout(300);
    const tCreateEnd = Date.now();

    log.uploader.info(
      {
        n: q.number,
        msSwitchToQuestionTab: tSwitchToQEnd - tSwitchToQStart,
        msFillQuestionTab: tFillQEnd - tFillQStart,
        msSwitchToFinishTab: tSwitchToFinishEnd - tSwitchToFinishStart,
        msFillFinishAndCreate: tCreateEnd - tSwitchToFinishStart,
        msCreateAndClose: tCreateEnd - tCreateStart,
      },
      "PROFILE: _fillFillUpQuestion timings",
    );
  }

  /**
   * Select-only flow for the Add Reading Question modal.
   *
   * Used for IELTS True / False / Not Given questions and any
   * proqyzType === "select" question. The type is already picked
   * (index 2) by `_pickQuestionTypeInEditor` on the Basic tab.
   *
   * Flow:
   *   1. Click "Question" tab.
   *   2. Set "Default Options" dropdown to the value derived from
   *      `q.defaultOptions` (e.g. "true_false_not_given").
   *   3. Set "Number of Options" to match the default options list
   *      length (e.g. 3 for True/False/Not Given).
   *   4. Paste question text into the content editor.
   *   5. Pick the correct answer from the per-question default-options
   *      dropdown (e.g. TRUE / FALSE / NOT GIVEN).
   *   6. Skip Explanation / Preview tabs.
   *   7. Finish tab: title = "Question N", category = "Uncategorized".
   *   8. Click "Create Question".
   *
   * IMPORTANT: this is NOT Radio. The Select editor renders the
   * default options in a dropdown per question; do NOT create custom
   * A/B/C/D options.
   *
   * @param {import("../../domain/schemas.js").Question} q
   * @private
   */
  async _fillSelectQuestion(q) {
    const { page } = this;
    const modal = page.locator(".question__components.modal.show").first();

    // Same clickTab helper pattern as Fill-up. NO waitForPageCalm
    // after the click.
    const clickTab = async (label) => {
      const tab = modal
        .locator(".tablist .tabs, .tablist li, [role='tab']")
        .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, "i") })
        .first();
      await tab
        .waitFor({ state: "visible", timeout: config.actionTimeoutMs })
        .catch(async () => {
          throw new Error(
            `_fillSelectQuestion: tab "${label}" not found inside the question modal`,
          );
        });
      await tab.click();
      await page.waitForTimeout(150);
    };

    // Stub guard.
    const tablist = modal.locator(".tablist").first();
    if (!(await tablist.isVisible().catch(() => false))) {
      log.uploader.debug(
        { n: q.number },
        "no tablist in question modal (stub); skipping Select fill",
      );
      return;
    }

    // Step 1 — Question tab.
    const tSwitchToQStart = Date.now();
    await clickTab("Question");
    const tSwitchToQEnd = Date.now();
    const tFillQStart = Date.now();

    // Step 2 — Default Options dropdown. The 2026-06-09 dump showed
    // ProQyz renders this as `<select id="default-options">` with no
    // name attribute, with options like `i`, `I`, `A`, `a`, `1`,
    // `true-false-notgiven`, `yes-no-notgiven`, `custom`. We probe
    // several shapes (id, name, class, role, label-nearby) before
    // declaring failure.
    if (q.defaultOptions) {
      const value = defaultOptionsToSelectValue(q.defaultOptions);
      const defaultOptsSel = await this._findDefaultOptionsSelect(modal);
      if (defaultOptsSel) {
        await defaultOptsSel
          .selectOption(value)
          .catch(async (err) => {
            // Some values are hyphenated (true-false-notgiven). If
            // the literal value doesn't match, try the option's
            // visible text — covers the case where the ProQyz
            // option uses different value/text pairs.
            const allTexts = await defaultOptsSel
              .locator("option")
              .allTextContents();
            const match = allTexts.find(
              (t) =>
                t
                  .trim()
                  .toLowerCase()
                  .replace(/\s+/g, "-") === value.toLowerCase() ||
                t.trim().toLowerCase().includes(value.toLowerCase()),
            );
            if (!match) {
              throw new Error(
                `_fillSelectQuestion: cannot set Default Options to "${value}" ` +
                  `for Q${q.number} (no matching option; saw ${JSON.stringify(allTexts)}; ` +
                  `original error: ${err.message})`,
              );
            }
            await defaultOptsSel.selectOption({ label: match });
          });
        log.uploader.info(
          { n: q.number, defaultOptions: q.defaultOptions, value },
          "Default Options set",
        );
      } else {
        // No control found via the structured probes. As a last
        // resort, look for a non-select control (combobox, listbox,
        // button trigger) — see fallback ladder in
        // `_findDefaultOptionsControl`.
        const altControl = await this._findDefaultOptionsControl(modal);
        if (altControl) {
          const valueLabel = value
            .replace(/-/g, " ")
            .replace(/true/i, "True")
            .replace(/false/i, "False")
            .replace(/notgiven/i, "Not Given");
          await this._chooseFromCombobox(altControl, valueLabel);
          log.uploader.info(
            {
              n: q.number,
              defaultOptions: q.defaultOptions,
              value,
              strategy: "combobox-fallback",
            },
            "Default Options set via combobox fallback",
          );
        } else {
          // Last-ditch: dump the inventory so the next iteration
          // knows what shape to look for.
          const failureName = `default-options-probe-Q${q.number}`;
          try {
            await captureFailure(page, failureName);
          } catch (capErr) {
            log.uploader.warn(
              { err: capErr.message },
              "captureFailure itself failed during default-options probe",
            );
          }
          const inventory = await this._dumpModalInventory(modal);
          log.uploader.error(
            {
              n: q.number,
              defaultOptions: q.defaultOptions,
              value,
              inventory,
            },
            "_fillSelectQuestion: Default Options control not found",
          );
          throw new Error(
            `_fillSelectQuestion: Default Options control not found on ` +
              `Question tab for Q${q.number} (code: ${q.defaultOptions}, ` +
              `value: ${value}). HTML+PNG dumped to failures/${failureName}.*`,
          );
        }
      }
    } else {
      throw new Error(
        `_fillSelectQuestion: q.defaultOptions is required for proqyzType=select (Q${q.number})`,
      );
    }

    // Step 3 — Number of Options. For true_false_not_given this
    // is 3. If the UI exposes this control, set it. If absent,
    // skip silently.
    const numOptsInput = modal
      .locator('input[name="numOptions"], input[name="number_of_options"], input[name="optionCount"]')
      .first();
    if (await numOptsInput.isVisible().catch(() => false)) {
      // Compute count from defaultOptions code.
      const countByCode = {
        true_false_not_given: 3,
        yes_no_not_given: 3,
        roman_lower: 5,
        roman_upper: 5,
        capital_letters: 4,
        lowercase_letters: 4,
        numeric: 4,
      };
      const count = countByCode[q.defaultOptions] ?? 3;
      await numOptsInput.fill(String(count));
    }

    // Step 4 — Question text. Select uses a TinyMCE editor
    // (iframe[class*="tox-edit-area__iframe"]) on the Question tab.
    //
    // The 2026-06-09 live dump showed the iframe is attached but
    // ProQyz may apply `style="visibility: hidden"` to it during
    // layout transitions (after Default Options change, after tab
    // switch, after brace scan). `state: "attached"` returns
    // immediately even when the iframe is not interactable. We
    // therefore:
    //   1. wait for `state: "visible"` (which checks the visibility
    //      style), with a generous timeout;
    //   2. if `visible` times out, try `state: "attached"` and
    //      explicitly check `isVisible()` on the iframe AND the
    //      `body#tinymce` inside the content frame;
    //   3. as a last resort, fall back to a plain textarea outside
    //      the iframe.
    const tmIframe = modal
      .locator('iframe[class*="tox-edit-area__iframe"]')
      .first();

    // Try visible first.
    let tmReady = await tmIframe
      .waitFor({ state: "visible", timeout: config.actionTimeoutMs })
      .then(() => true)
      .catch(() => false);

    if (!tmReady) {
      // Iframe might be in DOM but hidden. Try attached + manual
      // visibility check inside the content frame.
      const tmAttached = await tmIframe
        .waitFor({ state: "attached", timeout: 1500 })
        .catch(() => null);
      if (tmAttached) {
        const iframeVis = await tmIframe.isVisible().catch(() => false);
        if (iframeVis) {
          tmReady = true;
        } else {
          // Poll for the iframe to become visible while the
          // page is settling (e.g. after Default Options change).
          for (let i = 0; i < 8; i++) {
            await page.waitForTimeout(250);
            if (await tmIframe.isVisible().catch(() => false)) {
              tmReady = true;
              break;
            }
          }
        }
      }
    }

    if (tmReady) {
      const frame = await tmIframe.contentFrame();
      if (!frame) {
        throw new Error(
          `_fillSelectQuestion: TinyMCE iframe present but no contentFrame for Q${q.number}`,
        );
      }
      const body = frame
        .locator("body#tinymce, body.mce-content-body")
        .first();
      // Ensure the body is also visible/ready (TinyMCE sometimes
      // hides the body while initialising).
      for (let i = 0; i < 6; i++) {
        if (await body.isVisible().catch(() => false)) break;
        await page.waitForTimeout(200);
      }
      // Click the body to focus TinyMCE. Some versions of TinyMCE
      // need an extra "focus" call to enable input; if click() fails
      // because of the hidden ancestor, fall back to evaluate() to
      // set caret directly.
      try {
        await body.click({ timeout: 3000 });
      } catch (err) {
        log.uploader.debug(
          { n: q.number, err: err.message },
          "TinyMCE body.click() failed; falling back to evaluate() focus",
        );
        await body
          .evaluate((el) => {
            el.focus();
            if (typeof el.click === "function") el.click();
          })
          .catch(() => {});
      }
      await page.waitForTimeout(150);
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      await page.waitForTimeout(100);
      // Strip the leading "N " prefix from the content; the
      // Question tab on Select doesn't need it (the question
      // number is in the Title field on the Finish tab).
      const text = String(q.content || "").replace(/^\d+\s+/, "");
      await page.keyboard.insertText(text);
      await page.waitForTimeout(200);
    } else {
      // No TinyMCE — try a plain textarea fallback.
      const plainTa = modal
        .locator('textarea[name="content"], textarea[name="question"]')
        .first();
      if (await plainTa.isVisible().catch(() => false)) {
        await plainTa.fill(String(q.content || "").replace(/^\d+\s+/, ""));
      } else {
        // Final fallback: dump the inventory and throw.
        const failureName = `select-content-editor-probe-Q${q.number}`;
        try {
          await captureFailure(page, failureName);
        } catch (capErr) {
          log.uploader.warn(
            { err: capErr.message },
            "captureFailure itself failed during content-editor probe",
          );
        }
        const inventory = await this._dumpModalInventory(modal);
        log.uploader.error(
          {
            n: q.number,
            iframeCount: await modal
              .locator('iframe[class*="tox-edit-area__iframe"]')
              .count(),
            iframeVisible: await tmIframe.isVisible().catch(() => false),
            inventory,
          },
          "_fillSelectQuestion: no content editor found",
        );
        throw new Error(
          `_fillSelectQuestion: no content editor (TinyMCE or textarea) found for Q${q.number}. ` +
            `HTML+PNG dumped to failures/${failureName}.*`,
        );
      }
    }

    // Step 5 — Answer dropdown. The per-question "correct answer"
    // control on the Select editor is a react-select or native
    // <select> populated with the default options. We pick the
    // value matching `q.answer` (one of TRUE / FALSE / NOT GIVEN).
    if (q.answer) {
      // Try a native <select> first (most common on ProQyz).
      const answerSel = modal
        .locator('select[name="answer"], select[name="correct"]')
        .first();
      if (await answerSel.isVisible().catch(() => false)) {
        await answerSel
          .selectOption({ label: q.answer })
          .catch(async () => {
            // Try by value (TRUE/FALSE/NOT GIVEN are often the values).
            await answerSel
              .selectOption(q.answer)
              .catch((err) => {
                throw new Error(
                  `_fillSelectQuestion: cannot pick answer "${q.answer}" ` +
                    `for Q${q.number} (${err.message})`,
                );
              });
          });
        log.uploader.info(
          { n: q.number, answer: q.answer },
          "answer picked (native select)",
        );
      } else {
        // react-select dropdown.
        const answerCombo = modal
          .locator('[role="combobox"]')
          .filter({ hasText: /select|choose|answer/i })
          .first();
        if (await answerCombo.isVisible().catch(() => false)) {
          await answerCombo.click();
          await page.waitForTimeout(200);
          const opt = page
            .locator("[role='option']")
            .filter({ hasText: new RegExp(`^\\s*${q.answer}\\s*$`, "i") })
            .first();
          if (await opt.isVisible().catch(() => false)) {
            await opt.click();
            log.uploader.info(
              { n: q.number, answer: q.answer },
              "answer picked (react-select)",
            );
          } else {
            const all = await page.locator("[role='option']").allTextContents();
            throw new Error(
              `_fillSelectQuestion: answer option "${q.answer}" not in popup. ` +
                `Available: ${JSON.stringify(all)}`,
            );
          }
        } else {
          throw new Error(
            `_fillSelectQuestion: no answer control found on Question tab for Q${q.number}`,
          );
        }
      }
    } else {
      throw new Error(
        `_fillSelectQuestion: q.answer is required for proqyzType=select (Q${q.number})`,
      );
    }
    const tFillQEnd = Date.now();

    // Skip Explanation / Preview.

    // Step 7 — Finish tab.
    const tSwitchToFinishStart = Date.now();
    await clickTab("Finish");
    const tSwitchToFinishEnd = Date.now();

    // Title = "Question N".
    const titleCandidates = [
      modal.locator('input[name="title"]').first(),
      modal.locator('input[placeholder*="title" i]').first(),
      modal.locator('input[id*="title" i]').first(),
    ];
    let titleField = null;
    for (const cand of titleCandidates) {
      if (await cand.isVisible().catch(() => false)) {
        titleField = cand;
        break;
      }
    }
    if (titleField) {
      await titleField.fill(`Question ${q.number}`);
    } else {
      throw new Error(
        `_fillSelectQuestion: no title input found on Finish tab for Q${q.number}`,
      );
    }

    // Category = "Uncategorized".
    const catValue = "Uncategorized";
    const catCombo = modal
      .locator('[role="combobox"]')
      .filter({ hasText: /categor/i })
      .first();
    if (await catCombo.isVisible().catch(() => false)) {
      await catCombo.click();
      await page.waitForTimeout(200);
      const catOpt = page
        .locator("[role='option']")
        .filter({ hasText: new RegExp(`^\\s*${catValue}\\s*$`, "i") })
        .first();
      if (await catOpt.isVisible().catch(() => false)) {
        await catOpt.click();
      } else {
        // Fall back to Escape to close the popup and leave default.
        await page.keyboard.press("Escape");
      }
    } else {
      const catSel = modal.locator('select[name*="category" i]').first();
      if (await catSel.isVisible().catch(() => false)) {
        await catSel
          .selectOption({ label: catValue })
          .catch(() => null);
      }
    }

    // Step 8 — Create Question button.
    const createBtn = modal
      .locator('button:has-text("Create Question"), button:has-text("Save"), button[type="submit"]')
      .first();
    await createBtn
      .waitFor({ state: "visible", timeout: config.actionTimeoutMs })
      .catch(async () => {
        throw new Error(
          `_fillSelectQuestion: no Create Question button on Q${q.number} modal`,
        );
      });
    await Promise.all([
      modal.waitFor({ state: "hidden", timeout: config.saveTimeoutMs }).catch(() => null),
      createBtn.click(),
    ]);
    await waitForPageCalm(page, { timeoutMs: config.saveTimeoutMs });
    const tCreateEnd = Date.now();

    log.uploader.info(
      {
        n: q.number,
        msSwitchToQuestionTab: tSwitchToQEnd - tSwitchToQStart,
        msFillQuestionTab: tFillQEnd - tFillQStart,
        msSwitchToFinishTab: tSwitchToFinishEnd - tSwitchToFinishStart,
        msFillFinishAndCreate: tCreateEnd - tSwitchToFinishStart,
        msCreateAndClose: tCreateEnd - tCreateEnd + 0,
      },
      "PROFILE: _fillSelectQuestion timings",
    );
  }

  /**
   * Grouped Radio MCQ flow for the Add Reading Question modal.
   *
   * For IELTS "Questions 36-40" with A/B/C/D options, ProQyz exposes
   * a single Radio question that contains N sub-question blocks. The
   * sub-questions are NOT in the content editor — only the group
   * title + instruction lines go there. Each sub-question is a
   * separate row in a "List of Questions" section on the Question
   * tab, with its own question input, option rows, and a radio
   * button per option.
   *
   * Flow:
   *   1. Click Question tab.
   *   2. Paste group title + instructions into TinyMCE (the content
   *      editor). The actual sub-questions are NOT in the content.
   *   3. In the "List of Questions" section:
   *        a. Probe: count the existing question blocks.
   *        b. Click "Add More Questions" until block count ==
   *           subQuestions.length.
   *        c. For each block i (0..N-1):
   *            i.   Probe option-row count; click "Add more options"
   *                 until row count == subQuestions[i].options.length.
   *            ii.  Fill the question input with
   *                 `${subQuestions[i].number} ${subQuestions[i].text}`.
   *            iii. Fill each option-row input with the option text
   *                 (label is implicit by row order: A=row0, B=row1, …).
   *            iv.  Click the radio button next to the row whose
   *                 label matches subQuestions[i].answer.
   *   4. Click Preview tab; verify (best effort, dump screenshot).
   *   5. Click Finish tab; set title = q.displayTitle, category =
   *      "Uncategorized". Click "Create Question".
   *
   * Probing is heavy because the live Radio editor shape is not yet
   * observed (2026-06-09). We follow the same probe-then-fill-then-
   * verify pattern as the other helpers and dump rich inventory on
   * every failure.
   *
   * @param {import("../../domain/schemas.js").Question} q
   * @private
   */
  async _fillRadioQuestion(q) {
    const { page } = this;
    const subs = q.subQuestions ?? [];
    const tag = `Q${q.numberStart ?? q.number}-${q.numberEnd ?? q.number}`;
    const qLog = tag;

    log.uploader.info(
      {
        n: q.number,
        numberStart: q.numberStart,
        numberEnd: q.numberEnd,
        subQuestionCount: subs.length,
      },
      "starting grouped radio MCQ fill",
    );

    if (subs.length === 0) {
      throw new Error(
        `_fillRadioQuestion: ${tag} has no subQuestions; grouped radio ` +
          `MCQ requires a non-empty subQuestions array.`,
      );
    }

    // Acquire the question-modal locator AFTER it's confirmed
    // visible and has the right tabs. The previous eager
    // `.modal.show` capture at the top of this function was the
    // cause of every "tab not found inside the question modal"
    // failure: when a prior question's modal was still half-open
    // (e.g. after Fill-up regression), the captured locator
    // resolved to a stale element and `clickTab` couldn't find the
    // tabs inside it.
    const modal = await this._waitForQuestionModalReady(tag, qLog);

    // Local clickTab helper for the question-editor tabs. The
    // 2026-06-09 live dump showed the tabs are <li class="tabs"> in
    // a `.tablist` wrapper, NOT <a>/<button>/[role=tab]. We use the
    // same robust selector as `_fillFillUpQuestion` and
    // `_fillSelectQuestion` (`.tablist .tabs, .tablist li,
    // [role='tab']` filtered by exact text).
    //
    // On tab-not-found, we re-run `_waitForQuestionModalReady` once
    // (in case the modal was re-rendered mid-flow) and retry. If
    // the second attempt also fails, we captureFailure + throw
    // `modal-tab-not-found` with a rich inventory dump.
    const clickTab = async (label) => {
      log.uploader.info(
        { tag, qLog, tabLabel: label },
        `[${tag}] Clicking ${label} tab`,
      );
      const tryClick = async () => {
        const tab = modal
          .locator(".tablist .tabs, .tablist li, [role='tab']")
          .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, "i") })
          .first();
        await tab.waitFor({ state: "visible", timeout: 3000 });
        await tab.click();
        await page.waitForTimeout(150);
      };
      try {
        await tryClick();
        return;
      } catch (firstErr) {
        log.uploader.warn(
          { tag, qLog, tabLabel: label, err: firstErr.message },
          "tab not found on first try; re-acquiring modal and retrying",
        );
        const freshModal = await this._waitForQuestionModalReady(tag, qLog);
        // Replace the closure reference by re-running the click
        // against the fresh modal directly.
        const tab = freshModal
          .locator(".tablist .tabs, .tablist li, [role='tab']")
          .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, "i") })
          .first();
        await tab.waitFor({ state: "visible", timeout: 5000 });
        await tab.click();
        await page.waitForTimeout(150);
      }
    };

    // Step 1 — Click the Question tab.
    const tSwitchToQStart = Date.now();
    log.uploader.debug(
      { tag, step: 1, what: "clicking Question tab" },
      "RADIO checkpoint",
    );
    await clickTab("Question");
    // Deterministic visible-UI confirmation: wait for the Question
    // tab to become active. Mirrors fill-up/select which rely on
    // the panel becoming interactive without an explicit wait.
    await this._waitForActiveTab(modal, "Question", { timeoutMs: 4000 })
      .catch((waitErr) => {
        log.uploader.debug(
          { tag, err: waitErr.message },
          "Question tab active-state wait timed out; continuing (clickTab already clicked)",
        );
      });
    const tSwitchToQEnd = Date.now();
    log.uploader.debug(
      { tag, step: 1, ms: tSwitchToQEnd - tSwitchToQStart, ok: true },
      "RADIO checkpoint",
    );

    // Step 2 — Paste group title + instructions into TinyMCE.
    // Reuse the visible-then-contentFrame pattern from
    // _fillSelectQuestion.
    const tFillQStart = Date.now();
    const tmIframe = modal
      .locator('iframe[class*="tox-edit-area__iframe"]')
      .first();
    let tmReady = await tmIframe
      .waitFor({ state: "visible", timeout: config.actionTimeoutMs })
      .then(() => true)
      .catch(() => false);
    if (!tmReady) {
      const tmAttached = await tmIframe
        .waitFor({ state: "attached", timeout: 1500 })
        .catch(() => null);
      if (tmAttached) {
        for (let i = 0; i < 8; i++) {
          await page.waitForTimeout(250);
          if (await tmIframe.isVisible().catch(() => false)) {
            tmReady = true;
            break;
          }
        }
      }
    }
    if (tmReady) {
      const frame = await tmIframe.contentFrame();
      if (frame) {
        const body = frame
          .locator("body#tinymce, body.mce-content-body")
          .first();
        for (let i = 0; i < 6; i++) {
          if (await body.isVisible().catch(() => false)) break;
          await page.waitForTimeout(200);
        }
        try {
          await body.click({ timeout: 3000 });
        } catch (err) {
          log.uploader.debug(
            { tag, err: err.message },
            "TinyMCE body.click() failed in _fillRadioQuestion; using evaluate() fallback",
          );
          await body
            .evaluate((el) => {
              el.focus();
              if (typeof el.click === "function") el.click();
            })
            .catch(() => {});
        }
        await page.waitForTimeout(150);
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Delete");
        await page.waitForTimeout(100);
        // Content for grouped radio = the group title + instructions
        // only. Per-question text and options are entered in the
        // "List of Questions" section, not in the content editor.
        const contentText = String(q.content || "").trim();
        await page.keyboard.insertText(contentText);
        await page.waitForTimeout(200);
        // Blur so any brace scan / form-validation pass fires.
        await page.keyboard.press("Tab");
        await page.waitForTimeout(400);
        log.uploader.debug(
          { tag, step: 3, what: "content editor filled", ok: true },
          "RADIO checkpoint",
        );
      } else {
        throw new Error(
          `_fillRadioQuestion: TinyMCE iframe present but no contentFrame for ${tag}`,
        );
      }
    } else {
      // No TinyMCE — try a plain textarea fallback.
      const plainTa = modal
        .locator('textarea[name="content"], textarea[name="question"]')
        .first();
      if (await plainTa.isVisible().catch(() => false)) {
        await plainTa.fill(String(q.content || "").trim());
      } else {
        const failureName = `radio-content-editor-probe-${tag}`;
        try {
          await captureFailure(page, failureName);
        } catch (capErr) {
          log.uploader.warn(
            { err: capErr.message },
            "captureFailure itself failed during radio content-editor probe",
          );
        }
        throw new Error(
          `_fillRadioQuestion: no content editor (TinyMCE or textarea) ` +
            `found for ${tag}. HTML+PNG dumped to failures/${failureName}.*`,
        );
      }
    }

    // Step 3 — List of Questions: add question blocks, fill each.
    log.uploader.debug(
      { tag, step: 4, what: "ensuring question block count" },
      "RADIO checkpoint",
    );
    await this._fillRadioSubQuestions(q, subs, modal);
    log.uploader.debug(
      { tag, step: 4, ok: true, blockCount: subs.length },
      "RADIO checkpoint",
    );

    // Step 4 — Switch to Preview and verify (best effort).
    log.uploader.debug(
      { tag, step: 11, what: "clicking Preview tab" },
      "RADIO checkpoint",
    );
    try {
      await clickTab("Preview");
      // Deterministic visible-UI confirmation: wait for the Preview
      // tab to be marked active (or its tabpanel to be visible).
      // We do NOT call waitForPageCalm here — that helper does an
      // 8s spinner-poll PLUS a best-effort capped-5s networkidle.
      // networkidle is unreliable on the ProQyz SPA (long-poll
      // connections) and was the cause of multi-second hangs after
      // every Preview/Finish click. Visible-tab is the real signal.
      await this._waitForActiveTab(modal, "Preview", { timeoutMs: 4000 })
        .catch((waitErr) => {
          log.uploader.debug(
            { tag, err: waitErr.message },
            "Preview tab active-state wait timed out; continuing (best effort)",
          );
        });
      log.uploader.debug(
        { tag, step: 11, ok: true },
        "RADIO checkpoint",
      );
      try {
        await page.screenshot({
          path: `failures/radio-preview-${tag}.png`,
        });
      } catch (capErr) {
        log.uploader.debug(
          { err: capErr.message },
          "could not capture radio preview screenshot",
        );
      }
      log.uploader.debug(
        { tag, step: 12, what: "preview verification (best effort)" },
        "RADIO checkpoint",
      );
    } catch (err) {
      log.uploader.warn(
        { tag, err: err.message },
        "could not click Preview tab in _fillRadioQuestion; continuing",
      );
    }

    // End of Question-tab work (covers content + subQuestions +
    // best-effort Preview). The `msFillQuestionTab` profile metric
    // uses this point; placement matches fill-up/select conventions
    // where `tFillQEnd` is taken right before switching to Finish.
    const tFillQEnd = Date.now();

    // Step 5 — Finish tab: title, category, save.
    const tSwitchToFinishStart = Date.now();
    log.uploader.debug(
      { tag, step: 13, what: "clicking Finish tab + Create" },
      "RADIO checkpoint",
    );
    await clickTab("Finish");
    // Deterministic visible-UI confirmation: wait for the Finish
    // tab's title input to be visible. That is the canonical signal
    // that the Finish panel has rendered and is interactive. No
    // waitForPageCalm — no spinner-poll, no networkidle. The click
    // is followed by a focused locator wait instead.
    await modal
      .locator('input[name="title"]')
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .catch((waitErr) => {
        log.uploader.debug(
          { tag, err: waitErr.message },
          "Finish title input visibility wait timed out; continuing (will throw below if absent)",
        );
      });
    const tSwitchToFinishEnd = Date.now();

    // Title — use displayTitle.
    const titleCandidates = [
      modal.locator('input[name="title"]').first(),
      modal.locator('input[placeholder*="title" i]').first(),
      modal.locator('input[type="text"]').first(),
    ];
    let titleField = null;
    for (const cand of titleCandidates) {
      if (await cand.isVisible().catch(() => false)) {
        titleField = cand;
        break;
      }
    }
    if (titleField) {
      await titleField.fill(q.displayTitle ?? `Question ${q.number}`);
    } else {
      throw new Error(
        `_fillRadioQuestion: no title input found on Finish tab for ${tag}`,
      );
    }

    // Category = "Uncategorized" (same combobox path as Select).
    const catValue = "Uncategorized";
    const catCombo = modal
      .locator('[role="combobox"]')
      .filter({ hasText: /categor/i })
      .first();
    if (await catCombo.isVisible().catch(() => false)) {
      await catCombo.click();
      await page.waitForTimeout(200);
      const catOpt = page
        .locator("[role='option']")
        .filter({ hasText: new RegExp(`^\\s*${catValue}\\s*$`, "i") })
        .first();
      if (await catOpt.isVisible().catch(() => false)) {
        await catOpt.click();
      } else {
        await page.keyboard.press("Escape");
      }
    } else {
      const catSel = modal.locator('select[name*="category" i]').first();
      if (await catSel.isVisible().catch(() => false)) {
        await catSel
          .selectOption({ label: catValue })
          .catch(() => null);
      }
    }

    // Click "Create Question" (or whatever final action the editor
    // surfaces). Use the flexible _clickFinalSave helper: it
    // accepts Create Question / Save / Save changes / Submit / Done,
    // and falls back to autosave detection if no button is visible.
    // This replaces the previous strict `throw if no button`, which
    // is what produced "Timeout waiting for Save changes" on the
    // 2026-06-09 run when ProQyz autosaved on Finish-tab switch.
    const saveResult = await this._clickFinalSave({
      scope: modal,
      page,
      qTag: tag,
    });
    // Wait for the modal to close (best-effort, 5s).
    try {
      await modal.waitFor({ state: "hidden", timeout: 5000 });
    } catch {
      // Modal didn't close — autosave may have already done it; the
      // helper above will have detected that. Continue.
    }
    log.uploader.info(
      {
        tag,
        strategy: saveResult.strategy,
        buttonLabel: saveResult.buttonLabel,
        modalClosed: saveResult.modalClosed,
        questionCardVisible: saveResult.questionCardVisible,
      },
      `[${tag}] Save completed`,
    );
    // Tiny settle, then deterministic readiness check (no networkidle).
    await new Promise((r) => setTimeout(r, 200));
    const tCreateEnd = Date.now();
    log.uploader.debug(
      { tag, step: 13, ok: true, ms: tCreateEnd - tSwitchToFinishStart },
      "RADIO checkpoint",
    );

    log.uploader.info(
      {
        tag,
        subQuestionCount: subs.length,
        msSwitchToQuestionTab: tSwitchToQEnd - tSwitchToQStart,
        msFillQuestionTab: tFillQEnd - tFillQStart,
        msSwitchToFinishTab: tSwitchToFinishEnd - tSwitchToFinishStart,
        msFillFinishAndCreate: tCreateEnd - tSwitchToFinishStart,
      },
      "PROFILE: _fillRadioQuestion timings",
    );
  }

  /**
   * Probe the "List of Questions" section for question blocks, ensure
   * the right count of blocks and option rows, then fill each block.
   *
   * The 2026-06-09 live Radio editor shape is not yet observed — the
   * probe ladder is deliberately broad. If the probe cannot find the
   * "Add More Questions" button or the per-block option rows, the
   * helper dumps a rich inventory to failures/ and throws.
   *
   * @param {import("../../domain/schemas.js").Question} q
   * @param {import("../../domain/schemas.js").Question["subQuestions"]} subs
   * @param {import("playwright").Locator} modal
   * @private
   */
  async _fillRadioSubQuestions(q, subs, modal) {
    const { page } = this;
    const tag = `Q${q.numberStart ?? q.number}-${q.numberEnd ?? q.number}`;

    // 1. Find the List of Questions section. The whole modal is the
    //    section by default on Radio; refine via a heading lookup
    //    when one exists.
    const listSection = await this._findRadioListSection(modal);
    if (!listSection) {
      await this._captureAndThrowRadioFailure(
        page,
        modal,
        q,
        tag,
        "no-list-section",
        { subsLength: subs.length },
      );
    }

    // 2. Find the "Add More Questions" button.
    const addMoreQ = await this._findAddMoreQuestionsButton(listSection);
    if (!addMoreQ) {
      await this._captureAndThrowRadioFailure(
        page,
        modal,
        q,
        tag,
        "no-add-more-questions-button",
        { subsLength: subs.length },
      );
    }

    // 3. Find the per-block question inputs.
    const initialCount = (await this._findRadioQuestionInputs(listSection)).length;
    log.uploader.info(
      { tag, initialCount, need: subs.length },
      "radio List of Questions: initial question block count",
    );

    // 4. Click "Add More Questions" until count == subs.length.
    let safety = 30;
    while (
      (await this._findRadioQuestionInputs(listSection)).length < subs.length
    ) {
      if (safety-- <= 0) break;
      try {
        await addMoreQ.click();
      } catch (err) {
        await this._captureAndThrowRadioFailure(
          page,
          modal,
          q,
          tag,
          "add-more-questions-click-failed",
          {
            err: err.message,
            currentCount: (await this._findRadioQuestionInputs(listSection))
              .length,
          },
        );
      }
      await page.waitForTimeout(250);
    }
    const finalCount = (await this._findRadioQuestionInputs(listSection)).length;
    if (finalCount < subs.length) {
      await this._captureAndThrowRadioFailure(
        page,
        modal,
        q,
        tag,
        "add-more-questions-too-few",
        { initialCount, finalCount, need: subs.length },
      );
    }

    // 5. For each sub-question: ensure option row count, fill
    //    question input, fill options, pick correct radio.
    log.uploader.debug(
      {
        tag,
        step: 5,
        what: "ensuring Q36 option count",
        firstSubOptions: subs[0]?.options.length,
      },
      "RADIO checkpoint",
    );
    for (let i = 0; i < subs.length; i++) {
      const sq = subs[i];
      // Re-resolve each iteration in case the DOM re-rendered.
      const blocks = await this._findRadioQuestionInputs(listSection);
      const currentBlock = blocks[i];
      if (!currentBlock) {
        await this._captureAndThrowRadioFailure(
          page,
          modal,
          q,
          tag,
          "block-missing",
          { i, need: subs.length, have: blocks.length },
        );
      }

      // The "block" returned by _findRadioQuestionInputs is the
      // question <input> element itself, not the enclosing
      // .card.mb-4 wrapper. Searching for option inputs / add-more
      // inputs / radios inside an <input> element finds nothing,
      // which is what caused the 12:51 "no-initial-option-row"
      // failure. Walk up to the nearest .card.mb-4 ancestor and
      // use that as the per-block container for option / radio
      // lookups. Falls back to the question input itself if no
      // .card ancestor is found.
      const cardContainer = currentBlock
        .locator(
          'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " card ")][1]',
        )
        .first();
      const useContainer =
        (await cardContainer.count()) > 0 ? cardContainer : currentBlock;
      const qLog = `Q${sq.number}`;

      // -----------------------------------------------------------------
      // 5a. Fill the question input.
      //
      // The question input is a normal text input, but ProQyz
      // controls its value with React. A plain .fill() often leaves
      // the React state stale, so we use the canonical robust
      // pattern: click → select all → backspace → insertText → Tab.
      // If the value still didn't change, fall back to the React
      // native value setter (the trick that bypasses React's value
      // tracker) followed by an input event.
      // -----------------------------------------------------------------
      const questionText = `${sq.number} ${sq.text}`;
      const beforeQ = await currentBlock
        .inputValue()
        .catch(() => null);
      log.uploader.debug(
        { tag, sub: i, subNumber: sq.number, before: beforeQ, want: questionText },
        "Q-fill before",
      );
      await this._robustFillTextInput(currentBlock, questionText);
      const afterQ = await currentBlock
        .inputValue()
        .catch(() => null);
      log.uploader.info(
        { qLog, inserted: questionText, ok: afterQ === questionText },
        `[${qLog}] Question text inserted`,
      );
      log.uploader.debug(
        { tag, sub: i, subNumber: sq.number, after: afterQ, want: questionText, match: afterQ === questionText },
        "Q-fill after",
      );
      if (afterQ !== questionText) {
        await this._captureAndThrowRadioFailure(
          page,
          modal,
          q,
          tag,
          "question-fill-failed",
          {
            sub: i,
            subNumber: sq.number,
            want: questionText,
            got: afterQ,
          },
        );
      }

      // -----------------------------------------------------------------
      // 5b. Fill options, one row at a time, creating new rows
      //     by filling the "Add more options" placeholder input.
      //
      // Strategy:
      //   - For option A (j=0): fill the existing real "Option 1"
      //     input (no row creation needed).
      //   - For option B/C/D (j>0): find the add-more placeholder
      //     input (readonly text input), strip readonly, fill it
      //     with the next option's text, dispatch input/change
      //     events, blur, wait for ProQyz to create a new row,
      //     re-scan, then move to the next j.
      //   - Re-scan option inputs after EVERY fill so we always
      //     target the latest input, never an off-by-one stale
      //     locator.
      // -----------------------------------------------------------------
      // 5b. Fill options, one row at a time, creating new rows by
      //     TYPING into the "Add more options" input and pressing
      //     ENTER. ProQyz's radio option-row UI is a list where
      //     each new option is added by typing the option text
      //     into the trailing "Add more options" placeholder input
      //     and pressing Enter. Filling it via .fill() + Tab was
      //     unreliable: the synthetic input event would fire but
      //     the React handler that creates the new row listens on
      //     keydown for Enter. The "Add More Questions" button at
      //     the top of the modal adds a NEW QUESTION BLOCK, not a
      //     new option — never click it inside this loop.
      // -----------------------------------------------------------------
      // Pre-loop log: how many option rows already exist? For a
      // freshly created question block, this is exactly 1
      // ("Option 1" with its disabled radio).
      const preLoopOptionInputs = await this._findRadioOptionInputs(
        useContainer,
      );
      log.uploader.info(
        { qLog, existingOptionRows: preLoopOptionInputs.length },
        `[${qLog}] Existing option rows: ${preLoopOptionInputs.length}`,
      );

      for (let j = 0; j < sq.options.length; j++) {
        if (j === 0) {
          // The first option already exists as "Option 1".
          const optionInputs = await this._findRadioOptionInputs(
            useContainer,
          );
          if (optionInputs.length < 1) {
            await this._captureAndThrowRadioFailure(
              page,
              modal,
              q,
              tag,
              "no-initial-option-row",
              {
                sub: i,
                subNumber: sq.number,
                optionCount: optionInputs.length,
              },
            );
          }
          log.uploader.info(
            { qLog, optLabel: sq.options[j].label, targetRowIdx: 0 },
            `[${qLog}] Inserting option ${sq.options[j].label} into existing row`,
          );
          await this._robustFillTextInput(optionInputs[0], sq.options[j].text);
          const afterOpt0 = await optionInputs[0]
            .inputValue()
            .catch(() => null);
          log.uploader.info(
            {
              qLog,
              optLabel: sq.options[j].label,
              inserted: sq.options[j].text,
              ok: afterOpt0 === sq.options[j].text,
            },
            `[${qLog}] Option ${sq.options[j].label} inserted`,
          );
          if (afterOpt0 !== sq.options[j].text) {
            await this._captureAndThrowRadioFailure(
              page,
              modal,
              q,
              tag,
              "option-A-fill-failed",
              {
                sub: i,
                subNumber: sq.number,
                want: sq.options[j].text,
                got: afterOpt0,
              },
            );
          }
        } else {
          // Create a new option row by TYPING the option text into
          // the trailing "Add more options" input and pressing
          // Enter. The input is a readonly text input (a custom
          // placeholder trigger). ProQyz listens for a keydown
          // Enter / a synthetic input event + a row-creation
          // handler. We use a strict sequence:
          //   1. Find the "Add more options" input (NOT a button,
          //      NOT the "Add More Questions" button).
          //   2. Strip readonly / disabled so focus + typing works.
          //   3. Click the input to focus it.
          //   4. Type the option text via page.keyboard.insertText
          //      (bypasses IME / keyboard layout issues; works on
          //      React-controlled inputs).
          //   5. Press Enter. ProQyz's row-creation handler fires
          //      on the Enter keydown and inserts a new option
          //      row, then clears the input. Tab does NOT trigger
          //      row creation reliably on real ProQyz.
          //   6. Poll the option-row count until it grows from
          //      `j` to `j+1`. The re-render can take 200-800ms
          //      because of React's batching.
          //   7. Re-scan and assert the count, then fill the
          //      new row's value with the option text via the
          //      robust fill helper (it may already be correct,
          //      but re-filling is idempotent and a defensive
          //      belt-and-braces against the typed text landing
          //      in the trailing input instead of the new row).
          // -----------------------------------------------------------------
          log.uploader.info(
            { qLog, optLabel: sq.options[j].label, wantRows: j + 1 },
            `[${qLog}] Creating option ${sq.options[j].label} via Add more options input`,
          );
          const addMore = await this._findAddMoreOptionsButton(useContainer);
          if (!addMore) {
            await this._dumpAndThrowRowFailure(
              page,
              modal,
              q,
              tag,
              i,
              sq,
              "add-more-missing",
              j,
              useContainer,
            );
          }
          // Strip readonly/disabled so focus + keyboard typing
          // works. ProQyz's UI sets these to prevent direct typing
          // and force the Enter-driven flow, but the keyboard
          // events still need to land on a real, focusable input.
          await addMore.evaluate((el) => {
            el.removeAttribute("readonly");
            el.removeAttribute("disabled");
          });
          // Focus via click (ProQyz's onFocus handler also resets
          // the input's stored value to empty, which we want).
          await addMore.click().catch(async () => {
            await addMore.evaluate((el) => el.focus()).catch(() => null);
          });
          // Clear any leftover value from a previous attempt.
          await page.keyboard.press("Control+A").catch(() => null);
          await page.keyboard.press("Meta+A").catch(() => null);
          await page.keyboard.press("Backspace").catch(() => null);
          await page.waitForTimeout(60);
          // Type the option text via keyboard (NOT .fill()).
          await page.keyboard.insertText(sq.options[j].text);
          // Commit by pressing Enter. This is the key step that
          // .fill() + Tab was missing.
          await page.keyboard.press("Enter");
          // Poll for row count to grow. We expect j → j+1.
          const expectedRows = j + 1;
          const newRows = await this._waitForOptionRowCount(
            useContainer,
            expectedRows,
            /* timeoutMs */ 3000,
          );
          log.uploader.info(
            {
              qLog,
              optLabel: sq.options[j].label,
              optionRowsAfter: newRows.length,
              want: expectedRows,
              ok: newRows.length >= expectedRows,
            },
            `[${qLog}] Option rows after ${sq.options[j].label}: ${newRows.length}`,
          );
          if (newRows.length < expectedRows) {
            await this._dumpAndThrowRowFailure(
              page,
              modal,
              q,
              tag,
              i,
              sq,
              "row-not-created",
              j,
              useContainer,
            );
          }
          // Belt-and-braces: re-fill the just-created row's value
          // via the robust path. Sometimes the typed text lands in
          // the trailing input and we need to push it onto the new
          // row explicitly. Idempotent.
          await this._robustFillTextInput(
            newRows[j],
            sq.options[j].text,
          );
          const afterOptN = await newRows[j]
            .inputValue()
            .catch(() => null);
          log.uploader.debug(
            {
              tag,
              sub: i,
              subNumber: sq.number,
              optIdx: j,
              label: sq.options[j].label,
              after: afterOptN,
              want: sq.options[j].text,
              match: afterOptN === sq.options[j].text,
            },
            "opt-fill readback",
          );
          if (afterOptN !== sq.options[j].text) {
            await this._captureAndThrowRadioFailure(
              page,
              modal,
              q,
              tag,
              "option-N-fill-failed",
              {
                sub: i,
                subNumber: sq.number,
                optIdx: j,
                want: sq.options[j].text,
                got: afterOptN,
              },
            );
          }
        }
      }

      // 5c. Click the radio button for the correct option.
      //
      // Re-locate the radios AFTER all options exist, since each
      // option-row creation may add a new <input type="radio"> to
      // the DOM. Use the card container, not the question input.
      const correctIdx = sq.options.findIndex(
        (o) =>
          o.label.trim().toUpperCase() === sq.answer.trim().toUpperCase(),
      );
      if (correctIdx < 0) {
        await this._captureAndThrowRadioFailure(
          page,
          modal,
          q,
          tag,
          "answer-not-in-options",
          {
            sub: i,
            answer: sq.answer,
            optionLabels: sq.options.map((o) => o.label),
          },
        );
      }

      // -----------------------------------------------------------------
      // 5c-pre. Filtered DOM inventory dump BEFORE attempting any
      //     radio selection. ProQyz's Radio block has a trailing
      //     "Add more options" row that contains its own radio
      //     (disabled) and its own text input (empty, readonly).
      //     The raw DOM count is therefore 1 MORE than the actual
      //     answer rows — comparing the raw count to
      //     `sq.options.length` was the cause of every
      //     `radio-dom-mismatch` failure. We filter to ACTUAL
      //     answer rows (visible text input, non-empty value,
      //     non-disabled radio) and use only those for inventory
      //     logging AND for the click target. If total raw DOM
      //     count is 5 (4 answers + 1 add-more placeholder), that
      //     is FINE — we only fail if the FILTERED count does not
      //     match `sq.options.length`.
      // -----------------------------------------------------------------
      const actualRows = await this._buildActualOptionRows(useContainer);
      log.uploader.info(
        {
          qLog,
          actualOptionRowCount: actualRows.actualOptionRows.length,
          totalRawRows: actualRows.totalRawRows,
          totalRawRadios: actualRows.totalRawRadios,
        },
        `[${qLog}] Actual option rows: ${actualRows.actualOptionRows.length}`,
      );
      // Per-row logs, using the fixture's A/B/C/D label mapping so
      // the operator can confirm DOM order matches the fixture
      // order. Truncate to 80 chars for readability.
      const fixtureLabels = ["A", "B", "C", "D", "E", "F", "G", "H"];
      for (let i = 0; i < actualRows.actualOptionRows.length; i++) {
        const row = actualRows.actualOptionRows[i];
        const label = sq.options[i]?.label ?? fixtureLabels[i] ?? `?${i}`;
        const text = (row.value || "").slice(0, 80);
        log.uploader.info(
          { qLog, rowIdx: i, label, text, placeholder: row.placeholder },
          `[${qLog}] ${label}: text="${text}"`,
        );
      }
      log.uploader.info(
        { qLog, actualRadioCount: actualRows.actualRadios.length },
        `[${qLog}] Actual radios: ${actualRows.actualRadios.length}`,
      );

      // Hard pre-condition: filtered actual row count must equal
      // sq.options.length. The raw DOM count is allowed to be
      // larger (the "Add more options" placeholder row is
      // expected). If the FILTERED count doesn't match, the DOM
      // really doesn't match the fixture and any click is doomed.
      if (actualRows.actualOptionRows.length !== sq.options.length) {
        try {
          await captureFailure(
            page,
            `radio-dom-mismatch-${qLog}`,
          );
        } catch (_) {
          // best-effort
        }
        // Also dump the full raw block inventory at failure time
        // for diagnosis.
        const fullRawInventory = await this._dumpRadioBlockInventory(
          useContainer,
          sq,
          qLog,
        );
        await this._captureAndThrowRadioFailure(
          page,
          modal,
          q,
          tag,
          "radio-dom-mismatch",
          {
            sub: i,
            subNumber: sq.number,
            want: sq.options.length,
            actualOptionRowCount: actualRows.actualOptionRows.length,
            totalRawRows: actualRows.totalRawRows,
            totalRawRadios: actualRows.totalRawRadios,
            domInventory: fullRawInventory,
          },
        );
      }

      // Now emit the "Selecting" log AFTER the inventory so the
      // operator sees the full DOM before the click.
      log.uploader.info(
        { qLog, correctLabel: sq.options[correctIdx].label },
        `[${qLog}] Selecting correct answer: ${sq.options[correctIdx].label}`,
      );

      // Retry loop: re-find ACTUAL radios, re-check, re-verify up
      // to 3 times in case ProQyz re-renders and yanks the
      // checked state. CRITICAL: we use `actualRows.actualRadios`,
      // not `_findRadioButtons(useContainer)` — the latter would
      // include the disabled "Add more options" radio and shift
      // the index by 1.
      let radioOk = false;
      let lastRadioState = null;
      for (let attempt = 1; attempt <= 3 && !radioOk; attempt++) {
        // Re-build the actual rows on every attempt — ProQyz may
        // re-render between clicks.
        const reActual = await this._buildActualOptionRows(useContainer);
        if (reActual.actualRadios.length < sq.options.length) {
          log.uploader.warn(
            {
              qLog,
              attempt,
              want: sq.options.length,
              got: reActual.actualRadios.length,
            },
            "not enough actual radios; re-scanning",
          );
          await page.waitForTimeout(200);
          continue;
        }
        const radios = reActual.actualRadios;
        await radios[correctIdx].check();
        await page.waitForTimeout(150);
        const checked = await radios[correctIdx]
          .isChecked()
          .catch(() => false);
        const reActual2 = await this._buildActualOptionRows(useContainer);
        const reChecked =
          reActual2.actualRadios.length > correctIdx
            ? await reActual2.actualRadios[correctIdx]
                .isChecked()
                .catch(() => false)
            : false;
        lastRadioState = { attempt, checked, reChecked };
        if (checked || reChecked) {
          radioOk = true;
        } else {
          log.uploader.warn(
            { qLog, attempt, lastRadioState },
            "radio did not stay checked; retrying",
          );
          await page.waitForTimeout(250);
        }
      }
      if (!radioOk) {
        // Capture screenshot + dump visible radio labels + re-dump
        // the full block inventory so the operator can compare
        // pre-select vs post-attempt states.
        try {
          await captureFailure(
            page,
            `radio-verify-fail-${qLog}`,
          );
        } catch (_) {
          // best-effort
        }
        let visibleLabels = [];
        try {
          visibleLabels = await useContainer.evaluate((card) => {
            const inputs = Array.from(
              card.querySelectorAll('input[type="radio"]'),
            );
            return inputs.map((r) => ({
              disabled: r.disabled,
              checked: r.checked,
              value: r.value,
              name: r.name,
              ariaLabel: r.getAttribute("aria-label") || null,
              parentText: (
                r.closest(".question__input-group")?.innerText || ""
              ).slice(0, 120),
            }));
          });
        } catch (_) {
          // best-effort
        }
        // Re-dump the full block inventory at failure time so the
        // log shows the after-attempt state alongside the
        // before-attempt state captured above.
        const failureInventory = await this._dumpRadioBlockInventory(
          useContainer,
          sq,
          qLog,
        );
        await this._captureAndThrowRadioFailure(
          page,
          modal,
          q,
          tag,
          "radio-verify-failed",
          {
            sub: i,
            subNumber: sq.number,
            correctLabel: sq.options[correctIdx].label,
            attempts: lastRadioState,
            visibleRadios: visibleLabels,
            preSelectActualRows: actualRows,
            failureInventory,
          },
        );
      }
      log.uploader.info(
        { qLog, correctLabel: sq.options[correctIdx].label, ok: radioOk },
        `[${qLog}] Verification passed`,
      );
      log.uploader.debug(
        {
          tag,
          sub: i,
          subNumber: sq.number,
          correctIdx,
          correctLabel: sq.options[correctIdx].label,
        },
        "filled radio MCQ sub-question",
      );
    }
  }

  /**
   * Find the "List of Questions" section wrapper inside the modal.
   * The 2026-06-09 live dump shows it as a `<label for="question-html"
   * class="required mb-6">List of Questions</label>` followed by
   * per-question `.card.mb-4` blocks. We return the modal itself as
   * the section (the cards are children of the modal).
   *
   * @param {import("playwright").Locator} modal
   * @returns {Promise<import("playwright").Locator | null>}
   * @private
   */
  async _findRadioListSection(modal) {
    const headerLoc = modal
      .locator('label:has-text("List of Questions")')
      .first();
    if ((await headerLoc.count()) > 0) {
      return modal;
    }
    return modal;
  }

  /**
   * Find the "Add More Questions" button (global, not per-block).
   * The 2026-06-09 live dump shows it as a `<button
   * class="btn btn-primary btn-sm">` with text "Add More Questions"
   * (with a `+` icon).
   *
   * @param {import("playwright").Locator} section
   * @returns {Promise<import("playwright").Locator | null>}
   * @private
   */
  async _findAddMoreQuestionsButton(section) {
    const candidates = [
      section.locator('button:has-text("Add More Questions")').first(),
      section.locator('a:has-text("Add More Questions")').first(),
      section.locator('button:has-text("Add Question")').first(),
      section
        .locator('[class*="btn-primary"]:has-text("Add More Questions")')
        .first(),
      section
        .locator('[class*="btn-primary"]:has-text("Add Question")')
        .first(),
    ];
    for (const c of candidates) {
      if ((await c.count()) > 0 && (await c.isVisible().catch(() => false))) {
        return c;
      }
    }
    return null;
  }

  /**
   * Find the "Add more options" trigger inside a question block.
   *
   * The 2026-06-09 live dump shows this is **not a button** — it's
   * a readonly text input with `placeholder="Add more options"`
   * and a `readonly` attribute, sitting inside a
   * `.question_input-group-add-more` wrapper, with a **disabled**
   * radio button beside it. Clicking that input adds a new option
   * row to the block.
   *
   * @param {import("playwright").Locator} block
   * @returns {Promise<import("playwright").Locator | null>}
   * @private
   */
  async _findAddMoreOptionsButton(block) {
    const candidates = [
      // Live shape: readonly text input with placeholder.
      block
        .locator(
          'input[placeholder="Add more options" i], input[placeholder*="more option" i]',
        )
        .first(),
      block.locator('[class*="add-more" i]').first(),
      // Old shape: button/link (in case ProQyz changes).
      block.locator('button:has-text("Add more options")').first(),
      block.locator('a:has-text("Add more options")').first(),
      block.locator('button:has-text("Add Option")').first(),
      block.locator('a:has-text("Add Option")').first(),
    ];
    for (const c of candidates) {
      if ((await c.count()) > 0 && (await c.isVisible().catch(() => false))) {
        return c;
      }
    }
    return null;
  }

  /**
   * Find every question input on the page, in DOM order. The
   * 2026-06-09 live dump shows question inputs as
   * `<input class="question__question-input" placeholder="Question text">`
   * inside per-block `<div class="card mb-4">` wrappers.
   *
   * @param {import("playwright").Locator} section
   * @returns {Promise<import("playwright").Locator[]>}
   * @private
   */
  async _findRadioQuestionInputs(section) {
    // Primary selector: class=question__question-input.
    const primary = section.locator(
      'input.question__question-input, .question_box input.question__question-input',
    );
    const pn = await primary.count();
    if (pn > 0) {
      const out = [];
      for (let i = 0; i < pn; i++) {
        const el = primary.nth(i);
        if (await el.isVisible().catch(() => false)) out.push(el);
      }
      return out;
    }
    // Fallback: any text input whose placeholder is "Question text"
    // or whose name is "question".
    const fallback = section.locator(
      'input[placeholder="Question text" i], input[name*="question" i]',
    );
    const fn = await fallback.count();
    const out = [];
    for (let i = 0; i < fn; i++) {
      const el = fallback.nth(i);
      if (await el.isVisible().catch(() => false)) out.push(el);
    }
    return out;
  }

  /**
   * Find every option input inside a question block, in DOM order.
   *
   * The 2026-06-09 live dump shows:
   *   - Real option inputs: `placeholder="Option 1"`, `Option 2`, …
   *     (i.e. numbered placeholders, NOT "Add more options").
   *   - "Add more options" trigger: `placeholder="Add more options"`,
   *     `readonly` attribute — we MUST exclude this.
   *
   * We filter by placeholder matching `Option \d+` (with a digit),
   * which naturally excludes the "Add more options" trigger.
   *
   * @param {import("playwright").Locator} block
   * @returns {Promise<import("playwright").Locator[]>}
   * @private
   */
  async _findRadioOptionInputs(block) {
    // Primary: inputs whose placeholder matches "Option 1", "Option 2", …
    const optionNumbered = block.locator(
      'input[placeholder*="Option" i][placeholder*="1" i], ' +
        'input[placeholder*="Option 2" i], input[placeholder*="Option 3" i], ' +
        'input[placeholder*="Option 4" i], input[placeholder*="Option 5" i], ' +
        'input[placeholder*="option 1" i], input[placeholder*="option 2" i], ' +
        'input[placeholder*="option 3" i], input[placeholder*="option 4" i]',
    );
    let n = await optionNumbered.count();
    let locators = optionNumbered;
    if (n === 0) {
      // Fallback: any input with placeholder containing "option" but
      // NOT "add more" / "more options".
      locators = block.locator(
        'input[placeholder*="option" i]:not([placeholder*="more" i]):not([readonly])',
      );
      n = await locators.count();
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      const el = locators.nth(i);
      if (await el.isVisible().catch(() => false)) out.push(el);
    }
    return out;
  }

  /**
   * Find every radio button inside a question block, in DOM order.
   * Filters out disabled radios (the "Add more options" row has a
   * disabled radio beside it).
   *
   * @param {import("playwright").Locator} block
   * @returns {Promise<import("playwright").Locator[]>}
   * @private
   */
  async _findRadioButtons(block) {
    const candidates = [
      block.locator('input[type="radio"]:not([disabled])'),
      block.locator('[role="radio"]:not([aria-disabled="true"])'),
    ];
    for (const c of candidates) {
      const n = await c.count();
      if (n > 0) {
        const out = [];
        for (let i = 0; i < n; i++) {
          const el = c.nth(i);
          if (await el.isVisible().catch(() => false)) out.push(el);
        }
        if (out.length > 0) return out;
      }
    }
    return [];
  }

  /**
   * Walk every option row in a Radio question block, and return
   * ONLY the rows that represent a real A/B/C/D answer — filtering
   * out the trailing "Add more options" placeholder row, empty
   * rows, and any row that has a disabled radio.
   *
   * Filtering rules (per user spec, 2026-06-09):
   *   1. The row contains a visible text input (the option-value
   *      input).
   *   2. The text input's value is non-empty after `.trim()`.
   *   3. The row contains a visible radio input.
   *   4. The radio input is NOT disabled.
   *
   * The "Add more options" placeholder row is filtered out
   * automatically: its text input is always empty (placeholder
   * "Add more options"), and its radio is always disabled. But
   * we check the four conditions explicitly rather than relying
   * on placeholder-name heuristics — that way, if ProQyz renames
   * the placeholder or rearranges the row, the filter still
   * works.
   *
   * Why this exists: ProQyz's Radio block has a trailing
   * "Add more options" row that contains its own radio (disabled)
   * and its own text input (empty, readonly). The raw DOM count
   * is therefore 1 MORE than the actual answer rows. Comparing
   * the raw count to `sq.options.length` was failing the
   * pre-radio-select check on every run. The filtered count
   * matches what the click loop will actually use.
   *
   * Returns:
   *   - actualOptionRows: array of
   *     { input: Locator, radio: Locator, value: string,
   *       placeholder: string|null }
   *     in DOM order. Indexed 0..N-1 maps to A..D.
   *   - actualRadios: array of Locator — the `radio` field of
   *     each row, in the same order. This is the array the
   *     retry loop's `radios[correctIdx].check()` should use.
   *   - totalRawRows: number of option rows BEFORE filtering
   *     (for log visibility — operators want to see "raw 5,
   *     filtered 4").
   *   - totalRawRadios: number of radios BEFORE filtering.
   *
   * @param {import("playwright").Locator} block
   * @returns {Promise<{
   *   actualOptionRows: Array<{ input: import("playwright").Locator, radio: import("playwright").Locator, value: string, placeholder: string|null }>,
   *   actualRadios: Array<import("playwright").Locator>,
   *   totalRawRows: number,
   *   totalRawRadios: number,
   * }>}
   * @private
   */
  async _buildActualOptionRows(block) {
    const optionInputs = await this._findRadioOptionInputs(block);
    const allRadios = await this._findRadioButtons(block);
    const totalRawRows = optionInputs.length;
    const totalRawRadios = allRadios.length;

    const actualOptionRows = [];
    const actualRadios = [];

    for (let i = 0; i < optionInputs.length; i++) {
      const input = optionInputs[i];
      const inputVisible = await input.isVisible().catch(() => false);
      if (!inputVisible) continue;
      const value = (await input.inputValue().catch(() => "")).trim();
      if (value.length === 0) continue; // empty / "Add more options" row

      // Find the nearest sibling radio inside the same row. We
      // can't use `closest("row")` reliably (no shared class), so
      // pick the i-th radio from the full list (rows and radios
      // are in the same DOM order in the live 2026-06-09 dump).
      // If we run out of radios, skip this row.
      const radio = i < allRadios.length ? allRadios[i] : null;
      if (!radio) continue;
      const radioDisabled = await radio.isDisabled().catch(() => true);
      if (radioDisabled) continue; // "Add more options" radio is disabled
      const radioVisible = await radio.isVisible().catch(() => false);
      if (!radioVisible) continue;

      const placeholder = await input
        .getAttribute("placeholder")
        .catch(() => null);
      actualOptionRows.push({ input, radio, value, placeholder });
      actualRadios.push(radio);
    }

    return {
      actualOptionRows,
      actualRadios,
      totalRawRows,
      totalRawRadios,
    };
  }

  /**
   * Dump a structured inventory of a Radio question block's option
   * rows and radio buttons, for the "DOM structure actually matches
   * the expected A/B/C/D mapping" pre-condition check.
   *
   * Captured metrics (returned as `summary`):
   *   - optionRowCount: number of visible option input rows found
   *     inside the block (uses the same selector as
   *     `_findRadioOptionInputs`).
   *   - radioCount: total number of `<input type="radio">` inside
   *     the block, regardless of disabled state. (Disabled radios
   *     correspond to the "Add more options" placeholder row; we
   *     count them explicitly so the operator can see them in the
   *     log.)
   *   - activeRadioCount: number of NON-disabled radios — this is
   *     what `_findRadioButtons` returns and what we'll click.
   *
   * Captured detail (returned as `optionRows` and `radios`):
   *   - Each option row: { index, placeholder, value, visible }.
   *   - Each radio: { index, checked, disabled, value, name }.
   *
   * Also emits a per-line info log per the user's spec:
   *   `[Q36] Found 4 option rows`
   *   `[Q36] A: text="..."`
   *   `[Q36] B: text="..."`
   *   …
   *   `[Q36] Found 4 radios`
   *   `[Q36] Radio[0] checked=false disabled=false`
   *   …
   *
   * The function is intentionally read-only — no clicks, no state
   * mutation. It runs fast (~5ms) so it's safe to call before every
   * radio selection in the smoke fixture.
   *
   * @param {import("playwright").Locator} block
   * @param {{ number: number, options: Array<{label: string, text: string}> }} sq
   * @param {string} qLog — e.g. "Q36" for log line prefixing
   * @returns {Promise<{
   *   summary: {
   *     optionRowCount: number,
   *     radioCount: number,
   *     activeRadioCount: number,
   *   },
   *   optionRows: Array<{ index: number, placeholder: string|null, value: string, visible: boolean }>,
   *   radios: Array<{ index: number, checked: boolean, disabled: boolean, value: string, name: string }>,
   * }>}
   * @private
   */
  async _dumpRadioBlockInventory(block, sq, qLog) {
    const out = {
      summary: { optionRowCount: 0, radioCount: 0, activeRadioCount: 0 },
      optionRows: [],
      radios: [],
    };

    // 1. Option rows. Use the same `Option N` placeholder selector
    //    that `_findRadioOptionInputs` uses, so the count matches
    //    what selection will see.
    const optionInputs = await this._findRadioOptionInputs(block);
    out.summary.optionRowCount = optionInputs.length;
    for (let i = 0; i < optionInputs.length; i++) {
      const el = optionInputs[i];
      const placeholder = await el.getAttribute("placeholder").catch(() => null);
      const value = await el.inputValue().catch(() => "");
      const visible = await el.isVisible().catch(() => false);
      out.optionRows.push({ index: i, placeholder, value, visible });
    }

    // 2. Radios. Walk ALL radios (including disabled) so the
    //    operator can see the "Add more options" placeholder's
    //    disabled radio in the log. Then split into active.
    let allRadios = [];
    try {
      allRadios = await block.locator('input[type="radio"]').all();
    } catch (_) {
      // best-effort
    }
    out.summary.radioCount = allRadios.length;
    for (let i = 0; i < allRadios.length; i++) {
      const r = allRadios[i];
      const checked = await r.isChecked().catch(() => false);
      const disabled = await r.isDisabled().catch(() => false);
      const value = await r.getAttribute("value").catch(() => "");
      const name = await r.getAttribute("name").catch(() => "");
      out.radios.push({ index: i, checked, disabled, value: value ?? "", name: name ?? "" });
      if (!disabled) out.summary.activeRadioCount += 1;
    }

    // 3. Emit per-line info logs as the user requested.
    log.uploader.info(
      { qLog, optionRowCount: out.summary.optionRowCount },
      `[${qLog}] Found ${out.summary.optionRowCount} option rows`,
    );
    // Map optionRows to the fixture's A/B/C/D labels by index, so
    // the operator can see at a glance whether the DOM order
    // matches the fixture order.
    const labels = ["A", "B", "C", "D", "E", "F", "G", "H"];
    for (let i = 0; i < out.optionRows.length; i++) {
      const row = out.optionRows[i];
      const label = sq.options[i]?.label ?? labels[i] ?? `?${i}`;
      // Truncate to 80 chars for readability.
      const t = (row.value || "").slice(0, 80);
      log.uploader.info(
        { qLog, rowIdx: i, label, text: t, placeholder: row.placeholder },
        `[${qLog}] ${label}: text="${t}"`,
      );
    }
    log.uploader.info(
      { qLog, radioCount: out.summary.radioCount, activeRadioCount: out.summary.activeRadioCount },
      `[${qLog}] Found ${out.summary.radioCount} radios`,
    );
    for (let i = 0; i < out.radios.length; i++) {
      const r = out.radios[i];
      log.uploader.info(
        { qLog, radioIdx: i, checked: r.checked, disabled: r.disabled, value: r.value },
        `[${qLog}] Radio[${i}] checked=${r.checked} disabled=${r.disabled}`,
      );
    }

    return out;
  }

  /**
   * Poll the option-row count inside `useContainer` until it reaches
   * at least `targetCount`, or until `timeoutMs` elapses. Returns
   * the final list of option input locators (empty/partial on
   * timeout).
   *
   * ProQyz's row-creation handler runs on a keydown Enter, but the
   * resulting React re-render is batched and can take 200-800ms in
   * practice. A fixed `waitForTimeout(250)` is unreliable: too short
   * on slow machines, wasted time on fast ones. This helper polls
   * with a short interval so we react as soon as the row appears.
   *
   * @param {import("playwright").Locator} useContainer
   * @param {number} targetCount
   * @param {number} [timeoutMs=3000]
   * @returns {Promise<import("playwright").Locator[]>}
   * @private
   */
  async _waitForOptionRowCount(useContainer, targetCount, timeoutMs = 3000) {
    const { page } = this;
    const start = Date.now();
    const pollMs = 100;
    let lastSeen = [];
    let poll = 0;
    while (Date.now() - start < timeoutMs) {
      const rows = await this._findRadioOptionInputs(useContainer);
      lastSeen = rows;
      if (rows.length >= targetCount) {
        log.uploader.debug(
          { targetCount, got: rows.length, ms: Date.now() - start, polls: poll },
          "_waitForOptionRowCount: target reached",
        );
        return rows;
      }
      poll += 1;
      await page.waitForTimeout(pollMs);
    }
    log.uploader.debug(
      {
        targetCount,
        got: lastSeen.length,
        ms: Date.now() - start,
        polls: poll,
      },
      "_waitForOptionRowCount: timed out",
    );
    return lastSeen;
  }

  /**
   * Rich-failure dump for option-row creation problems. Captures a
   * screenshot + HTML dump, then dumps every input and every button
   * inside the question card (so the operator can see what
   * ProQyz's DOM actually looks like at the moment of failure), and
   * then throws `row-not-created` (or whichever phase is passed)
   * via `_captureAndThrowRadioFailure`.
   *
   * "Inputs" includes the question input, all option-row inputs,
   * the add-more placeholder input, and the trailing disabled
   * radio. "Buttons" includes the per-block "Add more options" UI
   * (if any) and the modal-level "Add More Questions" / "Create
   * Question" buttons (so the operator can confirm we never
   * accidentally clicked the wrong one).
   *
   * @param {import("playwright").Page} page
   * @param {import("playwright").Locator} modal
   * @param {import("../../domain/schemas.js").Question} q
   * @param {string} tag — e.g. "Q36-37"
   * @param {number} subIdx — sub-question index (i in the loop)
   * @param {{ number: number, options: Array<{label: string, text: string}> }} sq
   * @param {string} phase — failure phase name (e.g. "row-not-created", "add-more-missing")
   * @param {number} optIdx — index of the option we tried to create
   * @param {import("playwright").Locator} useContainer
   * @private
   */
  async _dumpAndThrowRowFailure(
    page,
    modal,
    q,
    tag,
    subIdx,
    sq,
    phase,
    optIdx,
    useContainer,
  ) {
    const failureName = `radio-${phase}-Q${sq.number}-opt${optIdx}`;
    try {
      await captureFailure(page, failureName);
    } catch (_) {
      // best-effort
    }
    // Dump every input + every button inside the per-block container
    // so the operator can see the actual DOM at failure time.
    let cardInputs = [];
    let cardButtons = [];
    try {
      cardInputs = await useContainer
        .locator("input")
        .evaluateAll((els) =>
          els.map((e) => ({
            tag: e.tagName.toLowerCase(),
            type: e.type ?? null,
            placeholder: e.placeholder ?? null,
            value: e.value ?? "",
            readOnly: e.readOnly,
            disabled: e.disabled,
            classes: (e.className ?? "").toString().slice(0, 120),
            name: e.name ?? null,
            id: e.id ?? null,
          })),
        );
    } catch (_) {
      // best-effort
    }
    try {
      cardButtons = await useContainer
        .locator("button, a, [role=button]")
        .evaluateAll((els) =>
          els.map((e) => ({
            tag: e.tagName.toLowerCase(),
            type: e.type ?? null,
            text: (e.textContent ?? "").trim().slice(0, 80),
            classes: (e.className ?? "").toString().slice(0, 120),
            disabled: e.disabled ?? false,
          })),
        );
    } catch (_) {
      // best-effort
    }
    // Also re-collect the current option-row count from the card so
    // the log shows what we saw at failure time.
    const currentOptionRows = await this._findRadioOptionInputs(useContainer);
    await this._captureAndThrowRadioFailure(
      page,
      modal,
      q,
      tag,
      phase,
      {
        sub: subIdx,
        subNumber: sq.number,
        optIdx,
        wantRows: optIdx + 1,
        currentOptionRows: currentOptionRows.length,
        cardInputs,
        cardButtons,
      },
    );
  }

  /**
   * Robustly fill a Playwright text input on a React-controlled form.
   *
   * Pattern (2026-06-09 live Radio editor):
   *   1. Click to focus.
   *   2. Ctrl/Cmd+A to select all existing text.
   *   3. Backspace to clear.
   *   4. `page.keyboard.insertText(newText)` to type the new value
   *      (bypasses IME / keyboard layout issues).
   *   5. Tab to blur and trigger React onBlur.
   *   6. Read back the input's value.
   *   7. If the value still didn't change (React's value tracker
   *      swallowed our synthetic events), fall back to the canonical
   *      "use the native value setter, then dispatch an input event"
   *      trick — this is the well-known workaround for React's
   *      synthetic event system.
   *
   * @param {import("playwright").Locator} input
   * @param {string} text
   * @returns {Promise<void>}
   * @private
   */
  async _robustFillTextInput(input, text) {
    const { page } = this;
    const wantsReadOnlyStrip = await input
      .evaluate((el) => {
        if (el.hasAttribute("readonly")) {
          el.removeAttribute("readonly");
        }
        if (el.hasAttribute("disabled")) {
          el.removeAttribute("disabled");
        }
        return el.readOnly || el.disabled;
      })
      .catch(() => false);

    await input.click({ timeout: 5000 }).catch(async () => {
      // If the click fails (e.g. element is hidden under a label),
      // focus it via JS.
      await input.evaluate((el) => el.focus()).catch(() => null);
    });
    await page.waitForTimeout(80);
    await page.keyboard.press("Control+A").catch(() => null);
    await page.keyboard.press("Meta+A").catch(() => null);
    await page.keyboard.press("Backspace").catch(() => null);
    await page.waitForTimeout(80);
    await page.keyboard.insertText(text);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(120);

    const after = await input.inputValue().catch(() => null);
    if (after === text) return;

    // React-native value setter fallback.
    log.uploader.debug(
      { want: text, got: after, wantsReadOnlyStrip },
      "robustFill: falling back to React native value setter",
    );
    await input.evaluate((el, val) => {
      const proto = Object.getPrototypeOf(el);
      const desc =
        Object.getOwnPropertyDescriptor(proto, "value") ||
        Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(proto),
          "value",
        );
      const setter = desc && desc.set;
      if (setter) setter.call(el, val);
      else el.value = val;
      el.dispatchEvent(
        new Event("input", { bubbles: true, cancelable: true }),
      );
      el.dispatchEvent(
        new Event("change", { bubbles: true, cancelable: true }),
      );
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    }, text);
    await page.waitForTimeout(120);
  }

  /**
   * Capture a rich-inventory failure dump for `_fillRadioQuestion`.
   *
   * @private
   */
  async _captureAndThrowRadioFailure(page, modal, q, tag, phase, extra) {
    const failureName = `radio-${phase}-${tag}`;
    try {
      await captureFailure(page, failureName);
    } catch (capErr) {
      log.uploader.warn(
        { err: capErr.message },
        "captureFailure itself failed during radio failure dump",
      );
    }
    const inventory = await this._dumpModalInventory(modal);
    log.uploader.error(
      { tag, phase, ...extra, inventory },
      `_fillRadioQuestion (${phase}) failure for ${tag}`,
    );
    throw new Error(
      `_fillRadioQuestion: ${phase} failure for ${tag} — see log + ` +
        `failures/${failureName}.*`,
    );
  }

  /**
   * Click the per-question Save button and then return to the list.
   * The "back" action is best-effort: if the editor was opened in the
   * same page, Save returns us to the list automatically.
   */
  async _saveQuestionAndBack(card) {
    const { page } = this;
    await this._clickFinalSave({
      scope: card,
      page,
      qTag: "per-question",
    });
    await waitForPageCalm(page, { timeoutMs: config.saveTimeoutMs });
    // Best-effort "Back" — ignored if absent.
    const back = page.locator(Selectors.questionEditor.backToListButton).first();
    if (await back.isVisible().catch(() => false)) {
      await back.click();
      await waitForPageCalm(page);
    }
  }

  /**
   * Flexible final-save click.
   *
   * Real ProQyz's last-mile save button is not fixed: it may render
   * as "Save changes", "Save", "Add Question", "Finish", "Submit",
   * "Create", "Create Question", or "Done" — and the per-question
   * editor may autosave on tab-switch and never show a save button
   * at all. The old strict `button:has-text("Save changes")` would
   * time out (30s) in any of those variants.
   *
   * Strategy:
   *   1. Enumerate visible buttons inside `scope` (modal/card/page)
   *      that match one of the known final-action labels.
   *   2. Pick the first VISIBLE + ENABLED one and click it.
   *   3. If no such button is found, do NOT throw. The flow may have
   *      already autosaved: check whether the question block is
   *      visible outside the modal (modal closed / card appeared).
   *   4. If autosave is also undetectable, throw a soft error that
   *      names every visible button so the operator can extend the
   *      label list. NEVER block on `networkidle` here.
   *
   * @param {object} args
   * @param {import("playwright").Locator|string} [args.scope]  Locator
   *   to search for the final button in. Defaults to `page`.
   * @param {import("playwright").Page} args.page
   * @param {string} [args.qTag]  Tag for log lines, e.g. "Q36-37".
   * @returns {Promise<{ strategy: "clicked"|"autosave"|"none",
   *                    buttonLabel?: string,
   *                    buttonCount: number,
   *                    modalClosed?: boolean,
   *                    questionCardVisible?: boolean }>}
   * @private
   */
  async _clickFinalSave({ scope, page, qTag = "save" } = {}) {
    // Final-action labels in priority order. The first visible match
    // wins; "Add Question" / "Create" only fire if the modal is still
    // up (otherwise we'd be clicking the "+ Add Question" sidebar
    // button and re-opening an editor).
    const finalLabels = [
      "Save changes",
      "Save Question",
      "Save",
      "Create Question",
      "Add Question",
      "Finish",
      "Submit",
      "Create",
      "Done",
    ];
    const root = scope ?? page;
    const finalBtn = root
      .locator("button, [role='button'], a.btn")
      .filter({ hasText: new RegExp(`^\\s*(${finalLabels.join("|")})\\s*$`, "i") })
      .first();
    // Don't auto-wait 30s — give it a 2s budget, then fall through.
    let picked = null;
    let pickedLabel = null;
    try {
      await finalBtn.waitFor({ state: "visible", timeout: 2000 });
      // Filter out DISABLED buttons.
      const isDisabled = await finalBtn
        .evaluate((el) => el.disabled === true || el.getAttribute("aria-disabled") === "true")
        .catch(() => false);
      if (!isDisabled) {
        picked = finalBtn;
        // Read the actual text to log which one matched.
        pickedLabel = (await finalBtn.textContent().catch(() => null))?.trim() ?? null;
      }
    } catch {
      // No final button visible within 2s — try autosave detection.
    }

    if (picked) {
      try {
        await picked.click({ timeout: 3000 });
        log.uploader.info(
          { qTag, buttonLabel: pickedLabel },
          `[${qTag}] Final save strategy: clicked "${pickedLabel}"`,
        );
        return {
          strategy: "clicked",
          buttonLabel: pickedLabel ?? undefined,
          buttonCount: 1,
        };
      } catch (clickErr) {
        // Click failed mid-flight (e.g. button disappeared during
        // a re-render). Fall through to autosave check below.
        log.uploader.debug(
          { qTag, err: clickErr.message },
          "final save click failed mid-flight; checking autosave",
        );
      }
    }

    // Autosave detection: dump visible buttons for diagnosis, then
    // check if the modal closed (meaning the question block was
    // committed without a Save click).
    const inventory = await this._dumpFinalButtonInventory(root, qTag);
    const modalClosed = await this._isModalClosed(root);
    const questionCardVisible = await this._isQuestionCardVisible(page);
    if (modalClosed || questionCardVisible) {
      log.uploader.info(
        {
          qTag,
          modalClosed,
          questionCardVisible,
          visibleButtonCount: inventory.length,
        },
        `[${qTag}] Final save strategy: autosave detected`,
      );
      return {
        strategy: "autosave",
        buttonCount: inventory.length,
        modalClosed,
        questionCardVisible,
      };
    }

    // No button, modal still up, no card visible — soft fail with
    // the full inventory so the operator can extend the label list.
    log.uploader.warn(
      {
        qTag,
        visibleButtonCount: inventory.length,
        visibleButtons: inventory.slice(0, 20),
      },
      `[${qTag}] Final save strategy: no final button found; modal still up`,
    );
    throw new Error(
      `_clickFinalSave (${qTag}): no final save button visible AND modal ` +
        `still up. Visible buttons: ${JSON.stringify(inventory.slice(0, 20))}. ` +
        `Extend finalLabels in _clickFinalSave if the new button label ` +
        `is not in the list.`,
    );
  }

  /**
   * Diagnostic inventory of visible buttons inside `scope`. Used by
   * `_clickFinalSave`'s autosave / no-button-found paths.
   * @param {import("playwright").Locator} scope
   * @param {string} qTag
   * @returns {Promise<Array<{ tag: string, text: string, classes: string, disabled: boolean }>>}
   * @private
   */
  async _dumpFinalButtonInventory(scope, qTag) {
    try {
      const buttons = scope.locator("button, [role='button'], a.btn");
      const count = await buttons.count();
      const out = [];
      for (let i = 0; i < Math.min(count, 80); i++) {
        const b = buttons.nth(i);
        const isVisible = await b.isVisible().catch(() => false);
        if (!isVisible) continue;
        const text = (await b.textContent().catch(() => null))?.trim() ?? "";
        const tag = await b.evaluate((el) => el.tagName.toLowerCase()).catch(() => "?");
        const classes = (await b.getAttribute("class").catch(() => null)) ?? "";
        const disabled = await b
          .evaluate((el) => el.disabled === true || el.getAttribute("aria-disabled") === "true")
          .catch(() => false);
        out.push({ tag, text, classes, disabled });
      }
      return out;
    } catch (err) {
      log.uploader.debug({ qTag, err: err.message }, "_dumpFinalButtonInventory failed");
      return [];
    }
  }

  /**
   * Detect whether a question-editor modal is still up. A modal that
   * has `.show`, `[role='dialog']`, or is a `.modal-dialog` counts as
   * "open". A scope that's NOT a modal locator (e.g. the page itself)
   * returns `true` for "closed" because the page can't be a modal.
   * @param {import("playwright").Locator} scope
   * @returns {Promise<boolean>}
   * @private
   */
  async _isModalClosed(scope) {
    // If `scope` doesn't have a modal class on it, treat as closed.
    try {
      const tag = await scope
        .evaluate((el) => {
          // For page locators this is the body; we accept that.
          if (el === document.body) return "body";
          return (el.tagName || "").toLowerCase();
        })
        .catch(() => null);
      if (tag === "body") return true; // page-wide scope ⇒ "no modal"
      // For real modal locators, check `.show` / `[role='dialog']`.
      const hasShow = await scope.evaluate((el) => {
        const cls = (el.className || "").toString();
        return cls.split(/\s+/).includes("show") || el.getAttribute("role") === "dialog";
      }).catch(() => false);
      return !hasShow;
    } catch {
      // If we can't tell, assume closed (don't fail).
      return true;
    }
  }

  /**
   * Detect whether a question block / card is now visible in the
   * page (i.e. the editor closed and a new question row appeared).
   * The ProQyz editor renders a list of question cards; we look for
   * a generic "Question N" / "Questions N" anchor. We do NOT pin a
   * specific selector — autosave success is "any new card visible".
   * @param {import("playwright").Page} page
   * @returns {Promise<boolean>}
   * @private
   */
  async _isQuestionCardVisible(page) {
    try {
      const cardSelectors = [
        ".question__card",
        ".question-card",
        ".card.mb-4",
        '[data-testid="question-item"]',
        "li:has-text('Question ')",
      ];
      for (const sel of cardSelectors) {
        const loc = page.locator(sel).first();
        if ((await loc.count({ timeout: 80 })) > 0 && (await loc.isVisible({ timeout: 80 }).catch(() => false))) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // EXPLANATION UPLOAD — separate from quiz/passage/question creation
  // ===========================================================================

  /**
   * Search for a quiz on My Quizzes and open its edit page.
   * If existingQuizUrl is provided, skip search and go directly.
   *
   * @param {string} testTitle
   * @param {string} [existingQuizUrl]
   * @returns {Promise<void>}
   */
  async searchAndOpenQuiz(testTitle, existingQuizUrl) {
    const { page } = this;

    if (existingQuizUrl) {
      log.uploader.info({ url: existingQuizUrl }, "opening quiz by direct URL");
      await page.goto(existingQuizUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
      return;
    }

    // ------------------------------------------------------------------
    // 0. Check if we're already on the correct quiz edit page.
    //    The user may have navigated here before the upload started.
    // ------------------------------------------------------------------
    const currentUrl = page.url();
    if (/quiz\/edit/i.test(currentUrl)) {
      log.uploader.info({ url: currentUrl }, "already on a quiz edit page — checking if it's the right one");
      await this._waitForEditQuizPageReady({ timeoutMs: 5000 }).catch(() => null);
      log.uploader.info("continuing from current quiz edit page");
      return;
    }

    // ------------------------------------------------------------------
    // 1. Navigate to My Quizzes and wait for the list to render.
    // ------------------------------------------------------------------
    log.uploader.info({ testTitle }, "searching quiz on My Quizzes");
    await page.goto(`${config.baseUrl}${Selectors.quizForm.myQuizzesPath}`, {
      waitUntil: "domcontentloaded",
    });
    // Wait for at least one row/card/link to appear — the real readiness
    // signal for My Quizzes (not networkidle, not a spinner).
    await page
      .locator(
        'a[href*="edit"], a[href*="quiz"], .quiz-item, .quiz-row, .card, .list-group-item, tr, .py-2',
      )
      .first()
      .waitFor({ state: "visible", timeout: 10000 })
      .catch(() => null);
    await page.waitForTimeout(300); // extra settle for SPA re-render

    // ------------------------------------------------------------------
    // 2. Scan visible rows BEFORE searching. The quiz may already be on
    //    the first page without any search filtering.
    // ------------------------------------------------------------------
    const beforeSearch = await this._collectQuizTitles();
    log.uploader.info(
      { count: beforeSearch.length, titles: beforeSearch },
      "visible quiz titles BEFORE search",
    );

    let editBtn = await this._findQuizEditPencil(testTitle, beforeSearch);
    if (editBtn) {
      log.uploader.info({ testTitle }, "quiz found in visible list (no search needed)");
      await editBtn.click();
      await page.waitForTimeout(500);
      await this._waitForEditQuizPageReady({ timeoutMs: 10000 }).catch(() => null);
      log.uploader.info({ testTitle }, "quiz edit page opened");
      return;
    }

    // ------------------------------------------------------------------
    // 3. Not found in visible rows — fill the search input and click
    //    the search icon button (id="basic-addon2").
    // ------------------------------------------------------------------
    log.uploader.info({ testTitle }, "quiz not in visible rows; searching");
    const searchInput = await this._findSearchInput();
    if (searchInput) {
      await searchInput.fill(testTitle);
      log.uploader.info({ testTitle }, "filled search input");

      // Click the search icon button adjacent to the input
      const searchIconBtn = page.locator('#basic-addon2, .input-group-text').first();
      if (await searchIconBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await searchIconBtn.click();
        log.uploader.info("clicked search icon button (#basic-addon2)");
      } else {
        // Fallback: press Enter
        await page.keyboard.press("Enter");
        log.uploader.info("pressed Enter (search icon not found)");
      }
      await page.waitForTimeout(1500); // wait for filter to apply + network
    } else {
      log.uploader.warn("no search input found on My Quizzes");
    }

    // ------------------------------------------------------------------
    // 4. Scan rows again after search.
    // ------------------------------------------------------------------
    const afterSearch = await this._collectQuizTitles();
    log.uploader.info(
      { count: afterSearch.length, titles: afterSearch },
      "visible quiz titles AFTER search",
    );

    editBtn = await this._findQuizEditPencil(testTitle, afterSearch);
    if (editBtn) {
      log.uploader.info({ testTitle }, "quiz found after search");
      await editBtn.click();
      await page.waitForTimeout(500);
      await this._waitForEditQuizPageReady({ timeoutMs: 10000 }).catch(() => null);
      log.uploader.info({ testTitle }, "quiz edit page opened");
      return;
    }

    // ------------------------------------------------------------------
    // 5. Last resort — dump page inventory and throw.
    // ------------------------------------------------------------------
    const inventory = await this._dumpPageInventory(page);
    log.uploader.error(
      { testTitle, beforeSearch, afterSearch, inventory },
      "searchAndOpenQuiz: quiz not found after search",
    );
    throw new Error(
      `quiz "${testTitle}" not found on My Quizzes. ` +
        `Visible titles: ${JSON.stringify(afterSearch)}`,
    );
  }

  // -----------------------------------------------------------------------
  // searchAndOpenQuiz helpers
  // -----------------------------------------------------------------------

  /**
   * Collect all visible "quiz title" texts from the My Quizzes list.
   * Walks every plausible row/card/link on the page, reads its text,
   * normalizes (trim, collapse whitespace, lowercase), and returns
   * unique non-empty values. Used by searchAndOpenQuiz to decide whether
   * the target quiz is already visible.
   *
   * @returns {Promise<string[]>}
   * @private
   */
  async _collectQuizTitles() {
    const { page } = this;
    // Every plausible quiz-row container.
    const rowSels = [
      ".quiz-item",
      ".quiz-row",
      ".card",
      ".list-group-item",
      ".py-2",
      "tr",
      '[data-quiz-id]',
      '[data-testid="quiz-row"]',
      // Broad fallback: any anchor that links to /edit/.
      'a[href*="edit"]',
      'a[href*="quiz"]',
    ];
    const texts = [];
    const seen = new Set();
    for (const sel of rowSels) {
      const rows = page.locator(sel);
      const n = await rows.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = rows.nth(i);
        const vis = await el.isVisible().catch(() => false);
        if (!vis) continue;
        const raw = (await el.innerText().catch(() => "")) || "";
        // The first meaningful line of the row is the quiz title.
        // Rows often contain "Title\nStatus\nDate\n…" — grab the first
        // non-empty line.
        const lines = raw
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length === 0) continue;
        const firstLine = _normalizeQuizText(lines[0]);
        if (firstLine && !seen.has(firstLine)) {
          seen.add(firstLine);
          texts.push(firstLine);
        }
      }
    }
    return texts;
  }

  /**
   * Find the edit-pencil button for a quiz row whose text matches
   * testTitle. Returns the locator of the clickable edit control, or
   * null if not found.
   *
   * @param {string} testTitle
   * @param {string[]} visibleTitles — output of _collectQuizTitles
   * @returns {Promise<import("playwright").Locator | null>}
   * @private
   */
  async _findQuizEditPencil(testTitle, visibleTitles) {
    const { page } = this;
    const normalized = _normalizeQuizText(testTitle);

    // First: try to find an exact title match in the list we collected.
    const exactMatch = visibleTitles.find((t) => t === normalized);
    const partialMatch =
      !exactMatch ? visibleTitles.find((t) => t.includes(normalized)) : null;
    const matchedTitle = exactMatch || partialMatch;
    if (matchedTitle) {
      log.uploader.info(
        { testTitle, matchedTitle, isExact: !!exactMatch },
        "matched quiz title in visible list",
      );
    }

    // Strategy 1: find a row whose text content includes the title, then
    // look for an edit pencil INSIDE that row.
    const editPencilSelectors = [
      // Pencil/link SVG icons — the purple edit pencil on ProQyz.
      'a[href*="edit"]:not([href*="preview"]):not([href*="view"])',
      'button[aria-label*="edit" i]:not([aria-label*="preview" i])',
      'a[aria-label*="edit" i]',
      // Generic edit icons — fa-edit, pencil SVG, etc.
      ".fa-edit",
      ".fa-pencil",
      ".btn-edit",
      'svg[data-icon="pencil"]',
      'svg[data-icon="edit"]',
      // Visible text fallback (but NOT "Preview", "View", "Delete").
      'a:has-text("Edit"):not(:has-text("Delete"))',
      'button:has-text("Edit"):not(:has-text("Delete"))',
    ];

    // Walk every plausible row container, check if it contains the
    // target title text, then look for the edit pencil inside it.
    const rowSels = [
      ".quiz-item",
      ".quiz-row",
      ".card",
      ".list-group-item",
      ".py-2",
      "tr",
      '[data-quiz-id]',
      '[data-testid="quiz-row"]',
      'a[href*="edit"]',
      'a[href*="quiz"]',
    ];

    for (const rowSel of rowSels) {
      const rows = page.locator(rowSel);
      const n = await rows.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const row = rows.nth(i);
        const vis = await row.isVisible().catch(() => false);
        if (!vis) continue;
        const rowText = (await row.innerText().catch(() => "")) || "";
        const rowNorm = _normalizeQuizText(rowText);
        // Does this row contain our quiz title?
        if (!rowNorm.includes(normalized)) continue;

        // Found the row. Now find the edit pencil inside it.
        for (const pencilSel of editPencilSelectors) {
          const pencil = row.locator(pencilSel).first();
          if (await pencil.isVisible({ timeout: 500 }).catch(() => false)) {
            log.uploader.info(
              {
                testTitle,
                matchedTitle: matchedTitle || "(from row text)",
                rowSel,
                pencilSel,
              },
              "edit pencil found",
            );
            return pencil;
          }
        }
        // Row matched but no pencil found — fall through to the
        // broader page-wide scan below.
        log.uploader.debug(
          { testTitle, rowSel, rowText: rowNorm.slice(0, 100) },
          "row matched but no edit pencil found inside; trying page-wide",
        );
      }
    }

    // Strategy 2: page-wide scan. Find every edit pencil on the page,
    // then walk up ancestors to see if the title text appears.
    for (const pencilSel of editPencilSelectors) {
      const pencils = page.locator(pencilSel);
      const n = await pencils.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const pencil = pencils.nth(i);
        const vis = await pencil.isVisible().catch(() => false);
        if (!vis) continue;
        // Walk up 5 ancestors looking for the title text.
        const found = await pencil
          .evaluate(
            (el, needle) => {
              let cur = el;
              for (let depth = 0; depth < 6; depth++) {
                if (!cur || cur === document.body) break;
                const t = (cur.textContent || "").toLowerCase();
                if (t.includes(needle)) return true;
                cur = cur.parentElement;
              }
              return false;
            },
            normalized,
          )
          .catch(() => false);
        if (found) {
          log.uploader.info(
            { testTitle, pencilSel },
            "edit pencil found (page-wide ancestor scan)",
          );
          return pencil;
        }
      }
    }

    // Strategy 3: last resort — getByText (partial match), then find
    // nearest sibling edit link/button.
    const textLoc = page.getByText(testTitle, { exact: false }).first();
    if (await textLoc.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Find an edit button in the same parent container.
      const container = textLoc.locator(
        "xpath=ancestor::*[contains(@class,'row') or contains(@class,'card') or contains(@class,'quiz') or contains(@class,'list-group') or contains(@class,'py-2') or self::tr][1]",
      );
      if ((await container.count()) > 0) {
        const pencil = container
          .locator(editPencilSelectors.join(", "))
          .first();
        if (await pencil.isVisible({ timeout: 500 }).catch(() => false)) {
          log.uploader.info({ testTitle }, "edit pencil found (getByText container)");
          return pencil;
        }
      }
      // Absolute last resort: click the text itself if it's a link.
      const tag = await textLoc
        .evaluate((el) => el.tagName.toLowerCase())
        .catch(() => "");
      if (tag === "a") {
        log.uploader.info({ testTitle }, "title text is a link; clicking directly");
        return textLoc;
      }
    }

    return null;
  }

  /**
   * Find the search input on the My Quizzes page.
   * @returns {Promise<import("playwright").Locator | null>}
   * @private
   */
  async _findSearchInput() {
    const { page } = this;
    // ProQyz uses: <input placeholder="Search Quiz" ...> inside an .input-group
    // with a sibling <span id="basic-addon2"> search icon button.
    const searchSelectors = [
      'input[placeholder*="Search Quiz"]',
      'input[placeholder*="search quiz" i]',
      'input[placeholder*="search" i]',
      'input[type="search"]',
      'input[name="search"]',
      'input.form-control:not([type="hidden"]):not([type="password"])',
    ];
    for (const sel of searchSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
        log.uploader.info({ selector: sel }, "search input found");
        return loc;
      }
    }
    return null;
  }

  /**
   * Find the question editor modal/dialog currently visible on the page.
   * ProQyz renders the question editor in various modal containers; we try
   * multiple selectors and return the first visible match.
   *
   * @returns {import("playwright").Locator}
   */
  async _findQuestionModal() {
    const { page } = this;
    const selectors = [
      '.question__components.modal.show',
      '.modal.show .question__components',
      '.modal.show[data-testid="question-editor"]',
      '#question-modal.show',
      '.modal.show',
      '.modal-dialog.show',
      '[role="dialog"][aria-modal="true"]',
      '.question__components',
    ];
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
        return loc;
      }
    }
    // Fallback: return broadest selector (caller will handle visibility)
    return page.locator(".modal.show").first();
  }

  /**
   * Open an existing question for editing by finding its row and clicking edit.
   * Assumes we are already on the Questions tab with the correct passage selected.
   *
   * @param {string} rangeLabel - e.g. "Questions 36-37" or "Question 5"
   * @returns {Promise<void>}
   */
  async openQuestionForEdit(rangeLabel, expectedSlots) {
    const { page } = this;
    const normalizedLabel = _normalizeRangeLabel(rangeLabel);
    const rangeKey = _extractRangeKey(normalizedLabel);
    log.uploader.info({ rangeLabel, normalizedLabel, rangeKey, expectedSlots }, "opening question for edit");

    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        log.pipeline.info({ rangeLabel, attempt }, "retrying openQuestionForEdit after wrong row");
      }

      // --- Step 1: Geometric Y-coordinate matching ---
      // Find all visible pencil buttons and the target text bounding box.
      // Click the pencil whose Y-center is closest to the target text's Y-center.
      const geoResult = await page.evaluate(({ rangeKey, normalizedLabel }) => {
        // 1. Find the text element containing the target range
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let textNode = null;
        while (walker.nextNode()) {
          const text = (walker.currentNode.textContent || "").trim();
          if (!text) continue;
          if (rangeKey && text.includes(rangeKey)) { textNode = walker.currentNode; break; }
          if (normalizedLabel && text.toLowerCase().includes(normalizedLabel.toLowerCase())) { textNode = walker.currentNode; break; }
        }
        if (!textNode) return { found: false, error: "text node not found" };

        // Get bounding box of the text node's parent (the visible element)
        const textEl = textNode.parentElement;
        if (!textEl) return { found: false, error: "text node has no parent" };
        const textBox = textEl.getBoundingClientRect();
        const titleCenterY = textBox.y + textBox.height / 2;

        // Log the matched text element details
        const titleText = (textEl.innerText || textNode.textContent || "").trim().slice(0, 100);
        const titleClass = (textEl.className || "").slice(0, 100);
        const titleOuterHTML = textEl.outerHTML.slice(0, 300);

        // 2. Find ALL pencil buttons on the page and their bounding boxes
        const pencilButtons = document.querySelectorAll('button:has(i.fa-pencil), button:has(.fa-pencil)');
        const pencils = [];
        for (const btn of pencilButtons) {
          const rect = btn.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue; // skip hidden
          const centerY = rect.y + rect.height / 2;
          pencils.push({
            centerY,
            top: rect.y,
            height: rect.height,
            distance: Math.abs(centerY - titleCenterY),
            outerHTML: btn.outerHTML.slice(0, 200),
          });
        }

        if (pencils.length === 0) return { found: false, error: "no pencil buttons on page" };

        // Sort by distance to title center Y
        pencils.sort((a, b) => a.distance - b.distance);
        const closest = pencils[0];

        return {
          found: true,
          titleCenterY,
          titleText,
          titleClass,
          titleOuterHTML,
          titleBox: { x: textBox.x, y: textBox.y, width: textBox.width, height: textBox.height },
          pencilCount: pencils.length,
          closestPencil: closest,
          topPencils: pencils.slice(0, 5),
        };
      }, { rangeKey, normalizedLabel }).catch((err) => ({ found: false, error: err.message }));

      log.uploader.info({ rangeLabel, attempt, geoResult }, "geometric row matching result");

      if (!geoResult.found) {
        await captureFailure(page, `no-row-match-${rangeLabel.replace(/\s+/g, "-")}`).catch(() => {});
        throw new Error(
          `openQuestionForEdit: no text node matching "${rangeLabel}" found in page DOM. ${geoResult.error || ""}`,
        );
      }

      // --- Step 2: Click the pencil closest to the target text ---
      await page.evaluate(({ titleCenterY }) => {
        const pencilButtons = document.querySelectorAll('button:has(i.fa-pencil), button:has(.fa-pencil)');
        let closest = null;
        let minDist = Infinity;
        for (const btn of pencilButtons) {
          const rect = btn.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const centerY = rect.y + rect.height / 2;
          const dist = Math.abs(centerY - titleCenterY);
          if (dist < minDist) {
            minDist = dist;
            closest = btn;
          }
        }
        if (closest) closest.click();
      }, { titleCenterY: geoResult.titleCenterY }).catch(() => {});

      log.uploader.info(
        { rangeLabel, titleCenterY: geoResult.titleCenterY, closestDist: geoResult.closestPencil.distance, titleText: geoResult.titleText },
        "clicked pencil closest to target text",
      );

      await page.waitForTimeout(800);

      // --- Step 3: Wait for modal ---
      const modalFound = await this._waitForQuestionModal(rangeLabel);

      if (!modalFound) {
        log.uploader.warn({ rangeLabel, attempt }, "modal did not appear; retrying");
        continue;
      }

      // --- Step 4: Verify — click Explanation tab and count cards ---
      if (expectedSlots && expectedSlots > 0) {
        const verified = await this._verifyModalForRange(page, rangeKey, expectedSlots);
        if (verified) {
          log.uploader.info({ rangeLabel, expectedSlots }, "modal verified — correct question opened");
          return; // success
        }
        // Wrong modal — close and retry
        log.uploader.warn(
          { rangeLabel, expectedSlots, attempt },
          "wrong question opened (card count mismatch); closing modal and retrying",
        );
        await this._closeQuestionModal(page).catch(() => {});
        await page.waitForTimeout(500);
        continue;
      }

      // No expectedSlots provided — trust the geometric match
      log.uploader.info({ rangeLabel }, "no expectedSlots for verification; proceeding");
      return;
    }

    // All retries exhausted
    await captureFailure(page, `open-question-retries-exhausted-${rangeLabel.replace(/\s+/g, "-")}`).catch(() => {});
    throw new Error(
      `openQuestionForEdit: failed to open correct question "${rangeLabel}" after ${MAX_RETRIES} attempts`,
    );
  }

  /**
   * Wait for the question edit modal to appear.
   * @returns {Promise<boolean>} true if modal detected
   */
  async _waitForQuestionModal(rangeLabel) {
    const { page } = this;
    const modalSelectors = [
      '.question__components.modal.show',
      '.modal.show:has(text("Edit"))',
      '.modal.show:has(text("Question"))',
      '.modal.show .question__components',
      '[data-testid="question-editor"]',
      '#question-modal.show',
      '.modal-backdrop.show',
    ];

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      for (const sel of modalSelectors) {
        if (await page.locator(sel).first().isVisible({ timeout: 300 }).catch(() => false)) {
          log.uploader.info({ rangeLabel, selector: sel }, "question editor modal detected");
          return true;
        }
      }
    }

    const url = page.url();
    const bodyText = (await page.locator(".content, .card-body, .container-xxl, body").first().innerText().catch(() => "")).slice(0, 500);
    log.uploader.warn({ rangeLabel, url, bodySnippet: bodyText.replace(/\s+/g, " ").slice(0, 300) }, "modal not detected");
    await captureFailure(page, `open-question-${rangeLabel.replace(/\s+/g, "-")}`).catch(() => {});
    return false;
  }

  /**
   * Verify that the opened modal corresponds to the expected question range
   * by clicking the Explanation tab and counting the explanation cards.
   *
   * @param {import("playwright").Page} page
   * @param {string} rangeKey - e.g. "4-7"
   * @param {number} expectedSlots - e.g. 4
   * @returns {Promise<boolean>}
   */
  async _verifyModalForRange(page, rangeKey, expectedSlots) {
    const { browserContext: ctx } = this;

    // Click the Explanation tab in the modal
    const modal = await this._findQuestionModal();
    const tab = modal
      .locator('li.tabs, [role="tab"]')
      .filter({ hasText: /Explanation/i })
      .first();
    if (!(await tab.isVisible({ timeout: 3000 }).catch(() => false))) {
      log.uploader.warn("Explanation tab not visible for verification");
      return true; // can't verify — trust the match
    }
    await tab.click();
    await page.waitForTimeout(500);

    // Count explanation cards with "N. Explanation" labels
    const cardCount = await modal.evaluate((modalEl) => {
      const cards = modalEl.querySelectorAll('.card');
      let count = 0;
      for (const card of cards) {
        const label = card.querySelector('label');
        if (label && /explanation/i.test((label.textContent || "").trim())) {
          count++;
        }
      }
      return count;
    }).catch(() => 0);

    log.uploader.info({ rangeKey, expectedSlots, cardCount }, "modal card count verification");

    // Switch back to the Question tab so the caller's flow is unaffected
    const questionTab = modal
      .locator('li.tabs, [role="tab"]')
      .filter({ hasText: /Question/i })
      .first();
    if (await questionTab.isVisible({ timeout: 1000 }).catch(() => false)) {
      await questionTab.click();
      await page.waitForTimeout(300);
    }

    return cardCount === expectedSlots;
  }

  /**
   * Close the question edit modal without saving.
   */
  async _closeQuestionModal(page) {
    // Click the top-right X button (.btn-close) or press Escape
    const closeBtn = page.locator('.modal.show .btn-close').first();
    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeBtn.click({ force: true });
    } else {
      await page.keyboard.press("Escape");
    }
    await page.waitForTimeout(500);
    log.uploader.info("question modal closed");
  }

  /**
   * Fill explanation slots on the Explanation tab of the question editor.
   *
   * Card-based approach: finds each explanation card by its label
   * ("1. Explanation", "2. Explanation", ...), expands it if collapsed,
   * targets its TinyMCE instance via textarea ID, and verifies insertion.
   *
   * Supports blank explanations: when `blank: true`, the editor is
   * verified to be empty instead of having content written to it.
   *
   * @param {Array<{slot: number, content: string, blank?: boolean}>} explanations
   * @returns {Promise<{slotsFilled: number, slotsVerified: number}>}
   */
  async fillExplanationsSlot(explanations) {
    const { page } = this;
    const modal = await this._findQuestionModal();

    // --- Step 1: Click the Explanation tab in the modal ---
    log.uploader.info("opening explanation tab");
    const tab = modal
      .locator('li.tabs, [role="tab"]')
      .filter({ hasText: /Explanation/i })
      .first();
    await tab.waitFor({ state: "visible", timeout: config.actionTimeoutMs });
    await tab.click();
    await page.waitForTimeout(500);

    // Wait for Explanation tab content to render — look for card labels
    // with "Explanation" text or TinyMCE wrappers.
    const explanationSignal = modal
      .locator('label:has-text("Explanation"), .tox, [id^="explanation-"]')
      .first();
    await explanationSignal.waitFor({ state: "visible", timeout: 10000 }).catch(() => null);
    log.uploader.info("explanation tab opened");

    // --- Step 2: Wait for editors to fully load ---
    await this._waitForExplanationEditors(modal, explanations.length);

    // --- Step 3: Build card inventory ---
    const inventory = await this._dumpExplanationCards(modal);
    log.uploader.info({ inventory }, "explanation card inventory");

    if (inventory.length < explanations.length) {
      log.uploader.error(
        { expected: explanations.length, found: inventory.length },
        "Explanation cards not ready",
      );
      await captureFailure(page, "explanation-editors-not-ready").catch(() => {});
      throw new Error(
        `Explanation cards not ready: expected ${explanations.length}, found ${inventory.length}`,
      );
    }

    // --- Step 4: Fill each slot (skip blank slots) ---
    const sorted = [...explanations].sort((a, b) => a.slot - b.slot);
    let slotsFilled = 0;
    let slotsVerified = 0;

    for (let i = 0; i < sorted.length; i++) {
      const exp = sorted[i];
      const card = inventory[i];
      const isBlank = !!exp.blank;

      log.uploader.info(
        { slot: exp.slot, index: i + 1, total: sorted.length, cardId: card.id, blank: isBlank },
        isBlank ? `blank slot ${exp.slot} — will verify empty` : `filling slot ${exp.slot}`,
      );

      // 4a: Expand collapsed card if needed
      await this._expandExplanationCard(modal, card, i);

      // 4a2: Wait for TinyMCE to initialize this card's editor
      if (card.textareaId) {
        await this._waitForTinyMceReady(page, card.textareaId);
      }

      if (isBlank) {
        // --- Blank slot: verify editor is empty, do NOT write ---
        const verified = await this._verifyBlankExplanation(page, card);
        if (verified) {
          slotsFilled++;
          slotsVerified++;
          log.uploader.info({ slot: exp.slot }, `blank slot ${exp.slot} verified empty`);
        } else {
          log.uploader.error(
            { slot: exp.slot, cardId: card.id },
            `blank slot ${exp.slot} verification FAILED — editor not empty`,
          );
          await captureFailure(page, `blank-verify-fail-${exp.slot}`).catch(() => {});
          throw new Error(
            `Blank explanation slot ${exp.slot} verification failed: editor not empty`,
          );
        }
        continue;
      }

      // --- Non-blank slot: write content ---
      // 4b: Choose write path — content with \n needs line-by-line keyboard
      //     insertion because setContent(html) collapses newlines in TinyMCE.
      const hasNewlines = /\r?\n/.test(exp.content);
      let writeOk;
      if (hasNewlines) {
        writeOk = await this._insertTextWithNewlines(page, card, exp.content);
      } else {
        writeOk = await this._setExplanationContent(page, modal, card, exp.content);
      }
      if (!writeOk) {
        log.uploader.error({ slot: exp.slot, cardId: card.id }, "write failed for slot");
        await captureFailure(page, `slot-write-fail-${exp.slot}`).catch(() => {});
        throw new Error(`Explanation slot ${exp.slot} write failed (card ${card.id})`);
      }
      slotsFilled++;

      // 4c: Verify content was written correctly
      const verified = await this._verifyExplanationContent(page, card, exp.content);
      if (verified) {
        slotsVerified++;
        log.uploader.info({ slot: exp.slot }, `verified slot ${exp.slot}`);
      } else {
        log.uploader.error(
          { slot: exp.slot, cardId: card.id, expected: exp.content.slice(0, 100) },
          `slot ${exp.slot} verification FAILED`,
        );
        await captureFailure(page, `slot-verify-fail-${exp.slot}`).catch(() => {});
        throw new Error(
          `Explanation slot ${exp.slot} verification failed: content not written correctly`,
        );
      }
    }

    log.uploader.info(
      { slotsFilled, slotsVerified, expected: sorted.length },
      "all explanation slots verified",
    );

    // --- Step 5: Pre-save content comparison (Fix 2) ---
    const preSaveCheck = await this._verifyAllSlotsBeforeSave(sorted, inventory);
    if (!preSaveCheck.match) {
      log.uploader.error({ mismatches: preSaveCheck.mismatches }, "pre-save content mismatch — aborting save");
      await captureFailure(page, "pre-save-mismatch").catch(() => {});
      throw new Error(`Pre-save verification failed: ${preSaveCheck.mismatches.length} slot(s) mismatch`);
    }
    log.uploader.info("all slots verified against source JSON before save");

    // NOTE: saveQuestionEdit() is called by the pipeline, not here.
    // This method only writes + verifies. Save is a separate step.

    return { slotsFilled, slotsVerified };
  }

  /**
   * Wait for explanation editors to appear in the modal.
   * Polls for TinyMCE tox wrappers, contenteditable, or textarea elements.
   *
   * @param {import("playwright").Locator} modal
   * @param {number} expectedSlots
   */
  async _waitForExplanationEditors(modal, expectedSlots) {
    const { page } = this;
    const deadline = Date.now() + 15000;
    let found = 0;

    while (Date.now() < deadline) {
      // Count TinyMCE wrappers (.tox divs with iframes) or contenteditable or textarea
      const toxCount = await modal.locator('.tox').count().catch(() => 0);
      const iframeCount = await modal.locator('iframe.tox-edit-area__iframe').count().catch(() => 0);
      const ceCount = await modal.locator('[contenteditable="true"]').count().catch(() => 0);
      const taCount = await modal.locator('textarea[id^="tiny-"]').count().catch(() => 0);
      // Use whichever gives highest count
      found = Math.max(toxCount, iframeCount, ceCount, taCount);

      if (found >= expectedSlots) {
        log.uploader.info({ toxCount, iframeCount, ceCount, taCount }, "explanation editors detected");
        return;
      }

      // Try expanding collapsed sections
      await this._expandAllExplanationCards(modal).catch(() => {});

      await page.waitForTimeout(500);
    }

    log.uploader.warn(
      { expectedSlots, found },
      "explanation editors did not reach expected count within timeout; proceeding with what we have",
    );
  }

  /**
   * Dump explanation cards — finds each card with a label like "N. Explanation"
   * and records its textarea ID (for TinyMCE targeting) and whether it's collapsed.
   *
   * @param {import("playwright").Locator} modal
   * @returns {Promise<Array<{id: string, index: number, textareaId: string, collapsed: boolean}>>}
   */
  async _dumpExplanationCards(modal) {
    const { page } = this;

    // Find all cards with "Explanation" labels inside the modal.
    // DOM: <div class="card ..."><div class="card-header ..."><label>N. Explanation</label>...</div><div class="collapse show">...<textarea id="tiny-react_XXX">...</div></div>
    const cards = await modal.evaluate((modalEl) => {
      const allCards = modalEl.querySelectorAll('.card');
      const results = [];
      for (let i = 0; i < allCards.length; i++) {
        const card = allCards[i];
        const label = card.querySelector('label');
        const labelText = (label?.textContent || "").trim();
        if (!/explanation/i.test(labelText)) continue;

        // Find the textarea backing TinyMCE
        const textarea = card.querySelector('textarea[id^="tiny-"]');
        const textareaId = textarea ? textarea.id : "";

        // Find the collapsible container
        const collapseEl = card.querySelector('.collapse');
        const collapsed = collapseEl ? !collapseEl.classList.contains('show') : false;

        results.push({
          index: results.length,
          label: labelText,
          textareaId,
          collapsed,
          cardIndex: i,
        });
      }
      return results;
    }).catch(() => []);

    log.uploader.info({ cardCount: cards.length, cards }, "explanation cards found");
    return cards;
  }

  /**
   * Expand a collapsed explanation card by clicking its header.
   *
   * @param {import("playwright").Locator} modal
   * @param {{id: string, index: number, textareaId: string, collapsed: boolean}} card
   * @param {number} slotIndex
   */
  async _expandExplanationCard(modal, card, slotIndex) {
    if (!card.collapsed) return;

    const { page } = this;
    // Click the card-header to toggle the collapse open
    const header = modal.locator('.card-header.collapsible').nth(slotIndex);
    if (await header.isVisible({ timeout: 1000 }).catch(() => false)) {
      await header.click();
      await page.waitForTimeout(500);
      log.uploader.info({ slot: slotIndex, textareaId: card.textareaId }, "expanded collapsed card");
      // Update inventory
      card.collapsed = false;
    }
  }

  /**
   * Expand all collapsed explanation cards in the modal.
   *
   * @param {import("playwright").Locator} modal
   */
  async _expandAllExplanationCards(modal) {
    const { page } = this;
    const collapsedCards = modal.locator('.card-header.collapsible');
    const count = await collapsedCards.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const card = collapsedCards.nth(i);
      if (!(await card.isVisible({ timeout: 300 }).catch(() => false))) continue;

      // Check if the following .collapse div is collapsed
      const isCollapsed = await card.evaluate((header) => {
        const collapseEl = header.closest('.card')?.querySelector('.collapse');
        return collapseEl ? !collapseEl.classList.contains('show') : false;
      }).catch(() => false);

      if (isCollapsed) {
        await card.click().catch(() => {});
        await page.waitForTimeout(300);
      }
    }
  }

  /**
   * Wait for TinyMCE to initialize a specific editor instance.
   * Polls `tinymce.get(textareaId)` until it returns a valid editor
   * with a loaded iframe body. Timeout after 10s.
   *
   * @param {import("playwright").Page} page
   * @param {string} textareaId
   * @param {number} [timeoutMs=10000]
   */
  async _waitForTinyMceReady(page, textareaId, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ready = await page.evaluate((taId) => {
        if (typeof tinymce === "undefined") return false;
        const ed = tinymce.get(taId);
        if (!ed) return false;
        // Check if the editor iframe body is accessible
        try {
          const iframe = ed.iframeElement;
          if (!iframe) return false;
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!doc || !doc.body) return false;
          return true;
        } catch {
          return false;
        }
      }, textareaId).catch(() => false);
      if (ready) {
        log.uploader.info({ textareaId, ms: Date.now() - start }, "TinyMCE editor ready");
        return;
      }
      await page.waitForTimeout(500);
    }
    log.uploader.warn({ textareaId, timeoutMs }, "TinyMCE editor did not become ready within timeout; proceeding anyway");
  }

  /**
   * Write HTML content into a specific explanation card's TinyMCE editor.
   *
   * Uses targeted TinyMCE API: tinymce.get(textareaId) instead of
   * tinymce.activeEditor which targets the wrong editor for slot 2+.
   *
   * Falls back to: iframe body innerHTML → contenteditable → textarea value.
   *
   * @param {import("playwright").Page} page
   * @param {import("playwright").Locator} modal
   * @param {{textareaId: string, index: number}} card
   * @param {string} html
   * @returns {Promise<boolean>}
   */
  async _setExplanationContent(page, modal, card, html) {
    // Strategy 1: Targeted TinyMCE API (most reliable)
    if (card.textareaId) {
      const ok = await page.evaluate(({ textareaId, htmlContent }) => {
        if (typeof tinymce === "undefined") return false;
        const ed = tinymce.get(textareaId);
        if (!ed) return false;

        // Focus the editor so React picks up the change
        ed.focus();
        ed.setContent(htmlContent);
        ed.fire("change");

        // Sync the backing textarea for React state
        const ta = document.getElementById(textareaId);
        if (ta) {
          ta.value = htmlContent;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return true;
      }, { textareaId: card.textareaId, htmlContent: html }).catch(() => false);

      if (ok) {
        log.uploader.info({ textareaId: card.textareaId }, "TinyMCE targeted write succeeded");

        // Fix 1: Post-write verification — use canonical reader
        await page.waitForTimeout(600);
        const postWriteText = await readEditorTextByTextareaId(page, card.textareaId);
        if (postWriteText.length === 0) {
          log.uploader.warn({ textareaId: card.textareaId }, "post-write read empty — TinyMCE accepted but did not render");
          // Fall through to retry strategies
        } else {
          log.uploader.info({ textareaId: card.textareaId, bodyLength: postWriteText.length }, "post-write DOM body verified");
          return true;
        }
      }
      log.uploader.warn({ textareaId: card.textareaId }, "TinyMCE targeted write failed or body empty; trying fallback");
    }

    // Strategy 2: Fallback — find the card's iframe and write body innerHTML
    const cardLocator = modal.locator('.card').filter({ has: modal.locator(`textarea[id^="tiny-"]`) }).nth(card.index);
    const iframe = cardLocator.locator('iframe.tox-edit-area__iframe').first();
    const iframeCount = await iframe.count().catch(() => 0);
    if (iframeCount > 0) {
      let frame = null;
      try {
        frame = await iframe.first().contentFrame();
      } catch (err) {
        frame = null;
      }
      if (frame) {
        const body = frame.locator('body').first();
        const bodyVisible = await body.isVisible({ timeout: 1000 }).catch(() => false);
        if (bodyVisible) {
          await body.evaluate((el, htmlContent) => {
            el.innerHTML = htmlContent;
            el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertHTML", data: htmlContent }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
          }, html);
          log.uploader.info({ index: card.index }, "iframe body innerHTML write succeeded");
          return true;
        }
      }
    }

    // Strategy 3: Direct textarea value
    if (card.textareaId) {
      const ok = await page.evaluate(({ textareaId, htmlContent }) => {
        const ta = document.getElementById(textareaId);
        if (!ta) return false;
        ta.value = htmlContent;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
        ta.dispatchEvent(new Event("blur", { bubbles: true }));
        return true;
      }, { textareaId: card.textareaId, htmlContent: html }).catch(() => false);
      if (ok) {
        log.uploader.info({ textareaId: card.textareaId }, "textarea direct write succeeded");
        return true;
      }
    }

    // Strategy 4: keyboard insertText (plain text — last resort)
    log.uploader.warn("all targeted write strategies failed; falling back to keyboard insertText");
    const cardBody = modal.locator('.card-body').nth(card.index);
    const editorEl = cardBody.locator('[contenteditable="true"], textarea, iframe').first();
    if (await editorEl.isVisible({ timeout: 2000 }).catch(() => false)) {
      await editorEl.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      await page.keyboard.insertText(html);
      return true;
    }
    return false;
  }

  /**
   * Insert plain text into a TinyMCE editor one line at a time, pressing
   * Shift+Enter between lines so the editor renders a real line break.
   *
   * Used as the newline-aware replacement for `_setExplanationContent` when
   * `content` contains `\n`. The TinyMCE setContent path collapses newlines
   * into spaces, so we drive keyboard insertion directly to preserve breaks.
   *
   * Flow:
   *   1. Focus the targeted TinyMCE editor via `tinymce.get(textareaId)`
   *   2. Clear existing content with Ctrl+A + Delete (via keyboard)
   *   3. For each line: `page.keyboard.type(line)` then Shift+Enter
   *      (except after the last line)
   *
   * @param {import("playwright").Page} page
   * @param {{textareaId: string, index: number}} card
   * @param {string} content  raw plain text (may contain `\n`)
   * @returns {Promise<boolean>} true if the editor accepted the content
   */
  async _insertTextWithNewlines(page, card, content) {
    if (!card.textareaId) {
      log.uploader.warn({ cardId: card.id }, "_insertTextWithNewlines: no textareaId");
      return false;
    }
    const text = String(content ?? "");
    if (!text) return false;

    const lines = text.split(/\r?\n/);

    // Step 1: focus + clear the targeted editor
    const focused = await page.evaluate((textareaId) => {
      if (typeof tinymce === "undefined") return false;
      const ed = tinymce.get(textareaId);
      if (!ed) return false;
      ed.focus();
      ed.setContent("");
      return true;
    }, card.textareaId).catch(() => false);

    if (!focused) {
      log.uploader.warn({ textareaId: card.textareaId }, "_insertTextWithNewlines: could not focus editor");
      return false;
    }

    // Give TinyMCE a moment to register the focus on the iframe
    await page.waitForTimeout(150);

    // Step 2: type each line + Shift+Enter between
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 0) {
        await page.keyboard.type(line, { delay: 5 });
      }
      if (i < lines.length - 1) {
        await page.keyboard.press("Shift+Enter");
        // TinyMCE may need a beat to commit the soft break before the next line
        await page.waitForTimeout(50);
      }
    }

    // Step 3: fire change events so React / parent form pick up the new value
    await page.evaluate((textareaId) => {
      const ed = tinymce.get(textareaId);
      if (!ed) return;
      ed.fire("change");
      ed.fire("keyup");
      const ta = document.getElementById(textareaId);
      if (ta) {
        ta.value = ed.getContent();
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, card.textareaId).catch(() => null);

    // Step 4: post-write verification via canonical reader
    await page.waitForTimeout(600);
    const postWriteText = await readEditorTextByTextareaId(page, card.textareaId);
    if (postWriteText.length === 0) {
      log.uploader.warn(
        { textareaId: card.textareaId },
        "_insertTextWithNewlines: post-write read empty",
      );
      return false;
    }

    log.uploader.info(
      {
        textareaId: card.textareaId,
        lineCount: lines.length,
        bodyLength: postWriteText.length,
      },
      "_insertTextWithNewlines: inserted with line breaks",
    );
    return true;
  }

  /**
   * Verify that an explanation card's editor contains the expected content.
   *
   * Reads back via TinyMCE API targeting the specific editor instance,
   * then checks: not empty, no escaped HTML tags, visible text non-empty.
   *
   * @param {import("playwright").Page} page
   * @param {{textareaId: string, index: number}} card
   * @param {string} expectedHtml
   * @returns {Promise<boolean>}
   */
  async _verifyExplanationContent(page, card, expectedHtml) {
    const actual = await readEditorTextByTextareaId(page, card.textareaId);

    log.uploader.info({
      textareaId: card.textareaId,
      actualPreview: actual.slice(0, 120),
      expectedPreview: (expectedHtml || "").replace(/<[^>]+>/g, "").trim().slice(0, 120),
    }, "slot verification compare");

    if (actual.length === 0) {
      log.uploader.warn({ textareaId: card.textareaId }, "verification: editor content empty");
      return false;
    }

    return true;
  }

  /**
   * Verify that a blank explanation slot's editor is empty.
   * Used when `blank: true` — no content should be written.
   *
   * @param {import("playwright").Page} page
   * @param {{textareaId: string, index: number}} card
   * @returns {Promise<boolean>} true if editor is empty (correct for blank)
   */
  async _verifyBlankExplanation(page, card) {
    const actual = await readEditorTextByTextareaId(page, card.textareaId);
    if (actual.length === 0) {
      return true; // correct — blank slot should be empty
    }

    log.uploader.warn(
      { textareaId: card.textareaId, actual: actual.slice(0, 200) },
      "blank verification: editor is NOT empty",
    );
    return false;
  }

  /**
   * Pre-save content comparison: re-read every TinyMCE editor and compare
   * against source JSON. For blank slots, verifies editor is empty.
   * For non-blank slots, verifies content matches.
   *
   * @param {Array<{slot: number, content: string, blank?: boolean}>} explanations
   * @param {Array<{textareaId: string, index: number}>} inventory
   * @returns {Promise<{match: boolean, mismatches: Array}>}
   */
  async _verifyAllSlotsBeforeSave(explanations, inventory) {
    const { page } = this;
    const mismatches = [];
    const sorted = [...explanations].sort((a, b) => a.slot - b.slot);

    for (let i = 0; i < sorted.length; i++) {
      const exp = sorted[i];
      const card = inventory[i];
      const isBlank = !!exp.blank;

      if (!card || !card.textareaId) {
        mismatches.push({ slot: exp.slot, reason: "card or textareaId not found" });
        continue;
      }

      await page.waitForTimeout(200);

      const actual = await readEditorTextByTextareaId(page, card.textareaId);

      if (isBlank) {
        // Blank slot: editor must be empty
        if (actual.length > 0) {
          mismatches.push({
            slot: exp.slot,
            reason: "blank slot not empty",
            actual: actual.slice(0, 200),
          });
        }
        log.uploader.info({ slot: exp.slot, blank: true, empty: actual.length === 0 }, "pre-save blank slot check");
      } else {
        // Non-blank slot: content must match
        const normalize = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
        const actualNorm = normalize(actual);
        const expectedNorm = normalize(exp.content);
        const matches = actualNorm.includes(expectedNorm) || expectedNorm.includes(actualNorm);

        if (!matches) {
          mismatches.push({
            slot: exp.slot,
            expected: exp.content.slice(0, 200),
            actual: actual.slice(0, 200),
          });
        }
        log.uploader.info({ slot: exp.slot, match: matches, actualLen: actual.length }, "pre-save slot comparison");
      }
    }

    return { match: mismatches.length === 0, mismatches };
  }

  /**
   * Post-save reopen verification: re-opens the same question, reads all
   * explanation editors, and compares against source JSON.
   *
   * Blank slots are verified to remain empty.
   * Non-blank slots are verified to match content.
   *
   * If any slot fails, throws an error — the question group is NOT
   * reported as success.
   *
   * @param {string} rangeLabel — e.g. "Question 36-37"
   * @param {number} expectedSlots — number of explanation slots
   * @param {Array<{slot: number, content: string, blank?: boolean}>} explanations
   * @returns {Promise<boolean>}
   */
  async reopenAndVerifyExplanations(rangeLabel, expectedSlots, explanations) {
    const { page } = this;

    log.uploader.info({ rangeLabel }, "post-save verification: reopening question");
    await this.openQuestionForEdit(rangeLabel, expectedSlots);

    const modal = await this._findQuestionModal();
    const tab = modal.locator('li.tabs, [role="tab"]').filter({ hasText: /Explanation/i }).first();
    await tab.waitFor({ state: "visible", timeout: 5000 }).catch(() => null);
    await tab.click();
    await page.waitForTimeout(1000);

    // Wait for editors to load
    await this._waitForExplanationEditors(modal, explanations.length);

    const inventory = await this._dumpExplanationCards(modal);
    const sorted = [...explanations].sort((a, b) => a.slot - b.slot);
    const mismatches = [];

    for (let i = 0; i < sorted.length; i++) {
      const exp = sorted[i];
      const card = inventory[i];
      const isBlank = !!exp.blank;

      if (!card || !card.textareaId) {
        mismatches.push({ slot: exp.slot, reason: "card not found" });
        continue;
      }

      if (card.collapsed) {
        await this._expandExplanationCard(modal, card, i);
        await page.waitForTimeout(500);
      }

      await this._waitForTinyMceReady(page, card.textareaId);

      const actual = await readEditorTextByTextareaId(page, card.textareaId);

      if (isBlank) {
        // Blank slot: must be empty
        if (actual.length > 0) {
          mismatches.push({ slot: exp.slot, reason: "blank slot not empty after save", actual: actual.slice(0, 100) });
        }
        log.uploader.info({ slot: exp.slot, blank: true, empty: actual.length === 0 }, "post-save blank check");
      } else {
        // Non-blank slot: must match content
        const normalize = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
        const actualNorm = normalize(actual);
        const expectedNorm = normalize(exp.content);
        const matches = actualNorm.includes(expectedNorm) || expectedNorm.includes(actualNorm);

        log.uploader.info({
          slot: exp.slot, match, actualPreview: actual.slice(0, 120), expectedPreview: exp.content.replace(/<[^>]+>/g, "").trim().slice(0, 120),
        }, "post-save slot check");

        if (!matches) {
          mismatches.push({ slot: exp.slot, expected: exp.content.slice(0, 100), actual: actual.slice(0, 100) });
        }
      }
    }

    // NOTE: modal is closed by the pipeline after this method returns.
    // Do NOT close here — the pipeline owns the close lifecycle.

    if (mismatches.length > 0) {
      log.uploader.error({ mismatches }, "POST-SAVE VERIFICATION FAILED — content not persisted");
      await captureFailure(page, "post-save-mismatch").catch(() => {});
      throw new Error(`Post-save verification failed: ${mismatches.length} slot(s) not persisted after save`);
    }

    log.uploader.info({ rangeLabel }, "post-save verification PASSED — all content survived save");
    return true;
  }

  /**
   * Save the question edit via "Save Changes" (NOT "Create Question").
   *
   * This method ONLY clicks Save and waits for the save to complete.
   * It does NOT assume the modal closes automatically.
   * It does NOT close the modal.
   * The pipeline is responsible for closing the modal after save.
   *
   * @returns {Promise<void>}
   */
  async saveQuestionEdit() {
    const { page } = this;
    const modal = await this._findQuestionModal();

    // Pre-save screenshot
    await captureFailure(page, "explanation-pre-save").catch(() => {});
    log.uploader.info("pre-save screenshot captured");

    // Dirty-state check — verify save button is enabled
    const dirtySignal = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const text = (btn.textContent || "").toLowerCase();
        if (text.includes("save") && !btn.disabled) {
          return { found: true, text: btn.textContent.trim() };
        }
      }
      return { found: false };
    });
    log.uploader.info({ dirtySignal }, "dirty state check before save");

    // Click the Save Changes button
    const saveBtn = modal.locator('button:has-text("Save Changes"), button:has-text("Save"), button[type="submit"]').first();
    if (!(await saveBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
      log.uploader.warn("Save Changes button not visible; trying Finish tab");
      const finishTab = modal.locator('.tablist .tabs, .tablist li, [role="tab"]').filter({ hasText: /Finish/i }).first();
      if (await finishTab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await finishTab.click();
        await page.waitForTimeout(200);
      }
    }

    // Re-locate the save button after potential tab switch
    const saveBtnFinal = modal.locator('button:has-text("Save Changes"), button:has-text("Save"), button[type="submit"]').first();
    await saveBtnFinal.click({ force: true }).catch(() => saveBtnFinal.click());

    // Wait for save to complete — up to 10s for any of:
    //   - modal disappears (auto-close)
    //   - spinner/loading appears then disappears
    //   - stable state (no network activity)
    const saveDeadline = Date.now() + 10000;
    while (Date.now() < saveDeadline) {
      const modalStillVisible = await modal.isVisible({ timeout: 500 }).catch(() => true);
      if (!modalStillVisible) {
        log.uploader.info("modal auto-closed after save");
        break;
      }

      // Check if spinner/loading is present (save in progress)
      const hasSpinner = await page.evaluate(() => {
        return !!document.querySelector('.spinner, .loading, [class*="spinner"], .btn-spinner');
      }).catch(() => false);

      if (!hasSpinner) {
        // No spinner, modal still visible — save likely done, modal just didn't close
        log.uploader.info("save complete, modal still open (will be closed by pipeline)");
        break;
      }

      await page.waitForTimeout(300);
    }

    await page.waitForTimeout(500);
    log.uploader.info("question edit saved");
  }

  /**
   * Close the question modal explicitly by clicking the X button.
   * Waits for the modal to fully disappear.
   * Returns true if modal was closed, false if no modal was found.
   *
   * @returns {Promise<boolean>}
   */
  async closeQuestionModalAfterSave() {
    const { page } = this;

    // Check if modal is still visible
    const modalVisible = await page.locator('.modal.show').first().isVisible({ timeout: 1000 }).catch(() => false);
    if (!modalVisible) {
      log.uploader.info("modal already closed — nothing to close");
      return true;
    }

    log.uploader.info("modal still open after save — clicking X to close");

    // Click X close button (top-right of modal)
    const closeBtn = page.locator('.modal.show .btn-close, .modal.show [data-bs-dismiss="modal"], .modal.show button[aria-label="Close"]').first();
    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeBtn.click({ force: true });
    } else {
      // Fallback: press Escape
      await page.keyboard.press("Escape");
    }

    // Wait for modal to fully disappear
    const closeDeadline = Date.now() + 5000;
    while (Date.now() < closeDeadline) {
      const stillVisible = await page.locator('.modal.show').first().isVisible({ timeout: 300 }).catch(() => false);
      if (!stillVisible) {
        log.uploader.info("modal closed via X button");
        await page.waitForTimeout(300);
        return true;
      }
      await page.waitForTimeout(200);
    }

    // Modal still visible after timeout — force close
    log.uploader.warn("modal still visible after close attempt — pressing Escape as fallback");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    const finalCheck = await page.locator('.modal.show').first().isVisible({ timeout: 500 }).catch(() => false);
    if (finalCheck) {
      log.uploader.error("modal refuses to close after save");
      return false;
    }
    log.uploader.info("modal closed via Escape fallback");
    return true;
  }
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

/**
 * Canonical editor reader. Returns the normalized visible text from a
 * TinyMCE editor instance identified by its backing textarea ID.
 *
 * This is the SINGLE source of truth for reading explanation editor
 * content. All verification paths (post-write, pre-save, blank check,
 * post-save reopen) MUST use this function.
 *
 * Fallback chain:
 *   1. TinyMCE editor instance getBody().innerText
 *   2. TinyMCE editor getContent({ format: 'text' })
 *   3. iframe body innerText (searched via textarea's closest editor root)
 *   4. textarea.value
 *
 * @param {import("playwright").Page} page
 * @param {string} textareaId
 * @returns {Promise<string>} normalized visible text (empty if no content)
 */
export async function readEditorTextByTextareaId(page, textareaId) {
  return await page.evaluate((id) => {
    const normalize = (s) => {
      if (!s) return "";
      return String(s).replace(/\s+/g, " ").trim();
    };

    // 1. TinyMCE instance — getBody() can throw or return null
    try {
      if (window.tinymce) {
        const editor = window.tinymce.get(id);
        if (editor) {
          let body = null;
          try { body = editor.getBody(); } catch (_e) { body = null; }
          if (body) {
            const bodyText = body.innerText || body.textContent || "";
            if (normalize(bodyText)) return normalize(bodyText);
          }
          let contentText = "";
          try { contentText = editor.getContent({ format: "text" }) || ""; } catch (_e) { contentText = ""; }
          if (normalize(contentText)) return normalize(contentText);
        }
      }
    } catch (_e) { /* tinymce not available */ }

    // 2. TinyMCE iframe by textarea id
    try {
      const textarea = document.getElementById(id);
      if (textarea) {
        const editorRoot = textarea.closest(".tox-tinymce, .tox, .card, .accordion-item") || document;
        const iframe = editorRoot ? editorRoot.querySelector("iframe") : null;
        if (iframe) {
          let doc = null;
          try { doc = iframe.contentDocument || iframe.contentWindow?.document || null; } catch (_e) { doc = null; }
          if (doc && doc.body) {
            const bodyText = doc.body.innerText || doc.body.textContent || "";
            if (normalize(bodyText)) return normalize(bodyText);
          }
        }
        const textareaValue = textarea.value || "";
        if (normalize(textareaValue)) return normalize(textareaValue);
      }
    } catch (_e) { /* DOM access failed */ }

    return "";
  }, textareaId);
}

/**
 * Normalize a range label to "Question X-Y" format (singular "Question").
 * @param {string} range
 * @returns {string}
 */
function _normalizeRangeLabel(range) {
  const raw = String(range || "").trim();
  const match = raw.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (!match) return raw;
  return `Question ${match[1]}-${match[2]}`;
}

/**
 * Extract "X-Y" key from a range label for flexible matching.
 * @param {string} text
 * @returns {string|null}
 */
function _extractRangeKey(text) {
  const m = String(text).match(/(\d+)\s*[-–]\s*(\d+)/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function extractQuizIdFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || url;
  } catch {
    return url;
  }
}

function slugId(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
