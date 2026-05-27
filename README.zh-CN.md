# Notes App（笔记应用）

[English](./README.md) | 中文

一个自托管的 Markdown 笔记阅读器，兼容 Obsidian 格式的知识库。笔记以纯文本文件存储，提供移动端友好的阅读界面，支持私有 Git 同步操作，并可为指定笔记生成公开只读的分享链接。

## 功能特性

- 浏览知识库中的 `.md`、`.html`、`.htm` 文件。
- 支持 GFM Markdown 渲染、文章目录（TOC）、Obsidian 风格的本地图片。
- 通过 Basic Auth 保护私有笔记页面和 API。
- 查看 Git 状态、文件差异、提交历史，支持 pull / push / 撤销操作。
- 为指定笔记生成带 token 的公开分享链接（路径：`/share/:token`）。
- 可选：在 `/notes-claude/` 下挂载独立的 Claude 对话服务。

## 环境要求

- Node.js 20 或更高版本。
- npm。
- 一个本地 Markdown 文件夹（任意包含 `.md` 文件的目录均可，Obsidian 格式最佳）。

## 快速开始

```bash
git clone <仓库地址> notes-app
cd notes-app
npm install
cp .env.example .env.local
```

编辑 `.env.local`：

```bash
NEXT_PUBLIC_APP_NAME=我的笔记        # 显示在界面标题和页面 title 中
VAULT_PATH=/绝对路径/你的笔记文件夹  # Markdown 文件夹的绝对路径
SITE_URL=http://localhost:3000       # 替换为你的域名或公网 IP
NOTES_BASIC_AUTH_USERNAME=notes
NOTES_BASIC_AUTH_PASSWORD=改成强密码  # 设置一个强密码
```

构建并启动：

```bash
npm run build
npm start            # 默认监听 http://localhost:3000
```

在浏览器中打开 `http://localhost:3000/notes`，用上面设置的账号密码登录即可。

## 无域名访问（直接用公网 IP）

没有域名？没关系。将 `SITE_URL` 设置为服务器的公网 IP：

```bash
SITE_URL=http://203.0.113.42        # 通过 Nginx 代理到 80 端口
# 或者
SITE_URL=http://203.0.113.42:3000   # 不用 Nginx，直接暴露 Next.js
```

如果不使用 Nginx，需要在防火墙开放 `3000` 端口：

```bash
# CentOS / RHEL / AlmaLinux（firewalld）
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload

# Ubuntu / Debian（ufw）
sudo ufw allow 3000/tcp
```

使用 IP 访问与域名完全一致，分享链接中会自动带上 IP 地址。

## 环境变量说明

| 变量名 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` | 否 | `My Notes` | 显示在界面和页面标题中的应用名称。 |
| `VAULT_PATH` | 是 | `./vault` | Markdown 知识库的绝对路径。 |
| `NOTES_BASIC_AUTH_USERNAME` | 是 | `notes` | 访问 `/notes` 和 `/api/notes/*` 的用户名。 |
| `NOTES_BASIC_AUTH_PASSWORD` | 是 | *(空)* | 访问密码，为空时始终拒绝访问。 |
| `SHARED_NOTES_PATH` | 否 | `./shared-notes.json` | 存储分享 token 的 JSON 文件路径。 |
| `SITE_URL` | 否 | `http://localhost:3000` | 生成分享链接时使用的公开地址（域名或 IP）。 |
| `NOTES_GIT_PUSH_TARGET` | 否 | `HEAD:main` | Git push 操作的目标 refspec。 |
| `NEXT_PUBLIC_CF_WEB_ANALYTICS_TOKEN` | 否 | *(空)* | 填写后启用 Cloudflare Web Analytics。 |

## 常用命令

```bash
npm run dev      # 本地开发模式（热更新）
npm run build    # 生产构建
npm start        # 运行构建产物
npm run lint     # ESLint 代码检查
npx tsc --noEmit # TypeScript 类型检查
```

通过命令行创建分享链接：

```bash
node scripts/create-share-link.mjs "笔记在知识库中的相对路径/note.md"
```

## 生产部署

典型的生产环境部署方案：

1. 用 **systemd** 保持 Next.js 进程常驻 — 参考 `deploy/notes-app.service.example`。
2. 用 **Nginx** 将 80/443 端口代理到 `127.0.0.1:3000` — 参考 `deploy/nginx.conf.example`。

```bash
# 安装并启用 systemd 服务（先编辑模板，填写 User、WorkingDirectory、EnvironmentFile）
sudo cp deploy/notes-app.service.example /etc/systemd/system/notes-app.service
sudo systemctl daemon-reload
sudo systemctl enable --now notes-app
```

如需配置 HTTPS（需要真实域名）：

```bash
sudo apt install certbot python3-certbot-nginx   # Debian/Ubuntu
sudo certbot --nginx -d your-domain.com
```

拉取新代码后更新应用：

```bash
SERVICE_NAME=notes-app bash scripts/update_app.sh
```

## 安全说明

- 私有路由 `/notes` 和 `/api/notes/*` 均需通过 Basic Auth 验证。
- 公开分享路由通过 token 鉴权，仅允许只读访问。
- 文件读取被限制在 `VAULT_PATH` 目录内，自动排除 `.git`、`.obsidian`、`.claude`、`.claudian`、`node_modules`。
- Git 命令不经过 shell 执行，并对用户提供的路径进行合法性校验。
- Git 同步 API 可修改知识库内容，请勿在未加认证的情况下暴露 `/api/notes/*`。

## 提交前注意

以下文件不要提交到 Git：

- `.env.local` 及任何 `.env*` 文件（已在 `.gitignore` 中）。
- `shared-notes.json`（含真实 token 时，已在 `.gitignore` 中）。
- `.next/`、`node_modules/`、知识库内容或生成的媒体文件。
