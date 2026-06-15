#!/usr/bin/env node
/**
 * ProQyz IELTS Automation — CLI entry.
 *
 * Usage:
 *   node bin/upload.js <path-to-quiz.json> [options]
 *   node bin/upload.js ./quizzes/                  # bulk folder (Phase 3)
 *   node bin/upload.js --from-localhost <url>      # fetch JSON from a local page
 *
 * Options:
 *   --dry-run                 Record intended actions without clicking.
 *   --fresh                   Ignore any existing checkpoint; start over.
 *   --on-duplicate=skip       On duplicate question, skip (default).
 *   --on-duplicate=update     On duplicate question, update.
 *   --on-duplicate=fail       On duplicate question, fail.
 *   --publish                 Print review URL and instruct to publish.
 *   --skip-review             Skip the human review pause (CI use).
 *   --from-localhost URL      Fetch the JSON payload from a local URL
 *                             (e.g. http://localhost:8000/src/input/localInput.html
 *                             serving the page, or any /api/quizzes endpoint
 *                             that returns the uploader-shaped JSON).
 *                             The response must have Content-Type: application/json
 *                             OR be a <pre id="jsonOut"> HTML page from which
 *                             the JSON is extracted.
 *   --questions-only          Sanity check: require mode=questionsOnly and
 *                             existingQuizUrl in the JSON. (The JSON field
 *                             is the source of truth; this flag is a
 *                             guard rail for typos in CI.)
 *   --publish-existing URL    Publish an existing draft quiz by URL.
 *   --api-questions           Use the ProQyz internal API to create
 *                             questions directly. Requires --quiz-id and
 *                             --post-id. (Stub for now — see Part 3 of
 *                             the master plan; flag is accepted and
 *                             acknowledged so the local tool server can
 *                             drive the right code path.)
 *   --quiz-id <id>            Quiz id (for --api-questions).
 *   --post-id <id>            Post id (for --api-questions).
 *   -h, --help                Show this help.
 */

import { statSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQuiz, publishExistingQuiz } from "../src/pipeline/run.js";
import { runExplanation } from "../src/pipeline/runExplanation.js";
import { runBulkFromDir } from "../src/pipeline/runBulk.js";
import { log } from "../src/logger.js";

// --- HARD DIAGNOSTIC: write env state to file so we can verify ---
const _diagPath = join(process.cwd(), "generated", "_auto-login-diag.txt");
try {
  const lines = [
    `timestamp: ${new Date().toISOString()}`,
    `PROQYZ_AUTO_LOGIN: ${process.env.PROQYZ_AUTO_LOGIN ?? "(undefined)"}`,
    `PROQYZ_LOGIN_EMAIL: ${process.env.PROQYZ_LOGIN_EMAIL ?? "(undefined)"}`,
    `PROQYZ_LOGIN_PASSWORD: ${process.env.PROQYZ_LOGIN_PASSWORD ? "(set)" : "(empty/undefined)"}`,
    `pid: ${process.pid}`,
    `cwd: ${process.cwd()}`,
    `argv: ${process.argv.join(" ")}`,
    `envKeys(PROQYZ): ${Object.keys(process.env).filter(k => k.startsWith("PROQYZ")).join(", ") || "(none)"}`,
  ];
  writeFileSync(_diagPath, lines.join("\n") + "\n");
  process.stderr.write("[upload.js ENV DIAG] " + lines.join(" | ") + "\n");
} catch { /* best effort */ }

