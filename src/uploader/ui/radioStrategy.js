/**
 * Correct-answer selection strategy.
 *
 * NON-NEGOTIABLE PRINCIPLE: never click radios by global index.
 * Always scope to the specific question/option container.
 *
 * Three execution modes for radio (detected at runtime):
 *   - Mode A: click-to-save       — radio writes through immediately.
 *   - Mode B: click-and-parent    — radio only persists on Save.
 *   - Mode C: dropdown            — "correct answer" is a <select>.
 *
 * Checkbox (multiple correct answers) follows the same scope principle
 * but calls `.check()` on every correct option.
 */

import { Selectors } from "./selectors.js";
import { log } from "../../logger.js";
import { jitter } from "./waitHelpers.js";

/** @typedef {"click_to_save" | "click_and_parent" | "dropdown"} RadioMode */

/**
 * Select the correct answer for a radio question.
 *
 * @param {import("playwright").Page} page
 * @param {import("playwright").Locator} questionCard  Scoped to ONE question.
 * @param {{ label: string, text: string }} option
 */
export async function selectCorrectOption(page, questionCard, option) {
  const targetLabel = option.label.toUpperCase().trim();

  const rows = questionCard.locator(Selectors.option.row);
  const count = await rows.count();
  if (count === 0) throw new Error("No option rows found in question card");

  let matchedRow = null;
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const labelText =
      (await row.locator(Selectors.option.labelText).first().innerText().catch(() => "")) || "";
    const textField =
      (await row.locator(Selectors.option.textField).first().inputValue().catch(() => "")) || "";
    if (
      labelText.trim().toUpperCase() === targetLabel ||
      textField.trim() === option.text.trim()
    ) {
      matchedRow = row;
      break;
    }
  }

  if (!matchedRow) {
    throw new Error(
      `Could not find option row matching label="${targetLabel}" / text="${option.text.slice(0, 30)}"`,
    );
  }

  const radio = matchedRow.locator(Selectors.option.correctRadio).first();
  await radio.scrollIntoViewIfNeeded();
  await _checkOrClick(radio);
  await jitter();
  log.radio.debug({ label: targetLabel }, "selected correct option (radio)");
}

/**
 * Check all correct answers for a checkbox question.
 *
 * @param {import("playwright").Page} page
 * @param {import("playwright").Locator} questionCard  Scoped to ONE question.
 * @param {string[]} answerLabels  Uppercased labels of all correct options.
 */
export async function selectCorrectCheckboxes(page, questionCard, answerLabels) {
  const rows = questionCard.locator(Selectors.option.row);
  const count = await rows.count();
  if (count === 0) throw new Error("No option rows found in question card");

  const upper = answerLabels.map((l) => l.toUpperCase().trim());
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const labelText =
      (await row.locator(Selectors.option.labelText).first().innerText().catch(() => "")) || "";
    if (upper.includes(labelText.trim().toUpperCase())) {
      const cb = row.locator(Selectors.option.correctCheckbox).first();
      await cb.scrollIntoViewIfNeeded();
      await _checkOrClick(cb);
      await jitter();
    }
  }
  log.radio.debug({ labels: answerLabels }, "selected correct options (checkbox)");
}

/**
 * Playwright's `.check()` is idempotent and asserts the result.
 * For custom widgets (non-native checkboxes), fall back to `.click()`.
 */
async function _checkOrClick(locator) {
  try {
    await locator.check({ timeout: 2000 });
  } catch {
    await locator.click({ force: true });
  }
}
