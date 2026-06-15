/**
 * QuizUploader — the interface that every implementation must satisfy.
 *
 * The orchestrator depends only on this interface. The UI implementation
 * lives in ./ui/UiQuizUploader.js. A future API implementation would
 * live in ./api/ApiQuizUploader.js (NOT in Phase 1).
 *
 * @typedef {import("../domain/schemas.js").Quiz} Quiz
 * @typedef {import("../domain/schemas.js").Passage} Passage
 * @typedef {import("../domain/schemas.js").Question} Question
 * @typedef {import("../domain/schemas.js").Option} Option
 *
 * @typedef {object} QuizHandle
 * @property {string} id
 * @property {string} url
 *
 * @typedef {object} QuestionHandle
 * @property {string} id
 * @property {number} number
 * @property {number} passageIndex
 *
 * @typedef {object} UploaderContext
 * @property {import("playwright").BrowserContext} browserContext
 * @property {import("playwright").Page} page
 * @property {boolean} dryRun
 *
 * @typedef {object} QuizUploader
 * @property {() => Promise<QuizHandle>} createQuiz
 * @property {(p: Passage, index: number) => Promise<{ index: number, id: string }>} addPassage
 * @property {(q: Question, index: number, total: number) => Promise<QuestionHandle>} addQuestion
 * @property {(question: QuestionHandle, opt: Option) => Promise<void>} addOption
 * @property {(question: QuestionHandle, opt: Option) => Promise<void>} setCorrectAnswer
 * @property {() => Promise<QuizHandle>} save
 * @property {(existing: QuizHandle) => Promise<QuizHandle>} openExisting
 */

export const REQUIRED_METHODS = [
  "createQuiz",
  "addPassage",
  "addQuestion",
  "addOption",
  "setCorrectAnswer",
  "save",
];

/**
 * Verify an object satisfies the QuizUploader contract. Throws on the
 * first missing method.
 * @param {object} uploader
 */
export function assertUploader(uploader) {
  for (const m of REQUIRED_METHODS) {
    if (typeof uploader[m] !== "function") {
      throw new Error(`QuizUploader is missing method: ${m}`);
    }
  }
}
