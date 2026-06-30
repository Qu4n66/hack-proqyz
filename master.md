# MASTER TASK — ProQyz Explanation Uploader: Stable HTML + Full Passage Mode

## Current State

We have an existing ProQyz explanation uploader using Playwright.

Current working features:

- Login works.
- Quiz search/open works.
- Explanation upload can open question group modal.
- Existing explanation JSON schema works.
- Plain text explanation upload used to work.
- New HTML support was added for:
  - `<b>`
  - `<strong>`
  - `<i>`
  - `<em>`
  - `<p>`
  - `<br>`
  - `\n`
- TinyMCE should receive HTML through:

```js
editor.setContent(html, { format: "html" });
editor.fire("change");
editor.fire("input");
editor.save();
```

Current problems:

- Upload sometimes exits with code `1` after pasting/writing explanations.
- UI log is too poor and may only show `[exit 1]`.
- Need stable logging, stable plain text support, stable HTML support, and optional full-passage upload.

---

## Part 1 — Fix Fatal Logging First

When upload exits non-zero, the UI must show the real reason.

Required logs:

- current step
- error message
- stack trace
- current URL
- screenshot path
- HTML snapshot path
- stdout/stderr
- never log password

Add step logs before/after each major stage:

```txt
[step] load JSON
[step] validate schema
[step] login
[step] open quiz editor
[step] select passage
[step] open questions tab
[step] fill explanations
[step] verify before save
[step] finish tab
[step] click Save Changes
[step] wait save confirmation
[step] exit 0
```

Do not allow the client UI to only show:

```txt
[exit 1]
```

That is not enough.

---

## Part 2 — Keep Safe HTML Support

Use normal HTML inside JSON `content`.

Allowed tags only:

- `<b>`
- `<strong>`
- `<i>`
- `<em>`
- `<p>`
- `<br>`

Do not use:

- `[[b]]`
- `\b`
- `<script>`
- `<style>`
- `<iframe>`
- `<img>`
- `<a>`
- arbitrary attributes
- keyboard typing of literal HTML tags

Correct insertion path:

- Prepare safe HTML from `content`.
- Use TinyMCE API when available.
- Keyboard insertion should only be fallback for plain text when TinyMCE API is unavailable.

Correct TinyMCE insertion example:

```js
editor.setContent(html, { format: "html" });
editor.fire("change");
editor.fire("input");
editor.save();
```

Important:

Do not type literal tags like this through keyboard:

```html
<b>dopamine</b>
<i>important</i>
```

Typing those through `page.keyboard.insertText()` will insert visible tags, not formatting.

---

## Part 3 — Normalize Verification

Do not compare raw HTML.

TinyMCE may normalize:

- `<b>` into `<strong>`
- `<i>` into `<em>`
- `<p>` into plain text, `<div>`, or another block structure
- `<br>` into newline or paragraphs
- HTML entities into decoded characters
- whitespace differently

These differences must not fail upload.

Use visible text comparison.

Implement or keep:

```js
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
```

Pass/fail rule:

```js
const expectedText = htmlToComparableText(prepareExplanationHtml(content));
const actualText = htmlToComparableText(actualEditorContent);

if (expectedText !== actualText) {
  throw new Error("Pre-save verification failed: visible text mismatch");
}
```

Formatting mismatch may log a warning, but must not abort save.

---

## Part 4 — Plain Text Must Still Work

Plain text with no HTML must work.

Example:

```json
{
  "questionNumber": 1,
  "content": "At present, the average car spends more than 90 percent of its life parked."
}
```

This must save correctly.

If `prepareExplanationHtml()` wraps it as:

```html
<p>At present, the average car spends more than 90 percent of its life parked.</p>
```

and TinyMCE returns:

```txt
At present, the average car spends more than 90 percent of its life parked.
```

verification must pass because visible text matches.

---

## Part 5 — Add Optional Full Passage Upload Mode

Add optional full-passage mode without breaking old single-group mode.

If `fullPassage !== true`, keep current old behavior.

