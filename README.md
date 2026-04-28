# llmbot

A Discord bot powered by **llama-server** (llama.cpp) with a three-tier local/VPS LLM setup using Gemma 4. The VPS runs a lightweight always-on fallback model; a Windows local machine with a GPU runs two additional models managed on demand. The bot routes every request to the best available model automatically, with optional web search via SearXNG and automatic escalation to a heavier model for complex queries.

---

## Architecture

The bot uses three model roles:

- **VPS model** — always-on cloud fallback. A `llama-server` process runs permanently on the VPS. Every request falls back here when the local agent is unavailable.
- **Common model** — everyday local GPU model. Managed by the Windows local agent, loaded on first use and kept resident. Handles the majority of requests when the local agent is online.
- **Heavy model** — loaded on escalation. Also managed by the Windows local agent. Swapped in (or run with alternative inference args) when the common model signals a query is too complex.

**Routing logic:** every incoming message goes to the common model if the local agent is up; otherwise it falls back to the VPS model. The common model can emit an `__ESCALATE__` signal to trigger the heavy model.

---

## Prerequisites

- **Node.js 18+**
- A running `llama-server` instance for the VPS model (always-on fallback)
- Windows local agent (see [`/agent`](./agent)) for local GPU models — manages loading/unloading llama-server on the Windows machine
- A [SearXNG](https://searxng.github.io/searxng/) instance (optional, for web search)
- A Discord bot token and application

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/noname9006/llmbot.git
cd llmbot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in all required values. See the [Environment Variables](#environment-variables) section for a full reference.

### 2a. VPS llama-server binary (VPS only)

Place the `llama-server` binary in the `llama/` directory at the project root:

```bash
mkdir -p llama
cp /path/to/llama-server llama/
chmod +x llama/llama-server
```

Set `VPS_MODEL_PATH` in `.env` to the full path of the GGUF model you want the VPS instance to use.
The bot will start and stop `llama-server` automatically on launch/shutdown.
To manage `llama-server` externally instead, set `VPS_LLAMA_ENABLED=false`.

### 3. System prompts

The bot loads a separate system prompt file for each model role:

| File | Role |
|------|------|
| `sysprompt_remote.txt` | Remote model system prompt |
| `sysprompt.txt` / `sysprompt_common.txt` | Common model system prompt |
| `sysprompt_heavy.txt` | Heavy model system prompt |

Each file falls back to `sysprompt.txt` if the role-specific file does not exist. Edit these files to customise the bot's personality and behaviour per model.

### 4. Run

```bash
npm start
```

For production use with PM2:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

---

## Commands

| Command | Description |
|---------|-------------|
| `!reset` | Clear your conversation history |
| `!status` | Check local agent status and active model (server administrators only) |
| `!search <query>` | Force a web search (default name; configurable via `SEARCH_COMMAND`) |
| `!escalate` | Force escalation to the heavy model (default name; configurable via `ESCALATE_COMMAND`; only shown when `ESCALATE_MODE=command`) |
| `!help` | Show available commands |

Command names for search and escalation are dynamic — they reflect whatever you set in `SEARCH_COMMAND` and `ESCALATE_COMMAND`.

---

## Environment Variables

Copy `.env.example` to `.env` and edit it. Variables marked **required** have no default and must be set.

### Discord

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_TOKEN` | — **required** | Discord bot token |
| `ALLOWED_CHANNEL_IDS` | *(empty — all channels)* | Comma-separated channel IDs the bot will respond in. Leave empty to allow all channels. |

### LLM endpoints

| Variable | Default | Description |
|----------|---------|-------------|
| `VPS_LLAMA_URL` | `http://localhost:8080/v1` | Base URL of the VPS llama-server OpenAI-compatible API |
| `VPS_LLAMA_ENABLED` | `true` | Set to `false` to skip auto-launching llama-server (e.g. if it's managed externally) |
| `VPS_LLAMA_BIN` | `./llama/llama-server` | Path to the llama-server binary |
| `VPS_MODEL_PATH` | *(empty — required when enabled)* | Full path to the GGUF model file to load into the VPS llama-server |
| `LOCAL_LLAMA_URL` | *(empty)* | Direct URL of the local llama-server on the Windows machine (same Tailscale IP as the agent, different port) |

### Model files

| Variable | Default | Description |
|----------|---------|-------------|
| `VPS_MODEL_FILE` | `phi4-mini.Q4_K_M.gguf` | Model filename shown in logs for the VPS instance |
| `LOCAL_MODEL_COMMON_FILE` | *(empty)* | GGUF filename for the common model (looked up in the agent's `LLAMA_MODEL_DIR`) |
| `LOCAL_MODEL_HEAVY_FILE` | *(empty)* | GGUF filename for the heavy model |

### System prompts

System prompts are loaded from files, not environment variables. See [Setup → System prompts](#3-system-prompts) above. You can override the fallback system prompt via `SYSTEM_PROMPT=...` if you want to skip prompt files entirely.

### Windows local agent

| Variable | Default | Description |
|----------|---------|-------------|
| `LOCAL_AGENT_URL` | *(empty)* | HTTP URL of the Windows local agent (e.g. `http://100.x.x.x:3000`) |
| `LOCAL_AGENT_TOKEN` | *(empty)* | Bearer token — must match `AGENT_TOKEN` in the agent's `.env` |
| `LOCAL_HEALTH_POLL_INTERVAL_MS` | `30000` | How often (ms) to poll the agent `/health` endpoint |

### Escalation controls

| Variable | Default | Description |
|----------|---------|-------------|
| `ESCALATE` | `on` | Master switch — `on` enables escalation, `off` disables it entirely |
| `ESCALATE_MODE` | `auto` | `auto`: the common model's `__ESCALATE__` signal triggers escalation automatically. `command`: auto-signals are ignored; user must type the escalate command. |
| `ESCALATE_COMMAND` | `!escalate` | Command users type to manually trigger escalation (only used when `ESCALATE_MODE=command`). Must start with `!`. |
| `ESCALATE_TYPE` | `model` | `model`: switch to the heavy model when escalating. `args`: keep the common model but re-run the query with the heavy extra args (`LLAMA_EXTRA_ARGS_HEAVY`). |

### Search controls

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARCH` | `on` | Master switch — `on` enables search, `off` disables it entirely |
| `SEARCH_MODE` | `auto` | `auto`: the model's `__SEARCH__: <query>` signal triggers a search automatically. `command`: auto-signals are dropped; only the search command works. |
| `SEARCH_COMMAND` | `!search` | Command name for forced search. Must start with `!`. |
| `SEARXNG_BASE_URL` | *(empty)* | Base URL of your SearXNG instance (required for search to work) |
| `SEARCH_RESULT_COUNT` | `5` | Number of search results to inject into the model context |

### llama.cpp startup args (per-model)

These are passed to `llama-server` when the agent starts a model. The global `LLAMA_EXTRA_ARGS` is used as a fallback when a role-specific var is not set.

When using the **Windows local agent**, per-model extra args can also be set in the **agent's** `.env` (`LLAMA_EXTRA_ARGS_COMMON`, `LLAMA_EXTRA_ARGS_HEAVY`) and will take priority over bot-sent values. Include `-ngl <N>` in those vars to control GPU layer offload per model.

| Variable | Default | Description |
|----------|---------|-------------|
| `LLAMA_EXTRA_ARGS` | *(empty)* | Global fallback extra args for llama-server |
| `LLAMA_EXTRA_ARGS_REMOTE` | *(falls back to `LLAMA_EXTRA_ARGS`)* | Extra args for the remote model |
| `LLAMA_EXTRA_ARGS_COMMON` | *(falls back to `LLAMA_EXTRA_ARGS`)* | Extra args for the common model |
| `LLAMA_EXTRA_ARGS_HEAVY` | *(falls back to `LLAMA_EXTRA_ARGS`)* | Extra args for the heavy model |

### Context size (per-model)

Passed to llama-server as the context window size. `0` means use the model default.

| Variable | Default | Description |
|----------|---------|-------------|
| `LLAMA_CONTEXT_SIZE` | `0` | Global fallback context size |
| `LLAMA_CONTEXT_SIZE_REMOTE` | *(falls back to `LLAMA_CONTEXT_SIZE`)* | Context size for the remote model |
| `LLAMA_CONTEXT_SIZE_COMMON` | *(falls back to `LLAMA_CONTEXT_SIZE`)* | Context size for the common model |
| `LLAMA_CONTEXT_SIZE_HEAVY` | *(falls back to `LLAMA_CONTEXT_SIZE`)* | Context size for the heavy model |

### Fetch timeout (per-model)

Maximum time to wait for a single `/chat/completions` response before giving up.

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_FETCH_TIMEOUT_MS` | `120000` | Global fallback fetch timeout in ms (`0` = no timeout) |
| `LLM_FETCH_TIMEOUT_MS_REMOTE` | *(falls back to `LLM_FETCH_TIMEOUT_MS`)* | Fetch timeout for remote model requests |
| `LLM_FETCH_TIMEOUT_MS_COMMON` | *(falls back to `LLM_FETCH_TIMEOUT_MS`)* | Fetch timeout for common model requests |
| `LLM_FETCH_TIMEOUT_MS_HEAVY` | *(falls back to `LLM_FETCH_TIMEOUT_MS`)* | Fetch timeout for heavy model requests |

### Inference parameters (global + per-model)

Each global parameter has per-model overrides (`_REMOTE`, `_COMMON`, `_HEAVY`). Per-model values fall back to the global value when not set.

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_TEMPERATURE` | `0.8` | Sampling temperature. Gemma 4 recommended: `1.0` |
| `LLM_TEMPERATURE_COMMON` / `_HEAVY` / `_REMOTE` | *(falls back to `LLM_TEMPERATURE`)* | Per-model temperature override |
| `LLM_TOP_P` | `0.95` | Top-p (nucleus) sampling. Gemma 4 recommended: `0.95` |
| `LLM_TOP_P_COMMON` / `_HEAVY` / `_REMOTE` | *(falls back to `LLM_TOP_P`)* | Per-model top-p override |
| `LLM_TOP_K` | `40` | Top-k sampling. Gemma 4 recommended: `64` |
| `LLM_TOP_K_COMMON` / `_HEAVY` / `_REMOTE` | *(falls back to `LLM_TOP_K`)* | Per-model top-k override |
| `LLM_MIN_P` | `0.0` | Min-p sampling threshold |
| `LLM_MIN_P_COMMON` / `_HEAVY` / `_REMOTE` | *(falls back to `LLM_MIN_P`)* | Per-model min-p override |
| `LLM_REPEAT_PENALTY` | `1.1` | Repetition penalty. Gemma 4 recommended: `1.0` (disabled). Old name `LLM_REPETITION_PENALTY` still accepted. |
| `LLM_REPEAT_PENALTY_COMMON` / `_HEAVY` / `_REMOTE` | *(falls back to `LLM_REPEAT_PENALTY`)* | Per-model repetition penalty override |
| `LLM_MAX_TOKENS` | `2048` | Max tokens per response (`-1` = unlimited) |
| `LLM_MAX_TOKENS_COMMON` / `_HEAVY` / `_REMOTE` | *(falls back to `LLM_MAX_TOKENS`)* | Per-model max tokens override |
| `LLM_REASONING_BUDGET` | `-1` (disabled) | Max reasoning/thinking tokens (`budget_tokens`). `-1` = not sent (model default). `0` = disable reasoning. Positive = token cap. |
| `LLM_REASONING_BUDGET_COMMON` / `_HEAVY` / `_REMOTE` | *(falls back to `LLM_REASONING_BUDGET`)* | Per-model reasoning budget override |

### History

| Variable | Default | Description |
|----------|---------|-------------|
| `HISTORY_MAX_PAIRS` | `10` | Conversation message pairs kept per user (sliding window) |

### Rate limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_MAX_REQUESTS` | `5` | Max messages per user per time window |
| `RATE_LIMIT_WINDOW_MS` | `30000` | Sliding window duration in ms |
| `MAX_CONCURRENT_REQUESTS` | `5` | Max simultaneous LLM calls across all users |

### Retries

| Variable | Default | Description |
|----------|---------|-------------|
| `RETRY_MAX_ATTEMPTS` | `3` | Max retry attempts for failed LLM/SearXNG calls |
| `RETRY_INITIAL_DELAY_MS` | `500` | Initial backoff delay in ms (exponential back-off) |

### Observability

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_PORT` | `0` (disabled) | Port to expose `GET /health` for uptime monitors. `0` disables it. |
| `LOG_LEVEL` | `info` | Log verbosity: `debug` / `info` / `warn` / `error` |

---

## Gemma 4 Notes

See [`gemma4.md`](./gemma4.md) for a full Gemma 4 setup and hardware guide.

Key points for running Gemma 4 with this bot:

- **Enable thinking mode** by passing `--chat-template-kwargs '{"enable_thinking":true}'` to llama-server. Set this via `LLAMA_EXTRA_ARGS_COMMON` and `LLAMA_EXTRA_ARGS_HEAVY`.

  When using the **Windows local agent**, the preferred place is the **agent's** `.env` (agent-side values take priority over bot-sent values):

  **Windows PowerShell** (in `agent/.env`):
  ```
  LLAMA_EXTRA_ARGS_COMMON=--chat-template-kwargs "{\"enable_thinking\":true}"
  LLAMA_EXTRA_ARGS_HEAVY=--chat-template-kwargs "{\"enable_thinking\":true}"
  ```

  Alternatively, set them in the **bot's** `.env` (used as a fallback when the agent doesn't override):

  **Linux / bash** (in bot `.env`):
  ```
  LLAMA_EXTRA_ARGS_COMMON=--chat-template-kwargs '{"enable_thinking":true}'
  LLAMA_EXTRA_ARGS_HEAVY=--chat-template-kwargs '{"enable_thinking":true}'
  ```

  **Windows PowerShell** (in bot `.env`):
  ```
  LLAMA_EXTRA_ARGS_COMMON=--chat-template-kwargs "{\"enable_thinking\":true}"
  LLAMA_EXTRA_ARGS_HEAVY=--chat-template-kwargs "{\"enable_thinking\":true}"
  ```
- **Think blocks are automatically stripped** before the response is sent to Discord. The internal reasoning `<|channel>thought ... <channel|>` block is removed; only the final answer is shown.
- **Recommended inference parameters** for Gemma 4: `temperature=1.0`, `top_p=0.95`, `top_k=64`, `repetition_penalty=1.0`. Set these globally or per-model:
  ```
  LLM_TEMPERATURE=1.0
  LLM_TOP_P=0.95
  LLM_TOP_K=64
  LLM_REPEAT_PENALTY=1.0
  ```
- **VPS model** can be a different, smaller/faster model (e.g. a compact quantised model) — it does not need to be Gemma 4.

---

## Escalation Flow

1. User sends a message → bot routes to the **common model** (if local agent is online) or the **VPS model** (if local agent is offline).
2. The common model may emit `__ESCALATE__` in its response if the query is too complex.
3. If `ESCALATE=on` and conditions are met:
   - The bot sends a transition notification to Discord (e.g. *"switching to heavy model…"*).
   - If `ESCALATE_TYPE=model`: the heavy model is loaded via the agent, the query is re-run with the heavy model.
   - If `ESCALATE_TYPE=args`: the common model is kept; the query is re-run using `LLAMA_EXTRA_ARGS_HEAVY` inference params.
4. The heavy model responds. It cannot escalate further.
5. After the heavy model responds, the common model is reloaded (if common ≠ heavy; if they are the same file, no reload is needed).

**Mode variants:**
- `ESCALATE_MODE=command`: auto-escalation is disabled; users must type the escalate command (default `!escalate`) to trigger it manually.
- `ESCALATE=off`: escalation is fully disabled regardless of model signals or commands.

---

## Search Flow

1. A user message is processed by the model, which may emit `__SEARCH__: <query>` in its response.
2. If `SEARCH=on` and `SEARCH_MODE=auto`: the search executes against SearXNG, results are injected into the conversation context, and the model re-runs to produce a final answer.
3. Users can also force a search directly with the search command (default: `!search <query>`), bypassing the model signal.
4. If `SEARCH_MODE=command`: auto-signals from the model are dropped; only the `!search` command triggers a search.
5. If `SEARCH=off`: all search functionality is disabled.

---

## Agent Setup

See [`agent/README.md`](./agent/README.md) for full instructions on setting up the Windows local agent that manages llama-server on the Windows machine.
