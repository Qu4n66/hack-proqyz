# Local Content Input → ProQyz JSON

Three upload modes, all driven from a single JSON file that follows
`src/domain/schemas.js`.

| Mode | Trigger | Use when… |
|---|---|---|
| `full` (default) | no `mode` field in JSON | create quiz + passage + questions end-to-end |
| `questionsOnly` | `mode: "questionsOnly"` + `existingQuizUrl` in JSON | quiz and passage already exist on ProQyz; only add questions |
| `--from-localhost` | CLI flag | the JSON comes from a local server (e.g. `localInput.html`) instead of a file |

The local page (`src/input/localInput.html`) is a single-file HTML
data-entry tool. It produces JSON in the same shape the uploader
consumes. You can:

1. Paste IELTS content in your browser.
2. Click **Generate JSON** to see the live preview.
3. Click **Download .json** to save it.
4. Run `node bin/upload.js <downloaded>.json` to upload.

---

## 1. The local input page

### Open it

Three ways, pick whichever is convenient:

- **File:** double-click `src/input/localInput.html` (it has no
  external deps, so file:// works).
- **Local server (recommended for `--from-localhost`):**
  ```bash
  cd /Users/quanb/Documents/vs/project\ 4
  python3 -m http.server 8000
  # then open http://localhost:8000/src/input/localInput.html
  ```
- **Direct file URL in the uploader:** if your browser can serve
  `file://` URLs, you can run
  `node bin/upload.js file:///Users/quanb/Documents/vs/project%204/src/input/localInput.html`
  — but `--from-localhost` only works for `http(s)://`, so the server
  path is preferred for the automated flow.

### Sections

1. **Quiz info** — `quizTitle`, `time`, `status`, `source.name`,
   `source.url`. Default values match the Cambridge IELTS 17 smoke
   fixture.
2. **Passage** — `title` + `content` (plain text, newlines preserved).
3. **Questions** — dynamic list, one block per question. Add with
   the buttons:
   - `+ Fill-up` — single `{answer}` placeholder, one answer.
   - `+ Radio (single)` — A/B/C/D options, one correct label.
   - `+ Radio (grouped MCQ)` — IELTS "Questions 36-40" shape:
     multiple sub-questions under one ProQyz Radio block.
   - `+ Select (TFNG)` — for true/false/not-given, yes/no/not-given,
     etc.
4. **Mode** — pick `full` or `questionsOnly`. If you pick
   `questionsOnly`, paste the existing quiz's edit URL into
   `Existing quiz edit URL`.
5. **Generate** — `Generate JSON` (live preview), `Download .json`,
   `Copy to clipboard`, `Prettify`.

### Notes on the JSON shape

The page emits the exact shape the uploader consumes. A few details
worth knowing:

- `instruction` is **required** on every question. Empty strings are
  accepted (a question with no instruction is valid), but the field
  is always present.
- For fill-ups with **more than one `{answer}` placeholder**, the
  page automatically emits a grouped shape (`numberStart`,
  `numberEnd`, `answers[]`). The brace text in each placeholder
  must match the corresponding answer in `answers[]` — the
  validator catches this.
- For grouped radio MCQ, the page emits `subQuestions[]` with each
  sub-question's own options and answer. The top-level `options`
  and `answer` are NOT used in this mode.
- The page's `Generate JSON` button is wired to the form's `input`
  events — every keystroke updates the preview.

---

## 2. Mode 1: `full`

Default mode. The JSON omits `mode`, or has `mode: "full"`.

```bash
node bin/upload.js fixtures/cam17-reading-test01-passage1-fresh.json
```

What happens:
1. `loadQuizFromJson` validates against `QuizSchema` and normalizes.
2. Browser opens My Quizzes. Uploader clicks "+ New quiz", fills
   title/time/status/source, and saves.
3. For each passage: opens Add Passage modal, pastes content via
   TinyMCE API, clicks Add Passage, waits for modal to close, then
   verifies the row appears.
4. For each question in each passage: opens Add Question modal,
   picks the question type, fills content + options + answer.
5. Clicks Save. Hands off to the human review pause (or
   `--publish`).

---

## 3. Mode 2: `questionsOnly`

The quiz and the passage already exist on ProQyz. You only need to
add questions. Useful when the createQuiz / addPassage automation
is failing or the passage was inserted manually.

### JSON shape (add to the top of your quiz JSON)

```json
{
  "quizTitle": "Cam 17 Reading Test 01",
  "quizType": "reading",
  "time": 60,
  "status": "draft",
  "mode": "questionsOnly",
  "existingQuizUrl": "https://app.proqyz.com/dashboard/@customer/pro-qyz/edit/<id>",
  "passages": [ ... ]
}
```

`existingQuizUrl` is REQUIRED. The uploader opens this URL,
identifies the existing passage by `passages[0].title`, and runs
the question loop against it.

### CLI

```bash
node bin/upload.js fixtures/local-only-questions.json --questions-only
```

The `--questions-only` flag is a **guard rail**: it checks the JSON
has `mode: "questionsOnly"` and a non-empty `existingQuizUrl`
before opening the browser. It exists to catch typos in CI.

### What it does

1. `loadQuizFromJson` validates, normalizes, sets `mode: "questionsOnly"`.
2. Browser opens `existingQuizUrl` via `openExisting()`.
3. The pipeline records the passage as "already uploaded" in the
   checkpoint (with `preexisting: true`) so the loop does not try
   to recreate it.
4. For each question: opens Add Question modal, picks type, fills
   content + options + answer. The passage picker inside
   `addQuestion` auto-binds to the existing passage by title.
5. **No `save()` call.** ProQyz autosaves after every question add;
   calling save() would just re-trigger autosave and could regress
   into the spinner-stuck path we already debugged.
6. The checkpoint is **kept** (not cleared) so a partial run can
   resume from the last completed question against the same URL.

### Limitations

- The current implementation only supports one existing passage. If
  your quiz has multiple passages and you want to add questions to
  passage 2 or 3, you must manually set the Questions tab's passage
  dropdown after the first add — the uploader does not switch
  passages between question groups.
- The passage title in the JSON must match an existing passage on
  ProQyz. The picker uses title-match, not ID-match.

---

## 4. Mode 3: `--from-localhost`

Fetches the JSON from a local server. Two response shapes are
supported:

- `Content-Type: application/json` — the body IS the JSON.
- `Content-Type: text/html` — the response is the local input page;
  the JSON is extracted from the `<pre id="jsonOut">` element.

### Example (with the local page)

```bash
# Terminal 1: serve the project
cd /Users/quanb/Documents/vs/project\ 4
python3 -m http.server 8000

# Terminal 2: open the page, fill it, click "Generate JSON"
# (the <pre id="jsonOut"> is now populated)

# Then upload:
node bin/upload.js --from-localhost http://localhost:8000/src/input/localInput.html
```

The uploader:
1. Fetches the HTML.
2. Extracts the JSON from `<pre id="jsonOut">`.
3. Writes it to a temp file.
4. Runs the normal pipeline.

### Example (with a custom API)

If you have an API endpoint that returns the uploader-shaped JSON
with the right Content-Type:

```bash
node bin/upload.js --from-localhost http://localhost:8000/api/quizzes/cam17-test01
```

### When to use it

- The data-entry happens in your browser (the local page), not in a
  file editor.
- You want to iterate: edit a field in the page, click
  `Generate JSON`, then re-run the uploader without manually
  saving/downloading.
- You have a custom local API that builds the JSON server-side.

---

## 5. End-to-end recipes

### Recipe A: smoke-test the local page → questionsOnly path

```bash
# 1. Create the quiz and passage manually in ProQyz.
#    (Use the existing radio-smoke-q36-q37 fixture for the title.)
#    Copy the edit URL from your browser.

# 2. Serve the local page.
cd /Users/quanb/Documents/vs/project\ 4
python3 -m http.server 8000 &

# 3. Open http://localhost:8000/src/input/localInput.html in your browser.
#    - Title: "Cam 17 Reading Test 01"
#    - Mode: questionsOnly
#    - existingQuizUrl: <paste the URL you copied>
#    - Click "Generate JSON"

# 4. From the terminal:
node bin/upload.js --from-localhost http://localhost:8000/src/input/localInput.html --questions-only
```

### Recipe B: questionsOnly from a saved JSON

```bash
# 1. Open localInput.html, fill it, click "Download .json".
#    (Or use the existing fixtures/local-input-test.json as a template.)

# 2. Edit the saved JSON to set existingQuizUrl to your real quiz.

# 3. Run:
node bin/upload.js /path/to/your.json --questions-only
```

### Recipe C: full upload from the local page

```bash
# 1. localInput.html — Mode: full. (default)
# 2. Generate JSON. Download.
# 3. node bin/upload.js /path/to/your.json
```

---

## 6. JSON shape cheat-sheet

The validator (`scripts/validate-fixtures.js`) is the source of
truth. Here's a minimal example covering every field the local
page can emit:

```json
{
  "quizTitle": "Cam 17 Reading Test 01",
  "quizType": "reading",
  "time": 60,
  "status": "draft",
  "source": { "name": "IELTS Training Online", "url": "https://..." },

  "mode": "questionsOnly",                     // optional; default "full"
  "existingQuizUrl": "https://app.proqyz.com/.../edit/<id>",  // required iff mode=questionsOnly

  "passages": [
    {
      "title": "Reading Passage 1",
      "content": "The London Underground Railway\n\nA ...",

      "questions": [
        // Grouped fill-up (one ProQyz Fill-up with N placeholders)
        {
          "number": 1,
          "numberStart": 1,                    // optional
          "numberEnd": 6,                      // optional
          "displayTitle": "Questions 1-6",      // optional; auto-derived
          "ieltsType": "note_completion",
          "proqyzType": "fill_up",
          "questionTypeIndex": 0,
          "instruction": "Questions 1-6\n\nComplete the notes below.",
          "content": "The {population} of London\n... the tunnel was covered with {soil}",
          "answers": ["population", "...", "soil"]
        },

        // Single radio
        {
          "number": 7,
          "ieltsType": "multiple_choice_single",
          "proqyzType": "radio",
          "questionTypeIndex": 1,
          "instruction": "Choose the correct letter, A, B, C or D.",
          "content": "What is the reviewer's main purpose?",
          "options": [
            { "label": "A", "text": "to describe what happened during the Battle of Worcester" },
            { "label": "B", "text": "to give an account of the circumstances leading to Charles II's escape" }
          ],
          "answer": "B"
        },

        // Grouped radio MCQ
        {
          "number": 36,
          "numberStart": 36,
          "numberEnd": 37,
          "ieltsType": "multiple_choice_single",
          "proqyzType": "radio",
          "questionTypeIndex": 1,
          "instruction": "Questions 36-37\n\nChoose the correct letter, A, B, C or D.",
          "content": "Questions 36-37\n\nChoose the correct letter, A, B, C or D.",
          "subQuestions": [
            {
              "number": 36,
              "text": "What is the reviewer's main purpose?",
              "options": [
                { "label": "A", "text": "..." }, { "label": "B", "text": "..." }
              ],
              "answer": "B"
            }
          ]
        },

        // Select (TFNG)
        {
          "number": 38,
          "ieltsType": "true_false_not_given",
          "proqyzType": "select",
          "questionTypeIndex": 2,
          "defaultOptions": "true_false_not_given",
          "instruction": "Do the following statements agree with the information in the passage?",
          "content": "38 The Metropolitan line was originally operated using steam-powered trains.",
          "answer": "TRUE"
        }
      ]
    }
  ]
}
```

---

## 7. Troubleshooting

### `--questions-only: JSON does not have mode: "questionsOnly"`

The CLI guard rail fired. Your JSON has `mode: "full"` (or no `mode`
field), but you passed `--questions-only`. Either remove the flag
or set `"mode": "questionsOnly"` in the JSON.

### `--questions-only: JSON is missing existingQuizUrl`

Add `"existingQuizUrl": "https://app.proqyz.com/.../edit/<id>"` to
the JSON. The URL is the quiz's edit page (where you go to add
passages / questions manually).

