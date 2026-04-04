# discord-llm-bot

A Discord bot powered by **llama-server** (llama.cpp), using a three-model architecture. The VPS runs a lightweight fallback model; a Windows local machine with a GPU runs two additional models managed by a local agent over Tailscale.

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

### Routing logic

1. **Local agent offline** → VPS llama-server (Model 1, always available)
2. **Local agent online** → local llama-server with Model 2 (common)
   - Model 2 replies `__ESCALATE__` → switch to Model 3 (heavy)
   - Model 3 idles for 15 min → local llama-server is stopped automatically

---

## Repository structure

```
discord-llm-bot/
├── src/
│   ├── index.js                        # Entry point & graceful shutdown
│   ├── bot.js                          # Discord client setup
│   ├── config.js                       # Validated config from .env
│   ├── logger.js                       # Leveled logger
│   ├── handlers/
│   │   ├── messageHandler.js           # @mention handler, routing, search
│   │   └── commandHandler.js           # !reset, !status, !search, !help
│   └── services/
│       ├── llamaService.js             # OpenAI-compat client for llama-server
│       ├── agentService.js             # HTTP client for Windows agent + model state
│       ├── localAvailabilityService.js # Polls agent /health
│       ├── searchService.js            # SearXNG client
│       └── historyService.js           # Per-user conversation memory
├── agent/
│   ├── index.js                        # Windows local agent (Express)
│   ├── package.json
│   ├── .env.example
│   └── README.md                       # Agent-specific setup guide
├── .env.example
├── ecosystem.config.js                 # PM2 config for the bot
├── package.json
└── sysprompt.txt                       # Default system prompt
```

---

## Prerequisites

| Where | What |
|-------|------|
| VPS | Node.js ≥ 18, PM2, llama-server binary (AVX2 build), model file |
| Windows machine | Node.js ≥ 18, llama-server (Vulkan build), model files, Tailscale |
| Both | Tailscale installed and connected |

---

## 1. Create a Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. **New Application** → give it a name
3. **Bot** tab → **Add Bot** → copy the **Token**
4. Under **Privileged Gateway Intents**, enable:
   - `MESSAGE CONTENT INTENT`
5. **OAuth2 → URL Generator**: scopes `bot`, permissions:
   - Read Messages / View Channels, Send Messages, Read Message History
6. Visit the generated URL to invite the bot to your server

---

## 2. VPS — llama-server setup

llama-server runs as a **separate PM2 process** (not managed by the bot). It must be started before the bot.

```bash
# Download a pre-built AVX2 binary from the llama.cpp releases page
# https://github.com/ggerganov/llama.cpp/releases
# Look for: llama-<version>-bin-ubuntu-x64.zip or similar

# Place your model file
mkdir -p /home/ubuntu/lllm
# copy your model: /home/ubuntu/lllm/phi4-mini.Q4_K_M.gguf

# Start llama-server via PM2
pm2 start --name llama-vps \
  /path/to/llama-server \
  -- \
  --model /home/ubuntu/lllm/phi4-mini.Q4_K_M.gguf \
  --port 8080 \
  --host 127.0.0.1 \
  -ngl 0          # CPU-only on most VPS instances

pm2 save
```

Verify it is running:
```bash
curl http://localhost:8080/health
```

---

## 3. Windows — local agent setup

See [`agent/README.md`](agent/README.md) for full instructions.

Short version:
```powershell
cd agent
npm install
copy .env.example .env
# edit .env — set AGENT_TOKEN, paths, GPU layers
node index.js
```

---

## 4. Deploy the bot on VPS

```bash
git clone <your-repo> discord-llm-bot
cd discord-llm-bot
npm install

cp .env.example .env
nano .env
# Set: DISCORD_TOKEN, VPS_LLAMA_URL, VPS_MODEL_FILE,
#      LOCAL_AGENT_URL, LOCAL_AGENT_TOKEN,
#      LOCAL_LLAMA_URL, LOCAL_MODEL_COMMON_FILE, LOCAL_MODEL_HEAVY_FILE

mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # follow the printed command to enable auto-start on reboot
```

---

## Usage

| Action | How |
|--------|-----|
| Chat | `@BotName your question here` |
| Clear history | `!reset` |
| Check status | `!status` |
| Force web search | `!search <query>` |
| Show help | `!help` |

---

## Configuration (bot `.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_TOKEN` | *(required)* | Discord bot token |
| `ALLOWED_CHANNEL_IDS` | *(empty = all)* | Comma-separated channel IDs |
| `VPS_LLAMA_URL` | `http://localhost:8080/v1` | VPS llama-server OpenAI-compat URL |
| `VPS_MODEL_FILE` | `phi4-mini.Q4_K_M.gguf` | VPS model filename (for logging) |
| `LOCAL_AGENT_URL` | *(empty)* | Windows agent URL (Tailscale) |
| `LOCAL_AGENT_TOKEN` | *(empty)* | Bearer token for agent auth |
| `LOCAL_LLAMA_URL` | *(empty)* | Local llama-server URL (Tailscale) |
| `LOCAL_MODEL_COMMON_FILE` | *(empty)* | Common model filename |
| `LOCAL_MODEL_HEAVY_FILE` | *(empty)* | Heavy model filename |
| `LOCAL_HEALTH_POLL_INTERVAL_MS` | `30000` | Agent health poll interval |
| `SEARXNG_BASE_URL` | *(empty)* | SearXNG instance URL |
| `LLM_TEMPERATURE` | `0.8` | Sampling temperature |
| `LLM_MAX_TOKENS` | `2048` | Max tokens per reply |
| `HISTORY_MAX_PAIRS` | `10` | Conversation pairs kept per user |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

---

## Troubleshooting

**Bot doesn't respond**
- Check `pm2 logs discord-llm-bot`
- Ensure `MESSAGE CONTENT INTENT` is enabled in the Discord developer portal

**VPS model unreachable**
- `curl http://localhost:8080/health`
- Check `pm2 logs llama-vps`

**Local agent unreachable**
- Run `!status` in Discord
- Check Tailscale is connected: `tailscale status`
- Verify Windows Firewall allows port 3000 from Tailscale subnet
- Check agent logs

**Model takes too long to load**
- Large models can take 60-120 s on first load — this is normal
- The bot keeps the Discord typing indicator alive during the wait
