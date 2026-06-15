# ProQyz IELTS Automation

A Node.js + Playwright CLI that automates the manual data entry of IELTS
Reading and Listening quizzes into ProQyz. **Content uploader, not
content generator** — you (or an external AI / parser) provide the JSON;
the tool drives the UI end-to-end.

> **Phase 1 (Reading MVP).** Schema, normalize, invariants, uploader,
> fixture, and tests are aligned with the new JSON contract. Login and
> session are working. Per-question editor selectors in
> `src/uploader/ui/selectors.js` are best-guess and will be refined on
> the first real ProQyz run.

## Real ProQyz Workflow

The tool mirrors the real ProQyz flow:

1. **Create quiz** — click "New quiz" on My Quizzes, fill the create
   modal (title, description, quiz type, time), Create.
2. **Add passages** — one at a time. Do not add questions before
   passages exist.
3. **Add questions per passage** — open the question editor, fill the
   content (with `{answer}` placeholder for `fill_up` / `select`; with
   options list for `radio` / `checkbox`), mark the correct answer(s),
   save, return to the list.
4. **Tool pauses** and prints the review URL. Publishing is a separate
   explicit step — by you, in the browser.

## Quick Start

```bash
npm install
npx playwright install chromium
cp .env.example .env
# edit .env: set PROQYZ_BASE_URL to your ProQyz instance

# First run — log in manually when prompted
node bin/upload.js fixtures/cam17-reading-test01-passage1.json

# Subsequent runs reuse the saved session
node bin/upload.js fixtures/cam17-reading-test01-passage1.json
```

## CLI

```bash
node bin/upload.js <path-to-quiz.json> [options]

Options:
  --dry-run              Record intended actions without clicking.
  --fresh                Ignore any existing checkpoint; start over.
  --publish              Print review URL and instruct to publish.
  --skip-review          Skip the human review pause (CI use).
  -h, --help             Show help.
```

---

## JSON Contract (the single source of truth)

The uploader must accept **any** valid IELTS JSON. Cam17 is one
fixture; the schema is not bound to it.

### Top-level shape

```ts
{
  title:     string,                    // required
  quizType:  "reading" | "listening",   // default: "reading"
  time:      integer (minutes),         // default: 60 (reading), 30 (listening)
  status:    "draft" | "published",     // default: "draft"
  source?:   { name: string, url: string },   // provenance
  passages:  [ { title, content, questions: [...] }, ... ]   // reading
  // OR
  sections:  [ { title, questions: [...] }, ... ]            // listening
}
```

`timeLimit` is now `time`. The "Default Options" dropdown is described
by stable codes (see below). Questions are **nested inside each
passage** — there is no top-level `questions` array.

### Field reference

| Field          | Where              | Notes |
|----------------|--------------------|-------|
| `title`        | quiz, passage, option | non-empty string |
| `quizType`     | quiz               | `"reading"` or `"listening"` |
| `time`         | quiz               | minutes; `60` for reading, `30` for listening |
| `status`       | quiz               | default `"draft"`; tool never auto-publishes |
| `source`       | quiz (optional)    | `{ name, url }` for provenance |
| `passages[]`   | reading quiz       | one entry per passage |
| `passages[].title` / `content` | passage | non-empty string |
| `passages[].questions[]` | passage | nested questions for THIS passage only |
| `sections[]`   | listening quiz     | (Phase 3) |
| `number`       | question           | 1-based, contiguous within a passage, starts at 1 |
| `ieltsType`    | question           | 1 of 13 IELTS Reading types |
| `proqyzType`   | question           | 1 of 4 ProQyz editor types |
| `defaultOptions` | question (select only) | 1 of 7 stable codes |
| `content`      | question           | HTML; for fill_up/select, must contain exactly one `{answer}` placeholder |
| `answer`       | question (radio, fill_up, select) | single answer — label for radio, placeholder text for fill_up/select |
| `answers`      | question (checkbox only) | array of correct option labels |
| `options[]`    | question (radio, checkbox only) | `{ label, text }` |

### `proqyzType` values (4)

- `fill_up`   — used for note / sentence / summary / table / flow-chart / short-answer completion
- `select`    — used for T/F/NG, Y/N/NG, matching headings, matching information, matching features
- `radio`     — multiple choice, single answer
- `checkbox`  — multiple choice, multiple answers

