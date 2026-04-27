import { spawn } from "child_process";
import fs from "fs";
import { config } from "../config.js";
import { logger } from "../logger.js";

/** @type {import("child_process").ChildProcess | null} */
let vpsProcess = null;

/**
 * Simple shell-like argument splitter that respects single and double quoted
 * strings and backslash escapes within double-quoted strings.
 * @param {string} str
 * @returns {string[]}
 */
function shellSplit(str) {
  const args = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "\\" && inDouble && i + 1 < str.length) {
      // In double-quoted context, backslash escapes the next character
      current += str[++i];
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

/**
 * Extracts the port number from a URL string.
 * @param {string} url
 * @returns {number}
 */
function extractPort(url) {
  try {
    const parsed = new URL(url);
    const port = parseInt(parsed.port, 10);
    return port > 0 ? port : 8080;
  } catch {
    return 8080;
  }
}

/**
 * Starts the VPS llama-server process.
 * Reads binary path, model path, port, context size, and extra args from config.
 * Polls GET /health every 1 s until it returns {"status":"ok"}, timeout 60 s.
 * @returns {Promise<void>}
 */
export async function startVpsLlamaServer() {
  if (!config.vpsLlama.enabled) {
    logger.info("[vpsLlama] VPS_LLAMA_ENABLED=false — skipping llama-server launch");
    return;
  }

  const bin = config.vpsLlama.bin;
  const modelPath = config.vpsLlama.modelPath;
  const port = extractPort(config.llama.vpsUrl);
  const contextSize = config.llama.contextSizeVps;
  const extraArgs = config.llama.extraArgsVps;

  if (!modelPath) {
    throw new Error("[vpsLlama] VPS_MODEL_PATH is required when VPS_LLAMA_ENABLED=true");
  }

  if (!fs.existsSync(bin)) {
    throw new Error(`[vpsLlama] llama-server binary not found: ${bin}`);
  }

  const args = [
    "-m", modelPath,
    "--host", "127.0.0.1",
    "--port", String(port),
  ];

  if (contextSize > 0) {
    args.push("-c", String(contextSize));
  }

  if (extraArgs) {
    args.push(...shellSplit(extraArgs));
  }

  logger.info(`[vpsLlama] Spawning llama-server: ${bin} ${args.join(" ")}`);

  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

  proc.stdout.on("data", (data) => {
    logger.debug(`[vpsLlama] ${data.toString().trim()}`);
  });

  proc.stderr.on("data", (data) => {
    logger.debug(`[vpsLlama] ${data.toString().trim()}`);
  });

  proc.on("error", (err) => {
    if (vpsProcess === proc) {
      logger.error(`[vpsLlama] llama-server process error: ${err.message}`);
    }
  });

  proc.on("exit", (code) => {
    if (vpsProcess === proc) {
      // vpsProcess still points to this proc — exit was not triggered by stopVpsLlamaServer
      vpsProcess = null;
      logger.warn(`[vpsLlama] llama-server exited unexpectedly (code ${code})`);
    }
  });

  vpsProcess = proc;

  // Poll GET /health every 1 s, timeout after 60 s
  const POLL_INTERVAL_MS = 1_000;
  const TIMEOUT_MS = 60_000;
  const HEALTH_CHECK_TIMEOUT_MS = 2_000;
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.status === "ok") {
          logger.info(`[vpsLlama] llama-server ready on port ${port}`);
          return;
        }
      }
    } catch {
      // Not ready yet — keep polling
    }

    // Check if the process died while we were waiting
    if (vpsProcess !== proc) {
      throw new Error("[vpsLlama] llama-server exited before becoming ready");
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Health check timed out — kill the process and throw
  vpsProcess = null;
  try {
    proc.kill();
  } catch {
    // Ignore — process may already be gone
  }
  throw new Error(`[vpsLlama] llama-server did not become ready within ${TIMEOUT_MS / 1000}s`);
}

/**
 * Sends a minimal inference request to the VPS llama-server to warm up the
 * model (load weights into VRAM / populate KV cache) so the first real user
 * message is not delayed by a cold start.
 *
 * Non-fatal: a failure is logged as a warning but does NOT throw.
 *
 * @returns {Promise<void>}
 */
export async function warmupVpsModel() {
  try {
    const WARMUP_TIMEOUT_MS = 30_000;
    const url = config.llama.vpsUrl;

    logger.info("[vpsLlama] Warming up model (sending minimal inference request)…");

    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: config.llm.systemPromptVps },
          { role: "user",   content: "Hi" },
        ],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
    });

    if (res.ok) {
      logger.info("[vpsLlama] Model warm-up complete");
    } else {
      const text = await res.text().catch(() => "(unreadable)");
      logger.warn(`[vpsLlama] Warm-up request returned non-OK status ${res.status}: ${text}`);
    }
  } catch (err) {
    logger.warn(`[vpsLlama] Warm-up request failed (non-fatal): ${err.message}`);
  }
}

/**
 * Stops the VPS llama-server process.
 * Sends SIGTERM, waits up to 5 s, then SIGKILLs if still running.
 * No-op if the process was never started or already exited.
 * @returns {Promise<void>}
 */
export async function stopVpsLlamaServer() {
  const proc = vpsProcess;
  if (!proc) {
    return;
  }

  // Clear the reference before sending the signal so the "exit" handler does
  // not log this as an unexpected exit.
  vpsProcess = null;

  return new Promise((resolve) => {
    const sigkillTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process likely already gone
      }
    }, 5_000);

    proc.once("exit", () => {
      clearTimeout(sigkillTimer);
      logger.info("[vpsLlama] llama-server stopped");
      resolve();
    });

    try {
      proc.kill("SIGTERM");
    } catch {
      // Process already gone — resolve immediately
      clearTimeout(sigkillTimer);
      logger.info("[vpsLlama] llama-server stopped");
      resolve();
    }
  });
}
