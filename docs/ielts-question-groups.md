# IELTS Reading Question Groups — Research

**Scope.** This is a research deliverable. **No code was modified.**
It documents how the five "completion" question types in the
project's schema — note completion, summary completion, table
completion, flow-chart completion, and diagram completion — should
be represented in the JSON contract **before** they reach the
uploader.

The investigation was triggered by the assertion that

> "Questions 1-6 should become **ONE** fill_up question with six
> placeholders, not six separate questions."

That assertion is a design call, not a Cambridge answer-key call.
The research below is the evidence used to evaluate it, and the
final recommendation is grounded in **what the live code, the
schema, and the published IELTS conventions actually require** —
not in the assertion alone.

---

## 1. What constitutes one IELTS question group

An IELTS Reading "group" is an **authoring / display** concept, not
a scoring concept. It is defined by the test booklet in three
parts:

1. **A shared instruction line.** The first line above the group,
   e.g.
   - *"Questions 1-6. Complete the notes below. Choose ONE WORD
     ONLY from the passage for each answer."*
   - *"Questions 7-13. Do the following statements agree with the
     information in the passage? Write TRUE, FALSE or NOT GIVEN."*
   - *"Complete the table below. Choose NO MORE THAN TWO WORDS
     from the passage for each answer."*
2. **A shared visual block** (notes, summary box, table, flow
   chart, or labelled diagram) where the **blanks are numbered
   1..N** in line with the question stem.
3. **A shared answer constraint** (one word only, no more than two
   words, etc.) and often a shared word limit.

**The Cambridge answer key lists the answers per question number,
not per group.** For an N-blank group the key reads:

```
1  population
2  suburbs
3  businessmen
4  funding
5  press
6  soil
```

Each blank is **scored independently**. From the test-taker's
point of view it is one block of work; from the test engineer's
point of view it is N separate items that all happen to share a
visual and an instruction.

The completion family per the project's
`IeltsQuestionTypeSchema` (`src/domain/schemas.js:55-69`):

| `ieltsType` | Common blanks | Diagram on page | Group label |
|---|---|---|---|
| `note_completion`         | 3-6 | notes block             | "Notes" |
| `summary_completion`      | 4-8 | prose block / box       | "Summary" |
| `table_completion`        | 4-7 | grid (rows × cols)      | "Table" |
| `flow_chart_completion`   | 3-6 | boxes + arrows          | "Flow chart" |
| `short_answer` (related)  | 1-3 | prose                   | n/a — usually free-form, one stem |

(Diagram labelling is in the **matching** family per Cambridge
classification, not the completion family, but the project lumps
it under fill-up because each label is a typed answer.)

---

## 2. How many ProQyz questions should be created?

**Recommendation: N, not 1.** The two pieces of load-bearing
evidence are in the live code:

### 2.1 The schema already enforces 1 question = 1 blank

`src/domain/schemas.js:278-296` (fill-up branch of the
`QuestionSchema.superRefine`):

```js
if (q.proqyzType === "fill_up") {
  const braces = q.content.match(/\{([^}]+)\}/g) ?? [];
  if (braces.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: `content must contain exactly one {answer} placeholder (found ${braces.length})`,
    });
  } else if (hasAnswer) {
    const inside = braces[0].slice(1, -1);
    const want = String(q.answer).trim();
    if (inside.trim().toUpperCase() !== want.toUpperCase()) {
      ctx.addIssue({ ... message: `placeholder "${braces[0]}" must match answer "${want}" (case-insensitive, whitespace-trimmed)` });
    }
  }
}
```

The schema **rejects** any content with zero or more than one
`{...}` placeholder for `fill_up`, and binds the **single**
placeholder's inner text to a single `answer` string. The check
"braces.length === 1" is a hard Zod failure today; fixtures with
two-or-more blanks in one content blob do not parse.

### 2.2 The orchestrator and the uploader interface both treat one question as one call

