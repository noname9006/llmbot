import "dotenv/config";
import express from "express";
import { spawn } from "child_process";
import path from "path";

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? "";
const LLAMA_SERVER_BIN = process.env.LLAMA_SERVER_BIN ?? "llama-server";
const LLAMA_SERVER_PORT = parseInt(process.env.LLAMA_SERVER_PORT ?? "8081", 10);
const LLAMA_MODEL_DIR = process.env.LLAMA_MODEL_DIR ?? ".";
const LLAMA_GPU_LAYERS = process.env.LLAMA_GPU_LAYERS ?? "99";
const LLAMA_GPU_LAYERS_COMMON = process.env.LLAMA_GPU_LAYERS_COMMON ?? "";
const LLAMA_GPU_LAYERS_HEAVY  = process.env.LLAMA_GPU_LAYERS_HEAVY  ?? "";
const LLAMA_CONTEXT_SIZE = process.env.LLAMA_CONTEXT_SIZE ?? "";
const LLAMA_EXTRA_ARGS = process.env.LLAMA_EXTRA_ARGS ?? "";
const LLAMA_MODEL_AUTOSTART = process.env.LLAMA_MODEL_AUTOSTART ?? "";
const LLAMA_MODEL_AUTOSTART_ROLE = process.env.LLAMA_MODEL_AUTOSTART_ROLE ?? "";
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

// ── Logger ───────────────────────────────────────────────────────────────────

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function serializeArg(arg) {
  if (arg instanceof Error) {
    return arg.stack ?? arg.message;
  }
  return arg;
}

function log(level, ...args) {
  if ((LEVELS[level] ?? 0) >= currentLevel) {
    const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
    const serialized = args.map(serializeArg);
    if (level === "error") {
      console.error(prefix, ...serialized);
    } else {
      console.log(prefix, ...serialized);
    }
  }
}

const logger = {
  debug: (...a) => log("debug", ...a),
  info: (...a) => log("info", ...a),
  warn: (...a) => log("warn", ...a),
  error: (...a) => log("error", ...a),
};

// ── llama-server process management ──────────────────────────────────────────

/** Currently running llama-server child process, or null */
let serverProcess = null;
/** Filename of the currently loaded model, or null */
let loadedModel = null;

// Mutex — prevents concurrent /start requests from spawning multiple processes
let startInProgress = false;
/** @type {Array<{ resolve: () => void, reject: (e: Error) => void }>} */
const startQueue = [];

/**
 * Spawns llama-server with the given model file.
 * Waits until the server reports it is ready (listens on the port).
 * Rejects after READY_TIMEOUT_MS if the server doesn't start in time.
 *
 * @param {string} modelFile  - filename (e.g. "model.gguf") inside LLAMA_MODEL_DIR
 * @returns {Promise<void>}
 */
