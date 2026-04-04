# discord-llm-bot

A Discord bot powered by **llama-server** (llama.cpp), using a three-model architecture. The VPS runs a lightweight fallback model; a Windows local machine with a GPU runs two additional models managed on demand. The bot routes every request to the best available model automatically.

---

## Table of Contents

1. [Architecture](#architecture)
2. [How It Works — Routing & Scenarios](#how-it-works--routing--scenarios)
3. [Feature Overview](#feature-overview)
4. [Repository Structure](#repository-structure)
5. [Full Setup from Scratch](#full-setup-from-scratch)
   - [Prerequisites](#prerequisites)
   - [Step 1 — Create a Discord Bot](#step-1--create-a-discord-bot)
   - [Step 2 — Install llama.cpp on the VPS](#step-2--install-llamacpp-on-the-vps)
   - [Step 3 — Configure & Start llama-server on the VPS](#step-3--configure--start-llama-server-on-the-vps)
   - [Step 4 — Install Tailscale](#step-4--install-tailscale)
   - [Step 5 — Install llama.cpp on Windows](#step-5--install-llamacpp-on-windows)
   - [Step 6 — Set Up the Windows Local Agent](#step-6--set-up-the-windows-local-agent)
   - [Step 7 — Deploy the Bot on the VPS](#step-7--deploy-the-bot-on-the-vps)
6. [Environment Variables Reference](#environment-variables-reference)
   - [Bot `.env` (VPS)](#bot-env-vps)
   - [Agent `.env` (Windows)](#agent-env-windows)
7. [Commands & Usage](#commands--usage)
8. [Troubleshooting](#troubleshooting)

---

## Architecture

```
[Discord]
    ↕
[VPS: Node.js bot (PM2)]
    ├── HTTP → [VPS: llama-server :8080 (PM2, always on)]
    │           /home/ubuntu/lllm/<VPS_MODEL_FILE>
    └── HTTP → [Windows: local agent :3000 (Node.js)]
                    ↑ Tailscale  (Authorization: Bearer token)
                    └── spawns/kills → [llama-server :8081]
                                        F:\AI\.models\<model>
```

- The **VPS bot** (Node.js + PM2) is the only process that touches Discord.
- The **VPS llama-server** (Model 1) runs 24/7 on CPU as a guaranteed fallback.
- The **Windows local agent** is a small Express server that manages the lifecycle of llama-server on the Windows machine (start, stop, health).
- The **Windows llama-server** (Models 2 & 3) runs on GPU via Vulkan; it is started on demand and auto-stopped after 15 minutes of idle time.
- All communication between VPS and Windows travels over a **Tailscale** private network — no public ports needed on the Windows machine.

---

## How It Works — Routing & Scenarios

Every incoming `@mention` message goes through the following decision tree:

### Scenario A — Local agent offline (VPS-only mode)

```
User @mentions bot
    → bot checks agent /health  →  offline
    → sends message to VPS llama-server (Model 1, :8080)
    → posts reply to Discord
```

Model 1 is always available, CPU-only, lightweight. Used as an always-on fallback.

---

### Scenario B — Local agent online, simple question

```
User @mentions bot
    → bot checks agent /health  →  online
    → bot calls agent POST /start { model: "common.gguf" }  (if not already loaded)
    → sends message to Windows llama-server (Model 2, :8081)
    → Model 2 returns a normal reply
    → posts reply to Discord
```

Model 2 is the everyday workhorse: GPU-accelerated, more capable than Model 1.

---

### Scenario C — Local agent online, question too complex (escalation)

```
User @mentions bot
    → bot routes to Model 2 (common)
    → Model 2 replies with the special token  __ESCALATE__
    → bot asks Model 2 to generate a short "I need to think" transition message
    → bot calls agent POST /start { model: "heavy.gguf" }
    → transition message is posted to Discord
    → bot sends full conversation history to Model 3 (heavy)
    → posts Model 3 reply to Discord
    → 15-minute idle timer starts; if no messages arrive, agent POST /stop is called
```

Model 3 is the heavy model, loaded only when needed and auto-unloaded to free VRAM.

---

### Scenario D — Web search triggered automatically

Any model (1, 2, or 3) can signal that it needs live information by replying with:

```
__SEARCH__: <search query>
```

When the bot detects this signal:

```
Model returns  __SEARCH__: how to install Node.js
    → bot sanitises the query
    → bot asks the same model to generate "I'm looking this up…" message → posts it
    → bot queries SearXNG  →  formats top N results
    → injects results as a system message into the conversation
    → re-runs the same model with search results in context
    → posts final answer to Discord
```

A second `__SEARCH__` signal in the follow-up response is suppressed with a safe fallback to prevent infinite loops.

---

### Scenario E — Forced web search (`!search`)

```
User types: !search what is the capital of France
    → bot picks the currently active endpoint (local if online, VPS otherwise)
    → runs SearXNG query
    → injects results and calls the model
    → posts answer to Discord
    → saves exchange to user conversation history
```

---

### Model idle auto-shutdown

After Model 3 (heavy) handles a response, a **15-minute idle timer** starts. Any new message from any user resets the timer. When the timer fires with no activity, the bot sends `POST /stop` to the Windows agent, which kills the llama-server process and frees GPU memory. The next request that needs the heavy model will reload it transparently.

---

### Availability polling

The bot polls the Windows agent's `/health` endpoint every `LOCAL_HEALTH_POLL_INTERVAL_MS` milliseconds (default 30 s). State transitions are logged:

- `offline → online`: cached model state is reset; next request triggers a fresh `/start`.
- `online → offline`: bot falls back to VPS Model 1 automatically.

The VPS llama-server is also polled and its status is visible via `!status`.

---

### Circuit breaker

If the Windows agent's `/start` endpoint fails **3 consecutive times**, the circuit breaker opens for **2 minutes**. During that window all local model requests fail fast with an error message, preventing a flood of slow timeouts. The breaker resets automatically on a successful `/start` or when the agent reconnects.

---

### Capitalization mirroring

The bot detects the capitalization style of the user's first word and injects an ephemeral system reminder so the model matches it:

| User writes | Model writes |
|-------------|--------------|
| `lowercase question` | entirely lowercase reply |
| `Capitalised question` | Normal sentence capitalisation |
| `ALL CAPS QUESTION` | ALL CAPS REPLY |

---

### Conversation memory

Each Discord user gets an isolated conversation history (sliding window, default 10 user+assistant pairs). The system prompt from `sysprompt.txt` is always prepended. Histories older than 24 hours are evicted automatically. Users can clear their own history with `!reset`.

---

### Rate limiting & concurrency

- **Per-user**: max 5 messages per 30-second sliding window (configurable).
- **Global**: max 5 simultaneous LLM calls in flight (configurable). Additional requests queue until a slot opens.

---

## Feature Overview

| Feature | Details |
|---------|---------|
| Three-model routing | VPS fallback → local common → local heavy, fully automatic |
| Automatic escalation | Model 2 signals `__ESCALATE__` to trigger Model 3 |
| Auto web search | Any model can signal `__SEARCH__: <query>` to fetch live results |
| Forced search | `!search <query>` command bypasses the model's decision |
| SearXNG integration | Configurable result count, sanitised query injection |
| GPU auto-management | llama-server is started/stopped on demand; 15 min idle shutdown |
| Circuit breaker | Opens after 3 consecutive agent failures, recovers after 2 min |
| Conversation memory | Per-user sliding window, 24 h TTL, `!reset` command |
| Rate limiting | Per-user + global concurrency cap |
| Retry with back-off | Exponential retry on LLM and SearXNG calls |
| Capitalization mirroring | Reply style matches the user's casing |
| Long message splitting | Replies > 1900 chars are automatically chunked |
| PM2 managed | Bot and VPS llama-server run under PM2 with auto-restart |
| Tailscale networking | Secure private tunnel — no public ports on Windows |
| Health endpoint | Optional HTTP `/health` port for uptime monitors |

---

## Repository Structure

```
discord-llm-bot/
├── src/
│   ├── index.js                        # Entry point & graceful shutdown
│   ├── bot.js                          # Discord client setup
│   ├── config.js                       # Validated config from .env
│   ├── logger.js                       # Leveled logger with timers
│   ├── handlers/
│   │   ├── messageHandler.js           # @mention handler, routing, search, escalation
│   │   └── commandHandler.js           # !reset, !status, !search, !help
│   ├── services/
│   │   ├── llamaService.js             # OpenAI-compat client for llama-server
│   │   ├── agentService.js             # HTTP client for Windows agent + model state + circuit breaker
│   │   ├── localAvailabilityService.js # Polls agent /health and VPS /models
│   │   ├── searchService.js            # SearXNG client
│   │   └── historyService.js           # Per-user conversation memory
│   └── utils/
│       ├── rateLimiter.js              # Per-user sliding window + global semaphore
│       └── retry.js                    # Exponential back-off retry wrapper
├── agent/
│   ├── index.js                        # Windows local agent (Express)
│   ├── package.json
│   ├── .env.example
│   └── README.md                       # Agent-specific setup guide
├── .env.example                        # Bot environment template
├── ecosystem.config.js                 # PM2 config for the bot
├── package.json
└── sysprompt.txt                       # Default system prompt (edit freely)
```

---

## Full Setup from Scratch

### Prerequisites

| Where | What | Notes |
|-------|------|-------|
| VPS | Ubuntu 20.04+ (or similar 64-bit Linux) | Any cloud provider |
| VPS | Node.js ≥ 18 | `node --version` to check |
| VPS | PM2 | `npm install -g pm2` |
| VPS | llama-server binary (AVX2 Linux build) | See Step 2 |
| VPS | A GGUF model file for the fallback (Model 1) | Hugging Face |
| Windows machine | Node.js ≥ 18 | https://nodejs.org |
| Windows machine | llama-server.exe (Vulkan build) | See Step 5 |
| Windows machine | GGUF model files for Models 2 & 3 | Hugging Face |
| Windows machine | Tailscale | https://tailscale.com |
| Both | Tailscale installed and connected to the same tailnet | See Step 4 |
| Discord | A bot application with `MESSAGE CONTENT INTENT` enabled | See Step 1 |

---

### Step 1 — Create a Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications).
2. Click **New Application** → give it a name → **Create**.
3. In the left sidebar click **Bot**.
4. Click **Add Bot** (if shown) → confirm.
5. Under **Token** click **Reset Token** → copy and **save it** (you will need it for `DISCORD_TOKEN`).
6. Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent**. Save changes.
7. In the left sidebar click **OAuth2 → URL Generator**.
   - Scopes: check `bot`.
   - Bot Permissions: check **Read Messages / View Channels**, **Send Messages**, **Read Message History**.
8. Copy the generated URL, open it in a browser, and invite the bot to your server.

---

### Step 2 — Install llama.cpp on the VPS

The easiest way is to download a pre-built binary from the llama.cpp GitHub releases page.

> **Note:** Since ~b5700, llama.cpp uses dynamically loaded CPU backends (`.so` files). The binary must run from its extracted directory, or `LD_LIBRARY_PATH` must point to it. Do **not** copy just the binary to `/usr/local/bin`.

**Install required system dependency:**

```bash
sudo apt-get install -y libgomp1
```

**Download and extract the latest build:**

```bash
# Check https://github.com/ggml-org/llama.cpp/releases for the latest tag
LLAMA_VERSION=b8664   # replace with the latest version tag

wget https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/llama-${LLAMA_VERSION}-bin-ubuntu-x64.tar.gz -O llama.tar.gz
mkdir llama-${LLAMA_VERSION}
tar -xzf llama.tar.gz -C llama-${LLAMA_VERSION}
```

The binary you need is called `llama-server` (no extension). Verify:

```bash
LD_LIBRARY_PATH=~/llama-${LLAMA_VERSION} ~/llama-${LLAMA_VERSION}/llama-server --version
```

> **AVX2 note:** The pre-built Ubuntu x64 bundles require AVX2. Check support with: `grep -o 'avx2' /proc/cpuinfo`. If missing, you will need to build from source.

---

### Step 3 — Configure & Start llama-server on the VPS

**Place your Model 1 (fallback) GGUF file:**

```bash
mkdir -p /home/ubuntu/llm
# Copy or download your model, e.g.:
# wget https://huggingface.co/.../Phi-4-mini-instruct-Q4_K_M.gguf -O /home/ubuntu/llm/Phi-4-mini-instruct-Q4_K_M.gguf
```

**Create a startup wrapper script:**

Because newer llama.cpp builds load CPU backends from `.so` files at runtime, the binary must be able to find them. The wrapper script sets `LD_LIBRARY_PATH` before starting the server.

```bash
nano /home/ubuntu/llm_bot/start-llama.sh
```

Paste the following (adjust `LLAMA_VERSION`, model path, and flags to match your setup):

```bash
#!/bin/bash
export LD_LIBRARY_PATH=/home/ubuntu/llm_bot/llama-b8664:$LD_LIBRARY_PATH
exec /home/ubuntu/llm_bot/llama-b8664/llama-server \
  --model /home/ubuntu/llm/Phi-4-mini-instruct-Q4_K_M.gguf \
  --port 8080 \
  --host 0.0.0.0 \
  --ctx-size 4096
```

Save (`Ctrl+O`, `Enter`, `Ctrl+X`) and make it executable:

```bash
chmod +x /home/ubuntu/llm_bot/start-llama.sh
```

> **`--ctx-size` note:** The Phi-4-mini model has a native context of 131072 tokens. Without this flag the server will attempt to allocate ~16 GB for the KV cache and crash with an OOM error on a typical VPS. Set it to a value your RAM can support (4096 is safe for most VPS plans; 8192 if you have ≥8 GB free).

**Start llama-server under PM2:**

```bash
pm2 start /home/ubuntu/llm_bot/start-llama.sh --name llama-vps
pm2 save
pm2 startup   # follow the printed command to enable auto-start on reboot
```

Verify llama-server is running:

```bash
curl http://localhost:8080/health
# Expected: {"status":"ok"}
```

**llama-server common flags reference:**

| Flag | Meaning |
|------|---------|
| `--model <path>` | Path to the GGUF model file |
| `--port <n>` | Port to listen on |
| `--host <ip>` | Bind address (`0.0.0.0` to allow connections from the bot process) |
| `--ctx-size <n>` | Context window size — **required** on low-RAM VPS to prevent OOM |
| `-ngl <n>` | GPU layers to offload (`0` = CPU-only; omit on CPU-only VPS) |
| `-np <n>` | Number of parallel inference slots |

> **Log note:** llama-server writes all output (including normal startup messages) to stderr. PM2 stores this in the error log (`pm2 logs llama-vps`). This is expected — it does not indicate errors.

---

### Step 4 — Install Tailscale

Tailscale creates a private encrypted network between your VPS and Windows machine so they can communicate securely without exposing any ports to the public internet.

**On the VPS (Linux):**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Follow the authentication URL printed in the terminal to log in.

**On Windows:**

1. Download and install Tailscale from [tailscale.com/download](https://tailscale.com/download/windows).
2. Open Tailscale from the system tray → **Log in** → authenticate with the same account as the VPS.

**Verify both machines are on the same tailnet:**

```bash
# On the VPS:
tailscale status
```

You should see the Windows machine listed. Note its **Tailscale IP** (it starts with `100.`). You will use it for `LOCAL_AGENT_URL` and `LOCAL_LLAMA_URL` in the bot's `.env`.

---

### Step 5 — Install llama.cpp on Windows

The Windows machine uses the **Vulkan** backend (works with AMD, NVIDIA, and Intel GPUs).

1. Go to [github.com/ggerganov/llama.cpp/releases](https://github.com/ggerganov/llama.cpp/releases).
2. Find the latest release and download the file named:
   `llama-<version>-bin-win-vulkan-x64.zip`
3. Extract the zip, e.g. to `F:\AI\llama.cpp\`.
4. The executable you need is `llama-server.exe` inside the extracted folder.

Verify it works (run in PowerShell):

```powershell
F:\AI\llama.cpp\llama-server.exe --version
```

**Place your model files** in a dedicated directory, e.g. `F:\AI\.models\`:

```
F:\AI\.models\
    your-common-model.Q4_K_M.gguf   ← Model 2 (everyday use)
    your-heavy-model.Q4_K_M.gguf    ← Model 3 (complex questions)
```

You can download GGUF models from [Hugging Face](https://huggingface.co/models?library=gguf). Recommended quantization: `Q4_K_M` for a balance of quality and VRAM use.

**Install Vulkan drivers** if not already installed:
- AMD: [amd.com/en/support](https://www.amd.com/en/support)
- NVIDIA: standard Game Ready or Studio driver includes Vulkan
- Verify: run `vulkaninfo` in PowerShell (install `vulkan-sdk` from [lunarg.com](https://www.lunarg.com/vulkan-sdk/) if the command is missing)

---

### Step 6 — Set Up the Windows Local Agent

The agent is a small Node.js/Express server that the VPS bot calls to start and stop llama-server.

**In PowerShell on your Windows machine:**

```powershell
# Clone the repo (or copy the agent folder to Windows)
git clone https://github.com/noname9006/llmbot.git discord-llm-bot
cd discord-llm-bot\agent

# Install dependencies
npm install

# Create the environment file
copy .env.example .env
notepad .env
```

**Edit `agent\.env`** — set every value to match your paths:

```dotenv
PORT=3000
AGENT_TOKEN=replace_with_a_long_random_secret   # must match LOCAL_AGENT_TOKEN in bot .env

LLAMA_SERVER_BIN=F:\AI\llama.cpp\llama-server.exe
LLAMA_SERVER_PORT=8081
LLAMA_MODEL_DIR=F:\AI\.models

LLAMA_GPU_LAYERS=99       # offload all layers to GPU (recommended)
# LLAMA_CONTEXT_SIZE=4096 # optional; omit to use the model's built-in default

LOG_LEVEL=info
```

**Generate a secure random token** (run in PowerShell):

```powershell
-join ((65..90 + 97..122 + 48..57) | Get-Random -Count 40 | ForEach-Object {[char]$_})
```

Copy the output into both `AGENT_TOKEN` (agent `.env`) and `LOCAL_AGENT_TOKEN` (bot `.env`).

**Open the Windows Firewall** to allow the VPS to reach the agent over Tailscale (run as Administrator in PowerShell):

```powershell
# Allow agent port from Tailscale subnet only (100.64.0.0/10)
New-NetFirewallRule -DisplayName "llmbot-agent" `
  -Direction Inbound -Protocol TCP -LocalPort 3000 `
  -RemoteAddress "100.64.0.0/10" -Action Allow

# Allow llama-server port from Tailscale subnet only
New-NetFirewallRule -DisplayName "llmbot llama-server" `
  -Direction Inbound -Protocol TCP -LocalPort 8081 `
  -RemoteAddress "100.64.0.0/10" -Action Allow
```

**Run the agent:**

```powershell
# Foreground (for testing):
nnode index.js

# Background with PM2 (recommended for persistent use):
npm install -g pm2
pm2 start index.js --name llmbot-agent
pm2 save
pm2 startup   # follow printed command to enable auto-start on Windows boot
```

Verify the agent is reachable from the VPS (replace `100.x.x.x` with the Windows Tailscale IP):

```bash
# Run on the VPS:
curl -H "Authorization: Bearer your_token_here" http://100.x.x.x:3000/health
# Expected: {"status":"ok","running":false,"model":null}
```

---

### Step 7 — Deploy the Bot on the VPS

```bash
# On the VPS:
git clone https://github.com/noname9006/llmbot.git discord-llm-bot
cd discord-llmbot
npm install

cp .env.example .env
nano .env
```

**Edit `.env`** — fill in every required value:

```dotenv
# Discord
DISCORD_TOKEN=your_discord_bot_token_here
ALLOWED_CHANNEL_IDS=          # leave empty to allow all channels, or e.g. 123456789,987654321

# VPS llama-server (Model 1 — always on fallback)
VPS_LLAMA_URL=http://localhost:8080/v1
VPS_MODEL_FILE=phi4-mini.Q4_K_M.gguf   # filename for log display only

# Windows local agent (Tailscale IP of the Windows machine)
LOCAL_AGENT_URL=http://100.x.x.x:3000
LOCAL_AGENT_TOKEN=replace_with_same_secret_as_agent_env

# Windows llama-server (same Tailscale IP, different port)
LOCAL_LLAMA_URL=http://100.x.x.x:8081/v1

# Model filenames (must exist in LLAMA_MODEL_DIR on Windows)
LOCAL_MODEL_COMMON_FILE=your-common-model.Q4_K_M.gguf
LOCAL_MODEL_HEAVY_FILE=your-heavy-model.Q4_K_M.gguf

# SearXNG (optional but required for web search features)
SEARXNG_BASE_URL=http://your-searxng-instance

# Tuning (defaults are reasonable; adjust as needed)
LLM_TEMPERATURE=0.8
LLM_MAX_TOKENS=2048
HISTORY_MAX_PAIRS=10
LOG_LEVEL=info
```

**Create the logs directory and start with PM2:**

```bash
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # follow the printed command
```

**Verify everything is running:**

```bash
pm2 list
# You should see: llama-vps (online) and discord-llm-bot (online)

pm2 logs discord-llm-bot --lines 30
# You should see: "Starting discord-llm-bot..." and "Logged in as YourBot#1234"
```

Go to Discord, mention the bot in a channel, and it should reply.

---

## Environment Variables Reference

### Bot `.env` (VPS)

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `DISCORD_TOKEN` | — | ✅ | Discord bot token from the developer portal |
| `ALLOWED_CHANNEL_IDS` | *(empty = all)* | | Comma-separated channel IDs to restrict the bot to |
| `VPS_LLAMA_URL` | `http://localhost:8080/v1` | | VPS llama-server OpenAI-compat base URL |
| `VPS_MODEL_FILE` | `phi4-mini.Q4_K_M.gguf` | | VPS model filename (used in logs only) |
| `LOCAL_AGENT_URL` | *(empty)* | | Windows agent URL, e.g. `http://100.x.x.x:3000` |
| `LOCAL_AGENT_TOKEN` | *(empty)* | | Bearer token for agent authentication |
| `LOCAL_LLAMA_URL` | *(empty)* | | Windows llama-server URL, e.g. `http://100.x.x.x:8081/v1` |
| `LOCAL_MODEL_COMMON_FILE` | *(empty)* | | Filename of the common (Model 2) GGUF |
| `LOCAL_MODEL_HEAVY_FILE` | *(empty)* | | Filename of the heavy (Model 3) GGUF |
| `LOCAL_HEALTH_POLL_INTERVAL_MS` | `30000` | | How often (ms) to poll the agent `/health` |
| `SEARXNG_BASE_URL` | *(empty)* | | SearXNG instance URL (required for search features) |
| `SEARCH_RESULT_COUNT` | `5` | | Number of search results injected into context |
| `LLM_TEMPERATURE` | `0.8` | | Sampling temperature |
| `LLM_TOP_P` | `0.95` | | Top-p (nucleus) sampling |
| `LLM_TOP_K` | `40` | | Top-k sampling |
| `LLM_MIN_P` | `0.0` | | Min-p sampling |
| `LLM_REPETITION_PENALTY` | `1.1` | | Repetition penalty |
| `LLM_MAX_TOKENS` | `2048` | | Max tokens per completion (`-1` = unlimited) |
| `LLM_FETCH_TIMEOUT_MS` | `120000` | | Timeout per LLM HTTP call in ms (`0` = none) |
| `SYSTEM_PROMPT` | *(from sysprompt.txt)* | | Override the system prompt entirely (env takes priority if sysprompt.txt missing) |
| `HISTORY_MAX_PAIRS` | `10` | | Conversation pairs kept per user (sliding window) |
| `LOG_LEVEL` | `info` | | `debug` / `info` / `warn` / `error` |
| `RATE_LIMIT_MAX_REQUESTS` | `5` | | Max messages per user per window |
| `RATE_LIMIT_WINDOW_MS` | `30000` | | Rate limit sliding window in ms |
| `MAX_CONCURRENT_REQUESTS` | `5` | | Max simultaneous LLM calls across all users |
| `RETRY_MAX_ATTEMPTS` | `3` | | Max retry attempts for LLM / SearXNG calls |
| `RETRY_INITIAL_DELAY_MS` | `500` | | Initial retry delay in ms (doubles each attempt) |
| `HEALTH_PORT` | `0` | | Port for the bot's own `/health` endpoint (`0` = disabled) |

### Agent `.env` (Windows)

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3000` | | Port the agent HTTP server listens on |
| `AGENT_TOKEN` | *(empty)* | ✅ | Bearer token — must match `LOCAL_AGENT_TOKEN` in bot `.env` |
| `LLAMA_SERVER_BIN` | `llama-server` | ✅ | Full path to `llama-server.exe` |
| `LLAMA_SERVER_PORT` | `8081` | | Port llama-server listens on |
| `LLAMA_MODEL_DIR` | `.` | ✅ | Directory containing GGUF model files |
| `LLAMA_GPU_LAYERS` | `99` | | Layers to offload to GPU (`99` = all) |
| `LLAMA_CONTEXT_SIZE` | *(model default)* | | Context window size passed to llama-server |
| `LOG_LEVEL` | `info` | | `debug` / `info` / `warn` / `error` |

---

## Commands & Usage

### Chatting

Mention the bot in any allowed channel:

```
@BotName what is the boiling point of water?
```

The bot will automatically choose the best available model, show a typing indicator while thinking, and reply. Long replies (> 1900 characters) are split into multiple messages automatically.

### Commands

| Command | Who can use | Description |
|---------|-------------|-------------|
| `!reset` | Everyone | Clears your personal conversation history |
| `!status` | Server admins only | Shows active model, VPS state, request queue, and uptime |
| `!search <query>` | Everyone | Forces a SearXNG web search and asks the model to answer using the results |
| `!help` | Everyone | Lists all available commands |

### `!status` output example

```
🟢 Local agent online (active model: common)
   ⏱ Online for 4m 32s
🟢 VPS llama-server online
⚙️ LLM requests: 1 active, 0 queued
📊 Active user histories: 3
```

---

## Troubleshooting

**Bot doesn't respond to mentions**
- Check `pm2 logs discord-llm-bot` for errors.
- Ensure **Message Content Intent** is enabled in the Discord developer portal.
- Make sure the bot has permission to read and send messages in the target channel.
- If `ALLOWED_CHANNEL_IDS` is set, confirm the channel ID is in the list.

**VPS model unreachable**
- `curl http://localhost:8080/health` — should return `{"status":"ok"}`.
- `pm2 logs llama-vps` — check for model loading errors.
- Make sure `VPS_LLAMA_URL` in the bot `.env` matches the port llama-server is listening on.

**Local agent unreachable**
- Run `!status` in Discord — the local agent line will show offline.
- Check Tailscale is connected on both machines: `tailscale status`.
- Confirm Windows Firewall allows port 3000 from the Tailscale subnet (`100.64.0.0/10`).
- Check agent logs: `pm2 logs llmbot-agent` (Windows) or `node index.js` in the foreground.
- Test from the VPS: `curl -H "Authorization: Bearer <token>" http://<tailscale-ip>:3000/health`.

**Model fails to load on Windows**
- Check `LLAMA_SERVER_BIN` — the path must point to the actual `llama-server.exe`.
- Check `LLAMA_MODEL_DIR` — the GGUF filename sent by the bot must exist in this directory.
- Large models (7B+) can take 60–120 s to load — wait before assuming failure.
- Run `llama-server.exe --model <path> --port 8081` manually in PowerShell to see raw error output.

**GPU not being used on Windows**
- Make sure you downloaded a **Vulkan** build of llama-server (filename contains `vulkan`).
- Set `LLAMA_GPU_LAYERS=99` in `agent\.env`.
- Verify Vulkan driver is installed: run `vulkaninfo` in PowerShell.
- For AMD GPUs: update to the latest Adrenalin driver.

**Circuit breaker is open**
- If you see "Agent circuit breaker is OPEN" in the logs, the agent's `/start` failed 3 times in a row.
- The circuit auto-recovers after 2 minutes. Check why `/start` is failing in the agent logs.
- Restarting the bot (`pm2 restart discord-llm-bot`) also resets the circuit breaker.

**Messages cut off at 2000 characters**
- This is Discord's hard limit. The bot automatically splits long replies into multiple messages at natural line/word boundaries.

**Search returns no results**
- Verify `SEARXNG_BASE_URL` is set and the SearXNG instance is reachable from the VPS.
- Test: `curl "http://your-searxng-instance/search?q=test&format=json"`.
