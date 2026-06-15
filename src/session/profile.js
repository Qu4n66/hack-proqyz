/**
 * Persistent Chromium profile management.
 *
 * The profile dir is shared across runs. Cookies, localStorage, and IndexedDB
 * persist there so the user only logs in once.
 */

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { config } from "../config.js";
import { log } from "../logger.js";

/**
 * Ensure the profile directory exists. Safe to call repeatedly.
 */
export async function ensureProfileDir() {
  if (!existsSync(config.profileDir)) {
    await mkdir(config.profileDir, { recursive: true });
    log.auth.debug({ dir: config.profileDir }, "created profile dir");
  }
  return config.profileDir;
}
