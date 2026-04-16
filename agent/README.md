# llmbot-agent

Windows local agent for the Discord LLM bot. Runs on your local Windows machine and manages the **llama-server** process, which does GPU-accelerated inference via Vulkan.

The bot (running on the VPS) connects to this agent over **Tailscale** to load/unload models and then sends inference requests directly to llama-server.

---

## Architecture

```
[VPS: Discord bot]
    └── HTTP (Tailscale) → [Windows: agent :3000]
                                └── spawns/kills → [llama-server :8081]
                                                      F:\AI\.models\<model>
```

---

## Prerequisites

| What | Where to get it |
|------|-----------------|
| Node.js ≥ 18 | https://nodejs.org |
| llama.cpp `llama-server.exe` | https://github.com/ggerganov/llama.cpp/releases |
| Tailscale | https://tailscale.com |
| GGUF model files | Hugging Face or similar |

The RX 6600 XT uses the **Vulkan** backend. Download a `llama-server.exe` build tagged `vulkan` from the llama.cpp releases page.

---

## Setup

### 1. Install dependencies

```powershell
cd agent
npm install
```

### 2. Configure environment

```powershell
copy .env.example .env
notepad .env
```

Edit `.env`:
- `AGENT_TOKEN` — set a strong random secret (must match `LOCAL_AGENT_TOKEN` in the bot's `.env`)
- `LLAMA_SERVER_BIN` — full path to `llama-server.exe`
- `LLAMA_MODEL_DIR` — directory containing your `.gguf` model files
- `LLAMA_EXTRA_ARGS_COMMON` *(optional)* — extra args for the "common" model, passed verbatim to llama-server; takes priority over bot-sent values. Include `-ngl <N>` here to control GPU layer offload for this model.
- `LLAMA_EXTRA_ARGS_HEAVY` *(optional)* — same for the "heavy" model
- `LLAMA_CONTEXT_SIZE_COMMON` *(optional)* — context window size for the "common" model; takes priority over bot-sent values
- `LLAMA_CONTEXT_SIZE_HEAVY` *(optional)* — same for the "heavy" model
- `LLAMA_EXTRA_ARGS` *(optional)* — global fallback extra args used when no per-model override is set
- `LLAMA_CONTEXT_SIZE` *(optional)* — global fallback context size
- `LLAMA_GPU_LAYERS` — for reference only; use `-ngl` inside `LLAMA_EXTRA_ARGS_COMMON`/`HEAVY` to control GPU offload per model

### 3. Run the agent

```powershell
node index.js
```

Or keep it running in the background with PM2 (install globally: `npm install -g pm2`):

```powershell
pm2 start index.js --name llmbot-agent
pm2 save
pm2 startup
```

---

## API

All endpoints require `Authorization: Bearer <AGENT_TOKEN>` unless `AGENT_TOKEN` is empty.

### `GET /health`

Returns agent status.

```json
{ "status": "ok", "running": true, "model": "some-model.gguf" }
```

### `POST /start`

Starts llama-server with the requested model. Stops any currently running instance first. Waits until the server is ready before responding (up to 120 seconds).

**Request:**
```json
{ "model": "some-model.Q4_K_M.gguf", "role": "common", "extraArgs": "--flash-attn", "contextSize": 8192 }
```

- `role` *(optional)* — `"common"` or `"heavy"`. Used to select per-model env var overrides on the agent.
- `extraArgs` *(optional)* — extra flags passed verbatim to llama-server (space-separated). Ignored when the agent has `LLAMA_EXTRA_ARGS_COMMON`/`HEAVY` set for the given role.
- `contextSize` *(optional)* — context window size. Ignored when the agent has `LLAMA_CONTEXT_SIZE_COMMON`/`HEAVY` set for the given role.

**Priority for `extraArgs` and `contextSize`:**
1. Agent's per-model env var (`LLAMA_EXTRA_ARGS_COMMON`/`HEAVY`, `LLAMA_CONTEXT_SIZE_COMMON`/`HEAVY`) — highest
2. Bot-sent value from the request body
3. Agent's global fallback (`LLAMA_EXTRA_ARGS`, `LLAMA_CONTEXT_SIZE`)

**Response (200):**
```json
{ "status": "ok", "model": "some-model.Q4_K_M.gguf", "port": 8081 }
```

**Response (500):**
```json
{ "error": "llama-server did not become ready within 120000ms" }
```

### `POST /stop`

Stops the running llama-server.

```json
{ "status": "ok" }
```

---

## Firewall

Allow inbound TCP connections on port `3000` (agent) **only from your Tailscale IP range** (`100.64.0.0/10`). Port `8081` (llama-server) does NOT need to be exposed externally — only the agent proxies to it, and the bot connects directly via Tailscale.

```powershell
# Windows Firewall — allow agent port from Tailscale subnet only
New-NetFirewallRule -DisplayName "llmbot-agent" `
  -Direction Inbound -Protocol TCP -LocalPort 3000 `
  -RemoteAddress "100.64.0.0/10" -Action Allow

New-NetFirewallRule -DisplayName "llmbot llama-server" `
  -Direction Inbound -Protocol TCP -LocalPort 8081 `
  -RemoteAddress "100.64.0.0/10" -Action Allow
```

---

## Troubleshooting

**Agent not reachable from VPS**
- Check Tailscale is connected on both machines: `tailscale status`
- Confirm Windows Firewall allows port 3000 from Tailscale subnet

**Model fails to load**
- Check `LLAMA_SERVER_BIN` path is correct and the binary exists
- Ensure `LLAMA_MODEL_DIR` contains the model file
- Check agent logs for the exact error message from llama-server

**GPU not used**
- Confirm you're using a Vulkan build of llama-server
- Add `-ngl 99` (or an appropriate layer count) to `LLAMA_EXTRA_ARGS_COMMON` and `LLAMA_EXTRA_ARGS_HEAVY` in the agent's `.env`
- Verify Vulkan drivers are installed: `vulkaninfo` in PowerShell
