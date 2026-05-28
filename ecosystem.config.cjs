/**
 * PM2 ecosystem — inkfellow
 *
 * 管理四个进程：
 *   inkfellow        — Next.js 笔记应用  (port 3000, jiang-vault)
 *   inkfellow-wumin  — Next.js 笔记应用  (port 3001, wumin-vault)
 *   claude-chat      — AI 对话后端       (port 8082, jiang-vault)
 *   claude-chat-wumin— AI 对话后端       (port 8083, wumin-vault)
 *
 * 启动：  pm2 start ecosystem.config.cjs
 * 重启：  pm2 restart ecosystem.config.cjs --update-env
 * 日志：  pm2 logs
 */

const BASE = "/home/admin/apps/clawapp";

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
      name: "inkfellow-wumin",
      script: "node_modules/.bin/next",
      args: "start",
      cwd: BASE,
      env: {
        PORT: "3001",
        NODE_ENV: "production",
        VAULT_PATH: "/home/admin/vault/wumin-vault",
        NOTES_BASIC_AUTH_USERNAME: "wumin",
        NOTES_BASIC_AUTH_PASSWORD: "wm891209",
      },
      autorestart: true,
      watch: false,
      merge_logs: true,
      out_file: "~/.pm2/logs/inkfellow-wumin-out.log",
      error_file: "~/.pm2/logs/inkfellow-wumin-error.log",
    },
    {
      name: "claude-chat-wumin",
      script: "server.js",
      cwd: `${BASE}/claude-chat`,
      node_args: "--env-file-if-exists=.env",
      env: {
        PORT: "8083",
        HOST: "127.0.0.1",
        VAULT_PATH: "/home/admin/vault/wumin-vault",
        CLAUDE_PERMISSION_MODE: "auto",
      },
      autorestart: true,
      watch: false,
      merge_logs: true,
      out_file: "~/.pm2/logs/claude-chat-wumin-out.log",
      error_file: "~/.pm2/logs/claude-chat-wumin-error.log",
    },
    {
      name: "claude-chat",
      script: "server.js",
      cwd: `${BASE}/claude-chat`,
      node_args: "--env-file-if-exists=.env",
      env: {
        PORT: "8082",
        HOST: "127.0.0.1",
        VAULT_PATH: "/home/admin/vault/jiang-vault",
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
