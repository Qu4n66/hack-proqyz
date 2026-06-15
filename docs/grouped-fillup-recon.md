# Grouped Fill-up — Probe + Implementation Recon

**Status:** Implemented (2026-06-09). This document records the
research that established ProQyz *does* support multiple
`{answer}` placeholders in a single Fill-up question, the schema
relaxation that enables that shape, and the uploader helper that
verifies the per-blank answer correspondence.

**Scope:** Q1–Q6 of `fixtures/cam17-reading-test01-passage1-fresh.json`
become ONE ProQyz Fill-up question with 6 `{answer}` placeholders.
Q7–Q13 remain 7 separate Select questions (out of scope for this
iteration; will be grouped in a follow-up using the same pattern).

---

## 1. Probe results — ProQyz natively supports multi-placeholder Fill-up

A direct Playwright probe was run on the live ProQyz editor
(2026-06-09). The probe deliberately bypassed our schema and
fixture, wrote six `{answer}` placeholders into a single Fill-up
question's content, and observed the editor's behavior.

### 1.1 What the probe did

1. Open Add Reading Question modal.
2. Select Fill-up on the Basic tab.
3. Navigate to the Question tab.
4. Paste the following content into TinyMCE:
   `The {population} of London... in the {suburbs}... A number of
   {businessmen}... the {funding} needed... appeared in the
   {press}... covered with {soil}`.
5. Blur the editor (Tab) so ProQyz's brace-scan pass fires.
6. Observe the Question tab's DOM.
7. Try saving.
8. Reopen the saved question and inspect persistence.

### 1.2 What the probe observed

- **Editor accepted the content with 6 placeholders.** No
  validation error, no UI shake, no "too many placeholders"
  warning. The schema's `braces.length === 1` is an **internal**
  guard, not a ProQyz-side restriction.
- **ProQyz auto-extracts the answers and renders them as read-only
  badges** below the TinyMCE editor. The relevant DOM is:

  ```html
  <blockquote style="margin-top: 10px;">
    <span class="badge bg-success" style="margin-right: 4px; color: white;">population</span>
    <span class="badge bg-success" style="margin-right: 4px; color: white;">suburbs</span>
    <span class="badge bg-success" style="margin-right: 4px; color: white;">businessmen</span>
    <span class="badge bg-success" style="margin-right: 4px; color: white;">funding</span>
    <span class="badge bg-success" style="margin-right: 4px; color: white;">press</span>
    <span class="badge bg-success" style="margin-right: 4px; color: white;">soil</span>
  </blockquote>
  ```

  The text inside each badge is exactly the inner text of the
  corresponding `{answer}` brace in the content — ProQyz's
  brace-scan pass scans the TinyMCE HTML, finds the braces, and
  renders one badge per brace, in brace order. The badges are
  *not* editable; they are display-only.
- **The Preview tab renders one blank per placeholder**, each
  showing the corresponding answer.
- **Save succeeds.** The "Create Question" button enables and
  the modal closes.
- **Reopening preserves all 6 placeholders and all 6 answers.**

### 1.3 The earlier assumption (editable inputs) was wrong

The first implementation of `_fillGroupedAnswerList` (this iteration,
pre-live-run) assumed ProQyz would render per-blank **editable inputs**
next to each badge. The live run disproved this — the badges are
*display-only*, and there are no editable per-blank inputs on the
Question tab for grouped fill_up. The brace scan does the work
server-side; the badges are just confirmation.