function startServer(modelFile, role = "") {
  return new Promise((resolve, reject) => {
    const modelPath = path.join(LLAMA_MODEL_DIR, modelFile);

    let gpuLayers = LLAMA_GPU_LAYERS; // default fallback
    if (role === "common" && LLAMA_GPU_LAYERS_COMMON) gpuLayers = LLAMA_GPU_LAYERS_COMMON;
    if (role === "heavy"  && LLAMA_GPU_LAYERS_HEAVY)  gpuLayers = LLAMA_GPU_LAYERS_HEAVY;

    const args = [
      "--model", modelPath,
      "--port", String(LLAMA_SERVER_PORT),
      "--host", "0.0.0.0",
      "-ngl", gpuLayers,
    ];
    if (LLAMA_CONTEXT_SIZE) {
      args.push("--ctx-size", LLAMA_CONTEXT_SIZE);
    }
    if (LLAMA_EXTRA_ARGS) {
      args.push(...LLAMA_EXTRA_ARGS.trim().split(/\s+/));
    }

    logger.info(`GPU layers: ${gpuLayers} (role: ${role || "default"})`);
    logger.info(`Spawning llama-server: ${LLAMA_SERVER_BIN} ${args.join(" ")}`);

    const proc = spawn(LLAMA_SERVER_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

    const READY_TIMEOUT_MS = 120_000;
    let ready = false;

    // ── readiness helpers ─────────────────────────────────────────────────────

    function markReady() {
      if (ready) return;
      ready = true;
      clearTimeout(timeout);
      clearInterval(httpProbeInterval);
      // Set loadedModel only now — /health would otherwise report the model as
      // loaded before llama-server is actually able to serve inference.
      loadedModel = modelFile;
      logger.info(`llama-server ready on port ${LLAMA_SERVER_PORT} (model: ${modelFile})`);
      resolve();
    }

    const timeout = setTimeout(() => {
      if (!ready) {
        clearInterval(httpProbeInterval);
        proc.kill();
        reject(new Error(`llama-server did not become ready within ${READY_TIMEOUT_MS}ms`));
      }
    }, READY_TIMEOUT_MS);

    // ── stdout/stderr log-line detection ──────────────────────────────────────
    // Validated against llama-server b3 (llama.cpp ≥ b3000).
    // If a future release changes this message, the HTTP probe below acts as
    // a fallback and will still detect readiness.
    function onData(data) {
      const text = data.toString();
      logger.debug(`[llama-server] ${text.trim()}`);
      if (text.includes("HTTP server listening") || text.includes("server is listening")) {
        markReady();
      }
    }

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    // ── HTTP readiness probe (fallback) ───────────────────────────────────────
    // Polls GET /health every 3 s starting at 5 s.  Catches cases where the
    // log line format changes in a future llama-server release.
    const HTTP_PROBE_INITIAL_DELAY_MS = 5_000;
    const HTTP_PROBE_INTERVAL_MS = 3_000;
    let httpProbeInterval = null;

    setTimeout(() => {
      if (ready) return;
      httpProbeInterval = setInterval(async () => {
        if (ready) {
          clearInterval(httpProbeInterval);
          return;
        }
        try {
          const res = await fetch(`http://127.0.0.1:${LLAMA_SERVER_PORT}/health`, {
            signal: AbortSignal.timeout(2_000),
          });
          if (res.ok) {
            logger.debug("llama-server HTTP probe: server is ready");
            markReady();
          }
        } catch {
          // Not ready yet — keep probing
        }
      }, HTTP_PROBE_INTERVAL_MS);
    }, HTTP_PROBE_INITIAL_DELAY_MS);

    proc.on("error", (err) => {
      clearTimeout(timeout);
      clearInterval(httpProbeInterval);
      if (!ready) {
        reject(new Error(`Failed to spawn llama-server: ${err.message}`));
      } else {
        logger.error("llama-server process error:", err.message);
      }
    });

    proc.on("exit", (code, signal) => {
      clearTimeout(timeout);
      clearInterval(httpProbeInterval);
      logger.info(`llama-server exited (code=${code} signal=${signal})`);
      if (serverProcess === proc) {
        serverProcess = null;
        loadedModel = null;
      }
      if (!ready) {
        reject(new Error(`llama-server exited before becoming ready (code=${code})`));
      }
    });

    serverProcess = proc;
    // loadedModel is set in markReady() — not here — so /health never reports
    // a model as loaded until llama-server is confirmed ready to serve.
  });
}

/**
 * Kills the running llama-server process and waits for it to exit.
 * No-op if no process is running.
 *
 * @returns {Promise<void>}
 */
function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) {
      resolve();
      return;
    }
    const proc = serverProcess;
    serverProcess = null;
    loadedModel = null;

    // Force-kill after 10 seconds if it hasn't exited cleanly
    const sigkillTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch (err) {
        logger.debug(`SIGKILL failed (process likely already gone): ${err.message}`);
      }
    }, 10_000);

    proc.once("exit", () => {
      clearTimeout(sigkillTimer);
      resolve();
    });
    proc.kill();
  });
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (!AGENT_TOKEN) {
    // No token configured — allow all (not recommended in production)
    return next();
  }
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== AGENT_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Returns agent status and whether llama-server is currently running.
 */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    running: serverProcess !== null,
    model: loadedModel,
  });
});

/**
 * POST /start
 * Body: { "model": "<filename.gguf>" }
 *
 * Stops any running llama-server, then starts a new one with the requested
 * model.  Waits until the server is ready before responding.
 *
 * Concurrent /start requests are serialised by a mutex — only one start
 * operation runs at a time; subsequent callers wait for it to complete.
 */
