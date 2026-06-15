/**
 * Pipeline orchestrator.
 *
 * The single entry point for actually running an upload. Coordinates:
 *   1. Loading + validating the quiz JSON.
 *   2. Loading (or creating) a checkpoint for resume support.
 *   3. Spinning up Playwright + auth.
 *   4. Driving the UiQuizUploader through createQuiz / addPassage /
 *      addQuestion / setCorrectAnswer / save.
 *   5. Updating the checkpoint after every question.
 *   6. Pausing for human review (default) or auto-publishing (--publish).
 *   7. Cleaning up the checkpoint on full success.
 *
 * This is the ONLY place that knows about the UiQuizUploader. If we ever
 * add an ApiQuizUploader, we'd swap it in here.
 */

import { chromium } from "playwright";
import { confirm, input } from "@inquirer/prompts";
import { config } from "../config.js";
import { log } from "../logger.js";
import { loadQuizFromJson } from "../input/jsonInput.js";
import { getAuthenticatedContext } from "../session/auth.js";
import { Selectors } from "../uploader/ui/selectors.js";
import { UiQuizUploader } from "../uploader/ui/UiQuizUploader.js";
import {
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  newCheckpoint,
  recordPassage,
  recordQuestion,
  recordQuiz,
  nextQuestionNumber,
} from "../uploader/ui/checkpoint.js";
import { captureFailure } from "../uploader/ui/screenshots.js";
import { printResult } from "./report.js";
import { waitForManualLogin } from "../session/auth.js";

/**
 * @typedef {object} RunOptions
 * @property {string} inputPath
 * @property {boolean} [dryRun]
 * @property {boolean} [fresh]        Delete any existing checkpoint.
 * @property {"skip" | "update" | "fail"} [onDuplicate]
 * @property {boolean} [publish]      Auto-publish (skips review pause).
 * @property {boolean} [skipReview]   Skip the review pause (used in CI).
 */

/**
 * Run a single quiz upload.
 * @param {RunOptions} opts
 * @returns {Promise<import("./report.js").RunResult>}
 */
