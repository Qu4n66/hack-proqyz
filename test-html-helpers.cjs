const fs = require("fs");
const src = fs.readFileSync("src/uploader/ui/UiQuizUploader.js", "utf8");

// Extract and eval helpers
const htmlToComparableTextSrc = src.match(
  /function htmlToComparableText\(value\)[\s\S]*?^}/m,
)?.[0];
const prepareExplanationHtmlSrc = src.match(
  /function prepareExplanationHtml\(content\)[\s\S]*?^}/m,
)?.[0];

if (!htmlToComparableTextSrc || !prepareExplanationHtmlSrc) {
  console.error("Could not find helpers in source");
  process.exit(1);
}

eval(htmlToComparableTextSrc);
eval(prepareExplanationHtmlSrc);

const tests = [
  {
    name: "basic bold",
    input: "The answer is <b>dopamine</b> because it controls reward.",
    expectBold: true,
  },
  {
    name: "newline converted to br",
    input: "Line 1\nLine 2",
    expectContains: "<br>",
  },
  {
    name: "italic preserved",
    input: "This is <i>important</i>.",
    expectItalic: true,
  },
  {
    name: "disallowed script tag stripped",
    input: "Hello <script>alert(1)</script> world",
    expectScript: false,
  },
  {
    name: "br tag preserved",
    input: "Line 1<br>Line 2",
    expectBr: true,
  },
  {
    name: "htmlToComparableText strips tags",
    input: "<p>The answer is <b>dopamine</b>.</p>",
    expectText: "The answer is dopamine.",
  },
  {
    name: "htmlToComparableText converts br to newline",
    input: "Line 1<br>Line 2",
    expectText: "Line 1\nLine 2",
  },
  {
    name: "htmlToComparableText converts p to newline",
    input: "<p>Para 1</p><p>Para 2</p>",
    expectText: "Para 1\nPara 2",
  },
  {
    name: "htmlToComparableText decodes entities",
    input: "A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39; &nbsp;",
    expectText: 'A & B < C > D "E" \'F\'  ',
  },
  {
    name: "htmlToComparableText normalizes whitespace",
    input: "  Hello   world  ",
    expectText: "Hello world",
  },
  {
    name: "prepare wraps in p tags",
    input: "plain text",
    expectContains: "<p>",
  },
  {
    name: "prepare wraps each line in p",
    input: "Line 1\nLine 2",
    expectContains: "<p>Line 1</p>",
  },
  {
    name: "prepare keeps strong tag",
    input: "Hello <strong>world</strong>",
    expectContains: "<strong>",
  },
  {
    name: "prepare keeps em tag",
    input: "Hello <em>world</em>",
    expectContains: "<em>",
  },
  {
    name: "text roundtrip: bold preserved and comparable",
    input: "The answer is <b>dopamine</b> because it controls reward.",
    expectTextSame: "The answer is dopamine because it controls reward.",
  },
  {
    name: "text roundtrip: italic preserved and comparable",
    input: "This is <i>especially important</i> in this context.",
    expectTextSame: "This is especially important in this context.",
  },
  {
    name: "text roundtrip: newline with formatting",
    input:
      "One frequently cited motive is <b>safety</b>.\nAnother aim is to free time.",
    expectTextSame:
      "One frequently cited motive is safety.\nAnother aim is to free time.",
  },
  {
    name: "disallowed img tag stripped",
    input: 'Hello <img src="x" onerror="alert(1)"> world',
    expectImg: false,
  },
  {
    name: "disallowed a tag stripped",
    input: 'Hello <a href="http://evil.com">link</a> world',
    expectA: false,
  },
  {
    name: "htmlToComparableText on empty string",
    input: "",
    expectText: "",
  },
  {
    name: "prepareExplanationHtml on null/undefined",
    input: null,
    expectEmpty: true,
  },
];

let pass = 0, fail = 0;
for (const t of tests) {
  let ok = true;
  let out = null;

  try {
    const input = t.input == null ? "" : t.input;
    out = prepareExplanationHtml(input);
    const textOut = htmlToComparableText(out);

    if (t.expectBold !== undefined)
      ok = ok && out.includes("<b>");
    if (t.expectItalic !== undefined)
      ok = ok && out.includes("<i>");
    if (t.expectContains !== undefined)
      ok = ok && out.includes(t.expectContains);
    if (t.expectScript !== undefined)
      ok = ok && !out.includes("<script>");
    if (t.expectBr !== undefined) ok = ok && out.includes("<br");
    if (t.expectImg !== undefined)
      ok = ok && !out.includes("<img");
    if (t.expectA !== undefined)
      ok = ok && !out.includes("<a ");
    if (t.expectText !== undefined)
      ok = ok && textOut === t.expectText;
    if (t.expectEmpty !== undefined)
      ok = ok && out === "";
    if (t.expectTextSame !== undefined)
      ok = ok && textOut === t.expectTextSame;
  } catch (err) {
    ok = false;
    console.log("  Exception:", err.message);
  }

  console.log((ok ? "✓" : "✗") + " " + t.name);
  if (!ok) {
    console.log("  Input:", JSON.stringify(t.input));
    console.log("  Output:", JSON.stringify(out));
    fail++;
  } else {
    pass++;
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
