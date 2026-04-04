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
const LLAMA_CONTEXT_SIZE = process.env.LLAMA_CONTEXT_SIZE ?? "";
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

// ── Logger ───────────────────────────────────────────────────────────────────

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function log(level, ...args) {
  if ((LEVELS[level] ?? 0) >= currentLevel) {
    console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}]`, ...args);
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

/**
 * Spawns llama-server with the given model file.
 * Waits until the server reports it is ready (listens on the port).
 * Rejects after READY_TIMEOUT_MS if the server doesn't start in time.
 *
 * @param {string} modelFile  - filename (e.g. "model.gguf") inside LLAMA_MODEL_DIR
 * @returns {Promise<void>}
 */
function startServer(modelFile) {
  return new Promise((resolve, reject) => {
    const modelPath = path.join(LLAMA_MODEL_DIR, modelFile);
    const args = [
      "--model", modelPath,
      "--port", String(LLAMA_SERVER_PORT),
      "--host", "0.0.0.0",
      "-ngl", LLAMA_GPU_LAYERS,
    ];
    if (LLAMA_CONTEXT_SIZE) {
      args.push("--ctx-size", LLAMA_CONTEXT_SIZE);
    }

    logger.info(`Spawning llama-server: ${LLAMA_SERVER_BIN} ${args.join(" ")}`);

    const proc = spawn(LLAMA_SERVER_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

    const READY_TIMEOUT_MS = 120_000;
    let ready = false;

    const timeout = setTimeout(() => {
      if (!ready) {
        proc.kill();
        reject(new Error(`llama-server did not become ready within ${READY_TIMEOUT_MS}ms`));
      }
    }, READY_TIMEOUT_MS);

    function onData(data) {
      const text = data.toString();
      logger.debug(`[llama-server] ${text.trim()}`);
      // llama-server prints this line when it's ready to accept connections
      if (!ready && text.includes("HTTP server listening")) {
        ready = true;
        clearTimeout(timeout);
        logger.info(`llama-server ready on port ${LLAMA_SERVER_PORT} (model: ${modelFile})`);
        resolve();
      }
    }

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("error", (err) => {
      clearTimeout(timeout);
      if (!ready) {
        reject(new Error(`Failed to spawn llama-server: ${err.message}`));
      } else {
        logger.error("llama-server process error:", err.message);
      }
    });

    proc.on("exit", (code, signal) => {
      logger.info(`llama-server exited (code=${code} signal=${signal})`);
      if (serverProcess === proc) {
        serverProcess = null;
        loadedModel = null;
      }
      if (!ready) {
        clearTimeout(timeout);
        reject(new Error(`llama-server exited before becoming ready (code=${code})`));
      }
    });

    serverProcess = proc;
    loadedModel = modelFile;
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

    proc.once("exit", () => resolve());
    proc.kill();

    // Force-kill after 10 seconds if it hasn't exited
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch (err) { logger.debug(`SIGKILL failed (process likely already gone): ${err.message}`); }
    }, 10_000);
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
 */
app.post("/start", async (req, res) => {
  const modelFile = req.body?.model;
  if (!modelFile || typeof modelFile !== "string") {
    return res.status(400).json({ error: "Missing or invalid 'model' field" });
  }

  logger.info(`/start requested: model="${modelFile}"`);

  try {
    // Stop any currently running server first
    if (serverProcess) {
      logger.info("Stopping existing llama-server before starting new one");
      await stopServer();
    }

    await startServer(modelFile);
    res.json({ status: "ok", model: modelFile, port: LLAMA_SERVER_PORT });
  } catch (err) {
    logger.error("Failed to start llama-server:", err.message);
    serverProcess = null;
    loadedModel = null;
    res.status(500).json({ error: err.message });
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

app.listen(PORT, () => {
  logger.info(`llmbot-agent listening on port ${PORT}`);
  logger.info(`llama-server binary: ${LLAMA_SERVER_BIN}`);
  logger.info(`Model directory:     ${LLAMA_MODEL_DIR}`);
  logger.info(`llama-server port:   ${LLAMA_SERVER_PORT}`);
  if (!AGENT_TOKEN) {
    logger.warn("AGENT_TOKEN is not set — agent is unprotected!");
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
