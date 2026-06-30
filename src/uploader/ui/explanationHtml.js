/**
 * Safe HTML helpers for explanation content.
 *
 * Allowed tags only:
 *   <b>, <strong>, <i>, <em>, <p>, <br>
 *
 * Two functions are the SINGLE source of truth:
 *   - prepareExplanationHtml(content): sanitize + wrap for TinyMCE
 *   - htmlToComparableText(value):     strip + normalize for verification
 *
 * TinyMCE may normalize <b>→<strong>, <i>→<em>, <p>→<div>, <br>→newline,
 * or decode HTML entities. We never compare raw HTML. We compare the
 * visible text after running both expected and actual through
 * htmlToComparableText().
 *
 * IMPORTANT: TinyMCE setContent() collapses "\n" into spaces, so plain
 * text with newlines must be inserted via keyboard (Shift+Enter) — see
 * `_insertTextWithNewlines` in UiQuizUploader.js.
 */

const ALLOWED_HTML_TAGS = new Set(["b", "strong", "i", "em", "br", "p"]);

/**
 * Strip all HTML tags and normalize whitespace to produce a comparable
 * plain-text string. Used for pre-save and post-save verification so
 * that TinyMCE normalization does not cause false mismatches.
 *
 * Rules:
 *   - <br>          → \n
 *   - </p>\s*<p>    → \n      (paragraph break becomes newline)
 *   - </?p[^>]*>    → ""       (paragraph tags themselves stripped)
 *   - any other tag → ""       (everything else stripped)
 *   - &nbsp;        → " "
 *   - &amp;/&lt;/&gt;/&quot;/&#39; → decoded
 *   - whitespace collapsed, trimmed
 *
 * @param {unknown} value
 * @returns {string}
 */
export function htmlToComparableText(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n")
    .replace(/<\/?p[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Prepare explanation content for TinyMCE insertion:
 *   - Converts to string
 *   - Preserves allowed inline tags (b, strong, i, em, br, p)
 *   - Strips all attributes from allowed tags (defense in depth — TinyMCE
 *     could otherwise re-parse them)
 *   - Converts \n into <br> (unless the content is already a block)
 *   - Wraps in <p>...</p> if no block wrapper is present
 *   - Strips all other HTML (script/style/iframe/img/a/...)
 *
 * This is the ONLY function that should produce HTML for
 * `editor.setContent(html, { format: "html" })`. Calling
 * `prepareExplanationHtml("Hello world")` returns
 * `"<p>Hello world</p>"`; calling `prepareExplanationHtml("Line one.\nLine two.")`
 * returns `"<p>Line one.<br></p>\n<p>Line two.</p>"` (one paragraph per
 * line, with `<br>` preserving the original newline inside the first paragraph).
 *
 * Do NOT type literal `<b>...</b>` strings through `page.keyboard.insertText` —
 * that inserts visible tags, not formatting. Always use the TinyMCE API path
 * with HTML prepared here.
 *
 * @param {string} content
 * @returns {string}
 */
export function prepareExplanationHtml(content) {
  const str = String(content ?? "");

  // Pass 1: extract allowed tags and strip everything else.
  // Also strip any attributes from allowed tags for safety.
  const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?\/?>/g;
  const segments = [];
  let lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(str)) !== null) {
    if (m.index > lastIndex) {
      segments.push(str.slice(lastIndex, m.index));
    }
    const tagName = m[1].toLowerCase();
    if (ALLOWED_HTML_TAGS.has(tagName)) {
      // Strip any attributes: keep the bare tag name (and the closing
      // slash for void tags like <br/>).
      const raw = m[0];
      const isClosing = raw.startsWith("</");
      const isVoid = !isClosing && /\/>$/.test(raw);
      if (isClosing) {
        segments.push(`</${tagName}>`);
      } else if (isVoid || tagName === "br") {
        segments.push(`<${tagName}>`);
      } else {
        segments.push(`<${tagName}>`);
      }
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < str.length) {
    segments.push(str.slice(lastIndex));
  }
  let sanitized = segments.join("");

  // Pass 2: convert \n to <br> when not already inside a block.
  sanitized = sanitized
    .replace(/([^>\n])\n(?!<)/g, "$1<br>\n")
    .replace(/\n+/g, "\n");

  // Pass 3: wrap in <p>...</p> if not already wrapped.
  const hasBlockWrapper = /^[\s\n]*<p[\s>]/i.test(sanitized) || /<\/?p[\s>]/i.test(sanitized);
  if (!hasBlockWrapper) {
    const wrapped = sanitized
      .split("\n")
      .map((seg) => {
        const trimmed = seg.trim();
        return trimmed ? `<p>${trimmed}</p>` : "";
      })
      .filter(Boolean)
      .join("\n");
    sanitized = wrapped;
  } else {
    sanitized = sanitized.trim();
  }

  return sanitized || "";
}

/**
 * Compare two HTML/strings by their visible text only. Returns
 * `{match: boolean, expectedText, actualText}`.
 *
 * This is the SINGLE pass/fail function used by both pre-save and
 * post-save verification. Formatting mismatches (e.g. <b>→<strong>)
 * do NOT cause a mismatch — only visible text differences do.
 *
 * @param {string} expected
 * @param {string} actual
 * @returns {{match: boolean, expectedText: string, actualText: string}}
 */
export function compareHtmlText(expected, actual) {
  const expectedText = htmlToComparableText(prepareExplanationHtml(expected));
  const actualText = htmlToComparableText(actual);
  return {
    match: expectedText === actualText,
    expectedText,
    actualText,
  };
}