/**
 * Unit tests for the safe HTML helpers used by the explanation uploader.
 *
 * These tests pin the behavior of:
 *   - prepareExplanationHtml() — sanitize and wrap content for TinyMCE
 *   - htmlToComparableText() — normalize HTML/text for visible-text comparison
 *   - compareHtmlText() — pass/fail decision based on visible text
 *
 * TinyMCE normalizes <b>→<strong>, <i>→<em>, <p>→<div>, <br>→newline,
 * and decodes entities. Tests must verify visible-text equality, not raw
 * HTML equality.
 *
 * Run with: node --test tests/unit/explanationHtml.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prepareExplanationHtml,
  htmlToComparableText,
  compareHtmlText,
} from "../../src/uploader/ui/explanationHtml.js";

// ──────────────────────────────────────────────────────────────
// htmlToComparableText
// ──────────────────────────────────────────────────────────────

test("htmlToComparableText: plain string passes through", () => {
  assert.equal(htmlToComparableText("Hello world"), "Hello world");
});

test("htmlToComparableText: empty and null return empty string", () => {
  assert.equal(htmlToComparableText(""), "");
  assert.equal(htmlToComparableText(null), "");
  assert.equal(htmlToComparableText(undefined), "");
  assert.equal(htmlToComparableText(0), "0");
});

test("htmlToComparableText: <p>Hello <b>world</b></p> becomes 'Hello world'", () => {
  assert.equal(htmlToComparableText("<p>Hello <b>world</b></p>"), "Hello world");
});

test("htmlToComparableText: <br> becomes newline", () => {
  assert.equal(
    htmlToComparableText("Line one.<br>Line two."),
    "Line one.\nLine two.",
  );
});

test("htmlToComparableText: <br/> and <br /> both become newline", () => {
  assert.equal(htmlToComparableText("a<br/>b"), "a\nb");
  assert.equal(htmlToComparableText("a<br />b"), "a\nb");
  assert.equal(htmlToComparableText("a<br >b"), "a\nb");
});

test("htmlToComparableText: </p><p> becomes newline", () => {
  assert.equal(
    htmlToComparableText("<p>One</p><p>Two</p>"),
    "One\nTwo",
  );
  assert.equal(
    htmlToComparableText("<p>One</p>\n<p>Two</p>"),
    "One\nTwo",
  );
});

test("htmlToComparableText: HTML entities are decoded", () => {
  assert.equal(htmlToComparableText("a&nbsp;b"), "a b");
  assert.equal(htmlToComparableText("a&amp;b"), "a&b");
  assert.equal(htmlToComparableText("a&lt;b&gt;c"), "a<b>c");
  assert.equal(htmlToComparableText("a&quot;b&quot;c"), 'a"b"c');
  assert.equal(htmlToComparableText("a&#39;b&#39;c"), "a'b'c");
});

test("htmlToComparableText: whitespace collapsed", () => {
  assert.equal(htmlToComparableText("a   b\t\t  c"), "a b c");
  assert.equal(htmlToComparableText("a\n\nb"), "a\nb");
  assert.equal(htmlToComparableText("a \n b"), "a\nb");
});

// ──────────────────────────────────────────────────────────────
// prepareExplanationHtml
// ──────────────────────────────────────────────────────────────

test("prepareExplanationHtml: plain text wraps in <p>", () => {
  assert.equal(prepareExplanationHtml("Hello world"), "<p>Hello world</p>");
});

test("prepareExplanationHtml: empty becomes empty", () => {
  assert.equal(prepareExplanationHtml(""), "");
  assert.equal(prepareExplanationHtml(null), "");
  assert.equal(prepareExplanationHtml(undefined), "");
});

test("prepareExplanationHtml: <b> bold is preserved", () => {
  assert.equal(
    prepareExplanationHtml("The answer is <b>dopamine</b>."),
    "<p>The answer is <b>dopamine</b>.</p>",
  );
});

test("prepareExplanationHtml: <i> italic is preserved", () => {
  assert.equal(
    prepareExplanationHtml("This is <i>important</i>."),
    "<p>This is <i>important</i>.</p>",
  );
});

test("prepareExplanationHtml: <strong> and <em> are preserved", () => {
  const out = prepareExplanationHtml("<p>One <strong>bold</strong> and <em>italic</em>.</p>");
  assert.equal(out, "<p>One <strong>bold</strong> and <em>italic</em>.</p>");
});

test("prepareExplanationHtml: <p> already-wrapped content is preserved", () => {
  const input = "<p>One <b>bold</b> line.</p><p>One <i>italic</i> line.</p>";
  const out = prepareExplanationHtml(input);
  assert.ok(out.includes("One <b>bold</b> line."));
  assert.ok(out.includes("One <i>italic</i> line."));
});

test("prepareExplanationHtml: \\n becomes <br>", () => {
  const out = prepareExplanationHtml("Line one.\nLine two.");
  assert.ok(out.includes("<br>"), `expected <br> in ${out}`);
  assert.ok(out.includes("Line one."));
  assert.ok(out.includes("Line two."));
});

test("prepareExplanationHtml: \\n produces separate <p> blocks when no wrapper", () => {
  const out = prepareExplanationHtml("Line one.\nLine two.");
  // The newline is converted to <br>, then the now-two-segment string is
  // wrapped as <p> per segment. Visible-text comparison still passes
  // because htmlToComparableText turns <br> back into \n.
  assert.equal(out, "<p>Line one.<br></p>\n<p>Line two.</p>");
});

test("prepareExplanationHtml: disallowed tags are stripped (text content preserved)", () => {
  // The dangerous tag is removed; its inner text becomes harmless plain text.
  // TinyMCE renders plain text, never executes it.
  assert.equal(
    prepareExplanationHtml("<script>alert(1)</script>safe"),
    "<p>alert(1)safe</p>",
  );
  assert.equal(
    prepareExplanationHtml("<style>body{}</style>safe"),
    "<p>body{}safe</p>",
  );
  assert.equal(
    prepareExplanationHtml('<a href="x">link</a>'),
    "<p>link</p>",
  );
  assert.equal(
    prepareExplanationHtml('<img src="x.png" alt="i"/>safe'),
    "<p>safe</p>",
  );
});

test("prepareExplanationHtml: dangerous attributes are stripped from allowed tags", () => {
  // The <b> tag is allowed but the onclick attribute is stripped for safety.
  const out = prepareExplanationHtml('<b onclick="bad()">bold</b>');
  assert.equal(out, "<p><b>bold</b></p>");
});

// ──��───────────────────────────────────────────────────────────
// compareHtmlText — pass/fail rules
// ──────────────────────────────────────────────────────────────

test("compareHtmlText: visible text match returns match=true", () => {
  const r = compareHtmlText("Hello world", "<p>Hello world</p>");
  assert.equal(r.match, true);
});

test("compareHtmlText: <b> formatting difference does NOT fail verification", () => {
  // TinyMCE may normalize <b>→<strong>; both produce "dopamine" visible text.
  const expected = "The answer is <b>dopamine</b>.";
  const actual = "<p>The answer is <strong>dopamine</strong>.</p>";
  const r = compareHtmlText(expected, actual);
  assert.equal(r.match, true, `expected match, got ${JSON.stringify(r)}`);
});

test("compareHtmlText: <i>→<em> difference does NOT fail verification", () => {
  const expected = "This is <i>important</i>.";
  const actual = "<p>This is <em>important</em>.</p>";
  const r = compareHtmlText(expected, actual);
  assert.equal(r.match, true);
});

test("compareHtmlText: <br>→<p> normalization does NOT fail verification", () => {
  // TinyMCE may convert <br> inside a paragraph into a separate paragraph.
  const expected = "Line one.\nLine two.";
  const actual = "<p>Line one.</p><p>Line two.</p>";
  const r = compareHtmlText(expected, actual);
  assert.equal(r.match, true);
});

test("compareHtmlText: plain text vs <p>-wrapped does NOT fail", () => {
  // TinyMCE wraps content in <p>; raw "Hello world" and "<p>Hello world</p>" match.
  const r = compareHtmlText("Hello world", "<p>Hello world</p>");
  assert.equal(r.match, true);
});

test("compareHtmlText: actual empty returns match=false", () => {
  const r = compareHtmlText("Hello world", "");
  assert.equal(r.match, false);
});

test("compareHtmlText: visible text mismatch returns match=false", () => {
  const r = compareHtmlText("Hello world", "<p>Goodbye world</p>");
  assert.equal(r.match, false);
  assert.notEqual(r.expectedText, r.actualText);
});

test("compareHtmlText: extra whitespace does NOT fail", () => {
  const r = compareHtmlText("Hello world", "<p>Hello   world</p>");
  assert.equal(r.match, true);
});

test("compareHtmlText: HTML entities in expected are decoded", () => {
  // "Tom &amp; Jerry" decodes to "Tom & Jerry" — TinyMCE stores it that way too.
  const r = compareHtmlText("Tom &amp; Jerry", "Tom &amp; Jerry");
  assert.equal(r.match, true);
});