If `fullPassage === true`, upload all question groups in the selected passage from top to bottom.

---

## Part 6 — Standard JSON Structure

Use this exact structure for full-passage explanation upload:

```json
{
  "mode": "explanation",
  "testTitle": "Cam 18 - Reading 1",
  "quizType": "reading",
  "fullPassage": true,
  "targetPassage": 1,
  "expectedGroupCount": 3,
  "passages": [
    {
      "passage": 1,
      "passageTitle": "Reading Passage 1",
      "questionGroups": [
        {
          "groupTitle": "Question 1-3",
          "range": "1-3",
          "questionNumberStart": 1,
          "questionNumberEnd": 3,
          "slotIndex": 1,
          "explanations": [
            {
              "questionNumber": 1,
              "content": "Plain explanation."
            },
            {
              "questionNumber": 2,
              "content": "Explanation with <b>bold</b> and <i>italic</i>."
            },
            {
              "questionNumber": 3,
              "content": "Line one.\nLine two."
            }
          ]
        },
        {
          "groupTitle": "Question 4-7",
          "range": "4-7",
          "questionNumberStart": 4,
          "questionNumberEnd": 7,
          "slotIndex": 2,
          "explanations": [
            {
              "questionNumber": 4,
              "content": "Answer explanation for question 4."
            }
          ]
        },
        {
          "groupTitle": "Question 8-13",
          "range": "8-13",
          "questionNumberStart": 8,
          "questionNumberEnd": 13,
          "slotIndex": 3,
          "explanations": [
            {
              "questionNumber": 8,
              "content": "Answer explanation for question 8."
            }
          ]
        }
      ]
    }
  ]
}
```

---

## Part 7 — Field Meanings

### `fullPassage`

Boolean.

If `true`, upload all groups in the selected passage.

If missing or `false`, keep old single-group behavior.

### `targetPassage`

Passage number to upload.

Example:

```json
"targetPassage": 1
```

Uploader should select `Reading passage 1`.

### `expectedGroupCount`

Number of question groups expected in the selected passage.

Example:

```json
"expectedGroupCount": 3
```

Before upload, verify ProQyz UI shows exactly 3 groups.

If UI count does not match JSON, stop before editing anything.

### `groupTitle`

Human-readable group name shown in ProQyz UI.

Example:

```json
"groupTitle": "Question 1-3"
```

Uploader should compare this with the visible UI card title.

### `slotIndex`

1-based order of the group card in the UI.

Example:

```json
"slotIndex": 2
```

Means second group card from top.

Use this as fallback if title matching is not perfect.

---

## Part 8 — Full Passage Algorithm

When `fullPassage: true`:

1. Load JSON.
2. Validate schema.
3. Login.
4. Open quiz editor.
5. Go to Questions tab.
6. Select `targetPassage` from passage dropdown.
7. Read all visible question group cards.
8. Verify:
   - visible group count equals `expectedGroupCount`
   - JSON `questionGroups.length` equals `expectedGroupCount`
   - each UI group title matches JSON `groupTitle` or `range` in order
9. For each group from top to bottom:
   - click edit pencil for that group
   - go to Explanation tab
   - fill all explanations in that group
   - verify normalized visible text
   - go to Finish tab
   - click Save Changes
   - wait for save confirmation
   - if modal remains open, click X close button safely
   - wait until back on question list
   - continue with next group
10. Print summary.
11. Exit 0.

Do not try to edit all groups inside one modal.

One group equals:

```txt
open modal -> edit explanations -> save -> close -> next group
```

---

## Part 9 — Validation Rules

Before editing anything:

```js
mode === "explanation"
quizType === "reading" || quizType === "listening"
questionNumberStart <= questionNumberEnd
range matches questionNumberStart/questionNumberEnd
slotIndex >= 1
explanations questionNumber inside range
```

For full passage:

```js
questionGroups.length === expectedGroupCount
visibleUiGroups.length === expectedGroupCount
```

If mismatch, stop before editing and print a clear error.

Example error:

