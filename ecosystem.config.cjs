/**
 * PM2 ecosystem — inkfellow
 *
 * Single-user template. For multi-user setups, duplicate the two entries
 * below and adjust PORT, VAULT_PATH, and credentials for each user.
 * See README → "Multi-User Setup" for step-by-step instructions.
 *
 * 启动：  pm2 start ecosystem.config.cjs
 * 重启：  pm2 restart ecosystem.config.cjs --update-env
 * 日志：  pm2 logs
 */

const BASE = "/absolute/path/to/clawapp";  // ← replace with your actual path

module.exports = {
  apps: [
    {
      name: "inkfellow",
      script: "node_modules/.bin/next",
      args: "start",
      cwd: BASE,
      env: {
        PORT: "3000",
        NODE_ENV: "production",
      },
      autorestart: true,
      watch: false,
      merge_logs: true,
      out_file: "~/.pm2/logs/inkfellow-out.log",
      error_file: "~/.pm2/logs/inkfellow-error.log",
    },
    {
      name: "claude-chat",
      script: "server.js",
      cwd: `${BASE}/claude-chat`,
      node_args: "--env-file-if-exists=.env",
      env: {
        PORT: "8082",
        HOST: "127.0.0.1",
        VAULT_PATH: "/path/to/your/vault",  // ← replace with your vault path
        CLAUDE_PERMISSION_MODE: "auto",
      },
      autorestart: true,
      watch: false,
      merge_logs: true,
      out_file: "~/.pm2/logs/claude-chat-out.log",
      error_file: "~/.pm2/logs/claude-chat-error.log",
    },
  ],
};