export async function runQuiz(opts) {
  const startedAt = Date.now();
  const dryRun = !!opts.dryRun;
  const onDuplicate = opts.onDuplicate || "skip";
  const publish = !!opts.publish;

  // 1. Load + validate.
  const quiz = await loadQuizFromJson(opts.inputPath);
  const totalQuestions = countQuestions(quiz);
  log.pipeline.info(
    { title: quiz.quizTitle, quizType: quiz.quizType, questions: totalQuestions },
    "starting run",
  );

  if (quiz.quizType !== "reading") {
    throw new Error(
      `Phase 1 supports IELTS Reading only. Got quizType="${quiz.quizType}". ` +
        `Listening will be added in Phase 3.`,
    );
  }

  // 2. Checkpoint.
  let cp = await loadCheckpoint(quiz.quizTitle);
  if (cp && opts.fresh) {
    log.pipeline.info("fresh run requested; clearing checkpoint");
    await clearCheckpoint(quiz.quizTitle);
    cp = null;
  }
  if (!cp) {
    cp = newCheckpoint(quiz.quizTitle, Selectors.version);
  } else if (cp.selectorsVersion !== Selectors.version) {
    log.pipeline.warn(
      { from: cp.selectorsVersion, to: Selectors.version },
      "checkpoint was created with a different selectors version; " +
        "verify before resuming",
    );
    const proceed = await confirm({
      message: "Resume anyway? (selectors changed since last run)",
      default: false,
    });
    if (!proceed) {
      return {
        title: quiz.quizTitle,
        status: "skipped",
        questionsUploaded: 0,
        questionsTotal: totalQuestions,
        durationMs: Date.now() - startedAt,
        error: "user declined to resume across selector version change",
      };
    }
  }

  const resumeFrom = nextQuestionNumber(cp, totalQuestions);
  const isResume = resumeFrom !== null && resumeFrom > 1;
  if (isResume) {
    log.pipeline.info(
      { resumeFrom, uploaded: cp.questions.length },
      "found existing checkpoint; will resume",
    );
  }

  // 3. Launch browser + auth.
  const browser = await chromium.launch({ headless: false });
  const ctx = await getAuthenticatedContext(browser, {
    loginUrl: `${config.baseUrl}${Selectors.login.loginUrl}`,
    loggedInPattern: Selectors.login.postLoginUrl,
  });
  const page = await ctx.newPage();

  // 3a. Startup navigation: never let the page stay at about:blank.
  // The browser context can come back with no open page (storageState path)
  // or a closed page (manual login path), so the freshly-created `page`
  // is always at about:blank. Force it onto My Quizzes before createQuiz
  // does anything else.
  await ensureOnDashboard(page, { dryRun });

  const uploader = new UiQuizUploader({ browserContext: ctx, page, dryRun });

  // 4. Drive the upload with failure capture.
  let resultHandle = null;
  let failure = null;
  try {
    // ----------------------------------------------------------------
    // 4-pre. Mode dispatch.
    //   - "full" (default): createQuiz + addPassage + addQuestion + save
    //   - "questionsOnly": open existing quiz, only add questions
    // ----------------------------------------------------------------
    const isQuestionsOnly = quiz.mode === "questionsOnly";

    if (isQuestionsOnly) {
      // Safety: questionsOnly requires an existing quiz URL.
      if (!quiz.existingQuizUrl) {
        throw new Error(
          'questionsOnly mode requires an "existingQuizUrl" field in the JSON. ' +
            "Open the quiz in ProQyz, copy its edit URL, and paste it into the JSON.",
        );
      }
      log.pipeline.info(
        { url: quiz.existingQuizUrl, passage: quiz.passages[0]?.title },
        "mode: questionsOnly — opening existing quiz, skipping createQuiz + addPassage",
      );
      // Use the existing URL as the quiz handle for checkpoint /
      // resume purposes. We do NOT call createQuiz.
      resultHandle = {
        id: extractQuizIdFromUrlLocal(quiz.existingQuizUrl),
        url: quiz.existingQuizUrl,
      };
      await uploader.openExisting(resultHandle);
      // Record the quiz handle so resume can find it.
      recordQuiz(cp, resultHandle);
      await saveCheckpoint(cp);

      // The passage MUST already exist in the quiz (we did not create
      // it). Use the first passage in the JSON as the target and let
      // addQuestion()'s _selectPassageInQuestionsTab helper bind to it
      // by title. We mark the passage as "already uploaded" in the
      // checkpoint so the loop does not try to recreate it.
      for (let i = 0; i < quiz.passages.length; i++) {
        if (!cp.passages.find((p) => p.index === i)) {
          cp.passages.push({
            index: i,
            id: null, // we did not create it; the page's selector
                      // pass will bind to it via title instead
            title: quiz.passages[i].title,
            preexisting: true,
          });
          await saveCheckpoint(cp);
        }
      }
    } else if (isResume && cp.quizHandle.url) {
      // If we have a quiz handle, we're resuming. Open the existing quiz.
      await uploader.openExisting(cp.quizHandle);
    } else {
      resultHandle = await uploader.createQuiz(quiz);
      recordQuiz(cp, resultHandle);
      await saveCheckpoint(cp);
    }

    // 4a. Passages.
    for (let i = 0; i < quiz.passages.length; i++) {
      if (cp.passages.find((p) => p.index === i)) {
        log.uploader.info({ index: i }, "passage already uploaded, skipping");
        continue;
      }
      const pHandle = await uploader.addPassage(quiz.passages[i], i);
      recordPassage(cp, pHandle);
      await saveCheckpoint(cp);
      // Post-save verification: reopen the created passage and
      // confirm the editor body contains the expected content. Fails
      // loudly if TinyMCE silently wrote the wrong text.
      await uploader.verifyPassage(quiz.passages[i], i);
    }

    // 4b. Questions — nested inside each passage.
    // 4b. Questions — nested inside each passage. WRITE-ONLY bulk
    // import per the master spec: process every question in the
    // dataset. Cap removed; pipeline runs to completion unless an
    // exception is thrown by the uploader.
    let globalIdx = 0;
    let questionsCreated = 0;
    for (let pIdx = 0; pIdx < quiz.passages.length; pIdx++) {
      const p = quiz.passages[pIdx];
      for (let qIdx = 0; qIdx < p.questions.length; qIdx++) {
        const q = p.questions[qIdx];
        if (cp.questions.find((cq) => cq.number === q.number && cq.passageIndex === pIdx)) {
          log.uploader.info(
            { n: q.number, passageIdx: pIdx },
            "question already uploaded, skipping",
          );
          globalIdx++;
          continue;
        }
        const qHandle = await uploader.addQuestion(q, globalIdx, totalQuestions, {
          passageIdx: pIdx,
          passageTitle: p.title,
        });
        recordQuestion(cp, {
          number: q.number,
          id: qHandle.id,
          passageIndex: pIdx,
        });
        await saveCheckpoint(cp);
        globalIdx++;
        questionsCreated++;
      }
    }

    // 4c. Save.
    // - full mode: explicit save() click. The user then reviews +
    //   publishes manually (or auto-publishes via --publish).
    // - questionsOnly mode: skip save() — the existing quiz is
    //   autosaved after every question add (per ProQyz's React
    //   "change" wiring). Calling save() would just re-trigger
    //   autosave and could regress into the spinner-stuck path
    //   we already debugged. We just open the existing URL again
    //   for review.
    if (isQuestionsOnly) {
      log.pipeline.info(
        "mode: questionsOnly — skipping save() (existing quiz is autosaved per question)",
      );
    } else {
      resultHandle = await uploader.save();
    }

    // 5. Clear checkpoint on full success.
    //    Keep the checkpoint in questionsOnly mode so a partial run
    //    can resume from the last completed question against the
    //    same existing URL.
    if (!isQuestionsOnly) {
      await clearCheckpoint(quiz.quizTitle);
    }

    // 6. Human review pause (default), or auto-publish.
    if (!dryRun && !opts.skipReview) {
      await pauseForReview(resultHandle?.url ?? page.url(), publish);
    }
    if (publish && !dryRun) {
      log.pipeline.info("--publish requested; user must click Publish in the review URL above");
    }
  } catch (err) {
    failure = err;
    log.pipeline.error({ err: err.message }, "upload failed");
    try {
      await captureFailure(page, `upload-${quiz.quizTitle}`);
    } catch (capErr) {
      log.pipeline.warn({ err: capErr.message }, "failure capture itself failed");
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // 7. Result.
  const questionsUploaded = cp.questions.length;
  const total = totalQuestions;
  log.pipeline.info(
    {
      title: quiz.quizTitle,
      mode: quiz.mode ?? "full",
      msTotal: Date.now() - startedAt,
      questionsUploaded,
      questionsTotal: total,
      status: failure ? "failed" : isResume ? "resumed" : "ok",
    },
    "PROFILE: total runtime",
  );

  /** @type {import("./report.js").RunResult} */
  const result = failure
    ? {
        title: quiz.quizTitle,
        status: "failed",
        error: failure.message,
        questionsUploaded,
        questionsTotal: total,
        durationMs: Date.now() - startedAt,
        reviewUrl: resultHandle?.url,
      }
    : {
        title: quiz.quizTitle,
        status: isResume ? "resumed" : "ok",
        reviewUrl: resultHandle?.url ?? page.url(),
        questionsUploaded,
        questionsTotal: total,
        durationMs: Date.now() - startedAt,
      };

  printResult(result);
  if (failure) {
    // Exit non-zero on failure.
    process.exitCode = 1;
  }
  return result;
}

/**
 * Pause and ask the user to review the quiz in their browser before
 * continuing. Pressing Enter exits cleanly. Ctrl+C aborts.
 * @param {string} url
 * @param {boolean} publishRequested
 */
async function pauseForReview(url, publishRequested) {
  log.pipeline.info("");
  log.pipeline.info("=========================================");
  log.pipeline.info("Quiz created in Draft status.");
  log.pipeline.info(`Open this URL to review: ${url}`);
  if (publishRequested) {
    log.pipeline.info("(You asked for --publish; click Publish in the review URL above.)");
  }
  log.pipeline.info("=========================================");
  log.pipeline.info("");
  // In CI (no TTY), skip the pause.
  if (!process.stdin.isTTY) {
    log.pipeline.info("non-interactive run; skipping review pause");
    return;
  }
  await input({ message: "Press Enter when reviewed (Ctrl+C to abort)..." });
}

/**
 * Publish an existing quiz by URL. Used by the --publish-existing flag.
 * @param {string} url The full ProQyz edit URL of the quiz.
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<{ id: string, url: string }>}
 */
export async function publishExistingQuiz(url, opts = {}) {
  const browser = await chromium.launch({ headless: false });
  const ctx = await getAuthenticatedContext(browser, {
    loginUrl: `${config.baseUrl}${Selectors.login.loginUrl}`,
    loggedInPattern: Selectors.login.postLoginUrl,
  });
  const page = await ctx.newPage();
  const uploader = new UiQuizUploader({
    browserContext: ctx,
    page,
    dryRun: !!opts.dryRun,
  });
  try {
    const id = extractQuizIdFromUrlLocal(url);
    const result = await uploader.publish({ id, url });
    log.pipeline.info({ url: result.url }, "publish complete");
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Local helper: extract the last non-empty path segment as the id. */
function extractQuizIdFromUrlLocal(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || url;
  } catch {
    return url;
  }
}

/** Count questions across all passages (reading) or sections (listening). */
function countQuestions(quiz) {
  if (quiz.quizType === "reading") {
    return quiz.passages.reduce((acc, p) => acc + p.questions.length, 0);
  }
  if (quiz.quizType === "listening") {
    return quiz.sections.reduce((acc, s) => acc + s.questions.length, 0);
  }
  return 0;
}

/**
 * Surgical startup-navigation guard.
 *
 * `getAuthenticatedContext` either:
 *   (A) returns a context with NO open page (storageState path), so the
 *       freshly-created `ctx.newPage()` lands at about:blank, OR
 *   (B) opens and CLOSES a page on login (manual login path), so the
 *       freshly-created `ctx.newPage()` is also at about:blank.
 *
 * In both cases, before `uploader.createQuiz` runs we must put the
 * page on the ProQyz dashboard. Otherwise `createQuiz` does its own
 * goto and may inherit stale state.
 *
 * Behaviour:
 *   - dryRun: skip (we don't touch the browser at all).
 *   - log current url.
 *   - if url is about:blank OR not on app.proqyz.com: navigate to
 *     My Quizzes with waitUntil: "domcontentloaded".
 *   - poll for either "My Quizzes" h1 or the "+ New quiz" button
 *     visible within 8s. Log "My Quizzes page ready" on success.
 *   - if we land on a login URL (storageState expired, or the goto
 *     redirected), call `waitForManualLogin` then re-navigate.
 *
 * This intentionally does NOT touch UiQuizUploader — it's a run.js
 * concern, keeping the uploader's internals untouched.
 *
 * @param {import("playwright").Page} page
 * @param {{ dryRun?: boolean }} opts
 */
async function ensureOnDashboard(page, opts = {}) {
  if (opts.dryRun) {
    log.pipeline.info("[startup] dryRun — skipping dashboard nav");
    return;
  }

  const loginUrl = `${config.baseUrl}${Selectors.login.loginUrl}`;
  const myQuizzesUrl = `${config.baseUrl}${Selectors.quizForm.myQuizzesPath}`;
  const loggedInPattern = Selectors.login.postLoginUrl;

  const currentUrl = page.url();
  log.pipeline.info({ url: currentUrl }, "[startup] current url");

  const isOnDashboard =
    currentUrl && !currentUrl.startsWith("about:") && /app\.proqyz\.com/.test(currentUrl);

  if (!isOnDashboard) {
    log.pipeline.info({ url: myQuizzesUrl }, "[startup] navigating to My Quizzes");
    try {
      await page.goto(myQuizzesUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (err) {
      log.pipeline.warn({ err: err.message }, "[startup] initial goto failed; will probe URL");
    }
  }

  // If we got bounced to the login page (storageState expired, etc.),
  // pause for manual login, then re-navigate to My Quizzes.
  if (isOnLoginUrl(page.url(), loginUrl)) {
    log.pipeline.warn({ url: page.url() }, "[startup] redirected to login; waiting for manual login");
    await waitForManualLogin(page, loginUrl, loggedInPattern, config.manualLoginTimeoutMs);
    log.pipeline.info({ url: myQuizzesUrl }, "[startup] re-navigating to My Quizzes after login");
    await page.goto(myQuizzesUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  // Wait for either the page heading or the new-quiz button to be visible.
  // 8s budget; poll every 150ms. Throws on timeout — createQuiz cannot
  // proceed without the dashboard.
  const deadline = Date.now() + 8000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const heading = page.getByRole("heading", { name: /my quizzes/i });
      if ((await heading.count()) > 0 && (await heading.first().isVisible().catch(() => false))) {
        ready = true;
        break;
      }
      const newBtn = page.locator(Selectors.nav.newQuizButton).first();
      if ((await newBtn.count()) > 0 && (await newBtn.isVisible().catch(() => false))) {
        ready = true;
        break;
      }
    } catch {
      // ignore — keep polling
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!ready) {
    throw new Error(
      `[startup] My Quizzes page did not become ready within 8s. ` +
        `url=${page.url()}. Cannot proceed to createQuiz.`,
    );
  }

  log.pipeline.info({ url: page.url() }, "[startup] My Quizzes page ready");
}

/**
 * Heuristic: is the current page on the ProQyz login screen?
 * Matches `/login`, `/signin`, `/auth/*` (any login-related path).
 */
function isOnLoginUrl(url, loginUrl) {
  if (!url) return false;
  if (loginUrl && url.startsWith(loginUrl)) return true;
  return /\/(login|signin|sign-in|auth)(\/|\?|$)/i.test(url);
}
