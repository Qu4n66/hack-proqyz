# Question-Type Example Fixtures

Three small, single-passage fixtures that exercise the three
ProQyz question types that are **not** Fill-up. Each fixture is
validated against the current schema (`QuizSchema` →
`normalizeQuiz` → `checkInvariants`).

> **Status.** Fill-up (`proqyzType: "fill_up"`, `questionTypeIndex: 0`)
> is the only type the live uploader currently dispatches
> (`UiQuizUploader.js:490-507`); radio/checkbox are explicitly
> deferred (line 499-502). These fixtures are prepared so that, when
> the dispatcher is widened, the new types can be exercised
> immediately against a known-good shape.

---

## Files

| File | `proqyzType` | `questionTypeIndex` | `ieltsType` | `# questions` | `defaultOptions` |
|---|---|---|---|---|---|
| `fixtures/examples/radio-single-mcq.json` | `radio`      | `1` | `multiple_choice_single`   | 2 | — |
| `fixtures/examples/select-true-false-not-given.json` | `select`     | `2` | `true_false_not_given`     | 2 | `true_false_not_given` |
| `fixtures/examples/checkbox-multiple-answer.json`     | `checkbox`   | `3` | `multiple_choice_multiple` | 2 | — |

Each fixture contains **1 passage** and **2 questions** of a single
type. Question numbers are contiguous starting at 1 (required by
`checkInvariants` in `src/domain/invariants.js:27-32`).

---

## What each fixture demonstrates

### `radio-single-mcq.json` — Radio, single correct answer

- **`proqyzType: "radio"`**, **`questionTypeIndex: 1`**.
- `options[]` has 4 entries each, with `label` ∈ {A, B, C, D} and
  free-text `text`. Schema requires **≥ 2 options**
  (`schemas.js:218-220`).
- `answer` is a **single label** that must match one of the
  `options[*].label` values case-insensitively
  (`schemas.js:226-234`). The normalize step uppercases the label
  (`normalize.js:33-39`), so both `"b"` and `"B"` are accepted.
- `answers` (plural) is **forbidden** on radio
  (`schemas.js:207-212`).
- **No** `{answer}` braces in `content`; no `defaultOptions` field.

This is the shape that the deferred `_addOptionsQuestion` strategy
(`UiQuizUploader.js:638-712`) and `selectCorrectOption`
(`radioStrategy.js:29-63`) will receive.

### `select-true-false-not-given.json` — Select with named preset

- **`proqyzType: "select"`**, **`questionTypeIndex: 2`**.
- `defaultOptions: "true_false_not_given"` is **required** for any
  select question (`schemas.js:264-270`). The schema's enum
  (`schemas.js:88-96`) lists all 7 valid codes; the driver maps
  each to a ProQyz value via `defaultOptionsToSelectValue`
  (`schemas.js:104-123`).
- `answer` is a **single preset label** — one of `TRUE`, `FALSE`,
  `NOT GIVEN` (case-insensitive after trim). The driver picks it
  from a `<select name="answer">` (or react-select fallback) on the
  `Question` tab (`UiQuizUploader.js:1521-1580`).
- The `content` includes a leading `<strong>N</strong>` prefix.
  `_fillSelectQuestion` strips a leading `"N "` from the stem
  before typing into TinyMCE (`UiQuizUploader.js:1497-1501`); the
  question number is captured on the `Finish` tab via the Title
  field.
- **No** `options[]` (the preset supplies the choices).
- **No** `{answer}` braces in `content` (the placeholder rule only
  applies to `fill_up`).

### `checkbox-multiple-answer.json` — Checkbox, multiple correct answers

- **`proqyzType: "checkbox"`**, **`questionTypeIndex: 3`**.
- `options[]` has 5 (Q1) and 6 (Q2) entries. Schema requires
  **≥ 2 options** (`schemas.js:240-243`).
- `answers` (plural) is a **non-empty array of labels** that all
  match `options[*].label` case-insensitively
  (`schemas.js:247-256`). Q1 picks 2, Q2 picks 3 — the typical
  IELTS "Choose TWO / THREE" pattern.
- `answer` (singular) is **forbidden** on checkbox
  (`schemas.js:189-195`). Using the singular form is a Zod error
  and a common author mistake.
- **No** `{answer}` braces in `content`; no `defaultOptions` field.

This is the shape that the deferred `_addOptionsQuestion` strategy
will receive when `kind === "checkbox"`; the correct-answer picker
is `selectCorrectCheckboxes` (`radioStrategy.js:72-90`).

---

## Validation

All three fixtures pass:

1. **Zod parse** — `QuizSchema.safeParse(...)` succeeds with no
   issues.
