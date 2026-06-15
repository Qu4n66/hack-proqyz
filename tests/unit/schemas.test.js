/**
 * Unit tests for the domain layer.
 * Run with: node --test tests/unit/schemas.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  QuizSchema,
  IeltsQuestionTypeSchema,
  ProqyzTypeSchema,
  DefaultOptionsSchema,
  defaultOptionsToSelectValue,
} from "../../src/domain/schemas.js";
import { normalizeQuiz, slugify } from "../../src/domain/normalize.js";
import { checkInvariants } from "../../src/domain/invariants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "..", "fixtures");

// ---------------------------------------------------------------------------
// Cam17 MVP-0 fixture (nested-questions, new model)
// ---------------------------------------------------------------------------
test("cam17 passage-1 fixture parses, normalizes, passes invariants", async () => {
  const raw = await readFile(
    resolve(fixturesDir, "cam17-reading-test01-passage1.json"),
    "utf8",
  );
  const parsed = JSON.parse(raw);
  const r = QuizSchema.safeParse(parsed);
  assert.equal(r.success, true, `cam17 fixture should validate, got ${JSON.stringify(r.success ? null : r.error.issues)}`);
  const quiz = normalizeQuiz(r.data);
  checkInvariants(quiz);
  assert.equal(quiz.passages.length, 1);
  assert.equal(quiz.passages[0].questions.length, 13);

  // Q1-6: fill_up, no options
  for (let i = 0; i < 6; i++) {
    const q = quiz.passages[0].questions[i];
    assert.equal(q.proqyzType, "fill_up", `Q${i + 1} should be fill_up`);
    assert.equal(q.options, undefined, `Q${i + 1} should have no options`);
    assert.ok(q.content.includes(`{${q.answer}}`), `Q${i + 1} content should contain {answer}`);
  }
  // Q7-13: select with defaultOptions=true_false_not_given
  for (let i = 6; i < 13; i++) {
    const q = quiz.passages[0].questions[i];
    assert.equal(q.proqyzType, "select", `Q${i + 1} should be select`);
    assert.equal(q.defaultOptions, "true_false_not_given");
    assert.ok(["TRUE", "FALSE", "NOT GIVEN"].includes(q.answer));
  }
});

test("cam17 fresh fixture (grouped fill_up + 7 select + grouped radio MCQ) parses and normalizes", async () => {
  const raw = await readFile(
    resolve(fixturesDir, "cam17-reading-test01-passage1-fresh.json"),
    "utf8",
  );
  const parsed = JSON.parse(raw);
  const r = QuizSchema.safeParse(parsed);
  assert.equal(r.success, true, `fresh fixture should validate, got ${JSON.stringify(r.success ? null : r.error.issues)}`);
  const quiz = normalizeQuiz(r.data);
  checkInvariants(quiz);
  // 2 passages: passage-1 has 1 grouped fill_up + 7 select = 8 entries,
  // passage-2 has 1 grouped radio = 1 entry. Total 9 entries
  // covering numbers 1..13 (passage 1) and 36..37 (passage 2).
  assert.equal(quiz.passages.length, 2);
  assert.equal(quiz.passages[0].questions.length, 8);
  assert.equal(quiz.passages[1].questions.length, 1);

  // Grouped fill_up: Q1-6, displayTitle derived.
  const gFill = quiz.passages[0].questions[0];
  assert.equal(gFill.proqyzType, "fill_up");
  assert.equal(gFill.numberStart, 1);
  assert.equal(gFill.numberEnd, 6);
  assert.equal(gFill.displayTitle, "Questions 1-6");
  assert.equal(gFill.answers.length, 6);

  // Grouped radio: Q36-37, displayTitle derived, 2 subQuestions.
  const gRadio = quiz.passages[1].questions[0];
  assert.equal(gRadio.proqyzType, "radio");
  assert.equal(gRadio.numberStart, 36);
  assert.equal(gRadio.numberEnd, 37);
  assert.equal(gRadio.displayTitle, "Questions 36-37");
  assert.equal(gRadio.subQuestions.length, 2);
  // Each sub-question has 4 options and a valid answer label.
  for (let i = 0; i < gRadio.subQuestions.length; i++) {
    const sq = gRadio.subQuestions[i];
    assert.equal(sq.options.length, 4, `subQ ${sq.number} should have 4 options`);
    const labels = sq.options.map((o) => o.label);
    assert.ok(
      labels.includes(sq.answer),
      `subQ ${sq.number} answer "${sq.answer}" must be one of [${labels.join(", ")}]`,
    );
  }
  // Sub-questions 36 and 37, with answers B and A respectively
  // (per the fixture's spec).
  assert.equal(gRadio.subQuestions[0].number, 36);
  assert.equal(gRadio.subQuestions[0].answer, "B");
  assert.equal(gRadio.subQuestions[1].number, 37);
  assert.equal(gRadio.subQuestions[1].answer, "A");
});

// ---------------------------------------------------------------------------
// Brace rule for fill_up / select (case-insensitive, trim)
// ---------------------------------------------------------------------------
test("fill_up content without a brace is rejected", () => {
  const bad = {
    quizTitle: "Bad",
    quizType: "reading",
    passages: [
      {
        title: "P",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "note_completion",
            proqyzType: "fill_up",
            content: "<strong>1</strong> The population grew.",
            answer: "population",
          },
        ],
      },
    ],
  };
  const r = QuizSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("fill_up brace is case-insensitive when compared to answer", () => {
  const good = {
    quizTitle: "Good",
    quizType: "reading",
    passages: [
      {
        title: "P",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "note_completion",
            proqyzType: "fill_up",
            content: "<strong>1</strong> {London} grew.",
            answer: "london", // case-insensitive match
          },
        ],
      },
    ],
  };
  const r = QuizSchema.safeParse(good);
  assert.equal(r.success, true);
});

test("fill_up brace with typo (different word) is rejected", () => {
  const bad = {
    quizTitle: "Bad",
    quizType: "reading",
    passages: [
      {
        title: "P",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "note_completion",
            proqyzType: "fill_up",
            content: "<strong>1</strong> {popluation} grew.",
            answer: "population",
          },
        ],
      },
    ],
  };
  const r = QuizSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("fill_up content with multiple braces is rejected", () => {
  const bad = {
    quizTitle: "Bad",
    quizType: "reading",
    passages: [
      {
        title: "P",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "note_completion",
            proqyzType: "fill_up",
            content: "{a} and {b}",
            answer: "a",
          },
        ],
      },
    ],
  };
  const r = QuizSchema.safeParse(bad);
  assert.equal(r.success, false);
});

// ---------------------------------------------------------------------------
// select requires defaultOptions
// ---------------------------------------------------------------------------
test("select without defaultOptions is rejected", () => {
  const bad = {
    quizTitle: "Bad",
    quizType: "reading",
    passages: [
      {
        title: "P",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "true_false_not_given",
            proqyzType: "select",
            content: "{TRUE}",
            answer: "TRUE",
            // defaultOptions missing
          },
        ],
      },
    ],
  };
  const r = QuizSchema.safeParse(bad);
  assert.equal(r.success, false);
  if (!r.success) {
    const msg = JSON.stringify(r.error.issues);
    assert.ok(msg.includes("defaultOptions"), `expected defaultOptions error, got ${msg}`);
  }
});

// ---------------------------------------------------------------------------
// answer vs answers exclusivity
// ---------------------------------------------------------------------------
test("checkbox must use answers (plural), not answer", () => {
  const bad = {
    quizTitle: "Bad",
    quizType: "reading",
    passages: [
      {
        title: "P",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "multiple_choice_multiple",
            proqyzType: "checkbox",
            content: "?",
            options: [
              { label: "A", text: "a" },
              { label: "B", text: "b" },
            ],
            answer: "A,B", // wrong — should be answers
          },
        ],
      },
    ],
  };
  const r = QuizSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("radio must use answer (singular), not answers", () => {
  const bad = {
    quizTitle: "Bad",
    quizType: "reading",
    passages: [
      {
        title: "P",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "multiple_choice_single",
            proqyzType: "radio",
            content: "?",
            options: [
              { label: "A", text: "a" },
              { label: "B", text: "b" },
            ],
            answers: ["A"], // wrong — should be answer
          },
        ],
      },
    ],
  };
  const r = QuizSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("checkbox must have non-empty answers array", () => {
  const bad = {
    quizTitle: "Bad",
    quizType: "reading",
    passages: [
      {
        title: "P",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "multiple_choice_multiple",
            proqyzType: "checkbox",
            content: "?",
            options: [
              { label: "A", text: "a" },
              { label: "B", text: "b" },
            ],
            answers: [],
          },
        ],
      },
    ],
  };
  const r = QuizSchema.safeParse(bad);
  assert.equal(r.success, false);
});

// ---------------------------------------------------------------------------
// radio: options required, answer must be a label
// ---------------------------------------------------------------------------
test("radio without options is rejected", () => {
  const bad = {
    quizTitle: "Bad",
    quizType: "reading",
    passages: [
      {
        title: "P",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "multiple_choice_single",
            proqyzType: "radio",
            content: "?",
            answer: "A",
            // options missing
          },
        ],
      },
    ],
  };
  const r = QuizSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("radio with answer not in option labels is rejected", () => {
  const bad = {
    quizTitle: "Bad",
    quizType: "reading",
    passages: [
      {
        title: "P",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "multiple_choice_single",
            proqyzType: "radio",
            content: "?",
            options: [
              { label: "A", text: "a" },
              { label: "B", text: "b" },
            ],
            answer: "Z",
          },
        ],
      },
    ],
  };
  const r = QuizSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("radio happy path: answer matches a label", () => {
  const good = {
    quizTitle: "Good",
    quizType: "reading",
    passages: [
      {
        title: "P",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "multiple_choice_single",
            proqyzType: "radio",
            content: "?",
            options: [
              { label: "A", text: "a" },
              { label: "B", text: "b" },
            ],
            answer: "B",
          },
        ],
      },
    ],
  };
  const r = QuizSchema.safeParse(good);
  assert.equal(r.success, true);
});

// ---------------------------------------------------------------------------
// checkbox: every answer must be a label
// ---------------------------------------------------------------------------
test("checkbox happy path: comma-separated labels", () => {
  const good = {
    quizTitle: "Good",
    quizType: "reading",
    passages: [
      {
        title: "P",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "multiple_choice_multiple",
            proqyzType: "checkbox",
            content: "Which two?",
            options: [
              { label: "A", text: "a" },
              { label: "B", text: "b" },
              { label: "C", text: "c" },
              { label: "D", text: "d" },
            ],
            answers: ["B", "D"],
          },
        ],
      },
    ],
  };
  const r = QuizSchema.safeParse(good);
  assert.equal(r.success, true);
});

test("checkbox with invalid label is rejected", () => {
  const bad = {
    quizTitle: "Bad",
    quizType: "reading",
    passages: [
      {
        title: "P",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "multiple_choice_multiple",
            proqyzType: "checkbox",
            content: "?",
            options: [
              { label: "A", text: "a" },
              { label: "B", text: "b" },
            ],
            answers: ["A", "Z"],
          },
        ],
      },
    ],
  };
  const r = QuizSchema.safeParse(bad);
  assert.equal(r.success, false);
});

// ---------------------------------------------------------------------------
// Normalize rules
// ---------------------------------------------------------------------------
test("normalizeQuiz uppercases labels and answer for radio", () => {
  const quiz = QuizSchema.parse({
    quizTitle: "  Test  ",
    quizType: "reading",
    passages: [
      {
        title: "P1",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "multiple_choice_single",
            proqyzType: "radio",
            content: "?",
            options: [
              { label: "a", text: "alpha" },
              { label: "b", text: "beta" },
            ],
            answer: "b",
          },
        ],
      },
    ],
  });
  const n = normalizeQuiz(quiz);
  assert.equal(n.quizTitle, "Test");
  assert.equal(n.passages[0].questions[0].options[0].label, "A");
  assert.equal(n.passages[0].questions[0].options[1].label, "B");
  assert.equal(n.passages[0].questions[0].answer, "B");
});

test("normalizeQuiz does NOT uppercase answer for fill_up", () => {
  const quiz = QuizSchema.parse({
    quizTitle: "T",
    quizType: "reading",
    passages: [
      {
        title: "P1",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "note_completion",
            proqyzType: "fill_up",
            content: "<strong>1</strong> The {London} grew.",
            answer: "London",
          },
        ],
      },
    ],
  });
  const n = normalizeQuiz(quiz);
  assert.equal(n.passages[0].questions[0].answer, "London", "fill_up answer must keep original case");
});

test("normalizeQuiz uppercases checkbox answers array", () => {
  const quiz = QuizSchema.parse({
    quizTitle: "T",
    quizType: "reading",
    passages: [
      {
        title: "P1",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "multiple_choice_multiple",
            proqyzType: "checkbox",
            content: "?",
            options: [
              { label: "A", text: "a" },
              { label: "B", text: "b" },
              { label: "C", text: "c" },
            ],
            answers: ["a", "c"],
          },
        ],
      },
    ],
  });
  const n = normalizeQuiz(quiz);
  assert.deepEqual(n.passages[0].questions[0].answers, ["A", "C"]);
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------
test("checkInvariants: non-contiguous question numbers within a passage throw", () => {
  const quiz = QuizSchema.parse({
    quizTitle: "Bad",
    quizType: "reading",
    passages: [
      {
        title: "P1",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "multiple_choice_single",
            proqyzType: "radio",
            content: "?",
            options: [
              { label: "A", text: "a" },
              { label: "B", text: "b" },
            ],
            answer: "A",
          },
          {
            number: 3,
        instruction: "", // gap
            ieltsType: "multiple_choice_single",
            proqyzType: "radio",
            content: "?",
            options: [
              { label: "A", text: "a" },
              { label: "B", text: "b" },
            ],
            answer: "A",
          },
        ],
      },
    ],
  });
  const n = normalizeQuiz(quiz);
  assert.throws(() => checkInvariants(n), /contiguous/);
});

test("checkInvariants: question numbers are per-passage, not global", () => {
  const quiz = QuizSchema.parse({
    quizTitle: "Two passages, each starts at 1",
    quizType: "reading",
    passages: [
      {
        title: "P1",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "",
            ieltsType: "multiple_choice_single",
            proqyzType: "radio",
            content: "?",
            options: [
              { label: "A", text: "a" },
              { label: "B", text: "b" },
            ],
            answer: "A",
          },
        ],
      },
      {
        title: "P2",
        content: "...",
        questions: [
          {
            number: 1,
        instruction: "", // also starts at 1 — must be allowed
            ieltsType: "multiple_choice_single",
            proqyzType: "radio",
            content: "?",
            options: [
              { label: "A", text: "a" },
              { label: "B", text: "b" },
            ],
            answer: "A",
          },
        ],
      },
    ],
  });
  const n = normalizeQuiz(quiz);
  // Should NOT throw — per-passage numbering is the rule.
  checkInvariants(n);
});

// ---------------------------------------------------------------------------
// Utility: slugify + defaultOptionsToSelectValue
// ---------------------------------------------------------------------------
test("slugify produces a safe filename", () => {
  assert.equal(slugify("IELTS Reading Practice Test 1"), "ielts-reading-practice-test-1");
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("   trim   "), "trim");
});

test("defaultOptionsToSelectValue maps codes to ProQyz select values", () => {
  assert.equal(defaultOptionsToSelectValue("true_false_not_given"), "true-false-notgiven");
  assert.equal(defaultOptionsToSelectValue("yes_no_not_given"), "yes-no-notgiven");
  assert.equal(defaultOptionsToSelectValue("roman_lower"), "i");
  assert.equal(defaultOptionsToSelectValue("roman_upper"), "I");
  assert.equal(defaultOptionsToSelectValue("capital_letters"), "A");
  assert.equal(defaultOptionsToSelectValue("lowercase_letters"), "a");
  assert.equal(defaultOptionsToSelectValue("numeric"), "1");
});

// ---------------------------------------------------------------------------
// Grouped radio MCQ (subQuestions)
// ---------------------------------------------------------------------------
function makeGroupedRadioQ(extra = {}) {
  return {
    quizTitle: "Radio MCQ",
    quizType: "reading",
    passages: [
      {
        title: "P",
        content: "...",
        questions: [
          {
            number: 36,
            numberStart: 36,
            numberEnd: 37,
            ieltsType: "multiple_choice_single",
            proqyzType: "radio",
            instruction: "Choose A/B/C/D",
            content: "Questions 36-37",
            subQuestions: [
              {
                number: 36,
                text: "Why?",
                options: [
                  { label: "A", text: "a1" },
                  { label: "B", text: "b1" },
                  { label: "C", text: "c1" },
                  { label: "D", text: "d1" },
                ],
                answer: "B",
              },
              {
                number: 37,
                text: "How?",
                options: [
                  { label: "A", text: "a2" },
                  { label: "B", text: "b2" },
                  { label: "C", text: "c2" },
                  { label: "D", text: "d2" },
                ],
                answer: "A",
              },
            ],
            ...extra,
          },
        ],
      },
    ],
  };
}

test("grouped radio MCQ with valid subQuestions parses", () => {
  const r = QuizSchema.safeParse(makeGroupedRadioQ());
  assert.equal(r.success, true, JSON.stringify(r.success ? null : r.error.issues));
});

test("grouped radio MCQ rejects when top-level options/answer are also set", () => {
  const r = QuizSchema.safeParse(
    makeGroupedRadioQ({
      options: [{ label: "A", text: "x" }],
      answer: "A",
    }),
  );
  assert.equal(r.success, false);
  const paths = r.error.issues.map((i) => i.path.join("."));
  assert.ok(
    paths.some((p) => p === "passages.0.questions.0.answer"),
    `expected an error on .answer, got paths=${JSON.stringify(paths)}`,
  );
});

test("grouped radio MCQ rejects when subQuestion count != numberEnd-numberStart+1", () => {
  const q = makeGroupedRadioQ();
  q.passages[0].questions[0].subQuestions =
    q.passages[0].questions[0].subQuestions.slice(0, 1); // only 1
  const r = QuizSchema.safeParse(q);
  assert.equal(r.success, false);
  const msgs = r.error.issues.map((i) => i.message).join(" | ");
  assert.ok(
    /subQuestions length/.test(msgs),
    `expected subQuestions length error, got: ${msgs}`,
  );
});

test("grouped radio MCQ rejects when subQuestion answer is not in its options", () => {
  const q = makeGroupedRadioQ();
  q.passages[0].questions[0].subQuestions[0].answer = "Z";
  const r = QuizSchema.safeParse(q);
  assert.equal(r.success, false);
  const msgs = r.error.issues.map((i) => i.message).join(" | ");
  assert.ok(
    /must match one of the option labels/.test(msgs),
    `expected label-mismatch error, got: ${msgs}`,
  );
});

test("grouped radio MCQ rejects when subQuestion number is outside numberStart..numberEnd", () => {
  const q = makeGroupedRadioQ();
  q.passages[0].questions[0].subQuestions[0].number = 35;
  const r = QuizSchema.safeParse(q);
  assert.equal(r.success, false);
  const msgs = r.error.issues.map((i) => i.message).join(" | ");
  assert.ok(
    /must be within 36\.\.37/.test(msgs),
    `expected range error, got: ${msgs}`,
  );
});

test("single radio with subQuestions is rejected (legacy single-radio path)", () => {
  // numberStart/numberEnd NOT set, but subQuestions is.
  const q = makeGroupedRadioQ();
  delete q.passages[0].questions[0].numberStart;
  delete q.passages[0].questions[0].numberEnd;
  const r = QuizSchema.safeParse(q);
  assert.equal(r.success, false);
  const msgs = r.error.issues.map((i) => i.message).join(" | ");
  assert.ok(
    /must not define `subQuestions`/.test(msgs),
    `expected legacy-mode rejection, got: ${msgs}`,
  );
});

// ---------------------------------------------------------------------------
// Enum sanity
// ---------------------------------------------------------------------------
test("ProqyzTypeSchema has exactly the 4 expected values", () => {
  assert.deepEqual(ProqyzTypeSchema.options.sort(), ["checkbox", "fill_up", "radio", "select"]);
});
test("IeltsQuestionTypeSchema covers all 13 IELTS Reading types", () => {
  const expected = [
    "note_completion",
    "sentence_completion",
    "summary_completion",
    "table_completion",
    "flow_chart_completion",
    "short_answer",
    "true_false_not_given",
    "yes_no_not_given",
    "matching_headings",
    "matching_information",
    "matching_features",
    "multiple_choice_single",
    "multiple_choice_multiple",
  ];
  assert.deepEqual(IeltsQuestionTypeSchema.options.sort(), expected.sort());
});
test("DefaultOptionsSchema covers all 7 source codes", () => {
  const expected = [
    "capital_letters",
    "lowercase_letters",
    "numeric",
    "roman_lower",
    "roman_upper",
    "true_false_not_given",
    "yes_no_not_given",
  ];
  assert.deepEqual(DefaultOptionsSchema.options.sort(), expected.sort());
});
