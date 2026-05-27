# Notes App（笔记应用）

[English](./README.md) | 中文

把你的 Markdown 笔记文件夹，变成一个可以在**任意设备、任意地点**通过浏览器**浏览、整理、同步、分享**的云端个人知识库。内置 AI Agent 对话面板，以 **LLM Wiki** 的方式让 AI 真正读懂你写的每一篇笔记——随时问、随时答，知识真正为你所用。

支持 **Claude 官方订阅**（无需 API Key）、**DeepSeek**、**OpenRouter**（200+ 模型）以及任意兼容 Anthropic API 的第三方服务——随时在界面内切换。

---

## 什么是 LLM Wiki？

普通的笔记工具，用法是：**写 → 搜索 → 翻找 → 读**。时间一长，大多数写过的内容就再也想不起来了。

**LLM Wiki** 把这个流程变成：**写 → 直接问 AI**。

你的每一篇笔记，都成为 AI 的"记忆"。想找什么、想整理什么，直接用自然语言提问：

> 「我之前记录的那个项目方案，核心思路是什么？」  
> 「帮我把这段读书笔记延伸成一篇完整的文章。」  
> 「这篇笔记和我其他关于 XX 的内容有什么联系？」

AI 会基于你**自己写的内容**来回答，而不是泛泛而谈。你的笔记库从一堆静态文件，变成了一个**懂你、能回答你问题的私人知识助理**。

---

## AI Agent 集成

AI 面板直接嵌入在笔记界面右侧，无需切换标签页，无需复制粘贴。

- **划选文字 → 自动引用**：在笔记中高亮任意段落，该内容会立即以引用格式出现在 AI 对话框中。
- **笔记上下文感知**：AI 知道你正在阅读哪篇笔记，可以基于当前内容直接展开讨论。
- **可拖拽调宽的侧边面板**：桌面端可自由调整宽度，移动端折叠为悬浮按钮。
- **会话持久化**：刷新页面后对话历史不丢失。

### 支持的模型服务商

| 服务商 | 接入方式 | 可用模型 |
| --- | --- | --- |
| **Claude 官方** | 使用 Anthropic 账号登录，**无需 API Key**，直接使用订阅额度 | Claude Opus / Sonnet / Haiku（最新版） |
| **DeepSeek** | 填入 DeepSeek API Key | DeepSeek V4 Pro、V4 Flash |
| **OpenRouter** | 填入 OpenRouter API Key | 200+ 模型（GPT-4o、Gemini、Llama 等） |
| **自定义** | 任意兼容 Anthropic API 的服务，填写 Base URL + API Key | 自选 |

可以同时添加多个账号，随时在设置面板内一键切换。

AI 后端是一个轻量 Node.js 服务，与笔记应用并行运行，使用官方 [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)。

---

## 其他功能

- 浏览知识库中的 `.md`、`.html`、`.htm` 文件。
- 支持 GFM Markdown 渲染、文章目录（TOC）、Obsidian 风格的本地图片。
- 通过 Basic Auth 保护私有笔记页面和 API。
- 查看 Git 状态、文件差异、提交历史，支持 pull / push / 撤销操作。
- 为指定笔记生成带 token 的公开分享链接（路径：`/share/:token`）。

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

# ↓ 这两行就是访问 /notes 页面时的登录账号和密码，自己设置、自己记住
NOTES_BASIC_AUTH_USERNAME=notes      # 用户名，可以改成任意字符串
NOTES_BASIC_AUTH_PASSWORD=改成强密码  # 密码，务必修改，不能留空
```

构建并启动笔记应用：

```bash
npm run build
npm start            # 默认监听 http://localhost:3000
```

在浏览器中打开 `http://localhost:3000/notes`，浏览器会弹出一个登录框，输入你在 `.env.local` 中设置的用户名和密码即可进入。

> **登录账号从哪里来？** 就是你自己在 `.env.local` 里填写的 `NOTES_BASIC_AUTH_USERNAME`（用户名）和 `NOTES_BASIC_AUTH_PASSWORD`（密码），没有注册流程，改了配置重启服务即可生效。

### 启用 AI 面板

AI 面板加载自 `/notes-claude/`，由 `claude-chat/` 目录下的独立 Node.js 进程提供服务。

```bash
cd claude-chat
npm install
npm start            # 默认监听 http://127.0.0.1:8082
```

然后在 Nginx 中将 `/notes-claude/` 路径转发到 `127.0.0.1:8082`，参考 `deploy/nginx.conf.example`。

启动后，点击笔记工具栏中的 **✦ AI** 按钮打开面板，在设置图标中连接你的服务商即可开始使用。

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

### 笔记应用（`clawapp/`）

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

### AI 服务（`claude-chat/`）

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8082` | AI 服务监听的端口。 |
| `VAULT_PATH` | *(当前目录)* | AI Agent 的工作目录，建议与笔记库路径一致。 |
| `CLAUDE_PERMISSION_MODE` | `auto` | Agent 权限模式：`plan`、`acceptEdits`、`auto`、`bypassPermissions`。 |
| `ANTHROPIC_API_KEY` | *(空)* | 可选的默认 API Key（用户也可以在界面中设置）。 |
| `ANTHROPIC_BASE_URL` | *(空)* | 可选的自定义 API 地址，用于接入自托管或第三方服务商。 |

## 常用命令

```bash
# 笔记应用
npm run dev      # 本地开发模式（热更新）
npm run build    # 生产构建
npm start        # 运行构建产物

# 命令行创建分享链接
node scripts/create-share-link.mjs "笔记在知识库中的相对路径/note.md"
```

## 生产部署

典型的生产环境部署方案：

1. 用 **systemd** 保持两个进程常驻 — 参考 `deploy/notes-app.service.example`。
2. 用 **Nginx** 分流请求：`/notes`、`/share` → 端口 3000；`/notes-claude/` → 端口 8082 — 参考 `deploy/nginx.conf.example`。

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
- `/notes-claude/` 同样应受保护，Nginx 示例中已包含对该路由的 Basic Auth 配置。
- 公开分享路由通过 token 鉴权，仅允许只读访问。
- 文件读取被限制在 `VAULT_PATH` 目录内，自动排除 `.git`、`.obsidian`、`.claude`、`.claudian`、`node_modules`。
- Git 命令不经过 shell 执行，并对用户提供的路径进行合法性校验。

## 提交前注意

以下文件不要提交到 Git：

- `.env.local` 及任何 `.env*` 文件（已在 `.gitignore` 中）。
- `shared-notes.json`（含真实 token 时，已在 `.gitignore` 中）。
- `claude-chat/auth-profile.json` 和 `claude-chat/session.json` — 这两个文件存有你的 AI 服务商凭据。
- `.next/`、`node_modules/`、知识库内容或生成的媒体文件。