function printHelp() {
  console.log(`ProQyz IELTS Automation

Usage:
  node bin/upload.js <path-to-quiz.json> [options]
  node bin/upload.js ./quizzes/                       # bulk folder (Phase 3)
  node bin/upload.js --from-localhost <url>           # fetch JSON from local
  node bin/upload.js --publish-existing <url>         # publish an existing draft

Options:
  --dry-run                 Record intended actions without clicking.
  --fresh                   Ignore any existing checkpoint; start over.
  --on-duplicate=skip       On duplicate question, skip (default).
  --on-duplicate=update     On duplicate question, update.
  --on-duplicate=fail       On duplicate question, fail.
  --publish                 Print review URL and instruct to publish.
  --skip-review             Skip the human review pause (CI use).
  --from-localhost URL      Fetch JSON from a local URL (or local page).
  --questions-only          Require mode=questionsOnly + existingQuizUrl.
  --publish-existing URL    Publish an existing draft quiz by URL.
  --api-questions           Stub: ack flag, no upload yet (Part 3).
  --quiz-id <id>            Quiz id for --api-questions.
  --post-id <id>            Post id for --api-questions.
  --explanation             Upload explanations to existing questions.
  --auto-login              Attempt auto-login before manual login.
  --login-email <email>     Email/username for auto-login.
  --login-password <pass>   Password for auto-login (kept in memory only).
  -h, --help                Show this help.

Three upload modes are supported by the JSON's "mode" field:

  1. full  (default) — create quiz + passage + questions + save.
     \`node bin/upload.js quizzes/cam17-test01.json\`

  2. questionsOnly — open an existing quiz, only add questions.
     The JSON must include: "mode": "questionsOnly" + "existingQuizUrl".
     \`node bin/upload.js fixtures/local-only-questions.json --questions-only\`

  3. --from-localhost — fetch the JSON from a local server.
     Useful with src/input/localInput.html served by python3 -m http.server
     or local-tool-server.js.
     \`node bin/upload.js --from-localhost http://localhost:8000/api/quiz\`

  4. --api-questions (stub) — placeholder for the ProQyz internal-API
     path (Part 3 of the master plan). The flag is accepted and the
     CLI exits cleanly. The full implementation lands in a follow-up.
     \`node bin/upload.js generated/latest-quiz.json --api-questions --quiz-id <id> --post-id <id>\`
`);
}

/**
 * Tiny arg parser. No deps — keeps the CLI small.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  /** @type {Record<string, string | boolean>} */
  const opts = {};
  /** @type {string[]} */
  const positionals = [];
  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--fresh") {
      opts.fresh = true;
      continue;
    }
    if (arg === "--publish") {
      opts.publish = true;
      continue;
    }
    if (arg === "--skip-review") {
      opts.skipReview = true;
      continue;
    }
    if (arg === "--questions-only") {
      opts.questionsOnly = true;
      continue;
    }
    if (arg === "--api-questions") {
      opts.apiQuestions = true;
      continue;
    }
    if (arg === "--explanation") {
      opts.explanation = true;
      continue;
    }
    if (arg === "--auto-login") {
      opts.autoLogin = true;
      continue;
    }
    if (arg.startsWith("--login-email=") || arg.startsWith("--email=")) {
      opts.loginEmail = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "";
      continue;
    }
    if (arg === "--login-email" || arg === "--email") {
      opts.loginEmailNext = true;
      continue;
    }
    if (opts.loginEmailNext) {
      opts.loginEmail = arg;
      opts.loginEmailNext = false;
      continue;
    }
    if (arg.startsWith("--login-password=") || arg.startsWith("--password=")) {
      opts.loginPassword = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "";
      continue;
    }
    if (arg === "--login-password" || arg === "--password") {
      opts.loginPasswordNext = true;
      continue;
    }
    if (opts.loginPasswordNext) {
      opts.loginPassword = arg;
      opts.loginPasswordNext = false;
      continue;
    }
    if (arg.startsWith("--quiz-id=")) {
      opts.quizId = arg.slice("--quiz-id=".length);
      continue;
    }
    if (arg === "--quiz-id") {
      opts.quizIdNext = true;
      continue;
    }
    if (opts.quizIdNext) {
      opts.quizId = arg;
      opts.quizIdNext = false;
      continue;
    }
    if (arg.startsWith("--post-id=")) {
      opts.postId = arg.slice("--post-id=".length);
      continue;
    }
    if (arg === "--post-id") {
      opts.postIdNext = true;
      continue;
    }
    if (opts.postIdNext) {
      opts.postId = arg;
      opts.postIdNext = false;
      continue;
    }
    if (arg.startsWith("--on-duplicate=")) {
      opts.onDuplicate = arg.slice("--on-duplicate=".length);
      continue;
    }
    if (arg.startsWith("--publish-existing=")) {
      opts.publishExisting = arg.slice("--publish-existing=".length);
      continue;
    }
    if (arg.startsWith("--from-localhost=")) {
      opts.fromLocalhost = arg.slice("--from-localhost=".length);
      continue;
    }
    if (arg === "--from-localhost") {
      // Allow space-separated form too: --from-localhost <url>
      opts.fromLocalhostNext = true;
      continue;
    }
    if (opts.fromLocalhostNext) {
      opts.fromLocalhost = arg;
      opts.fromLocalhostNext = false;
      continue;
    }
    if (arg.startsWith("--")) {
      log.warn({ arg }, "unknown flag, ignoring");
      continue;
    }
    positionals.push(arg);
  }
  return { opts, positionals };
}

