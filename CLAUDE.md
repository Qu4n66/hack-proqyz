# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
| `src/session/auth.js` | Authentication — auto-login + manual login + storageState |

## ProQyz DOM Facts (critical — do not guess)
- **Sidebar nav**: `div.subchild[type="button"]` — click `.subchild` containing target text. Active = `.subchild.active`
- **Top nav tabs**: `ul.nav.nav-stretch.nav-line-tabs > li > a` — NOT the primary nav on Edit Quiz page
- **Active tab detection**: `classList.contains("active")` NOT `className.includes("active")` (the latter matches `"text-active-primary"`)
- **Question list rows**: `div.card__hover` with `div.fs-5.text-dark.fw-bold` containing range text. Edit button: `<button class="btn btn-sm btn-light-primary btn-icon btn-link"><i class="fa fa-pencil"></i></button>` — it's a `<button>`, NOT `<a>`
- **Passage picker**: `select.form-select` with `option value="not-selected"` default. Single-passage quizzes do NOT render this — passage is implicitly bound
- **Add Question button**: `button:has-text("Add Question")` — visible = Questions tab loaded, passage bound
- **Edit modal**: React modal with `.modal.show`, `.question__components`, TinyMCE iframes for editors
- **Explanation modal tabs**: `<ul class="tablist"><li class="tabs tab-active">Explanation</li>` inside `.question__components.modal.show`
- **Explanation cards**: `<div class="col-md-12 mb-4"><div class="card shadow-sm"><div class="card-header collapsible"><label for="explanation-N" class="required">N. Explanation</label>...<textarea id="tiny-react_XXX" style="display:none">` + TinyMCE `<div class="tox tox-tinymce" style="visibility: hidden; height: 300px;">`
- **TinyMCE API**: `tinymce.get(textareaId)` targets specific editor instance (NOT `tinymce.activeEditor` which targets the focused one)
- **`contentFrame()` is synchronous**: returns `Frame | null`, NOT a Promise
- **Search input**: `<input placeholder="Search Quiz">` with adjacent `<span id="basic-addon2">` search icon button

## Auto-Login Support
The explanation upload supports automatic login. Credentials flow through:
1. UI checkbox + email/password fields → POST `/api/upload` → `_autoLogin` in JSON
2. Pipeline reads `_autoLogin` from JSON file → uses credentials for Playwright login → scrubs from disk

**Security**: Password is read from JSON, used in memory, then immediately deleted from disk. Never saved to storageState, logs, or config files.

**Data flow**:
- `local-tool-server.js` strips `_autoLogin` from the JSON written to disk, passes `--auto-login`, `--email`, `--password` as CLI args to child process
- `bin/upload.js` sets `process.env.PROQYZ_AUTO_LOGIN` / `PROQYZ_LOGIN_EMAIL` / `PROQYZ_LOGIN_PASSWORD` from CLI flags
- `runExplanation.js` reads credentials first from the raw JSON file (Strategy A), falls back to env vars (Strategy B), then scrubs from disk immediately

**Auth selectors** (ProQyz login page):
- Email: `input[placeholder*="email" i], input[type="email"], input[name*="email" i]`
- Password: `input[placeholder*="password" i], input[type="password"]`
- Submit: `button:has-text("Signin with Email"), button:has-text("Sign in"), button[type="submit"]`
- Login success: URL contains `/dashboard` OR body contains "my quizzes", "import quiz", "quiz library"

## Explanation Upload — Single Group Mode
The uploader processes exactly one questionGroup per upload. Throws if JSON contains more than one group.

**Pipeline flow**:
1. Search/open quiz (shortcuts if already on edit page)
2. Click Questions tab → select passage → verify question list
3. Open question for edit (geometric Y-coordinate matching on pencil button)
4. Fill explanation slots (write + verify each editor)
5. Pre-save content comparison (all slots re-read vs source JSON)
6. Save → close modal with X → verify question list returns
7. Done

**Canonical editor reader**: `readEditorTextByTextareaId(page, textareaId)` is the single function used for ALL editor reads (write verification, pre-save comparison, reopen verification). Uses a 4-level fallback chain with try/catch around every access:
1. `tinymce.get(id).getBody().innerText`
2. `tinymce.get(id).getContent({format:"text"})`
3. iframe `contentDocument.body.innerText`
4. `textarea.value`

**Blank explanations**: When `blank: true`, the editor is verified empty. `blank: true` takes precedence over `content`.

**Plain text to HTML**: `plainTextToHtml()` converts clean text to HTML — escapes entities, `\n` → `<br>`. HTML content (detected by tags) is passed through unchanged.

## Directory Structure
| Directory | Purpose |
|-----------|---------|
| `generated/` | Auto-generated files: `latest-quiz.json`, diagnostic logs |
| `failures/` | Screenshot dumps from failed automation runs — inspect before guessing selectors |
| `checkpoints/` | Saved progress snapshots for resume |
| `fixtures/` | JSON fixtures for testing and examples |
| `scripts/` | Utility scripts (validation, probing) |

## Running Tests
```bash
node --test tests/unit/explanationSchema.test.js   # 39 tests (including 7 blank tests)
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
- Password never appears in logs, saved files, or CLI args — always masked or scrubbed