- `QuizUploader.addQuestion(q, ...)` is called **per question** from
  `src/pipeline/run.js:160-185`, with per-question checkpoint
  records (`recordQuestion(cp, { number, id, passageIndex })`).
  One upload call → one ProQyz record → one scoring line.
- The `QuestionHandle` (`QuizUploader.js:17-21`) has a single
  `number` and a single `id`; there is no API for
  `addQuestionGroup(group, ...)`.
- The fill-up strategy (`UiQuizUploader._fillFillUpQuestion`)
  writes the **single content blob** into TinyMCE and saves
  exactly one ProQyz question.
- The checkpoint dedup loop
  (`run.js:164`: `if (cp.questions.find((cq) => cq.number === q.number && cq.passageIndex === pIdx))`)
  requires one ProQyz record per `q.number`; collapsing 6 blanks
  into 1 ProQyz record would orphan 5 of the 6 expected
  checkpoint rows.

### 2.3 The published IELTS convention is also N

- Cambridge answer keys list N answers per group, each on its
  own line.
- Most commercial IELTS item banks (Cambridge, IDP, Road to
  IELTS, Magoosh, IELTS Liz) export groups as N items with a
  shared `instruction` field.
- Cloze-deletion LMSes (Moodle `CLOZE`, Canvas, TAO, Questionmark)
  **can** model N blanks as one scored item, but in every one
  of those systems the author still has to *enumerate* the
  answers (e.g. Moodle CLOZE uses `{:MULTICHOICE:=A~=B}` per
  blank, with one sub-cloze per blank; partial credit is
  configurable but each blank is its own sub-item). Modelling
  "one question = N blanks" is possible; modelling "one
  question = N blanks with one *single* correct answer that
  depends on which blank the test-taker is filling" is not
  how cloze works — the answer is per-blank by construction.

### 2.4 The user's example — what it would take to make it work

Collapsing 6 blanks into 1 ProQyz question would require:

1. **Schema change** — drop the
   `braces.length === 1` check; allow
   `0..N` braces; bind brace N's inner text to `answers[N]`
   (a new array field on fill-up). This is a non-trivial
   change that affects every existing fill-up fixture
   (the live cam17 fixture, the 3 new example fixtures,
   and the validation tests).
