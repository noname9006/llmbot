module.exports = {
  apps: [
    {
      name: "discord-llm-bot",
      script: "src/index.js",

      // Restart on crash, but back off after repeated failures
      autorestart: true,
      max_restarts: 10,
      restart_delay: 4000,
      exp_backoff_restart_delay: 100,

      // Environment — PM2 will load .env automatically if dotenv is in the code,
      // but you can also set values here directly (prefer .env file though)
      env: {
        NODE_ENV: "production",
      },

      // Log settings
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      merge_logs: true,
    },
  ],
};