app.post("/start", async (req, res) => {
  const modelFile = req.body?.model;
  if (!modelFile || typeof modelFile !== "string") {
    return res.status(400).json({ error: "Missing or invalid 'model' field" });
  }

  // Prevent path-traversal attacks (e.g. "../../etc/passwd").
  // path.relative() returns a string starting with ".." if resolvedModelPath
  // escapes resolvedModelDir, regardless of OS path separator edge cases.
  const resolvedModelPath = path.resolve(LLAMA_MODEL_DIR, modelFile);
  const resolvedModelDir = path.resolve(LLAMA_MODEL_DIR);
  const rel = path.relative(resolvedModelDir, resolvedModelPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    logger.warn(`/start rejected — path traversal attempt: "${modelFile}"`);
    return res.status(400).json({ error: "Invalid model path" });
  }

  logger.info(`/start requested: model="${modelFile}"`);

  const rawRole = typeof req.body?.role === "string" ? req.body.role : "";
  const role = (rawRole === "common" || rawRole === "heavy") ? rawRole : "";
  if (rawRole && !role) {
    logger.warn(`/start received unrecognized role "${rawRole}" — falling back to default GPU layers`);
  }

  // ── Mutex: queue concurrent requests rather than spawning multiple processes ─
  if (startInProgress) {
    logger.info(`/start queued (another start is in progress): model="${modelFile}"`);
    try {
      await new Promise((resolve, reject) => startQueue.push({ resolve, reject }));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    // After the in-progress start finishes, just return the current state
    return res.json({ status: "ok", model: loadedModel, port: LLAMA_SERVER_PORT });
  }

  startInProgress = true;
  try {
    // Stop any currently running server first
    if (serverProcess) {
      logger.info("Stopping existing llama-server before starting new one");
      await stopServer();
    }

    await startServer(modelFile, role);
    res.json({ status: "ok", model: modelFile, port: LLAMA_SERVER_PORT });

    // Notify all queued callers that the start completed successfully
    const pending = startQueue.splice(0);
    for (const { resolve } of pending) resolve();
  } catch (err) {
    logger.error("Failed to start llama-server:", err);
    serverProcess = null;
    loadedModel = null;
    res.status(500).json({ error: err.message });

    // Reject all queued callers with the same error
    const pending = startQueue.splice(0);
    for (const { reject } of pending) reject(err);
  } finally {
    startInProgress = false;
  }
});

/**
 * POST /stop
 * Stops the running llama-server.  No-op if nothing is running.
 */
app.post("/stop", async (_req, res) => {
  logger.info("/stop requested");
  await stopServer();
  res.json({ status: "ok" });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  logger.info(`llmbot-agent listening on port ${PORT}`);
  logger.info(`llama-server binary: ${LLAMA_SERVER_BIN}`);
  logger.info(`Model directory:     ${LLAMA_MODEL_DIR}`);
  logger.info(`llama-server port:   ${LLAMA_SERVER_PORT}`);
  if (!AGENT_TOKEN) {
    logger.warn("AGENT_TOKEN is not set — agent is unprotected!");
  }

  if (LLAMA_MODEL_AUTOSTART) {
    // ── Path-traversal guard (same check as POST /start) ─────────────────────
    const resolvedAutoPath = path.resolve(LLAMA_MODEL_DIR, LLAMA_MODEL_AUTOSTART);
    const resolvedModelDir = path.resolve(LLAMA_MODEL_DIR);
    const autoRel = path.relative(resolvedModelDir, resolvedAutoPath);
    if (autoRel.startsWith("..") || path.isAbsolute(autoRel)) {
      logger.error(
        `Auto-start rejected — invalid LLAMA_MODEL_AUTOSTART path: "${LLAMA_MODEL_AUTOSTART}"`
      );
    } else {
      // ── Role sanitization (same check as POST /start) ───────────────────────
      const rawAutoRole = LLAMA_MODEL_AUTOSTART_ROLE;
      const autoRole =
        rawAutoRole === "common" || rawAutoRole === "heavy" ? rawAutoRole : "";
      if (rawAutoRole && !autoRole) {
        logger.warn(
          `Auto-start: unrecognized LLAMA_MODEL_AUTOSTART_ROLE "${rawAutoRole}" — falling back to default GPU layers`
        );
      }

      // ── Hold the mutex so a concurrent POST /start is queued, not raced ────
      logger.info(`Auto-starting model: ${LLAMA_MODEL_AUTOSTART}`);
      startInProgress = true;
      try {
        await startServer(LLAMA_MODEL_AUTOSTART, autoRole);
        logger.info(`Auto-start complete: ${LLAMA_MODEL_AUTOSTART}`);
        const pending = startQueue.splice(0);
        for (const { resolve } of pending) resolve();
      } catch (err) {
        logger.error(`Auto-start failed for ${LLAMA_MODEL_AUTOSTART}: ${err.message}`);
        serverProcess = null;
        loadedModel = null;
        const pending = startQueue.splice(0);
        for (const { reject } of pending) reject(err);
      } finally {
        startInProgress = false;
      }
    }
  }
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal) {
  logger.info(`Received ${signal} — shutting down`);
  await stopServer();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