```txt
[fullPassage] group mismatch
Expected:
1. Question 1-3
2. Question 4-7
3. Question 8-13

Actual:
1. Question 1-3
2. Question 8-13
3. Question 4-7

Upload stopped before editing.
```

---

## Part 10 — Save And Close Flow

After each group:

```txt
click Save Changes
wait 500-1000ms
if modal still visible, click X
wait for List of Questions page
```

Required behavior:

- Save group 1.
- Close modal.
- Return to group list.
- Open group 2.
- Repeat.

Do not proceed to next group while modal is still unstable.

---

## Part 11 — Suggested Functions

Add new functions around the existing stable flow.

Do not rewrite login/search/open quiz logic.

Suggested functions:

```js
async function uploadFullPassageExplanations(page, data) {}

async function selectReadingPassage(page, passageNumber) {}

async function getVisibleQuestionGroups(page) {
  return [
    {
      title: "Question 1-3",
      slotIndex: 1,
      editButton: locator
    }
  ];
}

async function verifyQuestionGroupsAgainstJson(uiGroups, jsonGroups, expectedGroupCount) {}

async function openQuestionGroupBySlot(page, group) {}

async function saveAndCloseQuestionGroupModal(page) {}

async function waitForQuestionList(page) {}
```

Reuse existing explanation fill helpers.

---

## Part 12 — Required Logs

Add detailed logs:

```txt
[fullPassage] enabled
[fullPassage] target passage: 1
[fullPassage] expected groups: 3
[fullPassage] found groups: 3
[fullPassage] group 1/3: Question 1-3 open
[fullPassage] group 1/3: explanations filled
[fullPassage] group 1/3: verification passed
[fullPassage] group 1/3: save clicked
[fullPassage] group 1/3: modal closed
[fullPassage] group 2/3: Question 4-7 open
[fullPassage] group 2/3: explanations filled
[fullPassage] group 2/3: verification passed
[fullPassage] group 2/3: save clicked
[fullPassage] group 2/3: modal closed
[fullPassage] completed 3/3 groups
```

On failure, log:

- current group
- current step
- current URL
- screenshot path
- HTML snapshot path
- stack trace

---

## Part 13 — Tests

Add or update tests for:

### Plain text

```js
Hello world
```

### Newline

```js
Line one.\nLine two.
```

### Bold

```html
The answer is <b>dopamine</b>.
```

### Italic

```html
This is <i>important</i>.
```

### Mixed HTML

```html
<p>One <b>bold</b> line.</p><p>One <i>italic</i> line.</p>
```

### Comparable text

```js
htmlToComparableText("<p>Hello <b>world</b></p>") === "Hello world"
htmlToComparableText("Hello world") === "Hello world"
```

### Full passage JSON

Check:

- `expectedGroupCount` matches
- `groupTitle` order matches
- question ranges are valid
- explanations question numbers are inside range

---

## Part 14 — CI Fixture Fix

Current CI may fail with:

```txt
fixtures/explanation-example.json INVALID
quizType: Invalid discriminator value. Expected 'reading' | 'listening'
```

Fix fixture only:

```json
"quizType": "reading"
```

Do not change uploader logic for this CI issue.

Run:

```bash
node scripts/validate-fixtures.js
npm test
```

---

## Part 15 — Success Criteria

### Single-group mode

Still works when:

```json
"fullPassage": false
```

or when `fullPassage` is missing.

### Full-passage mode

For UI groups:

```txt
Question 1-3
Question 4-7
Question 8-13
```

and JSON:

```json
"fullPassage": true,
"targetPassage": 1,
"expectedGroupCount": 3
```

Uploader must:

1. Upload group 1.
2. Save.
3. Close modal.
4. Upload group 2.
5. Save.
6. Close modal.
7. Upload group 3.
8. Save.
9. Exit 0.

### Final expected result

- Plain text works.
- Newlines work.
- `<b>` works.
- `<i>` works.
- Verification uses visible text.
- Raw HTML mismatch does not kill save.
- Logs show actual error if failed.
- GitHub CI passes.
