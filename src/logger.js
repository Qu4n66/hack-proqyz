import pino from "pino";
import { config } from "./config.js";

/**
 * Single pino logger instance. Pretty-printed for local dev, JSON in CI.
 */
const isCI = process.env.CI === "true" || process.env.NODE_ENV === "production";

export const logger = pino({
  level: config.logLevel,
  base: { app: "proqyz-ielts-automation" },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: isCI
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname,app" },
      },
});

/**
 * Convenience child loggers for sub-systems.
 */
export const log = {
  auth: logger.child({ mod: "auth" }),
  uploader: logger.child({ mod: "uploader" }),
  checkpoint: logger.child({ mod: "checkpoint" }),
  pipeline: logger.child({ mod: "pipeline" }),
  input: logger.child({ mod: "input" }),
  editor: logger.child({ mod: "editor" }),
  radio: logger.child({ mod: "radio" }),
};
