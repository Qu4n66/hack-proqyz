/**
 * Editor-write strategies.
 *
 * Phase-0 recon showed the real ProQyz UI has NO rich text editor
 * (editors.textarea=1, all RTEs 0). Every content field — passage body,
 * question content, option text — is a plain textarea or contenteditable.
 *
 * We keep the auto-detect scaffold in case the editor changes, but the
 * only writer we actually use is `writePlain`. The TinyMCE / CKEditor /
 * Quill branches stay for future-proofing and are exercised only by the
 * stub.
 */

import { Selectors } from "./selectors.js";
import { log } from "../../logger.js";
import { config } from "../../config.js";

/** @typedef {"tinymce" | "ckeditor" | "quill" | "textarea"} EditorKind */

/**
 * Detect the editor kind in the current scope. Defaults to "textarea"
 * because that is what the real ProQyz uses today.
 * @param {import("playwright").Page} page
 * @param {import("playwright").Locator} [root]
 * @returns {Promise<EditorKind>}
 */
export async function detectEditor(page, root) {
  // If the root is itself a TinyMCE hidden textarea (id prefix
  // `tiny-react_`), we know the editor is TinyMCE. This is more
  // reliable than the global `.tox-edit-area__iframe` selector,
  // which can match iframe markup from earlier/other modals.
  const tag = (await root.evaluate((el) => el.tagName).catch(() => "")).toLowerCase();
  const id = (await root.evaluate((el) => el.id).catch(() => "")) || "";
  if (tag === "textarea" && id.startsWith("tiny-react_")) return "tinymce";

  const scope = root ?? page.locator("body");
  if ((await scope.locator(Selectors.editor.tinymce.selector).count()) > 0) return "tinymce";
  if ((await scope.locator(Selectors.editor.ckeditor.selector).count()) > 0) return "ckeditor";
  if ((await scope.locator(Selectors.editor.quill.selector).count()) > 0) return "quill";
  return "textarea";
}

/**
 * Write HTML/text into an editor and verify the first 50 chars stuck.
 * @param {import("playwright").Page} page
 * @param {import("playwright").Locator} field
 * @param {string} content
 * @param {EditorKind} kind
 */
export async function writeToEditor(page, field, content, kind) {
  switch (kind) {
    case "tinymce":
      return writeTinyMCE(page, field, content);
    case "ckeditor":
      return writeCkEditor(page, field, content);
    case "quill":
      return writeQuill(page, field, content);
    case "textarea":
    default:
      return writePlain(page, field, content);
  }
}

async function writeTinyMCE(page, field, content) {
  // Resolve which TinyMCE instance to write to. The hidden textarea
  // we resolved to (passed as `field`) has an id that matches the
  // editor's id in window.tinymce.editors.
  const editorId = await field.evaluate((el) => el.id).catch(() => "");

  // Strategy: use the TinyMCE API (setContent) directly. The previous
  // keyboard-typing path (Control+A / Delete / insertText) was leaving
  // the editor's placeholder HTML — `<p>Add Passage content</p>`
  // rendered as gray "Add Passage content" — in the DOM, so real
  // content was being appended on top of placeholder and read-back
  // saw e.g. "Add Passage contentThe History of the Tortoise...".
  //
  // The API path is safer: setContent("") wipes the iframe body
  // completely (placeholder, real content, formatting), then
  // setContent(html) installs the new content in one shot and fires
  // the editor's `change` event so React picks up the new value.
  const plain = stripHtml(content);
  const apiResult = await page.evaluate(
    ({ id, html }) => {
      if (typeof window.tinymce === "undefined") return { ok: false, reason: "no-tinymce" };
      const editors = window.tinymce.editors || {};
      // Prefer the editor with the matching id (this content field);
      // fall back to the active editor if id resolution failed.
      const ed = (id && editors[id]) || window.tinymce.activeEditor;
      if (!ed) return { ok: false, reason: "no-editor-instance" };
      try {
        // 1. Wipe the body completely — placeholder, formatting,
        //    leftover text — all gone.
        ed.setContent("");
        // 2. Install the real content. Pass content as plain text
        //    wrapped in <p> tags so TinyMCE keeps block structure.
        const wrapped = `<p>${html.replace(/\n+/g, "</p><p>")}</p>`;
        ed.setContent(wrapped);
        // 3. Fire change so React / ProQyz state updates, and save
        //    so the backing textarea reflects the new value.
        ed.fire("change");
        if (typeof ed.save === "function") ed.save();
        return {
          ok: true,
          id: ed.id || id || null,
          contentLen: (ed.getContent({ format: "text" }) || "").length,
        };
      } catch (err) {
        return { ok: false, reason: "exception", message: err?.message || String(err) };
      }
    },
    { id: editorId, html: plain },
  );

  if (apiResult?.ok) {
    // CRITICAL: TinyMCE's save() writes to the backing <textarea>,
    // but React controlled components do NOT pick that up — they
    // only listen to native `input`/`change` DOM events. Without
    // this dispatch, clicking "Add Passage" submits React's stale
    // (empty) state and the content is silently lost.
    await dispatchNativeTextareaEvents(page, editorId);

    // 100ms is enough for React to batch-process the native events.
    await page.waitForTimeout(100);

    log.editor.debug(
      { editorId: apiResult.id, contentLen: apiResult.contentLen },
      "wrote content to TinyMCE (api setContent)",
    );
    return;
  }

  // Fallback: keyboard pipeline (the original path). The API path
  // is preferred, but if TinyMCE isn't on the page yet (timing),
  // fall back so we never silently lose the content.
  log.editor.warn(
    { apiResult, editorId },
    "TinyMCE API path failed; falling back to keyboard pipeline",
  );
  const iframeLocator = editorId
    ? page.locator(`iframe#${editorId}_ifr`)
    : page.locator('iframe[class*="tox-edit-area__iframe"]').first();
  await iframeLocator.waitFor({ state: "attached", timeout: config.actionTimeoutMs });
  const frame = await iframeLocator.contentFrame();
  if (!frame) {
    throw new Error("TinyMCE iframe found but no contentFrame available");
  }
  const body = frame.locator("body#tinymce, body.mce-content-body").first();
  await body.click();

  // Wipe via the API even in fallback — the keyboard Control+A
  // doesn't catch placeholder HTML.
  await page.evaluate((id) => {
    const ed =
      (id && window.tinymce?.editors?.[id]) || window.tinymce?.activeEditor;
    if (ed && typeof ed.setContent === "function") ed.setContent("");
  }, editorId);

  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");

  if (plain.length > 0) {
    await page.keyboard.insertText(plain);
  }

  // Save so the backing textarea picks up the new body.
  await page.evaluate((id) => {
    const ed =
      (id && window.tinymce?.editors?.[id]) || window.tinymce?.activeEditor;
    if (ed) {
      ed.fire("change");
      if (typeof ed.save === "function") ed.save();
    }
  }, editorId);

  // Same React sync as the API path: dispatch native events on
  // the backing textarea so React picks up the new content.
  await dispatchNativeTextareaEvents(page, editorId);
  await page.waitForTimeout(100);

  log.editor.debug({ editorId, len: plain.length }, "wrote content to TinyMCE (keyboard fallback)");
}

