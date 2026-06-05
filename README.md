# llmbot

A Discord bot powered by **llama-server** (llama.cpp) with a two-bot / two-role architecture: an always-on **remote** bot+model on VPS, plus an optional **local** bot+model managed through a Windows agent over Tailscale.

---

## Table of Contents

- [Architecture](#architecture)
- [Request & Routing Flow](#request--routing-flow)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
  - [1. Clone and install](#1-clone-and-install)
  - [2. Configure environment](#2-configure-environment)
  - [3. Install llama.cpp](#3-install-llamacpp)
    - [VPS (Linux)](#vps-linux)
    - [Windows local machine](#windows-local-machine)
  - [4. Set up Tailscale](#4-set-up-tailscale)
  - [5. Set up SearXNG (search engine)](#5-set-up-searxng-search-engine)
  - [6. System prompts](#6-system-prompts)
  - [7. Run](#7-run)
- [Commands](#commands)
- [Environment Variables](#environment-variables)
- [Gemma 4 Notes](#gemma-4-notes)
- [OpenRouter](#openrouter)
- [Search Flow](#search-flow)
- [MCP (Model Context Protocol)](#mcp-model-context-protocol)
- [Agent Setup](#agent-setup)

---

## Architecture

The bot uses **two Discord bots** with two model roles:

- **Remote role (Bot #1, required)** — uses `DISCORD_TOKEN_REMOTE` and the VPS llama-server (`VPS_LLAMA_URL`). This is the always-on bot/model.
- **Local role (Bot #2, optional)** — uses `DISCORD_TOKEN_LOCAL` and the local model managed by the Windows agent over Tailscale (`LOCAL_AGENT_URL` + `LOCAL_LLAMA_URL`).

Routing logic is role-based: the remote bot is always available, while the local bot is enabled only when configured and healthy.

```
[Discord]
    ├── [Bot #1: Remote role on VPS]
    │       └── [VPS llama-server :8080]
    └── [Bot #2: Local role (optional)]
            └── HTTP over Tailscale → [Windows agent :3000]
                                          └── manages [local llama-server :8081]
```

### Inference backend per role (llama-server or OpenRouter)

Each role's **inference backend** is independent of the bot routing above. By default both roles run against the self-hosted llama-server, but either role can additionally use **[OpenRouter](https://openrouter.ai)** (an OpenAI-compatible provider). Per role you choose a **priority** (which backend to try first), and if that backend's request fails (missing key, network error, 5xx) the request **automatically falls back** to the other backend. The self-hosted llama-server keeps running, so fallback always has a target. See [OpenRouter (per-role inference backend)](#openrouter-per-role-inference-backend) for configuration. This only swaps *where inference runs* — the answer/escalation routing between the two bots is unchanged.

---

## Request & Routing Flow

### Remote model behavior

Every user message tagged at the remote bot goes through this sequence:

1. **Rate-limit & command check** — commands (`!reset`, `!search`, etc.) are handled first and bypass the LLM entirely. Rate-limited users get a wait message.
2. **Semaphore** — a global slot (`MAX_CONCURRENT_REQUESTS`, default `1`) serializes LLM calls across all users. Queued requests wait here before any model work starts.
3. **History** — the user's conversation history is loaded and the new user message is appended, all inside the semaphore to avoid races.
4. **Typing indicator** — `sendTyping()` fires now, immediately before the LLM call. It does **not** fire during the semaphore wait or history loading — users only see "typing" while the model is actually generating.
5. **Remote model runs** — the remote model produces an answer. When the local bot is available, a complexity-routing instruction is appended to the system message asking the model to include a JSON block (`{"score": 0–10, "should_escalate": true/false}`) after its answer.
6. **Routing decision:**
   - `should_escalate: false` (or local unavailable) → the remote answer is sent directly. Done.
   - `should_escalate: true` → the remote answer is posted as a "starter" and the local bot is tagged with `@LocalBot`. The remote model's turn is recorded in history as `"(escalated to vale)"` so the alternating user/assistant structure stays intact.
7. **Search signal** — either model may emit `__SEARCH__: <query>` instead of (or as part of) its answer. The search flow runs and the model re-runs with results injected. See [Search Flow](#search-flow).

### Local model behavior (escalation path)

When the remote bot tags the local bot:

1. The local bot resolves the **original human user's ID** from the Discord message reference, so history is loaded under that ID (not the remote bot's ID).
2. **Model warm-up** (`ensureLocalModel`) — if the local llama-server isn't loaded yet, the agent loads it now. This can take a minute for large models.
3. **Typing indicator** fires, then the local model runs.
4. The local bot replies **directly to the original human message** (not to the relay), so the thread stays clean.
5. The local model's reply is stored in history under the human user's ID, shared with the remote model — both bots read from the same per-user history.

### Local direct replies

Users can **reply directly to any local bot message** to continue the conversation without re-mentioning the remote bot. This goes through the `onLocalDirectMessage` handler, which skips the routing step and runs the local model immediately.

### History sharing

Both bots store and retrieve conversation history **keyed by the human user's Discord ID**. The remote model pushes the user's message; the local model (when escalated) reads the same history without pushing a duplicate user turn. This means the full back-and-forth is visible to either model on the next exchange.

### Signal tokens

The models use internal signal tokens that are stripped before any text reaches Discord:

| Token | Purpose |
|-------|---------|
| `__SEARCH__: <query>` | Triggers a SearXNG web search |
| `{"score":…,"should_escalate":…}` | Complexity routing decision (remote model only) |
| `__VALE__` | Internal marker token, stripped on output |
| Leaked tool-call syntax | Stripped as a last-resort safety net |

---

## Prerequisites

- **Node.js 18+**
- A running `llama-server` instance for the VPS model (always-on fallback)
- Windows local agent (see [`/agent`](./agent)) for local GPU models — manages loading/unloading llama-server on the Windows machine
- **Tailscale** — connects the VPS bot to the Windows agent over a private network
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

---

### 3. Install llama.cpp

llama.cpp provides the `llama-server` binary that handles LLM inference. You need it in two places: on the **VPS** (for the always-on fallback model) and on the **Windows machine** (for local GPU models, managed by the agent).

#### VPS (Linux)

**Option A — pre-built binary (recommended)**

Download the latest release binary for Linux from the [llama.cpp releases page](https://github.com/ggerganov/llama.cpp/releases). Pick the build that matches your hardware:

| Hardware | Build tag to look for |
|---|---|
| CPU only | `llama-<version>-bin-ubuntu-x64.zip` |
| NVIDIA GPU (CUDA) | `llama-<version>-bin-ubuntu-cuda-cu12...` |
| AMD GPU (ROCm) | `llama-<version>-bin-ubuntu-rocm...` |

```bash
# Example — CPU/generic Linux build
wget https://github.com/ggerganov/llama.cpp/releases/latest/download/llama-<version>-bin-ubuntu-x64.zip
unzip llama-<version>-bin-ubuntu-x64.zip -d llama-bin
```

Place the binary where the bot can find it:

```bash
mkdir -p llama
cp llama-bin/llama-server llama/
chmod +x llama/llama-server
```

**Option B — build from source**

```bash
sudo apt-get update && sudo apt-get install -y build-essential cmake git
git clone https://github.com/ggerganov/llama.cpp.git
cd llama.cpp
cmake -B build -DLLAMA_CURL=ON
cmake --build build --config Release -j$(nproc)
# copy the resulting binary
cp build/bin/llama-server /path/to/llmbot/llama/llama-server
```

**Configure the bot to use it**

In `.env`:

```env
VPS_LLAMA_BIN=./llama/llama-server
VPS_MODEL_PATH=/absolute/path/to/your-model.gguf
VPS_LLAMA_ENABLED=true
```

The bot starts and stops `llama-server` automatically on launch/shutdown. To manage it externally instead, set `VPS_LLAMA_ENABLED=false` and point `VPS_LLAMA_URL` at your running instance.

---

#### Windows local machine

The Windows agent requires `llama-server.exe`. Use a pre-built binary from the [llama.cpp releases page](https://github.com/ggerganov/llama.cpp/releases).

**Choosing the right build for your GPU**

| GPU / backend | Build tag to look for |
|---|---|
| NVIDIA (CUDA) | `llama-<version>-bin-win-cuda-cu12...` |
| AMD / Intel / other (Vulkan) | `llama-<version>-bin-win-vulkan-x64.zip` |
| CPU only | `llama-<version>-bin-win-noavx-x64.zip` |

> **AMD GPU users (RX 6000 / 7000 series, etc.):** use the **Vulkan** build. It does not require ROCm on Windows.

```powershell
# 1. Download and extract the zip (example: Vulkan build)
Expand-Archive llama-<version>-bin-win-vulkan-x64.zip -DestinationPath C:\llama

# 2. Verify the binary runs
C:\llama\llama-server.exe --version
```

**Configure the agent to use it**

In `agent/.env`:

```env
LLAMA_SERVER_BIN=C:\llama\llama-server.exe
LLAMA_MODEL_DIR=F:\AI\.models
```

To enable GPU offload, add `-ngl 99` (offload all layers) to the per-model extra args:

```env
LLAMA_EXTRA_ARGS_LOCAL=--flash-attn -ngl 99
```

For Gemma 4 thinking mode (recommended), also append the thinking flag:

```env
# Windows PowerShell / .env — escape inner quotes with \"
LLAMA_EXTRA_ARGS_LOCAL=--flash-attn -ngl 99 --chat-template-kwargs '{"enable_thinking":true}'
```

**Verify Vulkan drivers (AMD/Intel)**

```powershell
# Should print adapter info — if it errors, update your GPU drivers
vulkaninfo --summary
```

---

### 4. Set up Tailscale

Tailscale creates a private WireGuard-based network between the VPS and the Windows machine so the bot can reach the Windows agent securely without exposing ports to the internet.

#### Install Tailscale

**VPS (Linux)**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Follow the auth URL printed in the terminal
```

**Windows**

1. Download and install from [https://tailscale.com/download/windows](https://tailscale.com/download/windows).
2. Sign in with the same Tailscale account used on the VPS.
3. Both machines will appear in your [Tailscale admin console](https://login.tailscale.com/admin/machines) with `100.x.x.x` addresses.

#### Verify connectivity

```bash
# On the VPS — check both machines are connected
tailscale status

# Ping the Windows machine from the VPS (use its Tailscale IP)
ping 100.x.x.x
```

#### Configure the bot

In the bot's `.env`, set the Windows agent URL using the Tailscale IP:

```env
LOCAL_AGENT_URL=http://100.x.x.x:3000
LOCAL_AGENT_TOKEN=your-strong-secret-token
```

#### Windows Firewall rules

Allow the agent and llama-server ports from the Tailscale subnet only:

```powershell
New-NetFirewallRule -DisplayName "llmbot-agent" `
  -Direction Inbound -Protocol TCP -LocalPort 3000 `
  -RemoteAddress "100.64.0.0/10" -Action Allow

New-NetFirewallRule -DisplayName "llmbot llama-server" `
  -Direction Inbound -Protocol TCP -LocalPort 8081 `
  -RemoteAddress "100.64.0.0/10" -Action Allow
```

> **Tip:** port `8081` (llama-server) does **not** need to be reachable from the internet — only the agent (port `3000`) needs to be reachable from the VPS over Tailscale, and llama-server only needs to be reachable from the agent on the same machine.

---

### 5. Set up SearXNG (search engine)

SearXNG is a self-hosted meta search engine. The bot uses it to fetch real-time web results and inject them into the model context.

#### Quick start with Docker (recommended)

```bash
# 1. Create a working directory
mkdir searxng && cd searxng

# 2. Pull and run the official image
docker run -d \
  --name searxng \
  --restart unless-stopped \
  -p 8888:8080 \
  -v "$(pwd)/searxng:/etc/searxng" \
  -e SEARXNG_BASE_URL="http://localhost:8888/" \
  searxng/searxng:latest
```

The instance is now reachable at `http://localhost:8888`.

#### Enable JSON output (required)

The bot queries SearXNG using the JSON format. By default it is disabled. Edit `searxng/settings.yml` (created automatically on first run):

```yaml
search:
  formats:
    - html
    - json          # ← add this line
```

Then restart the container:

```bash
docker restart searxng
```

Verify it works:

```bash
curl "http://localhost:8888/search?q=test&format=json" | head -c 200
```

#### Install without Docker

See the [official SearXNG installation guide](https://docs.searxng.org/admin/installation.html) for bare-metal setup. The requirement is only that the instance is reachable via HTTP and JSON format is enabled.

#### Configure the bot

In `.env`:

```env
SEARXNG_BASE_URL=http://localhost:8888
SEARCH=on
SEARCH_MODE=auto          # model emits __SEARCH__: <query> to trigger automatically
SEARCH_RESULT_COUNT=5     # number of results injected into context
```

If SearXNG is on a different machine, use its address (Tailscale IP recommended if it is on the Windows box):

```env
SEARXNG_BASE_URL=http://100.x.x.x:8888
```

---

### 6. System prompts

The bot loads one system prompt file per role:

| File | Role |
|------|------|
| `sysprompt_remote.txt` | Remote role (Bot #1) |
| `sysprompt_local.txt` | Local role (Bot #2) |
| `sysprompt.txt` | Global fallback when role-specific files are missing |

Backward compatibility note: if `sysprompt_local.txt` is missing, the loader also checks legacy `sysprompt_common.txt`.

### 7. Run

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
| `!help` | Show available commands |

Search command names are dynamic — they reflect whatever you set in `SEARCH_COMMAND`.

---

## Environment Variables

Copy `.env.example` to `.env` and edit it. Variables marked **required** have no default and must be set.

### Discord

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_TOKEN_REMOTE` | — **required** | Discord token for Bot #1 (remote role). Canonical variable name. |
| `DISCORD_TOKEN` | *(deprecated fallback)* | Legacy fallback for `DISCORD_TOKEN_REMOTE` only. |
| `DISCORD_TOKEN_LOCAL` | *(empty)* | Discord token for Bot #2 (local role). Leave empty to disable local bot. |
| `ALLOWED_CHANNEL_IDS` | *(empty — all channels)* | Comma-separated channel IDs the bot will respond in. |

### LLM endpoints

| Variable | Default | Description |
|----------|---------|-------------|
| `VPS_LLAMA_URL` | `http://localhost:8080/v1` | Base URL of the remote/VPS llama-server OpenAI-compatible API |
| `VPS_LLAMA_ENABLED` | `true` | Set to `false` to skip auto-launching VPS llama-server |
| `VPS_LLAMA_BIN` | `./llama/llama-server` | Path to the VPS llama-server binary |
| `VPS_MODEL_PATH` | *(empty — required when enabled)* | Full path to the GGUF model file loaded by VPS llama-server |
| `LOCAL_AGENT_URL` | *(empty)* | HTTP URL of the Windows local agent (e.g. `http://100.x.x.x:3000`) |
| `LOCAL_AGENT_TOKEN` | *(empty)* | Bearer token for local agent auth |
| `LOCAL_LLAMA_URL` | *(empty)* | Direct URL of local llama-server on the Windows machine |
| `LOCAL_HEALTH_POLL_INTERVAL_MS` | `30000` | How often (ms) to poll local agent `/health` |

### OpenRouter (per-role inference backend)

Optional. Lets either role run inference on [OpenRouter](https://openrouter.ai) instead of the self-hosted llama-server, with automatic fallback. A role uses OpenRouter only when its `*_ENABLED` flag is `true` **and** `OPENROUTER_API_KEY` is set. `*_PRIORITY` chooses which backend is tried first; the other is the fallback. Leave the enable flags off (default) to keep the bot llama-server-only.

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | *(empty)* | OpenRouter API key. Required for any OpenRouter use; when empty, OpenRouter is never selected. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL |
| `OPENROUTER_HTTP_REFERER` | *(empty)* | Optional `HTTP-Referer` ranking header (sent only when set) |
| `OPENROUTER_X_TITLE` | *(empty)* | Optional `X-Title` ranking header (sent only when set) |
| `OPENROUTER_REMOTE_ENABLED` | `false` | Allow OpenRouter for the remote role |
| `OPENROUTER_REMOTE_PRIORITY` | `llama` | Remote role preferred backend: `llama` or `openrouter` |
| `OPENROUTER_REMOTE_MODEL` | `google/gemma-4-26b-a4b-it:free` | OpenRouter model slug for the remote role |
| `OPENROUTER_REMOTE_CONTEXT_SIZE` | `8192` | Context size used for tool-round trim budgeting (remote) |
| `OPENROUTER_REMOTE_FETCH_TIMEOUT_MS` | falls back to `LLM_FETCH_TIMEOUT_MS` | Fetch timeout for remote OpenRouter calls |
| `OPENROUTER_LOCAL_ENABLED` | `false` | Allow OpenRouter for the local role |
| `OPENROUTER_LOCAL_PRIORITY` | `llama` | Local role preferred backend: `llama` or `openrouter` |
| `OPENROUTER_LOCAL_MODEL` | `google/gemma-4-31b-it:free` | OpenRouter model slug for the local role |
| `OPENROUTER_LOCAL_CONTEXT_SIZE` | `8192` | Context size used for tool-round trim budgeting (local) |
| `OPENROUTER_LOCAL_FETCH_TIMEOUT_MS` | falls back to `LLM_FETCH_TIMEOUT_MS` | Fetch timeout for local OpenRouter calls |
| `OPENROUTER_{TEMPERATURE,TOP_P,TOP_K,MAX_TOKENS}_{REMOTE,LOCAL}` | falls back to global `LLM_*` | Per-role OpenRouter inference params. Only this OpenAI-safe subset is sent (no `min_p`/`repeat_penalty`/reasoning budget). |
| `OPENROUTER_RETRY_MAX_ATTEMPTS` | falls back to `RETRY_MAX_ATTEMPTS` | Max retry attempts for OR calls |
| `OPENROUTER_RETRY_INITIAL_DELAY_MS` | falls back to `RETRY_INITIAL_DELAY_MS` | Initial backoff delay for non-429 OR failures |
| `OPENROUTER_RETRY_RATE_LIMIT_DELAY_MS` | `10000` | Fixed pause (ms) for 429 rate-limit responses; `Retry-After` header takes precedence when present |
| `OPENROUTER_FALLBACK` | `0` | Cross-role OR fallback: `0`=off, `1`=local→remote only, `2`=any direction |

### Model file / role prompt

| Variable | Default | Description |
|----------|---------|-------------|
| `VPS_MODEL_FILE` | `phi4-mini.Q4_K_M.gguf` | Remote model filename shown in logs |
| `LOCAL_MODEL_FILE` | *(empty)* | Local model filename looked up in agent `LLAMA_MODEL_DIR` |
| `LOCAL_MODEL_COMMON_FILE` | *(legacy fallback)* | Backward-compatible fallback for `LOCAL_MODEL_FILE` |
| `SYSTEM_PROMPT` | hardcoded fallback | Shared fallback prompt when role-specific prompt files/env are absent |
| `SYSTEM_PROMPT_REMOTE` | *(empty)* | Remote prompt override (used if `sysprompt_remote.txt` is missing) |
| `SYSTEM_PROMPT_LOCAL` | *(empty)* | Local prompt override (used if `sysprompt_local.txt` is missing) |

### Search & complexity controls

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARCH` | `on` | Master search switch (`on` / `off`) |
| `SEARCH_MODE` | `auto` | `auto` model-signal search, `command` command-only search |
| `SEARCH_COMMAND` | `!search` | Force-search command name (must start with `!`) |
| `SEARXNG_BASE_URL` | *(empty)* | Base URL of your SearXNG instance |
| `SEARCH_RESULT_COUNT` | `5` | Number of search results injected into model context |
| `COMPLEXITY_PROMPT_LENGTH` | `300` | Minimum prompt length threshold for complexity heuristics |
| `COMPLEXITY_KEYWORDS_CODE` | built-in list | Comma-separated keywords for code-related complexity signals |
| `COMPLEXITY_KEYWORDS_PLAN` | built-in list | Comma-separated keywords for planning/architecture complexity signals |

### History

| Variable | Default | Description |
|----------|---------|-------------|
| `HISTORY_MAX_PAIRS` | `10` | Conversation message pairs kept per user |
| `MAX_INPUT_TOKENS` | `0` | Shared max-input-token trim threshold (`0` = disabled) |
| `MAX_INPUT_TOKENS_REMOTE` | falls back to `MAX_INPUT_TOKENS` | Remote role token trim threshold |
| `MAX_INPUT_TOKENS_LOCAL` | falls back to `MAX_INPUT_TOKENS` | Local role token trim threshold |

### llama.cpp startup args / context / timeout (per role)

| Variable | Default | Description |
|----------|---------|-------------|
| `LLAMA_EXTRA_ARGS` | *(empty)* | Global fallback extra args for llama-server |
| `LLAMA_EXTRA_ARGS_REMOTE` | falls back to `LLAMA_EXTRA_ARGS` | Extra args for remote role |
| `LLAMA_EXTRA_ARGS_LOCAL` | falls back to `LLAMA_EXTRA_ARGS` | Extra args for local role |
| `LLAMA_CONTEXT_SIZE` | `0` | Global fallback context size (`0` = model default) |
| `LLAMA_CONTEXT_SIZE_REMOTE` | falls back to `LLAMA_CONTEXT_SIZE` | Context size for remote role (must match `llama-server -c`; also drives per-round tool-call trimming) |
| `LLAMA_CONTEXT_SIZE_LOCAL` | falls back to `LLAMA_CONTEXT_SIZE` | Context size for local role |
| `CONTEXT_TRIM_SAFETY_MARGIN` | `512` | Extra token reserve subtracted from `n_ctx` before each tool-calling LLM round |
| `CONTEXT_TRIM_MIN_MESSAGE_BUDGET` | `512` | Floor for the computed messages budget after reserves |
| `LLM_FETCH_TIMEOUT_MS` | `120000` | Global fallback timeout for `/chat/completions` |
| `LLM_FETCH_TIMEOUT_MS_REMOTE` | falls back to `LLM_FETCH_TIMEOUT_MS` | Fetch timeout for remote role |
| `LLM_FETCH_TIMEOUT_MS_LOCAL` | falls back to `LLM_FETCH_TIMEOUT_MS` | Fetch timeout for local role |

### Inference parameters (global + per role)

Use global values (`LLM_TEMPERATURE`, `LLM_TOP_P`, `LLM_TOP_K`, `LLM_MIN_P`, `LLM_REPEAT_PENALTY`, `LLM_MAX_TOKENS`, `LLM_REASONING_BUDGET`) with per-role overrides: `_REMOTE` and `_LOCAL`.

Examples: `LLM_TEMPERATURE_REMOTE`, `LLM_TEMPERATURE_LOCAL`, `LLM_REASONING_BUDGET_REMOTE`, `LLM_REASONING_BUDGET_LOCAL`.

### Rate limiting / retries

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_MAX_REQUESTS` | `5` | Max messages per user per time window |
| `RATE_LIMIT_WINDOW_MS` | `30000` | Sliding window duration in ms |
| `MAX_CONCURRENT_REQUESTS` | `1` | Max simultaneous LLM calls across all users |
| `RETRY_MAX_ATTEMPTS` | `3` | Max retry attempts for failed LLM/SearXNG calls |
| `RETRY_INITIAL_DELAY_MS` | `500` | Initial retry delay in ms (exponential backoff) |

### Observability / local presence

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_PORT` | `0` (disabled) | Port for `GET /health` endpoint |
| `HEALTH_TOKEN` | *(empty)* | Optional bearer token to protect `/health` |
| `LOG_LEVEL` | `info` | Log verbosity (`debug` / `info` / `warn` / `error`) |
| `LOG_RAW` | `false` | Log raw LLM input/output payloads |
| `LOCAL_PRESENCE_COOLDOWN_MS` | `30000` | Local bot online→idle cooldown |
| `LOCAL_MODEL_IDLE_MS` | `0` | Idle timeout before stopping local model (`0` = never) |

### MCP (Model Context Protocol)

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_ENABLED` | `false` | Master switch for MCP tool calling |
| `MCP_COINGECKO_ENABLED` | `false` | Enable built-in CoinGecko MCP server |
| `MCP_COINGECKO_API_KEY` | *(empty)* | Optional CoinGecko Pro key (`x-cg-pro-api-key`) |
| `MCP_COINGECKO_URL` | `https://mcp.api.coingecko.com/` | CoinGecko MCP server URL |
| `MCP_GITBOOK_ENABLED` | `false` | Enable built-in GitBook MCP integration |
| `MCP_GITBOOK_URL_1..10` | *(empty)* | GitBook docs URLs (app auto-appends `/~gitbook/mcp` when needed) |
| `MCP_GITBOOK_TOKEN_1..10` | *(empty)* | Optional per-GitBook bearer tokens |
| `MCP_GITBOOK_URL` | *(legacy)* | Deprecated single-URL fallback; used as `gitbook-1` when numbered URLs are not set |
| `MCP_GITBOOK_TOKEN` | *(empty)* | Shared GitBook token fallback when per-instance token is missing |
| `MCP_GITBOOK_TRANSPORT` | `streamable-http` | GitBook transport (`streamable-http` or `sse`) |
| `MCP_SERVER_1..10_NAME` | *(empty)* | Custom MCP server logical name |
| `MCP_SERVER_1..10_URL` | *(empty)* | Custom MCP server URL |
| `MCP_SERVER_1..10_TRANSPORT` | `streamable-http` | Custom MCP transport (`streamable-http` or `sse`) |
| `MCP_SERVER_1..10_API_KEY` | *(empty)* | Optional custom MCP `x-api-key` header |

---


## Gemma 4 Notes

See [`gemma4.md`](./gemma4.md) for a full Gemma 4 setup and hardware guide.

Key points for running Gemma 4 with this bot:

- **`--swa-full` is required.** Gemma 4 uses "hybrid SWA" which triggers a llama.cpp checkpoint invalidation bug (June 2025) that causes 10–44 minute cold starts on every slot switch. The bot automatically adds `--swa-full --parallel 4` to `LLAMA_EXTRA_ARGS_REMOTE` and `--swa-full` to `LLAMA_EXTRA_ARGS_LOCAL` by default. If you override those variables, make sure you keep `--swa-full`. Learn more: [`gemma4.md`](./gemma4.md).

- **Enable thinking mode** by passing `--chat-template-kwargs '{"enable_thinking":true}'` to llama-server. Set this via role-specific vars like `LLAMA_EXTRA_ARGS_REMOTE` and `LLAMA_EXTRA_ARGS_LOCAL`.

  When using the **Windows local agent**, the preferred place is the **agent's** `.env` (agent-side values take priority over bot-sent values):

  **Windows PowerShell** (in `agent/.env`):
  ```
  LLAMA_EXTRA_ARGS_LOCAL=--chat-template-kwargs '{"enable_thinking":true}'
  ```

  Alternatively, set them in the **bot's** `.env` (used as a fallback when the agent doesn't override):

  **Linux / bash** (in bot `.env`):
  ```
  LLAMA_EXTRA_ARGS_REMOTE=--chat-template-kwargs '{"enable_thinking":true}'
  LLAMA_EXTRA_ARGS_LOCAL=--chat-template-kwargs '{"enable_thinking":true}'
  ```

  **Windows PowerShell** (in bot `.env`):
  ```
  LLAMA_EXTRA_ARGS_REMOTE=--chat-template-kwargs '{"enable_thinking":true}'
  LLAMA_EXTRA_ARGS_LOCAL=--chat-template-kwargs '{"enable_thinking":true}'
  ```
- **Think blocks are automatically stripped** before the response is sent to Discord. The internal reasoning block is removed; only the final answer is shown.
- **Recommended inference parameters** for Gemma 4: `temperature=1.0`, `top_p=0.95`, `top_k=64`, `repetition_penalty=1.0`. Set these globally or per-model:
  ```
  LLM_TEMPERATURE=1.0
  LLM_TOP_P=0.95
  LLM_TOP_K=64
  LLM_REPEAT_PENALTY=1.0
  ```
- **VPS model** can be a different, smaller/faster model (e.g. a compact quantised model) — it does not need to be Gemma 4.

---

## OpenRouter

Use OpenRouter when you want a hosted model to serve a role instead of (or as a fallback for) your self-hosted llama-server. It is OpenAI-compatible, so it slots into the same inference path — only the backend selection changes; all bot routing, search, MCP, and history behave identically.

Minimal example — prefer OpenRouter for the remote role, fall back to llama-server on failure:

```env
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_REMOTE_ENABLED=true
OPENROUTER_REMOTE_PRIORITY=openrouter
OPENROUTER_REMOTE_MODEL=google/gemma-4-26b-a4b-it:free

# Optional: do the same for the local (escalation) role
OPENROUTER_LOCAL_ENABLED=true
OPENROUTER_LOCAL_PRIORITY=openrouter
OPENROUTER_LOCAL_MODEL=google/gemma-4-31b-it:free
```

How selection works per role:

- A role is OpenRouter-eligible only when its `*_ENABLED` flag is `true` **and** `OPENROUTER_API_KEY` is set.
- `*_PRIORITY` decides which backend is tried first (`llama` or `openrouter`).
- If the preferred backend's request fails (missing key, network error, 5xx), the request **automatically falls back** to the other backend. With `PRIORITY=llama` (default), OpenRouter acts purely as a backup; with `PRIORITY=openrouter`, the llama-server is the backup.
- The self-hosted llama-server still starts and warms up as usual, so a fallback target is always available. Set per-role `*_CONTEXT_SIZE` so tool-round context trimming matches the OpenRouter model's window.

> Only the OpenAI-safe inference params (`temperature`, `top_p`, `top_k`, `max_tokens`) are sent to OpenRouter. llama.cpp-specific options (`min_p`, `repeat_penalty`, `n_keep`, reasoning budget) apply to the llama-server backend only.

### OpenRouter retry

OpenRouter calls are retried independently from the global retry settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_RETRY_MAX_ATTEMPTS` | falls back to `RETRY_MAX_ATTEMPTS` | Max attempts per OR call |
| `OPENROUTER_RETRY_INITIAL_DELAY_MS` | falls back to `RETRY_INITIAL_DELAY_MS` | Initial backoff for non-429 failures |
| `OPENROUTER_RETRY_RATE_LIMIT_DELAY_MS` | `10000` | Fixed pause for 429 rate-limit responses (ms). The `Retry-After` header from OpenRouter is honoured when present and takes precedence. |

429 responses are retried up to `OPENROUTER_RETRY_MAX_ATTEMPTS` times; all other 4xx errors are not retried.

### OpenRouter cross-role fallback

`OPENROUTER_FALLBACK` controls whether a failing OR model can try the other role's OR model before falling back to llama-server:

| Value | Behaviour |
|-------|-----------|
| `0` (default) | Disabled — each role only falls back to its own llama-server |
| `1` | Local → remote only: local OR (31B, powerful) fails → try remote OR (26B, lighter) → then llama |
| `2` | Any direction: remote OR fails → try local OR, and vice versa → then llama |

When a cross-role OR fallback is used, the system prompt automatically switches to the fallback role's persona so the model behaves consistently.

### Local bot presence with OpenRouter

The local bot (vale) tracks OpenRouter availability by polling `GET /models` on the same interval as the agent health check (`LOCAL_HEALTH_POLL_INTERVAL_MS`). Presence shows:
- **Idle** — Tailscale agent is online+warmed **or** OpenRouter local is reachable
- **DND** — both the agent and OpenRouter local are unavailable

Escalation from the remote bot to vale is gated on this combined check — the remote bot will not tag vale when neither backend is available.

---

## Search Flow

1. A user message is processed by the model, which may emit `__SEARCH__: <query>` in its response.
2. If `SEARCH=on` and `SEARCH_MODE=auto`: the search executes against SearXNG, results are injected into the conversation context, and the model re-runs to produce a final answer.
3. Users can also force a search directly with the search command (default: `!search <query>`), bypassing the model signal.
4. If `SEARCH_MODE=command`: auto-signals from the model are dropped; only the `!search` command triggers a search.
5. If `SEARCH=off`: all search functionality is disabled.

---

## MCP (Model Context Protocol)

MCP lets the bot call external tools/APIs during generation (through OpenAI-style tool calls exposed by MCP servers).

### GitBook MCP (zero-setup docs lookup)

Use GitBook MCP when you want the bot to answer from published docs with minimal setup:

```env
MCP_ENABLED=true
MCP_GITBOOK_ENABLED=true
MCP_GITBOOK_URL_1=https://docs.botanixlabs.com/botanix/
MCP_GITBOOK_URL_2=https://docs.example.com/my-project/
MCP_GITBOOK_TRANSPORT=streamable-http
MCP_GITBOOK_TOKEN=
MCP_GITBOOK_TOKEN_2=optional_project_token
```

Behavior:
- The app creates one server per URL (`gitbook-1`, `gitbook-2`, ...).
- Friendly docs URLs are auto-normalized to MCP endpoints by appending `/~gitbook/mcp` when missing.
- Token resolution: `MCP_GITBOOK_TOKEN_N` first, then shared `MCP_GITBOOK_TOKEN`.
- Legacy fallback still works: `MCP_GITBOOK_URL` (single server, mapped to `gitbook-1`).

### Mintlify MCP (documentation lookup)

Use Mintlify MCP when you want the bot to answer from Mintlify-hosted docs:

```env
MCP_ENABLED=true
MCP_MINTLIFY_ENABLED=true
MCP_MINTLIFY_URL_1=https://docs.example.com/
MCP_MINTLIFY_URL_2=https://docs.another.com/
MCP_MINTLIFY_TRANSPORT=streamable-http
MCP_MINTLIFY_TOKEN=
MCP_MINTLIFY_TOKEN_2=optional_project_token
```

Behavior:
- The app creates one server per URL (`mintlify-1`, `mintlify-2`, ...).
- Friendly docs URLs are auto-normalized to MCP endpoints by appending `/mcp` when missing (GitBook still uses `/~gitbook/mcp`).
- Token resolution: `MCP_MINTLIFY_TOKEN_N` first, then shared `MCP_MINTLIFY_TOKEN`.
- Legacy fallback still works: `MCP_MINTLIFY_URL` (single server, mapped to `mintlify-1`).

### CoinGecko MCP

Enable CoinGecko MCP to give the bot crypto market tools:

```env
MCP_ENABLED=true
MCP_COINGECKO_ENABLED=true
MCP_COINGECKO_URL=https://mcp.api.coingecko.com/
MCP_COINGECKO_API_KEY=
```

### Custom MCP servers (full flexibility, self-hosted)

Add any self-hosted MCP server/tool with numbered variables:

```env
MCP_SERVER_1_NAME=mytools
MCP_SERVER_1_URL=https://example.com/mcp
MCP_SERVER_1_TRANSPORT=streamable-http
MCP_SERVER_1_API_KEY=
```

**GitBook MCP vs custom MCP:** GitBook MCP is a convenience integration for documentation lookup with no server hosting needed. Custom MCP is fully flexible for any tool/API, but you run and maintain that server yourself.

---

## Agent Setup

See [`agent/README.md`](./agent/README.md) for full instructions on setting up the Windows local agent that manages llama-server on the Windows machine.
