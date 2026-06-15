# ProQyz IELTS Automation

## Overview
Playwright-based automation for ProQyz (React SPA) — creates quizzes, passages, questions, and uploads explanations via browser automation.

## Architecture
- **3-layer pipeline**: Input (schema + loader) → Domain (transformation) → Uploader (Playwright driver)
- **Mode dispatch**: `full` (create quiz), `questionsOnly` (add questions to existing), `explanation` (fill explanations on existing)
- **Entry points**: `node bin/upload.js <file> --fresh|--explanation`, or web UI via `node local-tool-server.js` on port 8000

## Key Files
| File | Role |
|------|------|
| `bin/upload.js` | CLI entry — parses args, dispatches to `runQuiz` or `runExplanation` |
| `local-tool-server.js` | HTTP server for web UIs (`localInput.html`, `explanationInput.html`) |
| `src/pipeline/runQuiz.js` | Full quiz creation pipeline |
| `src/pipeline/runExplanation.js` | Explanation upload pipeline (search quiz → Questions tab → open question → fill explanations → save) |
| `src/uploader/ui/UiQuizUploader.js` | Playwright driver — all browser interactions |
| `src/uploader/ui/selectors.js` | CSS/XPath selectors for ProQyz DOM elements |
| `src/domain/explanationSchema.js` | Zod schema for explanation JSON |
| `src/input/explanationLoader.js` | Loads + validates explanation JSON files |
| `src/input/explanationInput.html` | Web UI for explanation upload |
| `src/input/localInput.html` | Web UI for full quiz creation |

## ProQyz DOM Facts (critical — do not guess)
- **Sidebar nav**: `div.subchild[type="button"]` — click `.subchild` containing target text. Active = `.subchild.active`
- **Top nav tabs**: `ul.nav.nav-stretch > li > a` — NOT the primary nav on Edit Quiz page
- **Question list rows**: `div.card__hover` with `a > i.fa-pencil` as edit button
- **Passage picker**: `select.form-select` with `option value="not-selected"` default. Single-passage quizzes do NOT render this — passage is implicitly bound
- **Add Question button**: `button:has-text("Add Question")` — visible = Questions tab loaded, passage bound
- **Edit modal**: React modal with `.modal.show`, `.question__components`, TinyMCE iframes for editors

## Running Tests
```bash
node --test tests/unit/explanationSchema.test.js   # 32 tests, should all pass
```

## Running Upload
```bash
node local-tool-server.js          # starts on :8000, opens browser to web UI
node bin/upload.js generated/latest-quiz.json --explanation   # CLI explanation upload
```

## Rules
- Do NOT modify existing quiz/passage/question creation flows when working on explanation feature
- Do NOT touch unrelated tests
- Inspect real DOM dumps in `failures/` before guessing selectors — never guess ProQyz DOM structure
