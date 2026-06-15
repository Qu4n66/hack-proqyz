# ProQyz Question Types — Research Documentation

**Scope:** Investigation of the four ProQyz editor question types and how the
[`proqyzType`](../src/domain/schemas.js) field maps onto ProQyz's real UI.
**Sources:** live source under `src/`, Phase-0 recon dumps
(`proqyz-inspection-*.json`), schema (`src/domain/schemas.js`), live
fixture (`fixtures/cam17-reading-test01-passage1.json`), the
"Add Reading Question" modal flow captured in
`src/uploader/ui/UiQuizUploader.js`, and the central selector map
(`src/uploader/ui/selectors.js`).
**Status:** research only — **no code modified**.

---

## 0. Type → ProQyz index → strategy at a glance

`proqyzType` is one of four stable codes enforced by `ProqyzTypeSchema`
(`src/domain/schemas.js:74-79`):

| `proqyzType` | Index in "Add" combobox (`#input-type`) | `questionTypeIndex` (fixture) | Strategy file in uploader | Status |
|---|---|---|---|---|
| `fill_up`     | 0 | 0 | `UiQuizUploader._fillFillUpQuestion` (active) | **Implemented** |
| `radio`       | 1 | 1 | `UiQuizUploader._addOptionsQuestion` (deferred) | **Not yet supported** — dispatcher throws on `radio`/`checkbox` (line 499-502) |
| `select`      | 2 | 2 | `UiQuizUploader._fillSelectQuestion` (active) | **Implemented** |
| `checkbox`    | 3 | 3 | `UiQuizUploader._addOptionsQuestion` (deferred) | **Not yet supported** — dispatcher throws on `radio`/`checkbox` (line 499-502) |

`questionTypeIndex` is **required on every question** in the fixture
(`_pickQuestionTypeInEditor` throws if it is missing — `UiQuizUploader.js:914`).
The numbering matches the visible dropdown order on real ProQyz
(`UiQuizUploader.js:887-891`).

`PROQYZ_TYPE_TO_SELECT_VALUE` in `UiQuizUploader.js:36-41` is a parallel
map for the stub's native `<select name="type">`:

```js
{ fill_up: "fill_up", select: "select", radio: "radio", checkbox: "checkbox" }
```

---

## 1. Shared pre-conditions (apply to all four types)

Before any of the four type-specific flows runs, the uploader has already:

1. **Logged in** and navigated to `/dashboard/@customer/pro-qyz/my-quizzes`.
2. **Created the quiz** via the two-step wizard:
   - Step 1 — pick a category radio (5 radios with `name="category"` —
     `reading` / `listening` / `writing` / `speaking` / `gov`); click
     **Next**.
   - Step 2 — title + description; submit routes to the edit page
     (`/dashboard/.../quiz/edit/<id>`).
   The edit page exposes `name="title"`, `name="description"`,
   `name="min"`, `name="status"`, and (sometimes) `name="quiz_type"`.
3. **Added at least one passage** via the **Passages** tab →
   `+ Add Passage` modal (title + TinyMCE content; submit).
4. Clicked the **Questions** tab and selected the right passage from
   the passage dropdown (a `<select class="form-select">` with a
   `--SELECT PASSAGE--` placeholder, options matching the passage
   titles; helper picks the first visible match by label, falls back
   to `passageIdx + 1`).
5. Clicked `+ Add Question`, which opens the **Add Reading Question
   modal** — a 5-tab card: `Basic` | `Question` | `Explanation` |
   `Preview` | `Finish`. The **type is picked on the `Basic` tab** by
   `_pickQuestionTypeInEditor`, which:
   - opens the combobox at `#input-type`,
   - clicks `[role="option"]:nth(questionTypeIndex)`,
   - presses `Enter` to commit (bare clicks do **not** commit on real
     ProQyz — `UiQuizUploader.js:972-977`),
   - clicks the modal backdrop at `(5, 5)` to close any lingering menu,
   - **asserts** the field now contains the option's text
     (`UiQuizUploader.js:1001`) and that the full
     `Question / Explanation / Preview / Finish` tab bar has rendered
     (line 1023-1071). Failure here = "modal stuck on Basic tab".
