# ProQyz Automation — User Guide

**For non-technical team members.** This guide explains how to use the browser-based tools to upload IELTS Reading quizzes and explanations to ProQyz — without needing to touch code or the command line.

---

## What Does This Tool Do?

This tool automates the manual work of entering IELTS quiz content into ProQyz. Instead of typing everything by hand, you:

1. Fill in a simple web form with your quiz content.
2. Click **Upload** — the tool opens a browser, logs in to ProQyz, and fills in everything for you.

There are two separate tools:

| Tool | What it does | When to use it |
|------|-------------|---------------|
| **Quiz Creator** | Creates a brand-new quiz: quiz title, reading passage, and all questions | When starting a fresh quiz from scratch |
| **Explanation Upload** | Adds answer explanations to questions that already exist in ProQyz | When you want to add "why is this the answer" explanations to an existing quiz |

---

## Before You Start

You need two things running:

1. **The local web server** — this serves the tool pages.
2. **A browser window** — where ProQyz automation runs.

### Step 1: Install dependencies

Open your terminal and run:

```bash
cd /Users/evice2457/proqyz\ hack/hack-proqyz
npm install
npx playwright install chromium
```

You only need to do this once (or after someone updates the tool).

### Step 2: Start the web server

```bash
node local-tool-server.js
```

You'll see:
```
local-tool-server listening on http://0.0.0.0:8000
open: http://localhost:8000/src/input/localInput.html
```

Keep this terminal window open. The server must keep running while you work.

### Step 3: Open the tool in your browser

Go to: **http://localhost:8000/src/input/localInput.html**

You should see the **Quiz Creator** page with two tabs at the top:
- **Quiz Creator** (active) — for creating new quizzes
- **Explanation Upload** — for adding explanations

---

## Tool 1: Quiz Creator

Use this when you want to create a completely new IELTS Reading quiz in ProQyz.

### The page layout

The page is split into two columns:

- **Left column** — the form you fill in (steps 1–5)
- **Right column** — a live preview of the JSON output (what the tool sends to ProQyz)

As you fill in the form, the right column updates automatically to show you the JSON. Green text means everything looks correct.

---

### Section 1: Quiz Info

Fill in the basic quiz details:

- **Quiz title** — a short name for the quiz, e.g. "Cam 17 Reading Test 01"
- **Time (minutes)** — how long students have (default is 60 for reading)
- **Status** — leave as **draft** (you publish manually later)
- **Source name** — where the quiz came from, e.g. "IELTS Training Online"
- **Source URL** — the website URL where you got the content

---

### Section 2: Passage

Fill in the reading passage:

- **Passage title** — e.g. "Reading Passage 1"
- **Passage content** — paste the full reading passage text here. Newlines are fine.

---

### Section 3: Question Blocks

This is where you add your IELTS questions. Each **block** represents one group of questions (e.g. "Questions 1–6").

#### How to add a question block

Click one of the buttons at the bottom of the section:

- **+ Fill-up** — for fill-in-the-blank questions (note completion, sentence completion, summary completion, table completion, flow-chart completion, short-answer)
- **+ Radio** — for multiple-choice questions with a single correct answer
- **+ Select** — for True/False/Not Given or Yes/No/Not Given questions (coming soon)
- **+ Checkbox** — for multiple-choice questions with multiple correct answers (coming soon)

Each block has three things to fill in:

1. **Type** — already set by the button you clicked
2. **Block title** — a short label, e.g. "Questions 1-6"
3. **JSON textarea** — the actual question data

#### The JSON textarea

The textarea is pre-filled with a template. You just need to edit the values inside it. Here's what each type needs:

**Fill-up questions** (example):

```json
{
  "type": "fill-up",
  "title": "Questions 1-6",
  "instructions": "Complete the notes below. Choose ONE WORD ONLY from the passage.",
  "content": "The {answer} of London increased between 1800 and 1850. The {answer} was covered with soil.",
  "answers": ["population", "tunnel"]
}
```

