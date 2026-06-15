/**
 * The CENTRAL SELECTOR MAP.
 *
 * Single source of truth for every ProQyz UI hook used by the uploader.
 * When ProQyz's UI changes, this is (almost always) the only file you
 * need to touch.
 *
 * Selectors are organized by:
 *   - login         — authentication page
 *   - nav           — top-level navigation (e.g. "Quizzes" link)
 *   - quizForm      — the create/edit quiz form
 *   - passage       — passage sub-editor
 *   - questionList  — the row in the question list (one per question)
 *   - questionEditor — the per-question editor page
 *   - option        — answer-option row inside a question editor
 *   - editor        — rich text editor variants (auto-detected at runtime)
 *
 * PRINCIPLES (non-negotiable):
 *   1. Prefer data-testid. Fall back to ARIA labels / role-based selectors.
 *   2. Always scope by container. "Click the 2nd option" is FORBIDDEN.
 *      "Click the correct radio inside the question card whose prompt
 *      matches" is the only allowed pattern.
 *   3. Never use nth-child(N) as the sole selector.
 *   4. Visible-text selectors (button:has-text("Save")) are OK for stable
 *      copy, but we keep a data-testid fallback for every such selector.
 *
 * Most question-editor selectors below are PHASE-1 BEST GUESS — derived
 * from the create-quiz and question-list recon dumps, refined after the
 * first real ProQyz run.
 */

