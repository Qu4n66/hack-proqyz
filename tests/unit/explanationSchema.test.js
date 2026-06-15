/**
 * Unit tests for the Explanation Upload JSON schema.
 * Run with: node --test tests/unit/explanationSchema.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  ExplanationDataSchema,
  ExplanationGroupSchema,
  normalizeExplanationData,
} from "../../src/domain/explanationSchema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "..", "fixtures");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidExplanation() {
  return {
    mode: "explanation",
    testTitle: "Cam 17 Reading Test 01",
    passages: [
      {
        passage: 1,
        questionGroups: [
          {
            range: "36-37",
            questionNumberStart: 36,
            questionNumberEnd: 37,
            explanations: [
              { questionNumber: 36, content: "<p>Explanation for Q36</p>" },
              { questionNumber: 37, content: "<p>Explanation for Q37</p>" },
            ],
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Valid JSON — should parse successfully
// ---------------------------------------------------------------------------

test("valid minimal explanation JSON parses", () => {
  const data = makeValidExplanation();
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, true, `expected success, got ${JSON.stringify(result.success ? null : result.error.issues)}`);
});

test("valid explanation JSON with existingQuizUrl parses", () => {
  const data = makeValidExplanation();
  data.existingQuizUrl = "https://app.proqyz.com/dashboard/quiz/edit/123";
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, true);
  assert.equal(result.data.existingQuizUrl, "https://app.proqyz.com/dashboard/quiz/edit/123");
});

test("valid explanation JSON with explicit slots parses", () => {
  const data = makeValidExplanation();
  data.passages[0].questionGroups[0].explanations[0].slot = 1;
  data.passages[0].questionGroups[0].explanations[1].slot = 2;
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, true);
});

// ---------------------------------------------------------------------------
// Slot auto-calculation via normalizeExplanationData
// ---------------------------------------------------------------------------

test("normalizeExplanationData fills in missing slots", () => {
  const data = makeValidExplanation();
  const result = ExplanationDataSchema.parse(data);
  const normalized = normalizeExplanationData(result);

  const exps = normalized.passages[0].questionGroups[0].explanations;
  assert.equal(exps[0].slot, 1, "Q36 should be slot 1");
  assert.equal(exps[1].slot, 2, "Q37 should be slot 2");
});

test("normalizeExplanationData sorts by slot", () => {
  const data = makeValidExplanation();
  // Provide slots out of order — the normalizer should sort them.
  data.passages[0].questionGroups[0].explanations = [
    { questionNumber: 37, content: "Q37 content", slot: 2 },
    { questionNumber: 36, content: "Q36 content", slot: 1 },
  ];
  const result = ExplanationDataSchema.parse(data);
  const normalized = normalizeExplanationData(result);

  const exps = normalized.passages[0].questionGroups[0].explanations;
  assert.equal(exps[0].questionNumber, 36, "first should be Q36 after sort");
  assert.equal(exps[1].questionNumber, 37, "second should be Q37 after sort");
});

test("normalizeExplanationData preserves explicit slots", () => {
  const data = makeValidExplanation();
  // Explicit slots must still be within the valid range (1..2 for 36-37)
  data.passages[0].questionGroups[0].explanations[0].slot = 2;
  data.passages[0].questionGroups[0].explanations[1].slot = 1;
  const result = ExplanationDataSchema.parse(data);
  const normalized = normalizeExplanationData(result);

  const exps = normalized.passages[0].questionGroups[0].explanations;
  // After sort by slot, slot 1 comes first regardless of input order
  assert.equal(exps[0].slot, 1);
  assert.equal(exps[1].slot, 2);
  assert.equal(exps[0].questionNumber, 37);
  assert.equal(exps[1].questionNumber, 36);
});

// ---------------------------------------------------------------------------
// Validation errors — mode
// ---------------------------------------------------------------------------

test("rejects missing mode", () => {
  const data = makeValidExplanation();
  delete data.mode;
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects wrong mode", () => {
  const data = makeValidExplanation();
  data.mode = "full";
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Validation errors — required fields
// ---------------------------------------------------------------------------

test("rejects missing testTitle", () => {
  const data = makeValidExplanation();
  delete data.testTitle;
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects empty testTitle", () => {
  const data = makeValidExplanation();
  data.testTitle = "";
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects missing passages", () => {
  const data = makeValidExplanation();
  delete data.passages;
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects empty passages array", () => {
  const data = makeValidExplanation();
  data.passages = [];
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects missing questionGroups", () => {
  const data = makeValidExplanation();
  delete data.passages[0].questionGroups;
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects empty questionGroups array", () => {
  const data = makeValidExplanation();
  data.passages[0].questionGroups = [];
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects missing explanations in group", () => {
  const data = makeValidExplanation();
  delete data.passages[0].questionGroups[0].explanations;
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects empty explanations array", () => {
  const data = makeValidExplanation();
  data.passages[0].questionGroups[0].explanations = [];
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects explanation with empty content", () => {
  const data = makeValidExplanation();
  data.passages[0].questionGroups[0].explanations[0].content = "";
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects explanation with missing questionNumber", () => {
  const data = makeValidExplanation();
  delete data.passages[0].questionGroups[0].explanations[0].questionNumber;
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Validation errors — range / slot constraints
// ---------------------------------------------------------------------------

test("rejects questionNumber outside group range", () => {
  const data = makeValidExplanation();
  // Q35 is outside the 36-37 range
  data.passages[0].questionGroups[0].explanations[0].questionNumber = 35;
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects duplicate slots in same group", () => {
  const data = makeValidExplanation();
  // Both slots set to 1
  data.passages[0].questionGroups[0].explanations[0].slot = 1;
  data.passages[0].questionGroups[0].explanations[1].slot = 1;
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects slot out of range (too high)", () => {
  const data = makeValidExplanation();
  // Slot 5 is out of range for a 36-37 group (expected 1-2)
  data.passages[0].questionGroups[0].explanations[0].slot = 5;
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects questionNumberEnd < questionNumberStart", () => {
  const data = makeValidExplanation();
  data.passages[0].questionGroups[0].questionNumberStart = 37;
  data.passages[0].questionGroups[0].questionNumberEnd = 36;
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Validation errors — invalid types
// ---------------------------------------------------------------------------

test("rejects non-object input", () => {
  const result = ExplanationDataSchema.safeParse("not an object");
  assert.equal(result.success, false);
});

test("rejects non-array passages", () => {
  const data = makeValidExplanation();
  data.passages = "not an array";
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects non-string content in explanation", () => {
  const data = makeValidExplanation();
  data.passages[0].questionGroups[0].explanations[0].content = 123;
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects non-string range", () => {
  const data = makeValidExplanation();
  data.passages[0].questionGroups[0].range = 123;
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects invalid existingQuizUrl (not a URL)", () => {
  const data = makeValidExplanation();
  data.existingQuizUrl = "not-a-url";
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Multi-passage / multi-group
// ---------------------------------------------------------------------------

test("valid multi-passage JSON with multiple groups", () => {
  const data = makeValidExplanation();
  data.passages.push({
    passage: 2,
    questionGroups: [
      {
        range: "1-5",
        questionNumberStart: 1,
        questionNumberEnd: 5,
        explanations: [
          { questionNumber: 1, content: "Q1" },
          { questionNumber: 2, content: "Q2" },
          { questionNumber: 3, content: "Q3" },
          { questionNumber: 4, content: "Q4" },
          { questionNumber: 5, content: "Q5" },
        ],
      },
    ],
  });
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, true);
  assert.equal(result.data.passages.length, 2);
});

test("normalizeExplanationData handles multiple groups correctly", () => {
  const data = makeValidExplanation();
  data.passages[0].questionGroups.push({
    range: "38-40",
    questionNumberStart: 38,
    questionNumberEnd: 40,
    explanations: [
      { questionNumber: 38, content: "Q38" },
      { questionNumber: 40, content: "Q40" },
      { questionNumber: 39, content: "Q39" },  // deliberately out of order
    ],
  });
  const result = ExplanationDataSchema.parse(data);
  const normalized = normalizeExplanationData(result);

  const g2 = normalized.passages[0].questionGroups[1];
  // Q38 = slot 1, Q39 = slot 2, Q40 = slot 3
  assert.equal(g2.explanations[0].slot, 1);
  assert.equal(g2.explanations[0].questionNumber, 38);
  assert.equal(g2.explanations[1].slot, 2);
  assert.equal(g2.explanations[1].questionNumber, 39);
  assert.equal(g2.explanations[2].slot, 3);
  assert.equal(g2.explanations[2].questionNumber, 40);
});

// ---------------------------------------------------------------------------
// Example fixture
// ---------------------------------------------------------------------------

test("example fixture parses and normalizes", async () => {
  const raw = await readFile(
    resolve(fixturesDir, "explanation-example.json"),
    "utf8",
  );
  const parsed = JSON.parse(raw);
  const result = ExplanationDataSchema.safeParse(parsed);
  assert.equal(result.success, true, `example fixture should validate, got ${JSON.stringify(result.success ? null : result.error.issues)}`);

  const normalized = normalizeExplanationData(result.data);
  assert.equal(normalized.mode, "explanation");
  assert.equal(normalized.testTitle, "Cam 17 Reading Test 01");
  assert.equal(normalized.passages.length, 1);
  assert.equal(normalized.passages[0].questionGroups.length, 1);

  const g = normalized.passages[0].questionGroups[0];
  assert.equal(g.explanations.length, 2);
  assert.equal(g.explanations[0].slot, 1);
  assert.equal(g.explanations[1].slot, 2);
  assert.equal(g.explanations[0].content.includes("population"), true);
  assert.equal(g.explanations[1].content.includes("suburbs"), true);
});

// ---------------------------------------------------------------------------
// superRefine: explanation count within range
// ---------------------------------------------------------------------------

test("rejects more explanations than range allows", () => {
  const data = makeValidExplanation();
  // Range is 36-37 (2 slots), but we add a third explanation
  data.passages[0].questionGroups[0].explanations.push({
    questionNumber: 36,
    content: "extra",
  });
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("rejects fewer explanations than range allows (wrong questionNumber)", () => {
  const data = makeValidExplanation();
  // Both explanations reference Q36, nothing for Q37 — but the range
  // is 36-37 which means 2 slots expected. The schema doesn't require
  // all slots to be filled, but it does require questionNumber to be
  // within range. So both Q36 is fine.
  data.passages[0].questionGroups[0].explanations[1].questionNumber = 36;
  // Now we have two Q36 entries with auto-slots 1 and 1 → duplicate!
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false, "duplicate auto-slot 1 should fail");
});

// ---------------------------------------------------------------------------
// Blank explanations
// ---------------------------------------------------------------------------

test("blank=true without content parses successfully", () => {
  const data = makeValidExplanation();
  data.passages[0].questionGroups[0].explanations[0] = {
    questionNumber: 36,
    blank: true,
  };
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, true, `blank slot should be valid, got ${JSON.stringify(result.success ? null : result.error.issues)}`);
});

test("blank=true with content still parses (content ignored)", () => {
  const data = makeValidExplanation();
  data.passages[0].questionGroups[0].explanations[0] = {
    questionNumber: 36,
    content: "this should be ignored",
    blank: true,
  };
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, true);
});

test("blank=true with empty content parses", () => {
  const data = makeValidExplanation();
  data.passages[0].questionGroups[0].explanations[0] = {
    questionNumber: 36,
    content: "",
    blank: true,
  };
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, true);
});

test("missing content without blank still rejected", () => {
  const data = makeValidExplanation();
  data.passages[0].questionGroups[0].explanations[0] = {
    questionNumber: 36,
    // no content, no blank
  };
  const result = ExplanationDataSchema.safeParse(data);
  assert.equal(result.success, false);
});

test("normalizeExplanationData preserves blank flag and clears content", () => {
  const data = makeValidExplanation();
  data.passages[0].questionGroups[0].explanations[0] = {
    questionNumber: 36,
    content: "ignored text",
    blank: true,
  };
  const result = ExplanationDataSchema.parse(data);
  const normalized = normalizeExplanationData(result);

  const exp = normalized.passages[0].questionGroups[0].explanations[0];
  assert.equal(exp.blank, true, "blank flag preserved");
  assert.equal(exp.content, "", "content cleared when blank=true");
  assert.equal(exp.slot, 1, "slot still auto-calculated");
});

test("normalizeExplanationData sets blank=false for non-blank slots", () => {
  const data = makeValidExplanation();
  const result = ExplanationDataSchema.parse(data);
  const normalized = normalizeExplanationData(result);

  const exp = normalized.passages[0].questionGroups[0].explanations[0];
  assert.equal(exp.blank, false, "blank=false for normal slot");
  assert.equal(exp.content, "<p>Explanation for Q36</p>", "content preserved");
});

test("blank=true takes precedence over content in same slot", () => {
  const data = makeValidExplanation();
  data.passages[0].questionGroups[0].explanations[0] = {
    questionNumber: 36,
    content: "some text",
    blank: true,
  };
  data.passages[0].questionGroups[0].explanations[1] = {
    questionNumber: 37,
    content: "<p>Q37 content</p>",
  };
  const result = ExplanationDataSchema.parse(data);
  const normalized = normalizeExplanationData(result);

  assert.equal(normalized.passages[0].questionGroups[0].explanations[0].blank, true);
  assert.equal(normalized.passages[0].questionGroups[0].explanations[0].content, "");
  assert.equal(normalized.passages[0].questionGroups[0].explanations[1].blank, false);
  assert.equal(normalized.passages[0].questionGroups[0].explanations[1].content, "<p>Q37 content</p>");
});