### `--from-localhost: response is HTML but contains no <pre id="jsonOut">`

You're pointing the flag at a page that isn't the local input
page, or the page hasn't been "Generate JSON"d yet (the `<pre>` is
empty until the button is clicked). Open the page in your browser,
click Generate JSON, then run the command.

### `questionsOnly mode requires an "existingQuizUrl" field in the JSON`

You set `mode: "questionsOnly"` but didn't include the URL. Add it.

### Passage picker fails to bind to the existing passage

The JSON's `passages[0].title` must EXACTLY match the title of the
passage on ProQyz. If you created the passage manually with a
different title, update the JSON to match (or rename on ProQyz).

### Uploader says it succeeded but no questions appear in ProQyz

Two common causes:
1. The Questions tab was on a different passage. Open the quiz in
   your browser, switch to the right passage, refresh.
2. The uploader was on a stale edit page. Reload the page and check
   again — ProQyz autosaves per question, so the change should be
   visible after a hard refresh.

---

## 8. Files touched

- `src/input/localInput.html` — new. The data-entry page.
- `src/domain/schemas.js` — added `mode` + `existingQuizUrl` to
  `ReadingQuizSchema`. Optional, default-absent.
- `src/domain/normalize.js` — propagate `mode` + `existingQuizUrl`
  through `normalizeQuiz`. Defaults `mode` to `"full"`.
- `src/pipeline/run.js` — dispatch on `quiz.mode === "questionsOnly"`.
  In questionsOnly mode: skip createQuiz + addPassage, skip save(),
  keep checkpoint.
- `bin/upload.js` — added `--from-localhost <url>` and
  `--questions-only` flags. `fetchFromLocalhost()` helper.
- `fixtures/local-input-test.json` — new. Reference shape for
  questionsOnly mode.
- `docs/local-input-workflow.md` — this file.

### Files NOT touched

- `src/uploader/ui/UiQuizUploader.js` — `openExisting` already
  supports opening by URL. `_selectPassageInQuestionsTab` already
  auto-binds to a single existing passage. No changes needed.
- `src/uploader/ui/radioStrategy.js` — radio engine untouched.
- `src/uploader/ui/editorStrategies.js` — fill-up / content paste
  engine untouched.
- `src/uploader/ui/checkpoint.js` — checkpoint format unchanged;
  questionsOnly just adds `preexisting: true` to the passage entry
  for documentation.
