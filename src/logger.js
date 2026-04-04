import { config } from "./config.js";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

function timestamp() {
  return new Date().toISOString();
}

/**
 * Serialize an argument for logging.
 * Error objects are expanded to include their stack trace.
 * @param {unknown} arg
 * @returns {unknown}
 */
function serialize(arg) {
  if (arg instanceof Error) {
    return arg.stack ?? arg.message;
  }
  return arg;
}

function log(level, ...args) {
  if (LEVELS[level] >= currentLevel) {
    const prefix = `[${timestamp()}] [${level.toUpperCase()}]`;
    const serialized = args.map(serialize);
    if (level === "error") {
      console.error(prefix, ...serialized);
    } else {
      console.log(prefix, ...serialized);
    }
  }
}

/**
 * Returns a function that, when called, logs the elapsed time since the timer
 * was created and returns the elapsed milliseconds.
 *
 * @param {string} label
 * @param {string} [level]
 * @returns {() => number}
 */
function timer(label, level = "debug") {
  const start = Date.now();
  return () => {
    const elapsed = Date.now() - start;
    log(level, `${label} completed in ${elapsed}ms`);
    return elapsed;
  };
}

export const logger = {
  debug: (...args) => log("debug", ...args),
  info: (...args) => log("info", ...args),
  warn: (...args) => log("warn", ...args),
  error: (...args) => log("error", ...args),
  /** Create a latency timer. Call the returned function to log elapsed time. */
  timer,
};