async function main() {
  const { opts, positionals } = parseArgs(process.argv);

  // Short-circuit: --publish-existing doesn't need a positional input.
  if (opts.publishExisting) {
    try {
      await publishExistingQuiz(opts.publishExisting, opts);
    } catch (err) {
      log.pipeline.error({ err: err.message }, "publish failed");
      process.exit(1);
    }
    return;
  }

  // --api-questions (stub): ack the flag, validate ids, log a clear
  // "not yet implemented" message, and exit 0. The full ProQyz API
  // question creation lands in Part 3 of the master plan. We accept
  // the flag now so the local tool server can route traffic without
  // hitting the Playwright path.
  if (opts.apiQuestions) {
    if (!opts.quizId || !opts.postId) {
      log.pipeline.error(
        "--api-questions requires both --quiz-id and --post-id",
      );
      process.exit(2);
    }
    log.pipeline.info(
      { quizId: opts.quizId, postId: opts.postId },
      "--api-questions: stub mode (Part 3 not yet implemented). " +
        "Nothing was uploaded. " +
        "Use --questions-only UI mode for now.",
    );
    if (positionals[0]) {
      log.pipeline.info(
        { file: positionals[0] },
        "--api-questions: would have used this JSON file",
      );
    }
    return;
  }

  // --explanation: upload explanations to existing questions.
  if (opts.explanation) {
    if (positionals.length === 0) {
      log.pipeline.error("--explanation requires a JSON file path");
      process.exit(1);
    }
    const inputPath = positionals[0];
    try {
      const raw = readFileSync(inputPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.mode !== "explanation") {
        log.pipeline.error(
          { mode: parsed.mode },
          '--explanation: JSON does not have mode: "explanation"',
        );
        process.exit(1);
      }
    } catch (err) {
      log.pipeline.error({ err: err.message }, "--explanation: failed to read JSON");
      process.exit(1);
    }
    // Pass auto-login from CLI flags to env vars (pipeline reads from process.env)
    if (opts.autoLogin && opts.loginEmail && opts.loginPassword) {
      process.env.PROQYZ_AUTO_LOGIN = "1";
      process.env.PROQYZ_LOGIN_EMAIL = opts.loginEmail;
      process.env.PROQYZ_LOGIN_PASSWORD = opts.loginPassword;
    }
    await runExplanation({ inputPath, dryRun: opts.dryRun });
    return;
  }

  // --from-localhost <url>: fetch JSON from a local server.
  // Two response shapes are supported:
  //   1. Content-Type: application/json — the body IS the JSON.
  //   2. Content-Type: text/html — the response is the local input
  //      page itself; we extract the JSON from the <pre id="jsonOut">
  //      element via a regex (cheap and avoids a DOM dep).
  let inputPath;
  if (opts.fromLocalhost) {
    inputPath = await fetchFromLocalhost(opts.fromLocalhost);
  } else if (positionals.length === 0) {
    printHelp();
    process.exit(1);
  } else {
    inputPath = positionals[0];
  }

  // --questions-only safety check: ensure the JSON declares
  // mode=questionsOnly and has an existingQuizUrl. (The pipeline
  // would also catch this; this is a friendlier early-fail with
  // the exact reason.)
  if (opts.questionsOnly) {
    try {
      const raw = readFileSync(inputPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.mode !== "questionsOnly") {
        log.pipeline.error(
          { mode: parsed.mode },
          "--questions-only: JSON does not have mode: \"questionsOnly\"",
        );
        process.exit(1);
      }
      if (!parsed.existingQuizUrl) {
        log.pipeline.error(
          "--questions-only: JSON is missing existingQuizUrl",
        );
        process.exit(1);
      }
    } catch (err) {
      log.pipeline.error(
        { err: err.message },
        "--questions-only: failed to inspect JSON for guard rails",
      );
      process.exit(1);
    }
  }

  // Detect single-quiz vs bulk-folder mode.
  let isDir = false;
  try {
    isDir = statSync(inputPath).isDirectory();
  } catch (err) {
    log.pipeline.error({ inputPath, err: err.message }, "path not found");
    process.exit(1);
  }

  try {
    if (isDir) {
      const results = await runBulkFromDir(inputPath, opts);
      const failed = results.filter((r) => r.status === "failed").length;
      if (failed > 0) {
        log.pipeline.error(
          { failed, total: results.length },
          `${failed} of ${results.length} quizzes failed`,
        );
        process.exit(1);
      }
    } else {
      await runQuiz({ inputPath, ...opts });
    }
  } catch (err) {
    log.pipeline.error({ err: err.message }, "run failed");
    process.exit(1);
  }
}