6. Dispatched on `proqyzType`. The dispatcher is at
   `UiQuizUploader.js:490-507`; `radio` and `checkbox` currently throw.

The modal root is `.question__components.modal.show` (scoped by
`_fillFillUpQuestion` / `_fillSelectQuestion`). The modal's mask is
`#question-modal-mask.show` / `.question__components.modal-mask.show`
(`_closeStrayQuestionModal`).

---

## 2. `proqyzType: 0` — Fill-up

> **One-line summary:** type prose into a TinyMCE editor, where the
> blank is marked inline with a `{...}` brace. ProQyz auto-extracts the
> text inside the brace as the correct answer.

### 2.1 UI differences vs. other types

- **Default editor:** TinyMCE iframe inside the `Question` tab
  (`iframe[class*="tox-edit-area__iframe"]` over a hidden
  `textarea[id^="tiny-react_"]`). A small instruction line above the
  editor reads **"Use { } brackets"** — the user-facing cue.
- **No** Default Options dropdown, **no** per-option list, **no**
  per-question "correct answer" picker. The answer lives **inside the
  content** as `{placeholder}` text.
- **No** Number of Options field.
- **`Preview` tab** is rendered but unused by the uploader — the brace
  substitution is visible only after the question is saved.
- The `Question` tab panel renders at least one of:
  `:text("Use { } brackets")`, the TinyMCE editor, or a `Media`
  button; the uploader uses a 3-way `Promise.race` to detect the panel
  (`UiQuizUploader.js:1175-1187`).

### 2.2 Required fields (per `QuestionSchema` in `schemas.js`)

- `number` (int ≥ 1, contiguous within a passage)
- `ieltsType` (one of 13 IELTS Reading types)
- `proqyzType: "fill_up"`
- `instruction` (Master-Spec required; can be `""` for none)
- `content` — **HTML, must contain exactly one `{...}` placeholder**
  (the brace regex `/\{([^}]+)\}/g` is checked at parse time, lines
  278-296)
- `answer` — must equal the brace's inner text
  **case-insensitively, after trim** (line 287-296)
- `questionTypeIndex: 0`

### 2.3 Correct-answer format

The answer is **not entered as a separate field**. It is the text
inside the single `{...}` placeholder in `content`, and it must equal
`answer` (case-insensitive, trimmed). Example from the live fixture
(`fixtures/cam17-reading-test01-passage1.json:21`):

```json
{
  "number": 1,
  "ieltsType": "note_completion",
  "proqyzType": "fill_up",
  "instruction": "Questions 1-6. Complete the notes below. Choose ONE WORD ONLY from the passage for each answer.",
  "content": "<strong>1</strong> The {population} of London increased rapidly between 1800 and 1850.",
  "answer": "population",
  "questionTypeIndex": 0
}
```

### 2.4 Save flow (per `_fillFillUpQuestion`)

1. Click the **`Question`** tab inside the modal
   (`UiQuizUploader.js:1203`). The tab's content is one of the three
   panel signals above.
2. Focus the TinyMCE iframe body (`body#tinymce, body.mce-content-body`),
   `Ctrl+A`, `Delete`, then `page.keyboard.insertText(q.content)` —
   **the entire HTML string, braces and all** is typed into the
   iframe. This deliberately bypasses TinyMCE's `setContent` and the
   MathJax plugin so React state updates via real input events
   (lines 1228-1246). If TinyMCE is absent, falls back to
   `[contenteditable="true"]` + `insertText` (lines 1218-1226).
3. Skip **`Explanation`** and **`Preview`** tabs.
4. Click the **`Finish`** tab. Fill:
   - **Title** — `Question ${q.number}` (e.g. `Question 1`). The
     field is found by candidates: `input[name="title"]` →
     `input[placeholder*="title" i]` → `input[id*="title" i]`.
   - **Category** — `"Uncategorized"`. Tries a combobox
     (`.tab-content__box [role="combobox"]`), then a native
     `<select name*="category" i]>`; falls back to leaving the default
     if neither is found.