2. **Normalize** — `normalizeQuiz(...)` runs cleanly. For radio and
   checkbox, this uppercases option labels and the answer(s);
   `fill_up` / `select` keep their original casing
   (`normalize.js:33-54`).
3. **Invariants** — `checkInvariants(...)` confirms question numbers
   are contiguous from 1 within the passage, with no duplicates
   (`invariants.js:27-46`).

To re-validate after any edit:

```bash
# Top-level fixtures (the live cam17 ones)
node scripts/validate-fixtures.js

# Example fixtures in fixtures/examples/
# (scripts/validate-fixtures.js does NOT recurse — see "Caveat" below)
node --input-type=module -e "
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuizSchema } from './src/domain/schemas.js';
import { normalizeQuiz } from './src/domain/normalize.js';
import { checkInvariants } from './src/domain/invariants.js';
const dir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/examples');
for (const e of await readdir(dir, { withFileTypes: true })) {
  if (!e.isFile() || !e.name.endsWith('.json')) continue;
  const f = join(dir, e.name);
  const r = QuizSchema.safeParse(JSON.parse(await readFile(f, 'utf8')));
  if (!r.success) { console.error(f, 'INVALID'); process.exit(1); }
  checkInvariants(normalizeQuiz(r.data));
  console.log(f, 'OK');
}
"
```

---

## Caveat — `validate-fixtures.js` does not recurse

`scripts/validate-fixtures.js` walks only the **top-level**
`fixtures/` directory (`readdir(fixturesDir, { withFileTypes: true })`
on line 30, then filters `e.isFile()`). Files under
`fixtures/examples/` are intentionally **invisible** to that
script. This is a feature, not a bug — the examples are reference
shapes, not uploader input — but it does mean the inline snippet
above is the only validator that covers the examples. (If you
prefer a script, save the snippet as `scripts/validate-examples.js`
or extend `validate-fixtures.js` to also descend into `fixtures/*/`
when those subdirs contain a `*.json`.)

---

## How to use these once radio/checkbox are unblocked

When `UiQuizUploader.addQuestion`'s dispatcher
(`UiQuizUploader.js:490-507`) is widened to accept `radio` and
`checkbox`, the per-type strategies are already in place:

- **Radio** → `_addOptionsQuestion(q, "radio")`
  (`UiQuizUploader.js:638-712`). The stem-fill, Add-Option loop,
  text-fill, and `_saveQuestionAndBack` are shared with checkbox.
  The correct-answer picker is `selectCorrectOption`
  (`radioStrategy.js:29-63`).
- **Checkbox** → `_addOptionsQuestion(q, "checkbox")`. Same
  strategy with `selectCorrectCheckboxes`
  (`radioStrategy.js:72-90`) for the correct markers.

To dry-run the new types against a stub:

```bash
node --input-type=module -e "
import { readFile } from 'node:fs/promises';
import { QuizSchema } from './src/domain/schemas.js';
import { normalizeQuiz } from './src/domain/normalize.js';
import { checkInvariants } from './src/domain/invariants.js';
for (const name of [
  'fixtures/examples/radio-single-mcq.json',
  'fixtures/examples/select-true-false-not-given.json',
  'fixtures/examples/checkbox-multiple-answer.json',
]) {
  const r = QuizSchema.safeParse(JSON.parse(await readFile(name, 'utf8')));
  if (!r.success) { console.error(name, 'INVALID'); process.exit(1); }
  checkInvariants(normalizeQuiz(r.data));
  console.log(name, 'OK');
}
"
```

Once the dispatcher change lands, these fixtures can be passed to
`bin/upload.js <path>` exactly like the cam17 ones, e.g.:

```bash
node bin/upload.js fixtures/examples/radio-single-mcq.json --dry-run
```

The dry-run path records the intended actions without clicking any
real UI, so it's a safe first end-to-end check of the new flow.

---

## Schema cheat-sheet for the four `proqyzType` values

| Field | `fill_up` | `radio` | `select` | `checkbox` |
|---|---|---|---|---|
| `proqyzType` | `"fill_up"` | `"radio"` | `"select"` | `"checkbox"` |
| `questionTypeIndex` | `0` | `1` | `2` | `3` |
| `content` | HTML with exactly one `{...}` placeholder | HTML, no braces | HTML, no braces (a leading `N ` is stripped by the driver) | HTML, no braces |
| `answer` (singular) | required (matches brace text) | required (a label) | required (a preset label) | **forbidden** |
| `answers` (plural) | **forbidden** | **forbidden** | **forbidden** | required (array of labels) |
| `options[]` | n/a | required (≥ 2) | n/a | required (≥ 2) |
| `defaultOptions` | n/a | n/a | **required** (one of 7 codes) | n/a |
| Validator (Zod) | brace text must equal `answer` (case-insensitive) | `answer` must match a label | — | every `answers` entry must match a label |