**This changes the helper's job from "fill the inputs" to "verify
the badges' text matches `q.answers`."** No fill is needed when the
badges are present and correct. The helper still falls back to
per-blank inputs / newline-textarea if badges are missing (e.g.
ProQyz's brace scan is delayed or broken), and a no-control-found
failure path captures a rich inventory dump for diagnosis.

### 1.4 Conclusion

The previous schema's restriction
(`src/domain/schemas.js:280`: `braces.length !== 1` for fill_up) is
an over-constraint, not a wire-protocol constraint. Relaxing it is
safe and matches the live ProQyz capability. The uploader's job is
to **trust the brace scan and verify**, not to re-supply the
answers.

---

## 2. Schema changes (delta)

File: `src/domain/schemas.js`

### 2.1 Three new optional fields on `QuestionSchema`

| Field | Type | Default | Notes |
|---|---|---|---|
| `numberStart` | `int >= 1` | undefined | Inclusive start of grouped range |
| `numberEnd`   | `int >= 1` | undefined | Inclusive end of grouped range |
| `displayTitle`| non-empty string | undefined | Finish-tab title; derived if absent |

All optional. Legacy single-blank fixtures omit them and continue
to validate unchanged.

### 2.2 `superRefine` rules

| Rule | Before | After |
|---|---|---|
| `fill_up` placeholder count | `=== 1` (binding to single `answer`) | Single: `=== 1` (unchanged). Grouped: `=== numberEnd - numberStart + 1` (must equal `answers.length`) |
| Brace text ↔ answer match | Single: `brace text == answer` (case-insensitive trim) | Single: unchanged. Grouped: `brace i text == answers[i]` (case-insensitive trim) |
| `answers` allowed for fill_up | No (only checkbox) | Yes, when `numberStart && numberEnd` are set; `answer` is then forbidden |
| `answer` allowed for grouped fill_up | (n/a) | No; grouped fill_up must use `answers` |

### 2.3 Backward compatibility

Every new field is optional. The legacy fixture
(`cam17-reading-test01-passage1.json`, 13 single-blank questions)
parses, normalizes, and passes invariants unchanged — confirmed by
`node --test tests/unit/schemas.test.js` (24/24 pass) and
`node scripts/validate-fixtures.js` (both fixtures pass).

---

## 3. Normalization changes

File: `src/domain/normalize.js`

A new `deriveDisplayTitle(q)` produces the Finish-tab title:

- Explicit input `displayTitle` wins.
- Grouped (numberStart..numberEnd set, S !== E) → `"Questions S-E"`.
- Single (has `number`) → `"Question N"`.
- Otherwise → undefined.

`normalizeQuestion` calls it and spreads the result onto the
normalized question, so the uploader always sees a `displayTitle`
field. `answers[]` entries are trimmed but **not** uppercased
(IELTS fill-up answers are case-sensitive on the page; the schema's
case-insensitive match is for *validation*, not for the stored
value).

---

## 4. Invariant changes

File: `src/domain/invariants.js`

The contiguous-numbers check (`questions[i].number === i + 1`) is
replaced with a **range-coverage** check:

1. Each question expands to a set of covered integers.
   - Single: `{number}`.
   - Grouped: `{numberStart, …, numberEnd}`.
2. Concatenate in array order; sort; assert the result is
   `{1, 2, …, N}` with no gaps and no duplicates.

This naturally handles:
- 13 legacy single-blank questions → 1..13 covered.
- 1 grouped fill_up (1..6) + 7 single select (7..13) → 1..13 covered.
- Multiple grouped questions in a passage (deferred but supported).

The log line for content-based question answers now also includes
`numberStart`, `numberEnd`, and `answers` so author typos are
visible in debug output.

---

## 5. Uploader changes

File: `src/uploader/ui/UiQuizUploader.js`

### 5.1 `_fillFillUpQuestion` (existing, modified)

- After TinyMCE content is written, if `q.answers.length > 1`, call
  the new `_fillGroupedAnswerList` helper (see §5.2).
- On the Finish tab, set the title field to
  `q.displayTitle ?? \`Question ${q.number}\`` (was hard-coded
  `"Question N"`). For grouped fill_up the new path emits
  `"Questions 1-6"`; for single the legacy shape is preserved.

### 5.2 Helper: `_fillGroupedAnswerList(q, modal)` (3-strategy)

The helper verifies (and, in fallback paths, fills) the per-blank
answer list for grouped fill_up. **Primary path is the read-only
badge auto-extract** — no fill is needed; the helper just verifies
the badge text matches `q.answers`.

**Strategy 1 — Badge auto-extract (primary).** ProQyz renders N
read-only `.badge.bg-success` spans below the TinyMCE editor, one
per brace, in brace order. The helper:

- Polls `modal.locator(".badge.bg-success")` for up to ~2.4s
  waiting for the count to reach `expected` (the brace scan
  is on-blur, so the helper has internal patience).
- Reads each badge's `innerText`, trims it.
- Compares to `q.answers[i]`:
  - **Strict case-trimmed equality** — match. Done.
  - **Case-insensitive equality** — match. Accept (warn-logged)
    because the brace rule is case-insensitive by spec.
  - **Real mismatch** — capture `failures/answer-list-readback-QS-E.*`
    and throw.
- **Strategy 1 succeeds → return.** No fill was needed.

**Strategy 2 — Per-blank inputs (fallback).** If no badges, look
for N fillable inputs. The probe selectors, in order:

1. `input[name*="answer" i][id*="answer" i]`
2. `input[placeholder*="answer" i]`
3. `input[aria-label*="answer" i]`
4. `input[name*="answer" i]`

Fill each in brace order, blur, then read back. On mismatch:
capture `failures/answer-list-readback-QS-E.*` and throw.

**Strategy 3 — Newline-joined textarea (last resort).** If no
badges and no per-blank inputs, try a single textarea and
paste `q.answers.join("\n")`. This is the user's spec'd
fallback for forms that expect one answer per line.

**No control found** — capture `failures/answer-list-probe-QS-E.*`
and throw. The error log includes a rich inventory of all visible
interactive elements in the modal (inputs, textareas,
contenteditable, role=textbox, buttons, tabs, labels) for
diagnosis. Per the user's spec: "do not invent a workaround" if
ProQyz doesn't expose a control.

**Helper change since the 2026-06-09 first iteration.** The first
draft assumed editable per-blank inputs (Strategy 2) was the
primary path. The live run showed badges are primary and
inputs/textarea are fallbacks. The reordering reflects the live
DOM.

### 5.3 What was NOT changed

- `_pickQuestionTypeInEditor` and the picker logic — grouped
  fill_up still uses `questionTypeIndex: 0` (Fill-up).
- `_fillSelectQuestion` — Q7–Q13 use the existing single-answer
  Select path; grouped Select is deferred.
- `addQuestion` dispatch — `switch (q.proqyzType)` routes grouped
  fill_up to `_fillFillUpQuestion` exactly like legacy single
  fill_up.
- The `recordQuestion` checkpoint key (`{ number, passageIndex }`)
  — grouped fill_up uses `number: 1` (same as the legacy first
  question); the 7 Select questions use `number: 7..13`. No
  collisions.

---

## 6. End-to-end fixture verification

After all edits, the fresh fixture is **8 questions** (1 grouped
fill_up + 7 single select) instead of 13 separate entries:

```
$ node scripts/validate-fixtures.js
fixtures/cam17-reading-test01-passage1-fresh.json ... OK (8 questions, 1 passages)
fixtures/cam17-reading-test01-passage1.json     ... OK (13 questions, 1 passages)
```

```
$ node --test tests/unit/schemas.test.js
… 24/24 pass …
```

The normalized shape of the grouped question is exactly as the
spec requires:

```
grouped displayTitle: "Questions 1-6"
grouped answers:      ["population","suburbs","businessmen","funding","press","soil"]
grouped contentBrace count: 6
grouped numberStart/End: 1 6
select displayTitle:  "Question 7"
select answer:        "FALSE"
total questions:      8
```

---

## 7. Schema error-path verification

The new branches reject the obvious bad shapes:

| Bad input | Error message |
|---|---|
| Grouped fill_up with 3 braces but `numberStart..numberEnd = 1..4` | `grouped fill_up (Q1-4) must contain exactly 4 {answer} placeholders (found 3)` AND `answers array length (3) must equal numberEnd - numberStart + 1 (4)` |
| Grouped fill_up with `answers[1] = "wrong"` and brace 2 = `{two}` | `placeholder 2 "{two}" must match answers[1] "wrong" (case-insensitive, whitespace-trimmed)` |
| Legacy single-blank fill_up with case-mismatched `answer: "london"` and brace `{London}` | **PASSES** (case-insensitive match is the documented behavior) |

---

## 8. Files changed in this iteration

| File | Change |
|---|---|
| `src/domain/schemas.js` | Add 3 optional fields; branch answer/answers exclusivity; branch fill_up placeholder rule (single vs grouped) |
| `src/domain/normalize.js` | Add `deriveDisplayTitle`; spread it onto normalized question; trim `answers[]` |
| `src/domain/invariants.js` | Replace contiguous-`number` check with range-coverage check |
| `src/uploader/ui/UiQuizUploader.js` | Add `_fillGroupedAnswerList`; call it from `_fillFillUpQuestion` for grouped; use `q.displayTitle` for Finish-tab title |
| `fixtures/cam17-reading-test01-passage1-fresh.json` | Collapse 6 fill_up entries into 1 grouped entry |
| `docs/grouped-fillup-recon.md` | This file |

Untouched: `src/pipeline/run.js`, `src/uploader/ui/checkpoint.js`,
`src/uploader/ui/selectors.js`, `bin/upload.js`,
`scripts/validate-fixtures.js`, all radio/checkbox paths, all
Select paths, all picker logic, the legacy fixture
`cam17-reading-test01-passage1.json`.

---

## 9. Open items / follow-up

1. **Live ProQyz run, second pass.** The end-to-end Playwright
   run with `--fresh` was executed once on 2026-06-09 and
   produced a `failures/answer-list-probe-Q1-6.html` dump
   showing ProQyz renders 6 read-only `.badge.bg-success` spans
   (not editable inputs). The helper has been updated to
   recognize this — Strategy 1 verifies badges, Strategy 2
   fills per-blank inputs, Strategy 3 pastes a newline-joined
   textarea. **Re-run the live upload to confirm the
   updated helper accepts the badge path on first try.**
2. **Grouped Select** for Q7–Q13: same pattern, separate task.
   Select per-blank answers are dropdowns, not text inputs —
   the helper's Strategy 2 doesn't apply; a new `kind: "select"`
   branch will be needed.
3. **Encoding B for grouped fill_up.** The current fixture
   uses Encoding A (question number in Title, content is just
   the prose + braces) — i.e. the leading `N ` prefix is
   absent from the content. Encoding A is what the spec asks
   for and is consistent with what `_fillSelectQuestion` does
   for single select. The earlier doc `ielts-question-groups.md`
   §3 still documents both encodings for the legacy single-fill
   case; that doc's recommendation ("Keep Encoding A") is now
   also the de-facto standard for grouped.

---

## 10. TL;DR

- **ProQyz supports multi-placeholder Fill-up.** Probed 2026-06-09.
- **ProQyz renders grouped answers as read-only badges**, not
  editable inputs. Auto-extracted from the `{answer}` braces in
  the content.
- **Schema relaxation is minimal:** 3 optional fields, 1 rule
  branch, 1 type-loosening. All backward-compatible.
- **Fixture went from 13 to 8 questions.** 6 fill_up entries
  collapsed into 1 grouped entry; 7 select entries unchanged.
- **Uploader helper is a 3-strategy verifier:** badge
  auto-extract (primary, no fill) → per-blank inputs (fallback)
  → newline-joined textarea (last resort). No silent
  workarounds. HTML+PNG dumps on any failure.
- **All 24 unit tests pass. Both fixtures validate. Backward
  compatibility confirmed.** Ready for the live re-run.
