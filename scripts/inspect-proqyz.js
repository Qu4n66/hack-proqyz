#!/usr/bin/env node
/**
 * Phase 0 recon script.
 *
 * Opens ProQyz in a headed browser, lets you log in, and dumps:
 *   - All form input fields with their accessible name and attributes.
 *   - All buttons with their text and data-testid.
 *   - The DOM around the correct-answer radio.
 *
 * Output is written to proqyz-inspection.json in the project root.
 * From this we hand-author src/uploader/ui/selectors.js with the
 * real selectors.
 *
 * Usage:
 *   node scripts/inspect-proqyz.js                 # inspects the create-quiz page
 *   node scripts/inspect-proqyz.js --page=login    # inspects the login page
 *   node scripts/inspect-proqyz.js --page=question # inspects the question editor
 */

import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../src/config.js";
import { logger as log } from "../src/logger.js";
import { getAuthenticatedContext } from "../src/session/auth.js";
import { Selectors } from "../src/uploader/ui/selectors.js";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? true];
    }),
);
const page_name = args.page || "create-quiz";
const targetUrl = args.url
  || (() => {
    switch (page_name) {
      case "login":
        return `${config.baseUrl}${Selectors.login.loginUrl}`;
      case "question":
        // You'll need to navigate to a specific question editor URL.
        return config.baseUrl;
      case "create-quiz":
      default:
        return `${config.baseUrl}/quizzes/new`;
    }
  })();

const browser = await chromium.launch({ headless: false });

// Single try/finally so the browser always closes and the JSON always
// writes — even if the user aborts (SIGINT) or the inspection throws.
let page;
try {
  const ctx = await getAuthenticatedContext(browser, {
    loginUrl: `${config.baseUrl}${Selectors.login.loginUrl}`,
    loggedInPattern: Selectors.login.postLoginUrl,
  });
  page = await ctx.newPage();

  log.info({ url: targetUrl }, `navigating to ${page_name}`);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  log.info("press Enter in the terminal when you've navigated to the right page...");
  await new Promise((r) => {
    process.stdin.once("data", r);
  });
} catch (err) {
  log.error({ err: err?.message ?? String(err) }, "recon failed during navigation/login");
  // Make sure the browser doesn't leak when we re-throw.
  await browser.close().catch(() => {});
  throw err;
}

let inspection = { url: page.url(), title: "", inputs: [], buttons: [], editors: {}, radios: [], error: null };
try {
inspection = await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll("input, textarea, select")).map((el) => {
    const id = el.id;
    const name = el.getAttribute("name");
    const type = el.getAttribute("type") || el.tagName.toLowerCase();
    const label =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      (id && document.querySelector(`label[for="${id}"]`)?.innerText) ||
      (el.closest("label")?.innerText) ||
      "";
    return {
      tag: el.tagName.toLowerCase(),
      type,
      id,
      name,
      label: label.trim().slice(0, 80),
      "data-testid": el.getAttribute("data-testid"),
      "data-field": el.getAttribute("data-field"),
      "aria-label": el.getAttribute("aria-label"),
      "data-attr-count": el.attributes.length,
    };
  });

  const buttons = Array.from(document.querySelectorAll("button, a[role='button'], [role='button']")).map(
    (el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || "").trim().slice(0, 60),
      "data-testid": el.getAttribute("data-testid"),
      type: el.getAttribute("type"),
    }),
  );

  // Probe for rich text editors.
  const editors = {
    tinymce: document.querySelectorAll(".tox-edit-area iframe, .tox-tinymce").length,
    ckeditor5: document.querySelectorAll(".ck-editor__editable").length,
    ckeditor4: document.querySelectorAll(".cke_contents iframe").length,
    quill: document.querySelectorAll(".ql-editor").length,
    textarea: document.querySelectorAll("textarea, [contenteditable='true']").length,
  };

  // Probe for radio groups.
  const radios = Array.from(document.querySelectorAll("input[type='radio']")).map((el) => ({
    name: el.getAttribute("name"),
    value: el.getAttribute("value"),
    "data-testid": el.getAttribute("data-testid"),
    parentLabel: el.closest("label")?.innerText?.trim()?.slice(0, 60) || "",
  }));

  return {
    url: location.href,
    title: document.title,
    inputs,
    buttons,
    editors,
    radios,
  };
});
} catch (err) {
  inspection.error = err?.message ?? String(err);
  log.error({ err: inspection.error }, "inspection evaluate failed; writing partial output");
}

const outPath = resolve(`proqyz-inspection-${page_name}.json`);
await writeFile(outPath, JSON.stringify(inspection, null, 2));
log.info({ path: outPath }, "inspection written");

await browser.close();