/**
 * Fetch a JSON payload from a local URL and write it to a temp file
 * (so the existing loadQuizFromJson → QuizSchema path works unchanged).
 *
 * Two response shapes:
 *   1. application/json — body is the JSON; write as-is.
 *   2. text/html — response is the localInput page; extract the
 *      <pre id="jsonOut"> contents and parse.
 *
 * @param {string} url
 * @returns {Promise<string>} the temp file path containing the JSON
 */
async function fetchFromLocalhost(url) {
  log.pipeline.info({ url }, "--from-localhost: fetching");
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`--from-localhost: HTTP ${res.status} from ${url}`);
  }
  const contentType = res.headers.get("content-type") || "";
  const body = await res.text();

  let jsonText;
  if (contentType.includes("application/json")) {
    jsonText = body;
  } else {
    // HTML mode: extract <pre id="jsonOut">...</pre>
    const m = body.match(
      /<pre\s+id="jsonOut"[^>]*>([\s\S]*?)<\/pre>/i,
    );
    if (!m) {
      throw new Error(
        "--from-localhost: response is HTML but contains no <pre id=\"jsonOut\">. " +
          "Either serve JSON with Content-Type: application/json, or load the " +
          "local input page in a browser first so the <pre> is populated.",
      );
    }
    // The HTML-escaped JSON is in the <pre> text node. Decode common
    // entities (the page's body uses &quot; &amp; &lt; &gt;).
    jsonText = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  // Validate it parses before writing, so we surface a clear error.
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `--from-localhost: extracted text is not valid JSON: ${err.message}`,
    );
  }

  // Write to a temp file so downstream code is identical to a
  // regular `node bin/upload.js file.json` invocation.
  const dir = mkdtempSync(join(tmpdir(), "proqyz-from-localhost-"));
  const out = join(dir, "quiz.json");
  writeFileSync(out, JSON.stringify(parsed, null, 2), "utf8");
  log.pipeline.info(
    { url, path: out, questions: parsed.passages?.[0]?.questions?.length ?? 0 },
    "--from-localhost: written",
  );
  return out;
}

main();