5. Click **Create Question** (selector
   `button:has-text("Create Question"), button:has-text("Save"), button[type="submit"]`,
   scoped to the modal). The uploader waits for
   `modal.waitFor({ state: "hidden" })` to confirm the modal closed
   (line 1335-1338).

### 2.5 DOM selectors (`selectors.js`, scoped to the question modal)

| Purpose | Selector |
|---|---|
| Question type combobox (Basic tab) | `#input-type input[role="combobox"]` (fallback: `.question__components [role="combobox"]`) |
| Question type options | `[role="option"]:nth(questionTypeIndex)` |
| Tab bar | `.question__components .tablist` |
| Tab link | `.tablist .tabs, .tablist li, [role='tab']` filtered by `hasText: /^\s*Question\s*$/i` etc. |
| TinyMCE iframe | `iframe[class*="tox-edit-area__iframe"]` |
| TinyMCE hidden textarea | `textarea[id^="tiny-react_"]` |
| Editor body | `body#tinymce, body.mce-content-body` (inside the iframe) |
| Panel signal — instruction text | `:text("Use { } brackets")` |
| Panel signal — media button | `:text("Media")` |
| Title input (Finish tab) | `input[name="title"]` → `input[placeholder*="title" i]` → `input[id*="title" i]` |
| Category (react-select) | `.tab-content__box [role="combobox"]` |
| Category option | `[role="option"]` filtered by `hasText: /^\s*Uncategorized\s*$/i` |
| Category (native select) | `select[name*="category" i]` |
| Create button (footer) | `button:has-text("Create Question"), button:has-text("Save"), button[type="submit"]` |
| Stray modal close | `button:has-text("Cancel"), button:has-text("Close"), [aria-label="Close"]` |

### 2.6 Source of truth

- Driver: [`_fillFillUpQuestion`](../src/uploader/ui/UiQuizUploader.js) (line 1145+)
- Schema rules: [`schemas.js`](../src/domain/schemas.js) line 278-296
- Selector map: [`selectors.js`](../src/uploader/ui/selectors.js) `questionEditor.*`, `editor.tinymce.*`

---

## 3. `proqyzType: 1` — Radio

> **One-line summary:** multiple-choice question with **one** correct
> answer. The uploader types the stem, adds N options, fills each
> option's text, then **ticks the radio button** in the row of the
> correct option.

### 3.1 UI differences vs. other types

- The **`Question` tab** is a plain content area (no TinyMCE-driven
  brace syntax, no Default Options). The stem is a plain textarea
  (`textarea[name="content"]` / `[contenteditable="true"][data-field="content"]`).
- A list of **N answer option rows** sits below the stem. Each row
  contains:
  - a **label** ("A" / "B" / "C" / "D" …) — often rendered as plain
    text inside `[data-testid="option-label"]` (or generated by
    ProQyz);
  - a **text field** — `input[name="optionText"]` /
    `textarea[name="optionText"]` /
    `[contenteditable="true"][data-field="optionText"]`;
  - a **correct-marker** — an `input[type="radio"][name="correct"]`
    scoped to the option row. **All radios share `name="correct"`**;
    the row's scope is the only thing that disambiguates them
    (`selectors.js:282`).
- The **Add Option** button (label varies — `Add Option` /
  `Add Answer`) appends a new row. The real ProQyz pre-populates
  2 rows; the driver adds the rest as needed.
- The picker operates in one of three modes (named in
  `radioStrategy.js:8-13`):
  - **Mode A — click-to-save:** ticking the radio persists
    immediately.
  - **Mode B — click-and-parent:** ticking only stages the change;
    a parent Save is required.
  - **Mode C — dropdown:** the "correct answer" is a single `<select>`
    (not seen in real ProQyz; best-guess fallback).
  The driver always uses **scoped `_checkOrClick`**
  (`radioStrategy.js:96-102`) — `locator.check({ timeout: 2000 })`
  with a `.click({ force: true })` fallback for non-native widgets.