### `ieltsType` values (13)

`note_completion`, `sentence_completion`, `summary_completion`,
`table_completion`, `flow_chart_completion`, `short_answer`,
`true_false_not_given`, `yes_no_not_given`, `matching_headings`,
`matching_information`, `matching_features`,
`multiple_choice_single`, `multiple_choice_multiple`.

### `defaultOptions` codes (7) — for `proqyzType=select` only

| Code                  | Meaning          | Example values |
|-----------------------|------------------|----------------|
| `roman_lower`         | Small Roman      | i, ii, iii, iv |
| `roman_upper`         | Capital Roman    | I, II, III     |
| `capital_letters`     | Capital A/B/C    | A, B, C, D     |
| `lowercase_letters`   | Small a/b/c      | a, b, c, d     |
| `numeric`             | Numeric          | 1, 2, 3, 4     |
| `true_false_not_given`| T/F/NG           | TRUE, FALSE, NOT GIVEN |
| `yes_no_not_given`    | Y/N/NG           | YES, NO, NOT GIVEN |

These are **stable codes**; the human-readable label shown in the
"Default Options" dropdown is a presentation concern. The uploader
maps each code to the correct ProQyz value via
`defaultOptionsToSelectValue()`.

### Valid examples

**fill_up** (note_completion)

```json
{
  "number": 1,
  "ieltsType": "note_completion",
  "proqyzType": "fill_up",
  "content": "<strong>1</strong> The {population} of London increased rapidly.",
  "answer": "population"
}
```

**select** (true_false_not_given)

```json
{
  "number": 7,
  "ieltsType": "true_false_not_given",
  "proqyzType": "select",
  "defaultOptions": "true_false_not_given",
  "content": "<strong>7</strong> Other countries had built underground railways first.",
  "answer": "FALSE"
}
```

**radio** (multiple choice, single answer)

```json
{
  "number": 27,
  "ieltsType": "multiple_choice_single",
  "proqyzType": "radio",
  "content": "<strong>27</strong> What is the writer's main point?",
  "options": [
    { "label": "A", "text": "Option A" },
    { "label": "B", "text": "Option B" },
    { "label": "C", "text": "Option C" },
    { "label": "D", "text": "Option D" }
  ],
  "answer": "B"
}
```

**checkbox** (multiple choice, multiple answers)

```json
{
  "number": 35,
  "ieltsType": "multiple_choice_multiple",
  "proqyzType": "checkbox",
  "content": "<strong>35</strong> Choose TWO answers.",
  "options": [
    { "label": "A", "text": "Option A" },
    { "label": "B", "text": "Option B" },
    { "label": "C", "text": "Option C" },
    { "label": "D", "text": "Option D" },
    { "label": "E", "text": "Option E" }
  ],
  "answers": ["B", "D"]
}
```

### Invalid examples (rejected before Playwright opens)

```jsonc
// Missing brace — content has no {answer} placeholder
{
  "number": 1, "proqyzType": "fill_up", "ieltsType": "note_completion",
  "content": "<strong>1</strong> The population of London grew.",
  "answer": "population"
}
```

```jsonc
// Typo — placeholder text differs from answer (case-insensitive comparison)
{
  "number": 1, "proqyzType": "fill_up", "ieltsType": "note_completion",
  "content": "<strong>1</strong> The {popluation} of London grew.",
  "answer": "population"
}
```

```jsonc
// Multiple braces — content has more than one {answer}
{
  "number": 1, "proqyzType": "fill_up", "ieltsType": "note_completion",
  "content": "{population} ... {population}",
  "answer": "population"
}
```

```jsonc
// select without defaultOptions
{
  "number": 7, "proqyzType": "select", "ieltsType": "true_false_not_given",
  "content": "{TRUE}", "answer": "TRUE"
}
```

```jsonc
// radio without options
{
  "number": 27, "proqyzType": "radio", "ieltsType": "multiple_choice_single",
  "content": "?", "answer": "B"
}
```

```jsonc
// radio: answer not in option labels
{
  "number": 27, "proqyzType": "radio", "ieltsType": "multiple_choice_single",
  "content": "?", "options": [{"label":"A","text":"a"},{"label":"B","text":"b"}],
  "answer": "Z"
}
```