export const Selectors = {
  /** Bump this whenever you change a selector. Failure dumps include it. */
  version: "2026-06-08-cam17-recon",

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  login: {
    emailInput: 'input[name="email"], input[type="email"]',
    passwordInput: 'input[name="password"], input[type="password"]',
    submitButton: 'button[type="submit"]',
    /** URL pattern that means the user is logged in. */
    postLoginUrl: /\/dashboard|\/home|\/quizzes/i,
    /** URL of the login page. */
    loginUrl: "/login",
  },

  // ---------------------------------------------------------------------------
  // Top-level navigation
  // ---------------------------------------------------------------------------
  nav: {
    quizzesLink: 'a[href*="quiz"], nav a:has-text("Quizzes")',
    /**
     * "New quiz" button on the My Quizzes page. Real ProQyz uses lowercase
     * "New quiz" (icon-plus + label) inside `.btn.btn-primary.btn-sm`.
     * Match the visible text robustly so we survive whitespace changes.
     */
    newQuizButton: 'button:has-text("New quiz"), a:has-text("New quiz")',
  },

  // ---------------------------------------------------------------------------
  // Quiz form (create + edit)
  // ---------------------------------------------------------------------------
  /**
   * `quizForm` covers BOTH the create modal (a TWO-STEP WIZARD on
   * real ProQyz) and the full edit form on
   * `/dashboard/.../quiz/edit/<id>`.
   *
   * Step 1 of the create wizard: "Select Quiz Type" — 5 radio buttons
   * with name="category" (reading/listening/writing/speaking/gov).
   *   → click Next to advance.
   * Step 2: title/description form. Submitting routes to the edit page.
   */
  quizForm: {
    /** The My Quizzes page (where the "New quiz" button lives). */
    myQuizzesPath: "/dashboard/@customer/pro-qyz/my-quizzes",
    /**
     * Modal that opens when "New quiz" is clicked. ProQyz uses a generic
     * Bootstrap modal markup. We match by the visible modal dialog.
     */
    createModal: '.modal.show, [role="dialog"].show, .modal-dialog',
    /**
     * Step 1 of the create wizard. The modal header shows "Select Quiz
     * Type". Five radio buttons share `name="category"`. Reading is
     * checked by default, so we only need to click it if the user
     * asked for a different type.
     */
    categoryRadio:
      'input[type="radio"][name="category"][value="reading"], input[type="radio"][name="category"][value="listening"]',
    /** "Next" button on the wizard's step 1. */
    nextButton: '.modal.show button:has-text("Next")',
    /** Modal-title text used to detect step 1 of the wizard. */
    selectQuizTypeHeader: 'h4:has-text("Select Quiz Type")',
    /**
     * Title input. Multiple fallbacks because the real create modal
     * uses a placeholder, not name="title"; the edit page does have
     * name="title".
     */
    titleInput:
      'input[name="title"], input[placeholder*="title" i], input[placeholder*="quiz name" i]',
    descriptionInput:
      'textarea[name="description"], [contenteditable="true"][data-field="description"]',
    /**
     * Quiz-type select on the EDIT page (post-create). The create
     * wizard uses a radio, not a select.
     */
    quizTypeSelect:
      'select[name="quiz_type"], select[name="quizType"], select[name="type"]',
    /** Time limit, in MINUTES. The real edit form uses `name="min"`. */
    timeLimitInput: 'input[name="min"], input[name="timeLimit"], input[name="time_limit"]',
    statusSelect: 'select[name="status"]',
    /**
     * Save button on the edit page. Real form has both "Save changes" and
     * "Discard" buttons. We prefer the submit-typed one.
     */
    saveButton: 'button[type="submit"]:has-text("Save changes"), button:has-text("Save changes")',
    discardButton: 'button:has-text("Discard")',
    /**
     * The submit button INSIDE the create modal's step 2. Real ProQyz
     * uses "Add Quiz"; older UIs and our local stub use "Create" /
     * "Create Quiz". The selector does NOT include a `.modal.show`
     * prefix because the uploader calls it via
     * `modal.locator(Selectors.quizForm.createButton)` — re-applying
     * `.modal.show` inside that scope yields a self-referencing
     * selector that never matches.
     */
    createButton:
      'button[type="submit"], button:has-text("Add Quiz"), button:has-text("Create Quiz"), button[type="submit"]:has-text("Create")',
    /** The "+ Add Passage" / "+ Add Question" buttons are under
     *  `passage.addButton` and `questionList.addButton` (the new
     *  tab-based flow). */
    questionsContainer: '[data-testid="questions-list"], .questions-list',
    passagesContainer: '[data-testid="passages-list"], .passages-list',
  },

  // ---------------------------------------------------------------------------
  // Tabs (Passages / Questions) on the quiz edit page
  //
  // Real ProQyz uses a `nav-line-tabs` nav at the top of the page. The
  // tabs are `<a type="button" class="nav-link ...">Label</a>` and
  // clicking them swaps the page content. There is also a sidebar
  // "Passages" item we MUST NOT match — it's a different sub-page
  // navigation. We scope to `.nav.nav-stretch` to avoid the sidebar.
  // ---------------------------------------------------------------------------
  tabs: {
    passagesTab:
      '.nav.nav-stretch a:has-text("Passages"), .nav.nav-line-tabs a:has-text("Passages"), [role="tab"]:has-text("Passages"), .tab:has-text("Passages"), [data-tab="passages"]',
    questionsTab:
      '.nav.nav-stretch a:has-text("Questions"), .nav.nav-line-tabs a:has-text("Questions"), [role="tab"]:has-text("Questions"), .tab:has-text("Questions"), [data-tab="questions"]',
  },

  // ---------------------------------------------------------------------------
  // Passage sub-editor (tab-based on real ProQyz)
  //
  // Real ProQyz flow:
  //   1. Click the "Passages" tab.
  //   2. Click "+ Add Passage" to open a modal.
  //   3. Fill title + content in the modal.
  //   4. Click Save / Add Passage.
  //   5. The new passage appears in the list.
  // ---------------------------------------------------------------------------
  passage: {
    /** Container that holds the list of passages on the Passages tab. */
    listContainer: '[data-testid="passages-list"], .passages-list, .passages, .card-body.border-top',
    /**
     * Each entry in the passages list. Real ProQyz renders each row
     * as `<div class="py-2"><div class="d-flex flex-stack">…</div></div>`
     * with the title text inside a `.fs-5.text-dark.text-hover-primary.fw-bold`
     * child. There are NO data-* hooks, so the best we can do is match
     * the `.py-2` row container.
     */
    row: '[data-passage-id], [data-testid="passage-row"], .passage-row, .passage-item, .py-2',
    /** The passage title text inside a row (for the "wait until it appears" check). */
    rowTitle: '[data-testid="passage-title"], .passage-title, .fs-5.text-dark.text-hover-primary.fw-bold',
    /** "+ Add Passage" button on the Passages tab. */
    addButton: 'button:has-text("Add Passage"), button:has-text("+ Add Passage"), a:has-text("Add Passage")',
    /** The Add-Passage modal. */
    addModal: '.modal.show, [role="dialog"].show, .modal-dialog',
    /** Title input INSIDE the Add-Passage modal. Real ProQyz uses
     *  `placeholder="Add Passage title"`. No `.modal.show` prefix —
     *  see "self-referencing selector" caveat above. */
    titleInput:
      'input[name="title"], input[placeholder*="title" i], input[placeholder*="passage" i]',
    /**
     * Passage content INSIDE the Add-Passage modal. Real ProQyz uses
     * **TinyMCE** (a hidden textarea + iframe). The selector accepts
     * either:
     *  - a plain textarea (older UIs / stub), OR
     *  - the hidden TinyMCE textarea (`textarea[id^="tiny-react_"]`),
     *    which is what the editor's `setContent` writes to.
     */
    contentRoot:
      'textarea[id^="tiny-react_"], textarea[name="content"], textarea[name="passageContent"], [data-testid="passage-content"] textarea, [data-testid="passage-content"]',
    /** Submit button inside the Add-Passage modal. Same scope caveat. */
    saveButton:
      'button[type="submit"], button:has-text("Add Passage"), button:has-text("Save"), button:has-text("Add Quiz")',
  },

  // ---------------------------------------------------------------------------
  // Question editor (tab-based on real ProQyz)
  //
  // Real ProQyz flow:
  //   1. Click the "Questions" tab.
  //   2. Select the passage from a passage dropdown.
  //   3. Click "+ Add Question" to open the per-question editor
  //      (modal or sub-page).
  //   4. Fill the question form and save.
  // ---------------------------------------------------------------------------
  questionList: {
    /** The list of questions for the currently selected passage. */
    container: '[data-testid="questions-list"], .questions-list, .questions',
    /**
     * The passage dropdown on the Questions tab. Real ProQyz shows
     * TWO passage selects when no passage is selected yet:
     *   1. A top-right select near "List of Questions"
     *   2. A center select inside the empty state under "Choose Passage"
     * The first match in DOM order is whichever appears first. We
     * accept both — the uploader's `_selectPassageInQuestionsTab`
     * helper iterates all matches, picks the first VISIBLE one, and
     * ignores hidden duplicates.
     *
     * The real DOM uses `<select class="form-select ...">` with no
     * `name` attribute, so we DON'T pin to a specific name. The
     * helper also walks `select` elements generically when this
     * selector misses.
     */
    passageSelect:
      'select[name="passage"], select[name="passage_id"], select[name="passageId"], .passage-select select, [data-testid="passage-select"], .form-select',
    /** Empty-state element: rendered when no passage is selected.
     *  When this disappears, the passage list for the selected
     *  passage has loaded. */
    emptyState: ':text("Choose Passage"), :text("choose a passage"), .empty-state, [data-testid="empty-state"]',
    /** Each question row in the list. */
    row: '[data-question-id], [data-testid="question-row"], .question-row, .question-item',
    /** "Add Question" button on the Questions tab. */
    addButton: 'button:has-text("Add Question"), button:has-text("+ Add Question"), a:has-text("Add Question")',
  },

  // ---------------------------------------------------------------------------
  // Per-question editor (modal or sub-page)
  //
  // The recon didn't capture this DOM yet; the per-question editor
  // selectors are still best-guess and will be refined on the next
  // real ProQyz run.
  // ---------------------------------------------------------------------------
  questionEditor: {
    /**
     * The container that wraps the per-question editor form. Tries
     * both the modal scope (most likely on real ProQyz) and a
     * dedicated sub-page.
     */
    container: '[data-testid="question-editor"], .question-editor, .modal.show form[name="question"], form[data-form="question"]',
    /** The ProQyz question-type select: Fill-up / Select / Radio / Checkbox. */
    typeSelect: 'select[name="type"], select[name="questionType"]',
    /**
     * The "Default Options" select — only meaningful for
     * proqyzType=select. Best-guess name.
     */
    defaultOptionsSelect: 'select[name="defaultOptions"], select[name="default_options"]',
    /** Question content textarea (HTML). */
    contentTextarea:
      'textarea[name="content"], textarea[name="question"], [contenteditable="true"][data-field="content"]',
    /** Add Option button. */
    addOptionButton: 'button:has-text("Add Option"), button:has-text("Add Answer")',
    /** Save button on the question editor. */
    saveButton: 'button[type="submit"]:has-text("Save"), button:has-text("Save")',
    /** Back-to-list button. */
    backToListButton: 'a:has-text("Back"), button:has-text("Back")',
  },

  // ---------------------------------------------------------------------------
  // Option row (answer option, inside a question editor)
  // ---------------------------------------------------------------------------
  option: {
    row: '[data-testid="option-row"], .option-row, [data-option-row]',
    textField:
      'input[name="optionText"], textarea[name="optionText"], [contenteditable="true"][data-field="optionText"]',
    /**
     * Correct-marker for radio questions. Scoped to an option row.
     */
    correctRadio: 'input[type="radio"][name="correct"]',
    /** Correct-marker for checkbox questions. Scoped to an option row. */
    correctCheckbox: 'input[type="checkbox"][name="correct"]',
    /** Display label "A" / "B" / "C" / "D" inside the option row. */
    labelText: '[data-testid="option-label"]',
  },

  // ---------------------------------------------------------------------------
  // Rich text editor — auto-detected at runtime
  //
  // The real ProQyz UI has no RTE (recon: editors.textarea=1, all RTEs 0).
  // We keep the detection in case the editor changes, but `writePlain`
  // is the only writer we call in practice.
  // ---------------------------------------------------------------------------
  editor: {
    tinymce: {
      api: "tinymce",
      selector: ".tox-edit-area iframe, .tox-tinymce",
      bodySelector: "body",
    },
    ckeditor: {
      api: "CKEDITOR",
      selector: ".ck-editor__editable, .cke_contents iframe",
    },
    quill: {
      api: "Quill",
      selector: ".ql-editor",
    },
    textarea: {
      api: null,
      selector: "textarea, [contenteditable='true']",
    },
  },

  // ---------------------------------------------------------------------------
  // Explanation upload — locating quiz, opening question editor, filling
  // explanation tab. These selectors are best-guess; will be refined on
  // first real ProQyz run.
  // ---------------------------------------------------------------------------
  explanation: {
    /** Search input on My Quizzes page. */
    searchInput:
      'input[type="search"], input[placeholder*="search" i], input[name="search"], .search-input, input.form-control',
    /** Quiz row in the list after search. */
    quizRow:
      '.quiz-item, .quiz-row, tr, [data-quiz-id], .card, .list-group-item',
    /** Edit pencil/icon on a quiz row or question row. */
    editPencil:
      'button:has-text("Edit"), a:has-text("Edit"), [aria-label*="edit" i], .fa-edit, .btn-edit, a[href*="edit"], button:has-text("Edit"), button:has-text("✎")',
    /** Explanation TinyMCE iframe on the Explanation tab. */
    explanationTinyMCE:
      'iframe[class*="tox-edit-area__iframe"]',
    /** Save Changes button on the question editor modal. */
    saveChangesButton:
      'button:has-text("Save Changes"), button:has-text("Save"), button[type="submit"]',
    /** Question row label — filtered by text like "Questions 36-37". */
    questionRowLabel:
      '.question-row, [data-question-id], [data-testid="question-row"], .question-item',
  },

  // ---------------------------------------------------------------------------
  // Post-save review
  // ---------------------------------------------------------------------------
  review: {
    /** Selector that indicates the quiz is in draft state. */
    draftBadge: ':text("Draft"), [data-status="draft"]',
    /** The URL pattern for the edit page of a quiz. */
    editUrlPattern: /\/quizzes\/[^/]+\/edit|\/quiz\/edit\//,
  },
};

/**
 * Sanity check: if anyone removes a top-level key, fail loud at import time.
 * Cheap, and it makes refactors safe.
 */
const REQUIRED_KEYS = [
  "login",
  "nav",
  "quizForm",
  "passage",
  "questionList",
  "questionEditor",
  "option",
  "editor",
  "review",
];
for (const k of REQUIRED_KEYS) {
  if (!Selectors[k]) {
    throw new Error(`Selectors map is missing required key: ${k}`);
  }
}