### 3.2 Required fields (per `QuestionSchema`)

- `number`, `ieltsType`, `proqyzType: "radio"`, `instruction`
- `content` — **HTML, no braces**
- `options` — array of `{label, text}` with **≥ 2** entries
  (`schemas.js:218-220`)
- `answer` — a single label, must match one of `options[*].label`
  case-insensitively (lines 226-234)
- `questionTypeIndex: 1`
- **`answers` (plural) is forbidden** on radio (lines 207-212)

### 3.3 Correct-answer format

A single option label (e.g. `"B"`). The uploader matches it by
**scanning every option row's label text and option text**
(`radioStrategy.js:36-50`) — case-insensitive on label, exact-match
on the option text fallback — then `.check()`s the `input[type=radio][name="correct"]`
inside the matched row. (`.check()` is idempotent: a re-tick is a
no-op.)

### 3.4 Save flow (`_addOptionsQuestion`, deferred)

Per `UiQuizUploader.js:638-712`:

1. `typeSelect.selectOption("radio")` (best-effort — falls through to
   the form's default on failure).
2. Fill `content` into `textarea[name="content"]` (or contenteditable)
   via `writePlain`.
3. Click **Add Option** until `option.row` count equals
   `q.options.length`.
4. For each option, fill its `optionText` field with
   `q.options[i].text`. `jitter()` between fills.
5. Mark the correct option via `selectCorrectOption(page, card, correctOpt)`:
   - iterate option rows, find the one whose label (or text) matches
     `q.answer`,
   - `_checkOrClick` the radio inside that row.
6. `_saveQuestionAndBack(card)` — click the question-level Save
   (`button[type="submit"]:has-text("Save"), button:has-text("Save")`),
   then a best-effort click on a `Back` link/button.

**Current state:** the dispatcher explicitly **rejects radio** (line
497-502): `addQuestion: proqyzType "radio" for Q<n> is not yet
supported (Radio/Checkbox intentionally deferred).` The
`_addOptionsQuestion` strategy file is written but not invoked.

### 3.5 DOM selectors

| Purpose | Selector |
|---|---|
| Question type select (stub) | `select[name="type"], select[name="questionType"]` |
| Content field | `textarea[name="content"], textarea[name="question"], [contenteditable="true"][data-field="content"]` |
| Add Option button | `button:has-text("Add Option"), button:has-text("Add Answer")` |
| Option row | `[data-testid="option-row"], .option-row, [data-option-row]` |
| Option label (display) | `[data-testid="option-label"]` |
| Option text field | `input[name="optionText"], textarea[name="optionText"], [contenteditable="true"][data-field="optionText"]` |
| Correct radio (per row) | `input[type="radio"][name="correct"]` |
| Save (question editor) | `button[type="submit"]:has-text("Save"), button:has-text("Save")` |
| Back to list | `a:has-text("Back"), button:has-text("Back")` |

### 3.6 Source of truth

- Driver: [`_addOptionsQuestion`](../src/uploader/ui/UiQuizUploader.js) line 638
- Correct-answer strategy: [`radioStrategy.js`](../src/uploader/ui/radioStrategy.js) `selectCorrectOption`
- Schema rules: [`schemas.js`](../src/domain/schemas.js) line 218-234
- Status: **deferred** — dispatcher throws (line 499-502)

---

## 4. `proqyzType: 2` — Select

> **One-line summary:** drop-down question where the answer is one of
> a **fixed, named** option set (T/F/NG, A/B/C, i/ii/iii, 1/2/3, …).
> The editor lets you pick a **preset** (e.g. T/F/NG) and ProQyz
> generates the per-question answer dropdown for you.

### 4.1 UI differences vs. other types

- **Two dropdowns** on the `Question` tab that the other types don't
  show:
  1. **Default Options** — a `<select name="defaultOptions">` (or
     `default_options`) that maps a stable code
     (`true_false_not_given`, `roman_lower`, …) to a ProQyz value via
     `defaultOptionsToSelectValue` in `schemas.js:104-123`. The current
     mapping is **best-guess** — the comment at line 101-103 says "real
     ProQyz labels are guessed; on first real run, if these don't
     match, update this function and bump `Selectors.version`."
  2. **Number of Options** — `input[name="numOptions"]` /
     `input[name="number_of_options"]` / `input[name="optionCount"]`.
     The driver sets it from a built-in table
     (`UiQuizUploader.js:1461-1469`):

     | code | default count |
     |---|---|
     | `true_false_not_given` | 3 |
     | `yes_no_not_given` | 3 |
     | `roman_lower` | 5 |
     | `roman_upper` | 5 |
     | `capital_letters` | 4 |
     | `lowercase_letters` | 4 |
     | `numeric` | 4 |
- **No** "Add Option" button. The options come from the preset.
- The **per-question answer** is a single `<select name="answer">` or
  `name="correct"` (or a react-select) populated with the preset's
  labels. Tries by `label` first, then by `value` (since TRUE / FALSE
  / NOT GIVEN are often the values, not the labels).
- The `Question` tab uses a **TinyMCE** editor for the stem (same
  iframe pattern as Fill-up). The uploader **strips the leading `N `
  prefix** from the content before typing
  (`UiQuizUploader.js:1497-1501`): `text = String(q.content || "").replace(/^\d+\s+/, "")`
  — the question number lives in the `Title` field on the `Finish`
  tab.

### 4.2 Required fields

- `number`, `ieltsType`, `proqyzType: "select"`, `instruction`
- `content` — HTML, no braces required (a leading `<strong>N</strong>`
  is typical and is stripped)
- `defaultOptions` — one of the 7 codes in
  `DefaultOptionsSchema` (`schemas.js:88-96`); **required** for select
  (`schemas.js:264-270`)
- `answer` — must match one of the preset's labels
  (e.g. `"TRUE"`, `"FALSE"`, `"NOT GIVEN"`, `"A"`, `"ii"`, …)
- `questionTypeIndex: 2`
- `options` is **not** used (the preset supplies the choices)

### 4.3 Correct-answer format

A single string equal to the **display label** of the chosen preset
option. The uploader tries the native `<select name="answer">` first:

```js
await answerSel.selectOption({ label: q.answer })
                .catch(() => answerSel.selectOption(q.answer))
```

If neither matches, it falls through to a `react-select` combobox
filtered by `/^\s*${q.answer}\s*$/i` (lines 1545-1574). On miss, it
throws with the full popup contents for debugging.

### 4.4 Save flow (`_fillSelectQuestion`)

1. Click the **`Question`** tab.
2. **`Default Options`** — `select[name="defaultOptions"]` (or
   `default_options`) → `defaultOptionsToSelectValue(q.defaultOptions)`.
   If the select is missing, **throw** (the type is unusable without
   it).
3. **`Number of Options`** — `input[name="numOptions"]` (or
   `number_of_options` / `optionCount`); fill from the table above.
   If absent, skip silently.
4. **Stem** — drive the TinyMCE iframe (or fallback plain textarea)
   the same way as Fill-up. The `^\d+\s+` prefix is stripped first.
5. **Answer picker** — pick `q.answer` from the per-question `<select
   name="answer">` (or react-select fallback).
6. Skip **`Explanation`** / **`Preview`**.
7. **`Finish` tab** — `Title = "Question ${q.number}"`,
   `Category = "Uncategorized"` (react-select or native select).
8. Click **Create Question** (footer); wait for the modal to hide.

### 4.5 DOM selectors (Select-specific additions)

| Purpose | Selector |
|---|---|
| Default Options | `select[name="defaultOptions"], select[name="default_options"]` (in `selectors.js:260` and the hard-coded fallback `select[name="defaultOptions"]` in `_fillSelectQuestion` line 1425) |
| Number of Options | `input[name="numOptions"], input[name="number_of_options"], input[name="optionCount"]` (line 1457) |
| Stem (TinyMCE) | `iframe[class*="tox-edit-area__iframe"]` over `textarea[id^="tiny-react_"]` |
| Stem (plain fallback) | `textarea[name="content"], textarea[name="question"]` |
| Per-question answer (native) | `select[name="answer"], select[name="correct"]` |
| Per-question answer (react-select) | `[role="combobox"]` filtered by `hasText: /select|choose|answer/i` |
| Per-question answer option | `[role="option"]` filtered by `hasText: /^\s*${q.answer}\s*$/i` |

### 4.6 `defaultOptions` code → ProQyz `<select>` value

From `defaultOptionsToSelectValue` (`schemas.js:104-123`):

| Code | `selectOption` value |
|---|---|
| `roman_lower` | `i` |
| `roman_upper` | `I` |
| `capital_letters` | `A` |
| `lowercase_letters` | `a` |
| `numeric` | `1` |
| `true_false_not_given` | `true_false_not_given` (passed through) |
| `yes_no_not_given` | `yes_no_not_given` (passed through) |

The roman/letter/numeric values (`i`, `A`, `1`, …) are **anchors to
the first option in the preset's list**; the driver follows up with
the `Number of Options` field to set the full range.

### 4.7 Source of truth

- Driver: [`_fillSelectQuestion`](../src/uploader/ui/UiQuizUploader.js) line 1382
- Mapping: [`defaultOptionsToSelectValue`](../src/domain/schemas.js) line 104
- Schema rules: [`schemas.js`](../src/domain/schemas.js) line 264-270
- Status: **implemented**

---

## 5. `proqyzType: 3` — Checkbox

> **One-line summary:** multiple-choice question with **multiple**
> correct answers. Same editor shape as radio, but the correct
> marker is a **checkbox** and the uploader ticks every correct row.

### 5.1 UI differences vs. other types

- Identical to radio for the **stem and option rows** (plain
  textarea + `Add Option` + option text fields).
- The correct marker is `input[type="checkbox"][name="correct"]` —
  **all options share the same name**; the row scope is the only
  disambiguator (`selectors.js:284`).
- The driver supports N correct options; the typical IELTS pattern
  is exactly 2 (e.g. "Choose **TWO** answers").

### 5.2 Required fields

- `number`, `ieltsType`, `proqyzType: "checkbox"`, `instruction`
- `content` — HTML, no braces
- `options` — array of `{label, text}` with **≥ 2** entries
  (`schemas.js:240-243`)
- `answers` — array of one or more labels, every entry must match
  `options[*].label` case-insensitively (lines 247-256)
- `questionTypeIndex: 3`
- **`answer` (singular) is forbidden** on checkbox (lines 189-195);
  using `answer` for a checkbox is a Zod error

### 5.3 Correct-answer format

An **array of option labels** (e.g. `["B", "D"]`). The uploader uppercases
and trims each label, iterates the option rows, and `.check()`s the
checkbox inside any row whose label text matches
(`radioStrategy.js:72-90`). `selectCorrectCheckboxes` does **not**
assert that the labels were found — silent skip is the current
behavior — so a misspelled label will produce a question with **no**
correct answers (no exception, but a bad quiz).

### 5.4 Save flow (`_addOptionsQuestion`, deferred)

Same shape as radio (5 steps in §3.4), with two differences:

1. The "correct" branch is the `else` of `kind === "radio"`:
   ```js
   const answerLabels = (q.answers ?? []).map((a) => a.trim()).filter(Boolean);
   await selectCorrectCheckboxes(page, card, answerLabels);
   ```
   (`UiQuizUploader.js:704-706`)
2. The marker is `input[type="checkbox"][name="correct"]` (scoped to
   the option row).

**Current state:** the dispatcher explicitly **rejects checkbox**
(line 497-502). `_addOptionsQuestion` is written but not invoked.

### 5.5 DOM selectors (delta from radio)

| Purpose | Selector |
|---|---|
| Correct checkbox (per row) | `input[type="checkbox"][name="correct"]` |

Everything else (option rows, text field, Add Option, Save/Back) is
identical to radio — see §3.5.

### 5.6 Source of truth

- Driver: [`_addOptionsQuestion`](../src/uploader/ui/UiQuizUploader.js) line 638
- Correct-answer strategy: [`radioStrategy.js`](../src/uploader/ui/radioStrategy.js) `selectCorrectCheckboxes`
- Schema rules: [`schemas.js`](../src/domain/schemas.js) line 183-212, 240-259
- Status: **deferred** — dispatcher throws (line 499-502)

---

## 6. Cross-type comparison matrix

| Dimension | `fill_up` (0) | `radio` (1) | `select` (2) | `checkbox` (3) |
|---|---|---|---|---|
| **Editor for stem** | TinyMCE iframe | Plain textarea / contenteditable | TinyMCE iframe (or plain fallback) | Plain textarea / contenteditable |
| **Default Options select** | — | — | `select[name="defaultOptions"]` | — |
| **Number of Options input** | — | — | `input[name="numOptions"]` (or `number_of_options` / `optionCount`) | — |
| **Add Option button** | — | `button:has-text("Add Option"/"Add Answer")` | — | `button:has-text("Add Option"/"Add Answer")` |
| **Per-option row** | — | `[data-testid="option-row"]` / `.option-row` | — | same as radio |
| **Option text field** | — | `input/textarea[name="optionText"]` / `[contenteditable="true"][data-field="optionText"]` | — | same as radio |
| **Option label display** | — | `[data-testid="option-label"]` | — | same as radio |
| **Correct marker** | inside content as `{brace}` | `input[type="radio"][name="correct"]` (scoped to row) | `select[name="answer"]` (or react-select) over the preset | `input[type="checkbox"][name="correct"]` (scoped to row) |
| **Min options** | n/a | 2 | n/a (preset-driven) | 2 |
| **Correct-answer field** | `answer` (singular) | `answer` (singular, label) | `answer` (singular, preset label) | `answers` (plural, labels) |
| **`{answer}` placeholder in content** | **required** (exactly 1) | forbidden (no braces parsed) | not required (number prefix stripped) | forbidden |
| **Strip leading `N ` from stem** | no | no | **yes** (`replace(/^\d+\s+/, "")`) | no |
| **Save trigger** | `Create Question` (footer of modal) | `Save` (per-question editor) | `Create Question` (footer) | `Save` (per-question editor) |
| **Tabs to visit** | Basic → Question → Finish | (no tab UI; direct editor) | Basic → Question → Finish | (no tab UI; direct editor) |
| **`questionTypeIndex`** | 0 | 1 | 2 | 3 |
| **Validator exclusivity** | forbids `answers` (plural) | forbids `answers` (plural); `answer` must be a label | requires `defaultOptions`; forbids `answers` (plural) | requires `answers` (plural); forbids `answer` (singular) |
| **Uploader status** | ✅ implemented | ❌ deferred (dispatcher throws) | ✅ implemented | ❌ deferred (dispatcher throws) |

---

## 7. What the recon actually confirmed (vs. what is best-guess)

**Confirmed by Phase-0 recon dumps** (`proqyz-inspection-create-quiz.json`,
`proqyz-inspection-question.json`):

- The `Edit Quiz` page exposes `name="title"`, `name="description"`,
  `name="min"`, `name="score_type"`, `name="status"`, and the
  checkbox `name="locate_question"` / `id="shared"`.
- The quiz-edit page has **no rich-text editor** at all
  (`editors.tinymce=0, ckeditor5=0, ckeditor4=0, quill=0, textarea=1`
  in the create-quiz dump). The *passage* body is the TinyMCE-bearing
  page (captured in code as `iframe[class*="tox-edit-area__iframe"]`
  + `textarea[id^="tiny-react_"]`).
- The question-list dump shows 1 `<select>` and 1 `Add Question`
  button; the **per-question editor was not yet captured** by recon
  (see `selectors.js:243-245`).

**Best-guess / not yet verified on real ProQyz:**

- `selectors.js:34` — `version: "2026-06-08-cam17-recon"` is the
  recon version. Every "phase-1 best guess" selector is
  acknowledged in the file header (line 26-29).
- The per-question type select **names** (`name="type"` vs
  `name="questionType"`), the Default Options select value mapping
  (see the explicit warning at `schemas.js:101-103`), and the
  react-select fallback paths for the answer picker are all
  best-guess — to be confirmed on the next real ProQyz run.
- The `Question / Explanation / Preview / Finish` tab bar is
  asserted-after-type-pick in code (`UiQuizUploader.js:1023-1071`)
  but the per-tab content was captured by reading the live source,
  not by a fresh DOM dump.

---

## 8. Risks and open questions

1. **`defaultOptions` mapping is best-guess.** The first time a
   `true_false_not_given` Select is run on real ProQyz, the
   `<select name="defaultOptions">` value list will be inspected
   and the codes in `defaultOptionsToSelectValue` will be adjusted
   (or the function will be moved to a config map).
2. **Number of Options may not be exposed** in real ProQyz. The
   driver treats the field as optional (silent skip on
   `isVisible()==false`) — if the preset auto-populates 5 options
   for `roman_lower` even when we only set the count, the
   `selectOption({ label })` call in the answer picker will still
   work.
3. **Radio / Checkbox are entirely unwired** in the dispatcher. The
   selectors are written; the strategy functions are written and
   unit-shape reasonable; but the orchestrator throws on either type
   today (line 499-502). The first non-fill-up/non-select run will
   be the first end-to-end test of `_addOptionsQuestion`.
4. **TinyMCE MathJax plugin** crashes if `setContent()` is called
   with HTML containing math. The driver side-steps it by using
   `Ctrl+A` → `Delete` → `insertText()` (keyboard pipeline) — the
   comment in `editorStrategies.js:91-95` documents this explicitly.
5. **The `_closeStrayQuestionModal` cleanup** is called after every
   `addQuestion` regardless of outcome (`UiQuizUploader.js:526`). If
   a real ProQyz variant dismisses the modal on its own, this is a
   harmless no-op; if it leaves the modal up, this prevents the next
   `+ Add Question` click from going to a stale modal.
6. **No timeout/network policy** is documented in the recon dumps;
   the driver's `actionTimeoutMs` and `saveTimeoutMs` come from
   `config.js` and are the only knobs the user can tighten.

---

## 9. Where to update when ProQyz changes

Single source of truth map (read top-down on any UI regression):

1. **Selector map** — [`src/uploader/ui/selectors.js`](../src/uploader/ui/selectors.js)
   (bump `Selectors.version`).
2. **Type→value table for the native stub select** — `PROQYZ_TYPE_TO_SELECT_VALUE`
   in [`src/uploader/ui/UiQuizUploader.js`](../src/uploader/ui/UiQuizUploader.js) line 36.
3. **Default-options code→ProQyz value** —
   [`defaultOptionsToSelectValue`](../src/domain/schemas.js) line 104.
4. **Count-by-code table for `Number of Options`** —
   `UiQuizUploader.js` line 1461 (inline in `_fillSelectQuestion`).
5. **Per-type strategy** — `_fillFillUpQuestion` (line 1145),
   `_fillSelectQuestion` (line 1382), `_addOptionsQuestion` (line 638).
6. **Correct-answer strategy** — `selectCorrectOption` /
   `selectCorrectCheckboxes` in
   [`src/uploader/ui/radioStrategy.js`](../src/uploader/ui/radioStrategy.js).

Recon re-runs land in `proqyz-inspection-*.json` at the project root;
failure HTML/PNG dumps land in `failures/`.