Key rules:
- Put `{answer}` in your content for each blank
- List the correct answers in the `answers` array, in order
- The number of `{answer}` placeholders must match the number of answers

**Multiple-choice (Radio) questions** (example):

```json
{
  "type": "radio",
  "title": "Questions 27-28",
  "instructions": "Choose the correct letter, A, B, C or D.",
  "questions": [
    {
      "number": 27,
      "text": "What is the writer's main point?",
      "options": [
        { "label": "A", "text": "to describe what happened during the Battle of Worcester" },
        { "label": "B", "text": "to give an account of the circumstances leading to Charles II's escape" },
        { "label": "C", "text": "to explain why Charles II escaped capture" },
        { "label": "D", "text": "to describe the historical context of the event" }
      ],
      "answer": "B"
    }
  ]
}
```

Key rules:
- Each question needs a `number` (the IELTS question number)
- Each option needs a `label` (A, B, C, D) and `text` (the option text)
- The `answer` must match one of the option labels exactly (case-insensitive)

#### What the color indicators mean

After you type in the JSON textarea, you'll see a small message below it:

- **Green "OK"** — the question is valid and ready to upload
- **Red "error"** — something is wrong (check the error message)

Common errors:
- Missing `{answer}` placeholders for fill-up questions
- Answer doesn't match any option label for radio questions
- Invalid JSON (missing a comma, bracket, or quote)

#### Reordering question blocks

Use the **up/down arrows** on each block header to reorder them. The order matters — it determines the order questions appear in ProQyz.

#### Removing a block

Click the **red X** button on the block header to remove it.

---

### Section 4: Upload

When your form is complete:

1. Click **Upload to ProQyz** in the left column.

The tool will:
- Open a Chromium browser window
- Navigate to ProQyz
- Log in (you may need to do this manually the first time)
- Create the quiz, add the passage, and add all your questions
- Show you the progress in the **Server log** panel

**Important:** Keep the browser window open. Do not click inside it while the tool is working.

When it's done, the tool will pause and show you the **review URL**. Open that URL in your browser to check the quiz looks correct. Then click **Publish** if everything is good.

---

### Section 5: Generate (Downloading JSON)

If you want to save the JSON file without uploading right now:

- **Download .json** — saves the quiz as a `.json` file to your computer
- **Copy to clipboard** — copies the JSON so you can paste it elsewhere
- **Prettify** — reformats the JSON to make it easier to read

---

## Tool 2: Explanation Upload

Use this when you already have a quiz in ProQyz and want to add explanations to its questions.

**Switch to it by clicking the "Explanation Upload" tab at the top of the page.**

---

### The page layout

Two columns again:

- **Left column** — quiz search + JSON input + Upload
- **Right column** — live JSON preview + reference examples

---

### Step 1: Search for the quiz

- **Quiz title (for search)** — enter the exact quiz title as shown in ProQyz, e.g. "Cam 17 Reading Test 01"
- **Existing quiz URL (optional)** — if you know the direct edit URL of the quiz, paste it here and the tool will skip the search step

---

### Auto Login (optional)

If the tool needs to log in to ProQyz, you can enter your credentials here:

1. Check the **Use Auto Login** box.
2. Enter your **Email / Username**.
3. Enter your **Password**.

Your credentials are kept in memory only — they are never saved to a file or sent anywhere.

---

### Step 2: Paste explanation JSON

In the large text area, paste your explanation JSON. Here's the format:

```json
{
  "mode": "explanation",
  "testTitle": "Cam 17 Reading Test 01",
  "passages": [
    {
      "passage": 1,
      "questionGroups": [
        {
          "range": "36-37",
          "questionNumberStart": 36,
          "questionNumberEnd": 37,
          "explanations": [
            {
              "questionNumber": 36,
              "content": "<p>The answer is <b>population</b> because the passage states that the city's population grew rapidly between 1800 and 1850.</p>"
            },
            {
              "questionNumber": 37,
              "content": "<p>The answer is <b>suburbs</b> because the text mentions expansion into surrounding areas beyond the city centre.</p>"
            }
          ]
        }
      ]
    }
  ]
}
```