2. **Uploader change** — write all braces into one TinyMCE
   content, and somehow set N correct answers on one ProQyz
   record. ProQyz's fill-up editor currently exposes **one**
   correct-answer field per question (per the recon
   comment in `selectors.js:243-245`: "the per-question
   editor selectors are still best-guess and will be
   refined on the next real ProQyz run"). Even if the
   editor accepts N braces, scoring them as N independent
   answers is **not** a documented feature of the editor.
3. **Orchestrator change** — the `addQuestion(q, ...)` API
   and the checkpoint loop are both 1:1 with ProQyz
   records. Changing to 1:N means restructuring
   `QuizUploader` and the checkpoint dedup.
4. **IELTS scoring** — collapse 6 marks into 1. The
   official IELTS band-score conversion is per-correct-blank
   (40 questions in 60 minutes = 40 marks). Collapsing
   changes the test's psychometric properties.

Items 1, 2, and 3 are doable; item 4 is a **semantic** change
to the test, not a data-shape choice. **The project is a
content uploader, not a test-design tool.** The project's
purpose is to *transcribe* an IELTS test into ProQyz, not to
*rescore* it. Collapsing would change the test's scoring
shape and is out of scope for an automation tool.

---

## 3. How placeholders should be represented

Given the recommendation in §2 (N questions, not 1), the
placeholder representation question is actually: **how should
the blank-marker live inside `content` for fill-up questions?**

There are two viable encodings. Both are compatible with the
current schema; the project already uses **Encoding A**.

### 3.1 Encoding A — one `{answer}` per content, in a prose-rich HTML blob

This is what the live code does today, and what the live cam17
fixture shows:

```json
{
  "number": 1,
  "ieltsType": "note_completion",
  "proqyzType": "fill_up",
  "instruction": "Questions 1-6. Complete the notes below. Choose ONE WORD ONLY from the passage for each answer.",
  "content": "<strong>1</strong> The {population} of London increased rapidly between 1800 and 1850.",
  "answer": "population"
}
```

The question number is **rendered** as part of the content
(`<strong>1</strong>`). The blank is `{population}` and the
`answer` field is the same string. The braces are typed into
the TinyMCE iframe via `insertText` (the keyboard pipeline
that bypasses MathJax) — see
`UiQuizUploader.js:1244` and the comment at line 91-95 in
`editorStrategies.js`.

**Pro:** the content reads naturally, matches the printed
booklet, and TinyMCE happily passes braces through (we have
the read-back assertion in
`editorStrategies.verifyReadback`).

**Con:** the content and the answer are two parallel
representations of the same fact and must be kept in sync
(enforced by Zod at
`schemas.js:286-296`).

### 3.2 Encoding B — a leading `N. ` instead of inline number, brace as the only marker

Same shape, but the question number lives in the Finish-tab
**Title** field (`Question N`) and is **not** part of the
content. The current Select flow does this — see
`UiQuizUploader.js:1497-1501`:

```js
// Strip the leading "N " prefix from the content; the
// Question tab on Select doesn't need it (the question
// number is in the Title field on the Finish tab).
const text = String(q.content || "").replace(/^\d+\s+/, "");
await page.keyboard.insertText(text);
```

This works for Select, where the answer is picked from a
dropdown, but it has not been wired up for Fill-up — the
existing fill-up code writes the content verbatim with the
`<strong>N</strong>` prefix intact
(`UiQuizUploader.js:1244`).

**Pro:** cleaner separation — content is a string of prose with
braces, the number is metadata.

**Con:** does not match the printed booklet, and any visual
display that renders the question content directly
(preview, PDF export, review) loses the question number.

### 3.3 Encoding C — per-blank short form (NOT recommended, listed for completeness)

Some authoring tools let the author write a stem once and list
blanks as a flat table. This would require a schema change
(separate `blanks[]` array with `{ index, answer }`). The
project deliberately keeps the stem in `content` so the
TinyMCE write is a single string; introducing a parallel
representation adds duplication for no clear gain.

### 3.4 Recommendation

**Keep Encoding A.** It is what the live code does, what the
fixtures use, and what the schema enforces. The braces-in-HTML
representation matches the printed booklet and makes the
fixture diffable against a paper source.

If a future pass wants Encoding B for fill-up (so the title
field is the sole source of truth for the number), the
change is a one-line addition in `_fillFillUpQuestion`
mirroring the Select strip, plus a fixture edit. It is
**not** a schema change.

---

## 4. The real gap: shared `instruction` is duplicated N times

The current fixture is verbose in a way that matters for
maintainability:

```
"instruction": "Questions 1-6. Complete the notes below. Choose ONE WORD ONLY from the passage for each answer.",
```

…appears on **all 6** of questions 1-6, and again on **all 7**
of questions 7-13. If the test-setter edits the wording, the
author must edit 6 (or 7) places in lockstep or the
`rawTextParser` (Phase 2) will detect different instructions
and likely fail to dedupe.

**Options for handling the shared instruction**, in order of
least-to-most invasive:

1. **No change.** Authors copy/paste the same string. Simple
   but error-prone.
2. **Passage-level `instructions[]`.** Add
   `passage.instructions: { "1-6": "...", "7-13": "..." }`
   and have the loader **expand** it onto each question's
   `instruction` field at parse time. The shape on disk is
   cleaner; the in-memory shape is identical to today; the
   uploader and orchestrator don't change.
3. **Group-level field on the question.** Add an optional
   `group: { id: "q1-6", range: [1, 6] }` to each question;
   the loader validates that all questions with the same
   `group.id` share an `instruction` and a contiguous range.
   Most expressive, most surface area to maintain.

**Recommendation: option 2.** The duplication is the only
real problem; option 2 is a loader-only change. Until the
`rawTextParser` (Phase 2) ships, option 2 is the smallest
delta that helps.

---

## 5. Recommended JSON schema for the five completion types

The **current** schema (`schemas.js`) is **already correct** for
representing N blanks as N fill-up questions with a shared
instruction. The only change worth making is the
**passage-level** instruction expansion in §4. The full
recommended shape:

```jsonc
{
  "quizTitle": "...",
  "quizType": "reading",
  "time": 60,
  "status": "draft",
  "passages": [
    {
      "title": "Reading Passage 1",
      "content": "<p>...the passage text...</p>",

      // OPTIONAL: shared instructions keyed by question-number
      // range. The loader expands them onto each question's
      // `instruction` field at parse time. If absent, the
      // question-level `instruction` is the source of truth
      // (current behaviour).
      "instructions": {
        "1-6":  "Complete the notes below. Choose ONE WORD ONLY from the passage for each answer.",
        "7-13": "Do the following statements agree with the information in the passage? Write TRUE, FALSE or NOT GIVEN."
      },

      "questions": [
        // One entry per blank. NOT one entry per group.
        // Numbers contiguous from 1, in the order they
        // appear in the printed booklet.
        { "number": 1, "ieltsType": "note_completion", "proqyzType": "fill_up",
          "instruction": "Complete the notes below. Choose ONE WORD ONLY from the passage for each answer.",
          "content": "<strong>1</strong> The {population} of London increased rapidly between 1800 and 1850.",
          "answer": "population", "questionTypeIndex": 0 },
        { "number": 2, "ieltsType": "note_completion", "proqyzType": "fill_up",
          "instruction": "...",
          "content": "<strong>2</strong> Many people moved out to the {suburbs} in search of better housing.",
          "answer": "suburbs", "questionTypeIndex": 0 },
        // ...
        { "number": 7, "ieltsType": "true_false_not_given", "proqyzType": "select",
          "defaultOptions": "true_false_not_given",
          "instruction": "Do the following statements agree with the information in the passage? Write TRUE, FALSE or NOT GIVEN.",
          "content": "<strong>7</strong> Other countries had built underground railways before the Metropolitan line opened.",
          "answer": "FALSE", "questionTypeIndex": 2 },
        // ...
      ]
    }
  ]
}
```

### 5.1 Type-by-type notes

#### Note completion (`ieltsType: "note_completion"`, `proqyzType: "fill_up"`)

- N fill-up questions, one per numbered blank.
- Content is a single prose block with N `{answer}` braces
  is **not** how the project represents it. Each question's
  content is its **own** sentence (or table cell, in the
  case of table completion) with exactly one brace.
- This is the live cam17 pattern.

#### Summary completion (`ieltsType: "summary_completion"`)

- Same as note completion: N fill-up questions, one per
  numbered blank in the summary block.
- If the summary is a single prose paragraph, the
  *author*'s view may look like one block, but on disk it
  is N entries. The author can put the full paragraph in
  the **passage's** notes/summary if they want a
  single-string source (not currently a field on the
  schema — see §6 open questions).
- For the *summary with a word bank* variant (a list of
  words to choose from), the per-blank shape still works:
  the content for each blank can include the bank as a
  hint comment, and the answer is one of the bank words.

#### Table completion (`ieltsType: "table_completion"`, `proqyzType: "fill_up"`)

- One fill-up question per numbered cell. The cell is
  represented as a one-line `content` per question (since
  there is no real schema field for "this is a table").
- **The visual table is the passage author's job, not the
  uploader's.** The uploader faithfully types each blank
  in turn; whether they sit in a table on the final
  rendered page is a presentation concern of the host
  system (ProQyz's `Preview` tab).
- If a future pass wants to carry the table's row/column
  structure, see §6.

#### Flow-chart completion (`ieltsType: "flow_chart_completion"`, `proqyzType: "fill_up"`)

- Same as table completion. One fill-up per blank inside a
  box. Boxes and arrows are visual — the schema carries
  prose-only content.
- The image (if the flow chart is an image with text
  overlays) is not currently representable in the schema.
  See §6.

#### Diagram completion (`ieltsType: "diagram_labelling"`, `proqyzType: "fill_up"`)

- One fill-up per numbered label on the diagram.
- The diagram image is not in the schema today
  (`PassageSchema` has no `images` field that is read by
  the uploader — only `title`, `content`, `questions`).
- The existing `images: z.array(z.string().url()).optional()`
  in `PassageSchema` (`schemas.js:306`) is declared but
  unused by the uploader.

### 5.2 Why one question per blank, not per group — the summary

| Concern | Per-blank (N) | Per-group (1) |
|---|---|---|
| Matches Cambridge answer key | ✅ | ❌ |
| Matches the schema (`braces.length === 1`) | ✅ | ❌ — requires schema change |
| Matches `addQuestion` checkpoint dedup | ✅ | ❌ — requires orchestrator change |
| Matches IELTS scoring (1 mark per blank) | ✅ | ❌ — collapses N marks into 1 |
| Matches the printed booklet's N numbered blanks | ✅ | ❌ — would need ProQyz to render the numbers, which it doesn't |
| Carries through a future API uploader (Phase 4) cleanly | ✅ | ❌ — most LMS-style APIs (REST, GraphQL) model items 1:1 |
| Survives a future "publish to LMS" step | ✅ | ❌ — most LMS cloze imports want per-blank sub-items anyway |

The per-group approach is appealing as a paperwork-reduction
device — fewer rows in the JSON — but every layer downstream
of the JSON would need to change, and the resulting quiz would
not score the same way in ProQyz. **It is a refactor of the
test, not of the data.**

---

## 6. Open questions / things to confirm in a future recon

1. **ProQyz fill-up brace semantics.** The `selectors.js`
   header (line 26-29) marks every per-question-editor
   selector as "PHASE-1 BEST GUESS". The
   "Use { } brackets" text is in the source code as a
   *probe* of the Question tab (line 1181), not as a
   confirmed fact. Until the type-pick step works
   end-to-end and the Question tab is captured, we don't
   know with certainty whether ProQyz accepts one brace
   per question (per the schema) or many (per the user's
   assertion). The recon dumps in
   `failures/2026-06-09T08-09-09-*.html` are all from the
   type-pick step (the modal stuck on Basic tab); none
   captured the Question tab.
2. **Diagram / table images.** `PassageSchema.images` exists
   but is unused. Adding image support to the uploader is
   not in scope for Phase 1.
3. **Word-bank (summary with a list).** A future
   `defaultOptions`-style extension for fill-up would let
   the author attach a word bank; ProQyz would render it
   below the question. Not currently supported.
4. **Per-question numbering in `content`.** Encoding A
   (live) uses `<strong>N</strong>` in the content;
   Encoding B (Select) uses the Finish-tab Title field.
   The two are not consistent across the four types today.
5. **Group metadata.** §4 option 2 (passage-level
   `instructions`) is a one-screen loader change but it has
   not been specified in detail. Open as a Phase 2 item
   alongside the raw-text parser.

---

## 7. TL;DR

- **An IELTS group is an authoring convention, not a
  ProQyz/score unit.** Each numbered blank is its own
  ProQyz question, scored independently.
- **Keep N questions per group.** Collapsing to 1 would
  require schema, orchestrator, and uploader changes,
  change the test's scoring shape, and is out of scope for
  a content-uploader tool.
- **Keep Encoding A** (one `{answer}` per question, question
  number inside the content). It is what the live code,
  the live fixture, and the schema all expect.
- **The only real wart** is that the shared `instruction`
  string is duplicated N times. The recommended fix is a
  passage-level `instructions` map (§4 option 2), expanded
  by the loader onto each question — a loader-only change.
- **Open items** (§6): confirm ProQyz's brace semantics on
  the next real run; add image support for diagrams/flow
  charts in a later phase; consider Encoding B for fill-up
  (one-line change in `_fillFillUpQuestion`).
