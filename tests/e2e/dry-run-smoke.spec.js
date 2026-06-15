/**
 * Smoke test against a local stub ProQyz page.
 *
 * Proves the UiQuizUploader logic works end-to-end against a local stub
 * ProQyz page — no real ProQyz instance required.
 *
 * We run the WHOLE flow (NOT dryRun) so the smoke test exercises
 * createQuiz's modal handling, addPassage, addQuestion, and save.
 *
 * Note: this is a SCRIPT, not a Playwright @playwright/test spec. We
 * run it with `node tests/e2e/dry-run-smoke.spec.js`.
 */

import { chromium } from "playwright";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stubUrl = "file://" + resolve(__dirname, "..", "fixtures", "stub-proqyz.html");
const fixturePath = resolve(__dirname, "..", "..", "fixtures", "cam17-reading-test01-passage1.json");

// Override PROQYZ_BASE_URL BEFORE importing config-dependent modules.
// config.js reads process.env at module load time; ESM evaluates
// imports in order, so this env var must be set first.
process.env.PROQYZ_BASE_URL = stubUrl;

const { UiQuizUploader } = await import("../../src/uploader/ui/UiQuizUploader.js");
const { loadQuizFromJson } = await import("../../src/input/jsonInput.js");

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(stubUrl);

const quiz = await loadQuizFromJson(fixturePath);
const totalQuestions = quiz.passages.reduce((acc, p) => acc + p.questions.length, 0);
console.log("[smoke] loaded quiz:", quiz.quizTitle, "—", totalQuestions, "questions");

const uploader = new UiQuizUploader({
  browserContext: ctx,
  page,
  dryRun: false,
  skipNavToQuizPage: true,
});

// Drive the same sequence the orchestrator does. Real flow (not
// dryRun) so we exercise the modal click path, the form fill path, and
// the question editor.
const quizHandle = await uploader.createQuiz(quiz);
assert.ok(quizHandle.id, "createQuiz should return an id");
assert.ok(!quizHandle.id.startsWith("dry-"), "createQuiz should run for real against the stub");
console.log("[smoke] createQuiz ok:", quizHandle);

for (let i = 0; i < quiz.passages.length; i++) {
  const pHandle = await uploader.addPassage(quiz.passages[i], i);
  assert.ok(pHandle.id, `addPassage ${i} should return an id`);
  console.log("[smoke] addPassage", i, "ok");
}

let globalIdx = 0;
for (let pIdx = 0; pIdx < quiz.passages.length; pIdx++) {
  const p = quiz.passages[pIdx];
  for (let qIdx = 0; qIdx < p.questions.length; qIdx++) {
    const q = p.questions[qIdx];
    const qHandle = await uploader.addQuestion(q, globalIdx, totalQuestions, {
      passageIdx: pIdx,
      passageTitle: p.title,
    });
    assert.ok(qHandle.id, `addQuestion ${q.number} should return an id`);
    console.log("[smoke] addQuestion", q.number, "ok");
    globalIdx++;
  }
}

const saveHandle = await uploader.save();
assert.ok(saveHandle, "save should return a handle");
console.log("[smoke] save ok");

await browser.close();
console.log("[smoke] PASS");
