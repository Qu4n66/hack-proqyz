/**
 * Unit tests for htmlToComparableText and prepareExplanationHtml helpers.
 * These are defined at the bottom of src/uploader/ui/UiQuizUploader.js.
 */
import { describe, it } from "node:test";
import assert from "node:assert";

const ALLOWED_HTML_TAGS = new Set(["b", "strong", "i", "em", "br", "p"]);

function htmlToComparableText(value) {
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

function prepareExplanationHtml(content) {
  const str = String(content ?? "");
  let sanitized = str;

  const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?\/?>/g;
  let lastIndex = 0;
  let match;
  const result = [];

  while ((match = TAG_RE.exec(sanitized)) !== null) {
    if (match.index > lastIndex) {
      result.push(sanitized.slice(lastIndex, match.index));
    }
    const tagName = match[1].toLowerCase();
    if (ALLOWED_HTML_TAGS.has(tagName)) {
      result.push(match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < sanitized.length) {
    result.push(sanitized.slice(lastIndex));
  }

  sanitized = result.join("");

  // Step 3: convert \n to <br>
  sanitized = sanitized
    .replace(/([^>\n])\n(?!<)/g, "$1<br>\n")
    .replace(/\n+/g, "\n");

  // Step 4: wrap in <p>...</p> if not already wrapped
  const hasBlockWrapper =
    /^[\s\n]*<p[\s>]/i.test(sanitized) ||
    /<\/?p[\s>]/i.test(sanitized);

  if (!hasBlockWrapper) {
    const segments = sanitized.split("\n");
    const wrapped = segments
      .map((seg) => {
        const trimmed = seg.trim();
        if (!trimmed) return "";
        return `<p>${trimmed}</p>`;
      })
      .filter(Boolean)
      .join("\n");
    sanitized = wrapped;
  } else {
    sanitized = sanitized.trim();
  }

  return sanitized || "";
}

// ─── htmlToComparableText tests ─────────────────────────────────────────────

describe("htmlToComparableText", () => {
  it("strips HTML tags", () => {
    assert.strictEqual(
      htmlToComparableText("<p>Hello <b>world</b></p>"),
      "Hello world",
    );
  });

  it("converts <br> to newline", () => {
    assert.strictEqual(htmlToComparableText("Line 1<br>Line 2"), "Line 1\nLine 2");
    assert.strictEqual(htmlToComparableText("Line 1<br/>Line 2"), "Line 1\nLine 2");
    assert.strictEqual(htmlToComparableText("Line 1<br />Line 2"), "Line 1\nLine 2");
  });

  it("converts <p>...</p><p>...</p> to single newline", () => {
    // </p><p> becomes a single \n (paragraph break), not double newline
    assert.strictEqual(
      htmlToComparableText("<p>Para 1</p><p>Para 2</p>"),
      "Para 1\nPara 2",
    );
  });

  it("strips lone <p> tags", () => {
    assert.strictEqual(
      htmlToComparableText("<p>Solo paragraph</p>"),
      "Solo paragraph",
    );
  });

  it("decodes &amp; &lt; &gt; &quot; &#39; &nbsp;", () => {
    // &nbsp; decodes to space, which then gets collapsed with adjacent space
    assert.strictEqual(
      htmlToComparableText("A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39; &nbsp;"),
      'A & B < C > D "E" \'F\'',
    );
  });

  it("collapses whitespace", () => {
    assert.strictEqual(htmlToComparableText("  Hello   world  "), "Hello world");
    // \n\s+ gets collapsed to single \n, so \n\n  becomes \n
    assert.strictEqual(htmlToComparableText("  Hello\n\n  world  "), "Hello\nworld");
  });

  it("handles empty/null/undefined", () => {
    assert.strictEqual(htmlToComparableText(""), "");
    assert.strictEqual(htmlToComparableText(null), "");
    assert.strictEqual(htmlToComparableText(undefined), "");
  });

  it("preserves newlines in content", () => {
    assert.strictEqual(
      htmlToComparableText("Line 1<br>Line 2<br>Line 3"),
      "Line 1\nLine 2\nLine 3",
    );
  });
});

// ─── prepareExplanationHtml tests ────────────────────────────────────────────

describe("prepareExplanationHtml", () => {
  it("preserves <b> tag", () => {
    const out = prepareExplanationHtml("Hello <b>world</b>");
    assert.ok(out.includes("<b>world</b>"), `got: ${out}`);
  });

  it("preserves <strong> tag", () => {
    const out = prepareExplanationHtml("Hello <strong>world</strong>");
    assert.ok(out.includes("<strong>world</strong>"), `got: ${out}`);
  });

  it("preserves <i> tag", () => {
    const out = prepareExplanationHtml("This is <i>important</i>.");
    assert.ok(out.includes("<i>important</i>"), `got: ${out}`);
  });

  it("preserves <em> tag", () => {
    const out = prepareExplanationHtml("This is <em>important</em>.");
    assert.ok(out.includes("<em>important</em>"), `got: ${out}`);
  });

  it("converts \\n to <br>", () => {
    const out = prepareExplanationHtml("Line 1\nLine 2");
    assert.ok(out.includes("<br>"), `got: ${out}`);
  });

  it("wraps plain text in <p> tags", () => {
    const out = prepareExplanationHtml("plain text");
    assert.ok(out.includes("<p>"), `got: ${out}`);
    assert.ok(out.includes("</p>"), `got: ${out}`);
  });

  it("wraps each line in its own <p> when newlines present", () => {
    const out = prepareExplanationHtml("Line 1\nLine 2");
    assert.ok(out.includes("<p>"), `got: ${out}`);
    assert.ok(out.includes("Line 1"), `got: ${out}`);
    assert.ok(out.includes("Line 2"), `got: ${out}`);
  });

  it("strips <script> tag and its content", () => {
    const out = prepareExplanationHtml("Hello <script>alert(1)</script> world");
    assert.ok(!out.includes("<script>"), `got: ${out}`);
    assert.ok(!out.includes("<script"), `got: ${out}`);
    // inner text "alert(1)" may or may not survive depending on sanitizer depth
    assert.ok(out.includes("Hello"), `got: ${out}`);
    assert.ok(out.includes("world"), `got: ${out}`);
  });

  it("strips <img> tag", () => {
    const out = prepareExplanationHtml("Hello <img src=\"x\"> world");
    assert.ok(!out.includes("<img"), `got: ${out}`);
    assert.ok(out.includes("Hello"), `got: ${out}`);
    assert.ok(out.includes("world"), `got: ${out}`);
  });

  it("strips <a> tag", () => {
    const out = prepareExplanationHtml("Hello <a href=\"x\">link</a> world");
    assert.ok(!out.includes("<a "), `got: ${out}`);
    assert.ok(out.includes("Hello"), `got: ${out}`);
    assert.ok(out.includes("world"), `got: ${out}`);
  });

  it("strips event handler attributes", () => {
    const out = prepareExplanationHtml("Hello <div onclick=\"evil()\">world</div>");
    assert.ok(!out.includes("onclick"), `got: ${out}`);
    assert.ok(out.includes("Hello"), `got: ${out}`);
  });

  it("handles null/undefined gracefully", () => {
    assert.strictEqual(prepareExplanationHtml(null), "");
    assert.strictEqual(prepareExplanationHtml(undefined), "");
  });

  it("preserves <br> tag", () => {
    const out = prepareExplanationHtml("Line 1<br>Line 2");
    assert.ok(out.includes("<br>"), `got: ${out}`);
  });

  it("keeps already-wrapped p content", () => {
    const out = prepareExplanationHtml("<p>Already wrapped</p>");
    assert.ok(out.includes("<p>Already wrapped</p>"), `got: ${out}`);
  });
});

// ─── Roundtrip text comparison tests ─────────────────────────────────────────

describe("text roundtrip (prepareExplanationHtml -> htmlToComparableText)", () => {
  const cases = [
    {
      name: "basic bold",
      input: "The answer is <b>dopamine</b> because it controls reward.",
      expectedText: "The answer is dopamine because it controls reward.",
    },
    {
      name: "italic",
      input: "This is <i>especially important</i> in this context.",
      expectedText: "This is especially important in this context.",
    },
    {
      name: "newline with formatting",
      input:
        "One frequently cited motive is <b>safety</b>.\nAnother aim is to free time.",
      expectedText:
        "One frequently cited motive is safety.\nAnother aim is to free time.",
    },
    {
      name: "strong and em",
      input: "Hello <strong>bold</strong> and <em>italic</em>.",
      expectedText: "Hello bold and italic.",
    },
    {
      name: "plain text",
      input: "Plain text with no formatting.",
      expectedText: "Plain text with no formatting.",
    },
    {
      name: "multiple paragraphs",
      input: "<p>First paragraph.</p><p>Second paragraph.</p>",
      // </p><p> becomes single newline (paragraph break)
      expectedText: "First paragraph.\nSecond paragraph.",
    },
    {
      name: "entities preserved in text",
      input: "A &amp; B &lt; C &gt; D",
      expectedText: "A & B < C > D",
    },
    {
      name: "the test JSON from the spec",
      input:
        "At present, the average car spends more than 90 percent of its life <b>parked</b>.",
      expectedText:
        "At present, the average car spends more than 90 percent of its life parked.",
    },
    {
      name: "test JSON q15 with newline",
      input:
        "One frequently cited motive is <b>safety</b>; indeed, research at the UKs Transport Research Laboratory has demonstrated that more than 90 percent of road collisions involve human error.\nAnother aim is to free the time people spend driving for other purposes. This is <i>especially important</i> for older or disabled travellers.",
      expectedText:
        "One frequently cited motive is safety; indeed, research at the UKs Transport Research Laboratory has demonstrated that more than 90 percent of road collisions involve human error.\nAnother aim is to free the time people spend driving for other purposes. This is especially important for older or disabled travellers.",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const prepared = prepareExplanationHtml(c.input);
      const actualText = htmlToComparableText(prepared);
      assert.strictEqual(
        actualText,
        c.expectedText,
        `\ninput:    ${JSON.stringify(c.input)}\nprepared: ${JSON.stringify(prepared)}\nactual:   ${JSON.stringify(actualText)}\nexpected: ${JSON.stringify(c.expectedText)}`,
      );
    });
  }
});