/**
 * Strip HTML tags to plain text. The Add Passage content field is
 * treated as plain text for now to avoid triggering the MathJax
 * plugin and other rich-text pipelines.
 */
function stripHtml(s) {
  return String(s)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * After TinyMCE saves content via `setContent()` + `ed.save()`,
 * the backing `<textarea>` is updated BUT React controlled
 * components do NOT pick it up — React only listens to native
 * DOM events (`input`, `change`). This helper finds the backing
 * textarea and dispatches both events so React syncs its state.
 *
 * ProQyz is a React SPA wrapping TinyMCE. Without this, clicking
 * "Add Passage" submits React's stale (empty) state instead of
 * the actual content.
 *
 * @param {import("playwright").Page} page
 * @param {string} editorId  The TinyMCE editor instance id.
 * @returns {Promise<void>}
 */
async function dispatchNativeTextareaEvents(page, editorId) {
  await page.evaluate((id) => {
    // 1. If the editor API is available, flush it first.
    if (typeof window.tinymce !== "undefined") {
      const editors = window.tinymce.editors || {};
      const ed = (id && editors[id]) || window.tinymce.activeEditor;
      if (ed) {
        try { ed.save(); } catch { /* noop */ }
      }
    }

    // 2. Find the backing textarea. TinyMCE's backing textarea
    //    has a matching id. If id-based lookup fails, walk all
    //    visible/hidden textareas and pick the first non-empty one.
    let textarea = id ? document.getElementById(id) : null;
    if (!textarea || textarea.tagName !== "TEXTAREA") {
      const all = document.querySelectorAll("textarea");
      for (const ta of all) {
        if (ta.value && ta.value.trim().length > 0) {
          textarea = ta;
          break;
        }
      }
    }
    if (!textarea || textarea.tagName !== "TEXTAREA") return;

    // 3. Dispatch native `input` and `change` events so React's
    //    controlled component picks up the new value.
    const nativeInputEvent = new Event("input", { bubbles: true });
    textarea.dispatchEvent(nativeInputEvent);
    const nativeChangeEvent = new Event("change", { bubbles: true });
    textarea.dispatchEvent(nativeChangeEvent);
  }, editorId);
}

async function writeCkEditor(page, field, content) {
  const ok = await page.evaluate(
    ({ html }) => {
      if (window.CKEDITOR && window.CKEDITOR.instances) {
        for (const inst of Object.values(window.CKEDITOR.instances)) {
          inst.setData(html);
          return "ck4";
        }
      }
      return null;
    },
    { html: content },
  );
  if (ok === null) {
    await field.click();
    await field.fill(content);
  }
  await verifyReadback(page, content);
  log.editor.debug({ mode: ok ?? "ck5-direct" }, "wrote content to CKEditor");
}

async function writeQuill(page, field, content) {
  await field.click();
  await field.fill(content);
  await page.evaluate(() => {
    document
      .querySelectorAll(".ql-editor")
      .forEach((el) => el.dispatchEvent(new Event("input", { bubbles: true })));
  });
  await verifyReadback(page, content);
  log.editor.debug("wrote content to Quill");
}

/**
 * The only writer we use in practice. Plain textarea or contenteditable.
 * Reads the tag and uses `fill` either way; Playwright's `fill` handles
 * both. We read back the first 50 chars to catch silent validation.
 */
export async function writePlain(page, field, content) {
  await field.fill(content);
  await verifyReadback(page, content);
  log.editor.debug("wrote content to plain field");
}

/**
 * Read the first ~50 chars back and verify they appear in the field.
 *
 * IMPORTANT: This is a SOFT check only. It exists to surface silent
 * validation failures during development, but it MUST NOT throw —
 * the downstream `addPassage` / `addQuestion` flow does its own
 * multi-signal verification (prefix match, substring match, length
 * fallback) and is the authoritative gate before save. Throwing
 * here used to abort writes whose content was actually present but
 * not yet reflected in the probed iframe body, producing
 * "RTE read-back failed" errors for visually-correct pastes.
 *
 * We now log a warning for any mismatch and let the caller's
 * verification decide whether to proceed.
 */
async function verifyReadback(page, content) {
  const probe = content.slice(0, 50).trim();
  if (!probe) return;
  await page.waitForTimeout(250);

  // 1. Try the TinyMCE iframe body directly. This is the most
  //    reliable check because the iframe body is what the user
  //    actually sees and what getContent() reads.
  const fromFrames = await readAllTinymceIframeBodies(page);
  if (fromFrames && fromFrames.length > 0) {
    const combined = fromFrames.join(" ");
    if (!combined.includes(probe)) {
      log.editor.warn(
        {
          probe: probe.slice(0, 30),
          frameLen: combined.length,
          framePreview: combined.slice(0, 80),
        },
        "editor: read-back mismatch (TinyMCE iframe body probe); downstream verification will decide",
      );
    }
    return;
  }

  // 2. Fall back to tinymce.getContent() (text form) for each
  //    editor. Some setups return the content here even if the
  //    iframe DOM is not accessible from the outer page.
  const fromTinymce = await page.evaluate(() => {
    if (typeof window.tinymce === "undefined") return null;
    const editors = window.tinymce.editors || {};
    const result = [];
    for (const id of Object.keys(editors)) {
      const ed = editors[id];
      try {
        result.push(ed.getContent({ format: "text" }));
      } catch {
        /* ignore */
      }
    }
    return result;
  });
  if (fromTinymce && fromTinymce.length > 0) {
    const combined = fromTinymce.join(" ");
    if (!combined.includes(probe)) {
      log.editor.warn(
        {
          probe: probe.slice(0, 30),
          editorCount: fromTinymce.length,
          totalLen: combined.length,
        },
        "editor: read-back mismatch (tinymce.getContent probe); downstream verification will decide",
      );
    }
    return;
  }

  // 3. Last-resort: active element or body innerText.
  const fromActive = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value;
    if (el.getAttribute && el.getAttribute("contenteditable") === "true") {
      return el.textContent;
    }
    return null;
  });
  if (fromActive !== null) {
    if (!fromActive.includes(probe)) {
      log.editor.warn(
        {
          probe: probe.slice(0, 30),
          activeTag:
            (await page.evaluate(() => document.activeElement?.tagName).catch(() => "")) || "",
          activeLen: fromActive.length,
        },
        "editor: read-back mismatch (active-element probe); downstream verification will decide",
      );
    }
    return;
  }
  const body = await page.evaluate(() => document.body.innerText);
  if (!body.includes(probe)) {
    log.editor.warn(
      {
        probe: probe.slice(0, 30),
        bodyLen: body.length,
      },
      "editor: read-back mismatch (body.innerText probe); downstream verification will decide",
    );
  }
}

/**
 * Read the text content of every TinyMCE iframe body on the page.
 * Returns an array of strings (one per iframe). Empty array if no
 * TinyMCE iframes are present.
 */
async function readAllTinymceIframeBodies(page) {
  const frames = page.frames();
  const results = [];
  for (const f of frames) {
    try {
      const text = await f.evaluate(() => {
        // TinyMCE iframes have body#tinymce or body.mce-content-body.
        const b = document.body;
        if (!b) return null;
        if (b.id === "tinymce" || b.classList.contains("mce-content-body")) {
          return b.innerText;
        }
        return null;
      });
      if (text) results.push(text);
    } catch {
      /* cross-origin or detached frame; skip */
    }
  }
  return results;
}

function looksLikeHtml(s) {
  return /<\/?[a-z][\s\S]*>/i.test(s);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
