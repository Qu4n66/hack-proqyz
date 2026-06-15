import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

/**
 * Load .env file into process.env if it exists. Minimal implementation —
 * we don't want to pull in dotenv for a single config file.
 */
function loadDotenv() {
  const envPath = resolve(projectRoot, ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotenv();

const baseUrl = (process.env.PROQYZ_BASE_URL || "https://app.proqyz.com").replace(/\/+$/, "");
const profileDir = process.env.PROQYZ_PROFILE_DIR || `${homedir()}/.proqyz-automation/profile`;
const storageStatePath = process.env.PROQYZ_STORAGE_STATE || resolve(projectRoot, "storageState.json");

export const config = {
  baseUrl,
  profileDir,
  storageStatePath,

  /** Max time we'll wait for the user to log in manually on first run. */
  manualLoginTimeoutMs: 120_000,

  /** Default per-action timeout for Playwright operations. */
  actionTimeoutMs: 15_000,

  /** Default per-quiz save timeout. */
  saveTimeoutMs: 30_000,

  /** Pause between actions (ms). Adds jitter to avoid looking like a bot. */
  actionJitterMs: { min: 50, max: 150 },

  paths: {
    projectRoot,
    checkpointsDir: resolve(projectRoot, "checkpoints"),
    failuresDir: resolve(projectRoot, "failures"),
    fixturesDir: resolve(projectRoot, "fixtures"),
  },

  logLevel: process.env.LOG_LEVEL || "info",
};
