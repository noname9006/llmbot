# llmbot

A Discord bot powered by **llama-server** (llama.cpp) with a three-tier local/VPS LLM setup using Gemma 4. The VPS runs a lightweight always-on fallback model; a Windows local machine with a GPU runs the heavier everyday and escalation models, managed by a small HTTP agent.

---

## Table of Contents

- [Architecture](#architecture)
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
- [Escalation Flow](#escalation-flow)
- [Search Flow](#search-flow)
- [Agent Setup](#agent-setup)

---

## Architecture

The bot uses three model roles:

- **VPS model** — always-on cloud fallback. A `llama-server` process runs permanently on the VPS. Every request falls back here when the local agent is unavailable.
- **Common model** — everyday local GPU model. Managed by the Windows local agent, loaded on first use and kept resident. Handles the majority of requests when the local agent is online.
- **Heavy model** — loaded on escalation. Also managed by the Windows local agent. Swapped in (or run with alternative inference args) when the common model signals a query is too complex.

**Routing logic:** every incoming message goes to the common model if the local agent is up; otherwise it falls back to the VPS model. The common model can emit an `__ESCALATE__` signal to trigger the heavy model automatically (configurable).

```
[Discord]
    └── [VPS: Discord bot + llama-server (fallback)]
              └── HTTP over Tailscale → [Windows: agent :3000]
                                              └── spawns/kills → [llama-server :8081]
                                                                    <model dir>\<model>.gguf
```

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
LLAMA_EXTRA_ARGS_COMMON=--flash-attn -ngl 99
LLAMA_EXTRA_ARGS_HEAVY=--flash-attn -ngl 99
```

For Gemma 4 thinking mode (recommended), also append the thinking flag:

```env
# Windows PowerShell / .env — escape inner quotes with \"
LLAMA_EXTRA_ARGS_COMMON=--flash-attn -ngl 99 --chat-template-kwargs '{"enable_thinking":true}'
LLAMA_EXTRA_ARGS_HEAVY=--flash-attn -ngl 99 --chat-template-kwargs '{"enable_thinking":true}'
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

The bot loads a separate system prompt file for each model role:

| File | Role |
|------|------|
| `sysprompt_remote.txt` | Remote model system prompt |
| `sysprompt_common.txt` | Common model system prompt |
| `sysprompt_local.txt` | Local fallback system prompt |
| `sysprompt.txt` | Global fallback (used when role-specific file is missing) |

Each file falls back to `sysprompt.txt` if the role-specific file does not exist. Edit these files to customise the bot's personality and behaviour per model.

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

System prompts are loaded from files, not environment variables. See [Setup → System prompts](#6-system-prompts) above.

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

When using the **Windows local agent**, per-model extra args can also be set in the **agent's** `.env` (`LLAMA_EXTRA_ARGS_COMMON`, `LLAMA_EXTRA_ARGS_HEAVY`) and will take priority over bot-sent values.

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
  LLAMA_EXTRA_ARGS_COMMON=--chat-template-kwargs '{"enable_thinking":true}'
  LLAMA_EXTRA_ARGS_HEAVY=--chat-template-kwargs '{"enable_thinking":true}'
  ```

  Alternatively, set them in the **bot's** `.env` (used as a fallback when the agent doesn't override):

  **Linux / bash** (in bot `.env`):
  ```
  LLAMA_EXTRA_ARGS_COMMON=--chat-template-kwargs '{"enable_thinking":true}'
  LLAMA_EXTRA_ARGS_HEAVY=--chat-template-kwargs '{"enable_thinking":true}'
  ```

  **Windows PowerShell** (in bot `.env`):
  ```
  LLAMA_EXTRA_ARGS_COMMON=--chat-template-kwargs '{"enable_thinking":true}'
  LLAMA_EXTRA_ARGS_HEAVY=--chat-template-kwargs '{"enable_thinking":true}'
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