```jsonc
// checkbox using answer (singular) instead of answers (array)
{
  "number": 35, "proqyzType": "checkbox", "ieltsType": "multiple_choice_multiple",
  "content": "?", "options": [...], "answer": "A,B"
}
```

### Full valid example

```json
{
  "title": "Cam 17 Reading Test 01",
  "quizType": "reading",
  "time": 60,
  "status": "draft",
  "source": {
    "name": "IELTS Training Online",
    "url": "https://ieltstrainingonline.com/practice-cam-17-reading-test-01-with-answer/"
  },
  "passages": [
    {
      "title": "Passage 1",
      "content": "...",
      "questions": [
        {
          "number": 1,
          "ieltsType": "note_completion",
          "proqyzType": "fill_up",
          "content": "<strong>1</strong> The {population} of London increased rapidly.",
          "answer": "population"
        },
        {
          "number": 7,
          "ieltsType": "true_false_not_given",
          "proqyzType": "select",
          "defaultOptions": "true_false_not_given",
          "content": "<strong>7</strong> Other countries had built underground railways first.",
          "answer": "FALSE"
        },
        {
          "number": 27,
          "ieltsType": "multiple_choice_single",
          "proqyzType": "radio",
          "content": "<strong>27</strong> What is the writer's main point?",
          "options": [
            { "label": "A", "text": "..." },
            { "label": "B", "text": "..." },
            { "label": "C", "text": "..." },
            { "label": "D", "text": "..." }
          ],
          "answer": "B"
        },
        {
          "number": 35,
          "ieltsType": "multiple_choice_multiple",
          "proqyzType": "checkbox",
          "content": "<strong>35</strong> Choose TWO answers.",
          "options": [
            { "label": "A", "text": "..." },
            { "label": "B", "text": "..." },
            { "label": "C", "text": "..." },
            { "label": "D", "text": "..." },
            { "label": "E", "text": "..." }
          ],
          "answers": ["B", "D"]
        }
      ]
    }
  ]
}
```

---

## Architecture

Three layers, each independently testable:

```
┌─ Input layer ─────────┐
│  jsonInput.js          │  Zod-validated Quiz
│  rawTextParser.js (P2) │
└────────┬──────────────┘
         ▼
┌─ Domain layer ────────┐
│  schemas.js            │  Zod schemas (IELTS + ProQyz dual types)
│  normalize.js          │  Trim, sort, dedupe, case rules
│  invariants.js         │  Per-passage semantic checks
└────────┬──────────────┘
         ▼
┌─ Uploader layer ──────┐
│  QuizUploader.js       │  Interface
│  ui/UiQuizUploader.js  │  Playwright driver
│  ui/selectors.js       │  Central selector map
│  ui/editorStrategies.js│  Plain textarea writer
│  ui/radioStrategy.js   │  Radio + checkbox correct-answer logic
│  ui/checkpoint.js      │  Resume state
└────────────────────────┘
```

## Folder Structure

```
src/
  config.js             Base URL, paths, timeouts
  logger.js             pino structured logging
  domain/               Pure schemas + normalization
  input/                JSON loader, raw-text parser (P2), listening input (P3)
  session/              Login + storageState
  uploader/             The only layer that touches ProQyz
    ui/                 Playwright driver + helpers
bin/upload.js           CLI entry
fixtures/               Live fixtures (cam17 passage 1 is MVP-0)
  legacy/               Pre-recon MVP-0/MVP-1 fixtures (historical)
scripts/
  inspect-proqyz.js     Phase 0 recon
  validate-fixtures.js  Validates every fixture against the schema
tests/
  unit/                 Schema/normalize tests
  e2e/                  Dry-run smoke test (no real ProQyz)
  fixtures/             Local stub ProQyz HTML
checkpoints/            Per-quiz resume state
failures/               Screenshots + HTML dumps on error
```

## Roadmap

- **Phase 0 (done):** Recon. Real workflow captured.
- **Phase 1 (now):** Reading MVP. Scaffolded; first real run pending
  per-question-editor selector refinement.
- **Phase 2:** Raw-text parser for all IELTS Reading types.
- **Phase 3:** Listening + bulk folder upload.
- **Phase 4 (future):** API mode (only if confirmed), local web UI.
