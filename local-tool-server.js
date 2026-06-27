#!/usr/bin/env node
/**
 * local-tool-server.js
 *
 * Zero-dep Node server (uses only `node:http` + `node:fs`) that:
 *   1. Serves static files from the project root (so src/input/localInput.html
 *      is reachable at http://localhost:8000/src/input/localInput.html).
 *   2. Accepts POST /api/upload with a JSON body that contains:
 *        {
 *          mode: "ui-full" | "api-questions",
 *          json: { ...the normalized ReadingQuizSchema... },
 *          quizId?: string,        // required when mode=api-questions
 *          postId?: string,        // required when mode=api-questions
 *        }
 *      It writes the JSON to generated/latest-quiz.json, spawns the right
 *      `node bin/upload.js` command, and streams stdout+stderr line-by-line
 *      to the browser as plain text over a chunked HTTP response.
 *
 * Run:
 *   node local-tool-server.js
 *   PORT=8001 node local-tool-server.js
 *
 * Open:
 *   http://localhost:8000/src/input/localInput.html
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs, createReadStream, statSync, appendFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = parseInt(process.env.PORT || "8000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const GENERATED_DIR = join(__dirname, "generated");
const GENERATED_FILE = join(GENERATED_DIR, "latest-quiz.json");

// -----------------------------------------------------------------------------
// MIME types
// -----------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".md":   "text/markdown; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
};

// -----------------------------------------------------------------------------
// Static file serving
// -----------------------------------------------------------------------------
/**
 * Resolve a URL pathname to a file path under the project root, with safety:
 *   - normalize and reject any ".."
 *   - 404 if not found, 403 if escapes the root
 */
function safeResolve(pathname) {
  // Strip leading slash; default to index.html.
  let p = pathname === "/" ? "/index.html" : pathname;
  p = normalize(p);
  if (p.includes("..")) return null;
  const abs = resolve(join(__dirname, p));
  if (!abs.startsWith(__dirname)) return null;
  return abs;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const filePath = safeResolve(url.pathname);
  if (!filePath) {
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("Forbidden");
  }
  let abs;
  try {
    const st = statSync(filePath);
    if (st.isDirectory()) {
      abs = join(filePath, "index.html");
    } else {
      abs = filePath;
    }
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not found: " + url.pathname);
  }
  const mime = MIME[extname(abs).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": mime,
    "cache-control": "no-cache",
  });
  createReadStream(abs).pipe(res);
}

// -----------------------------------------------------------------------------
// POST /api/upload
// -----------------------------------------------------------------------------
async function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      // 2 MB cap — enough for hundreds of questions, far less than memory pressure.
      if (size > 2 * 1024 * 1024) {
        rejectBody(new Error("payload too large (>2MB)"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

async function handleUpload(req, res) {
  let raw;
  try {
    raw = await readJsonBody(req);
  } catch (err) {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("Bad request: " + err.message);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("Bad request: invalid JSON: " + err.message);
  }

  const { mode, json, quizId, postId, useAutoLogin, loginEmail, loginPassword } = body || {};

  // --- HARD DIAGNOSTIC: write to file so we can verify even if console is lost ---
  const diagLines = [
    `[${new Date().toISOString()}] RECEIVED from UI:`,
    `  mode: ${mode}`,
    `  useAutoLogin: ${useAutoLogin} (type: ${typeof useAutoLogin})`,
    `  loginEmail: ${loginEmail || "(empty)"}`,
    `  hasPassword: ${!!loginPassword}`,
    `  bodyKeys: ${Object.keys(body || {}).join(", ")}`,
  ];
  try {
    await fs.mkdir(GENERATED_DIR, { recursive: true });
    appendFileSync(join(GENERATED_DIR, "_server-diag.txt"), diagLines.join("\n") + "\n");
  } catch { /* best effort */ }
  console.log(diagLines.join("\n"));

  if (!mode || (mode !== "ui-full" && mode !== "api-questions" && mode !== "explanation")) {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("Bad request: mode must be 'ui-full', 'api-questions', or 'explanation'");
  }
  if (!json || typeof json !== "object") {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("Bad request: missing `json` payload");
  }
  if (mode === "api-questions" && (!quizId || !postId)) {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("Bad request: api-questions mode requires `quizId` and `postId`");
  }

  // 1. Strip _autoLogin from json (credentials never go to disk)
  if (json._autoLogin) {
    delete json._autoLogin;
  }

  // 2. Write the JSON to generated/latest-quiz.json.
  try {
    await fs.mkdir(GENERATED_DIR, { recursive: true });
    await fs.writeFile(GENERATED_FILE, JSON.stringify(json, null, 2) + "\n", "utf8");
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    return res.end("Server error: failed to write generated/latest-quiz.json: " + err.message);
  }

  // 2. Build the upload command.
  const args = ["bin/upload.js", GENERATED_FILE];
  if (mode === "explanation") {
    args.push("--explanation");
  } else {
    args.push("--fresh");
    if (mode === "api-questions") {
      args.push("--api-questions", "--quiz-id", quizId, "--post-id", postId);
    }
  }

  // Pass auto-login as CLI flags (more reliable than env vars through spawn)
  if (useAutoLogin && loginEmail && loginPassword) {
    args.push("--auto-login", "--email", loginEmail, "--password", loginPassword);
  }

  // 3. Stream logs back as plain text, line-by-line.
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-cache",
    "x-upload-mode": mode,
    "x-upload-command": "node " + args.join(" "),
  });

  // Log command with masked password
  const maskedArgs = args.map(a => {
    if (a === loginPassword) return "(hidden)";
    if (a.includes("@") && a !== loginEmail) return `"${a}"`;
    return a;
  });
  console.log("[server] $ node " + maskedArgs.join(" "));
  res.write("$ node " + maskedArgs.join(" ") + "\n");
  res.write("[saved " + GENERATED_FILE + "]\n\n");

  // Pipe stdout/stderr so we can stream them to the browser AND log to server console.
  // Use 'ipc' only if needed; default: pipe stdout+stderr, ignore stdin.
  const child = spawn("node", args, {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Stream stdout and stderr to the browser response AND server console.
  child.stdout.on("data", (chunk) => {
    const line = chunk.toString();
    console.log(line); // server-side log
    res.write(line);
  });

  child.stderr.on("data", (chunk) => {
    const line = chunk.toString();
    console.error(line); // server-side log (stderr)
    res.write(line);
  });

  child.on("error", (err) => {
    const msg = "\n[spawn error] " + err.message + "\n";
    console.error(msg);
    res.write(msg);
    res.end();
  });

  child.on("close", (code) => {
    const msg = "\n[exit " + (code ?? "null") + "]\n";
    console.log(msg);
    res.write(msg);
    res.end();
  });
}

// -----------------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS for the local page (file:// or http://).
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === "/api/upload" && req.method === "POST") {
    return handleUpload(req, res);
  }

  if (req.method === "GET") {
    return serveStatic(req, res);
  }

  res.writeHead(405, { "content-type": "text/plain" });
  res.end("Method not allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`local-tool-server listening on http://${HOST}:${PORT}`);
  console.log(`open: http://localhost:${PORT}/src/input/localInput.html`);
});

// Graceful shutdown.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n${sig} received, closing server…`);
    server.close(() => process.exit(0));
  });
}
