# discord-llm-bot

A Discord bot powered by LM Studio running on your local machine, bridged to a VPS via **FRP** (Fast Reverse Proxy).

```
[Discord] ←→ [VPS: discord-llm-bot + frps] ←──FRP tunnel──→ [Local: LM Studio + frpc]
```

---

## Prerequisites

| Where | What |
|-------|------|
| VPS | Node.js ≥ 18, PM2, frp (`frps`) |
| Local machine | LM Studio running on port `1234`, frp (`frpc`) |

---

## 1. Create a Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. **New Application** → give it a name
3. **Bot** tab → **Add Bot** → copy the **Token**
4. Under **Privileged Gateway Intents**, enable:
   - `MESSAGE CONTENT INTENT`
   - `SERVER MEMBERS INTENT` (optional)
5. **OAuth2 → URL Generator**: scopes `bot`, permissions:
   - Read Messages/View Channels
   - Send Messages
   - Read Message History
   - Mention Everyone (optional)
6. Visit the generated URL to invite the bot to your server

---

## 2. Set Up FRP Tunnel

### On the VPS

```bash
# Download frp (adjust version/arch as needed)
wget https://github.com/fatedier/frp/releases/download/v0.61.0/frp_0.61.0_linux_amd64.tar.gz
tar -xzf frp_0.61.0_linux_amd64.tar.gz
sudo cp frp_0.61.0_linux_amd64/frps /usr/local/bin/frps

# Install config
sudo mkdir -p /etc/frp
sudo cp frp/frps.toml /etc/frp/frps.toml

# Edit and set a strong secret token
sudo nano /etc/frp/frps.toml

# Install and start systemd service
sudo cp frp/frps.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now frps

# Open firewall ports
sudo ufw allow 7000/tcp   # frp control port
sudo ufw allow 7860/tcp   # forwarded LM Studio port (only needed locally on VPS)
```

### On your local machine

```bash
# Linux
./frpc -c frp/frpc.toml

# Windows (PowerShell)
.\frpc.exe -c frp\frpc.toml

# Or run silently in background on Windows
Start-Process .\frpc.exe -ArgumentList "-c frp\frpc.toml" -WindowStyle Hidden
```

Edit `frp/frpc.toml` first:
- Set `serverAddr` to your VPS public IP
- Set the same `auth.token` as in `frps.toml`

---

## 3. Deploy the Bot on VPS

```bash
# Clone / copy project to VPS
git clone <your-repo> discord-llm-bot
cd discord-llm-bot

# Install dependencies
npm install

# Configure environment
cp .env.example .env
nano .env
# → Set DISCORD_TOKEN
# → LLM_BASE_URL should be http://127.0.0.1:7860/v1

# Create logs directory
mkdir -p logs

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # follow the printed command to auto-start on reboot
```

---

## 4. Configure LM Studio

1. Open LM Studio on your local machine
2. Load the model: `qwen3.5-prism-dynamic-quant`
3. Go to **Local Server** tab (⚡ icon)
4. Ensure it's listening on `127.0.0.1:1234`
5. Click **Start Server**

---

## Usage

| Action | How |
|--------|-----|
| Chat with the bot | `@BotName your question here` |
| Clear your history | `!reset` |
| Check LLM backend status | `!status` |
| Show help | `!help` |

---

## Configuration (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_TOKEN` | *(required)* | Your bot token |
| `ALLOWED_CHANNEL_IDS` | *(empty = all)* | Comma-separated channel IDs |
| `LLM_BASE_URL` | `http://127.0.0.1:7860/v1` | FRP-forwarded LM Studio URL |
| `LLM_MODEL` | `qwen3.5-prism-dynamic-quant` | Model identifier |
| `SYSTEM_PROMPT` | see `.env.example` | System prompt for all conversations |
| `LLM_MAX_TOKENS` | `1024` | Max tokens per reply (`0` = model default) |
| `LLM_TEMPERATURE` | `0.7` | Temperature |
| `HISTORY_MAX_PAIRS` | `10` | Max user+assistant pairs kept per user |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

---

## Project Structure

```
discord-llm-bot/
├── src/
│   ├── index.js                  # Entry point & graceful shutdown
│   ├── bot.js                    # Discord client setup
│   ├── config.js                 # Validated config from .env
│   ├── logger.js                 # Leveled logger
│   ├── handlers/
│   │   ├── messageHandler.js     # @mention handler + streaming
│   │   └── commandHandler.js     # !reset, !status, !help
│   └── services/
│       ├── llmService.js         # OpenAI-compatible streaming client
│       └── historyService.js     # Per-user conversation memory
├── frp/
│   ├── frps.toml                 # VPS: FRP server config
│   ├── frpc.toml                 # Local: FRP client config
│   └── frps.service              # Systemd unit for frps
├── .env.example
├── ecosystem.config.js           # PM2 process config
└── package.json
```

---

## Troubleshooting

**Bot doesn't respond**
- Check `pm2 logs discord-llm-bot`
- Ensure `MESSAGE CONTENT INTENT` is enabled in the Discord developer portal

**LLM backend unreachable**
- Run `!status` in Discord
- On VPS: `curl http://127.0.0.1:7860/v1/models`
- Check `frps` is running: `systemctl status frps`
- Check `frpc` is running on local machine and connected

**Responses cut off**
- Increase `LLM_MAX_TOKENS` or ask the bot to continue
- Discord messages have a 2000-character hard limit

**FRP tunnel drops**
- frp auto-reconnects; check `frpc` logs for errors
- Ensure VPS firewall allows port `7000` inbound
