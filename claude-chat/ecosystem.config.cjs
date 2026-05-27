module.exports = {
  apps: [{
    name: "claude-chat",
    script: "server.js",
    cwd: "/home/admin/apps/claude-chat",
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
    out_file: "/home/admin/.pm2/logs/claude-chat-out.log",
    error_file: "/home/admin/.pm2/logs/claude-chat-error.log",
  }]
};