Key fields:
- `testTitle` — must match the quiz title exactly in ProQyz
- `passage` — which passage number (1, 2, or 3)
- `range` — label like "36-37" — must match how the question group appears in ProQyz
- `questionNumberStart` / `questionNumberEnd` — the first and last IELTS question numbers in this group
- `explanations` — one entry per question:
  - `questionNumber` — the IELTS question number
  - `content` — the explanation text (HTML is fine here)

You can also click **Load example** to see a pre-filled example.

---

### Step 3: Validate

Click **Validate** to check your JSON is correct before uploading.

- **Green** — looks good, ready to upload
- **Red** — something is wrong, check the error message

---

### Step 4: Upload

Click **Upload Explanations**.

The tool will:
1. Open a Chromium browser
2. Search for your quiz in ProQyz
3. Open the quiz editor
4. Go to the Questions tab
5. Open each question in the group
6. Fill in the explanation
7. Save

Watch the **Server log** panel for progress. Keep the browser window open and don't click inside it while it works.

---

## How to Log In to ProQyz

On the **first run**, the tool will open a browser window and show the ProQyz login page. Log in with your username and password just like you normally would. The tool saves your session so you don't have to log in again on future runs.

If your session expires, the tool will open the login page again — just log in once more.

---

## Troubleshooting

### "Network error — is local-tool-server.js running on :8000?"

The local server stopped. Re-open your terminal and run:

```bash
node local-tool-server.js
```

Then refresh the page in your browser.

### Questions were uploaded but look wrong

Check the **review URL** shown at the end of the upload. Open it in your browser and manually fix any issues. The tool never auto-publishes — you always have a chance to review before going live.

### JSON shows errors (red text)

Common fixes:
- **Fill-up:** Make sure the number of `{answer}` placeholders matches the number of items in the `answers` array
- **Radio:** Make sure the `answer` value matches one of the option labels exactly
- **JSON syntax:** Check for missing commas, quotes, brackets. The JSON must be valid.

### Explanation upload can't find the quiz

- Double-check the `testTitle` in your JSON matches the quiz title in ProQyz exactly (same spelling, same capitalization)
- Make sure the quiz exists and is accessible in your ProQyz account

---

## Workflow Summary

### Creating a new quiz
1. Start the server: `node local-tool-server.js`
2. Open http://localhost:8000/src/input/localInput.html
3. Go to **Quiz Creator** tab
4. Fill in quiz info, passage, and question blocks
5. Click **Upload to ProQyz**
6. Wait for the tool to finish
7. Review at the URL shown
8. Click **Publish** in ProQyz

### Adding explanations to an existing quiz
1. Start the server: `node local-tool-server.js`
2. Open http://localhost:8000/src/input/localInput.html
3. Click the **Explanation Upload** tab
4. Enter the quiz title
5. Paste your explanation JSON
6. Click **Validate**
7. Click **Upload Explanations**
8. Wait for the tool to finish

---

## Keyboard Shortcuts

When the JSON textarea is focused, you can use:

- **Cmd+A** (Mac) / **Ctrl+A** (Windows) — select all
- **Cmd+Z** — undo
- **Cmd+D** — duplicate line
- **Tab** — indent
- **Shift+Tab** — outdent

To copy the JSON output quickly: click the **Copy to clipboard** button in the Generate section.

---

## Need Help?

If something isn't working, check:
1. Is the server running? (no "Network error" message)
2. Is the JSON valid? (green "OK" indicators)
3. Are you logged in to ProQyz? (try logging in manually once)
4. Does the quiz title match exactly? (for explanation uploads)

Contact the tool administrator if you see unexpected errors.
