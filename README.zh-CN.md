# inkfellow

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
- **新建文件夹**：直接在侧边栏工具栏创建文件夹，也可以在"新建笔记"对话框内 inline 创建，无需离开当前流程。
- **Git 同步面板**：查看状态、文件差异、提交历史，支持 pull / push / 撤销。侧边栏底部常驻状态条实时显示待同步数量；移动端侧边栏收起时，切换按钮右上角会出现橙色角标提示。
- **凌晨自动同步**：`scripts/nightly-sync.js` 通过 cron 每天凌晨自动执行——拉取最新、AI 生成提交说明、推送到云端，全程无需手动操作。当天无改动则静默跳过，不产生空 commit。
- 为指定笔记生成带 token 的公开分享链接（路径：`/share/:token`）。
- **渐进式网页应用（PWA）**：可将 inkfellow 安装到设备主屏幕，像原生 App 一样全屏启动，无浏览器地址栏，UI 框架支持离线加载。

## 安装为 App（PWA）

inkfellow 完整支持 PWA 标准，安装后体验接近原生应用——独立全屏窗口，无浏览器工具栏，无需每次打开标签页。

### 桌面端（Chrome / Edge）

1. 用 Chrome 或 Edge 打开网站。
2. 点击地址栏右侧出现的**安装图标**（带下载箭头的显示器图标）。
3. 点击**安装** → 应用出现在系统应用列表，之后直接从那里打开即可。

### 手机端

**iOS（Safari）**

1. 用 **Safari** 打开网站（iOS 上其他浏览器不支持 PWA 安装）。
2. 点击底部的**分享按钮**（方块加箭头图标）。
3. 下滑找到**"添加到主屏幕"** → 点**添加**。
4. 主屏幕上出现 inkfellow 图标，点击后全屏打开。

**Android（Chrome）**

1. 用 Chrome 打开网站。
2. Chrome 会自动弹出**"添加到主屏幕"**横幅；或点右上角菜单（⋮）→ **安装应用**。
3. 主屏幕出现图标，点击后全屏运行，无浏览器控件。

> **其他 Android 浏览器**（Via、Firefox 等）不支持 PWA 安装。用 Chrome 安装一次即可，之后与那些浏览器无关，直接从桌面图标打开。

## 在线演示（Vercel）

仓库内置了一个 `vault/` 示例知识库，可以直接部署到 Vercel 体验完整界面。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/jiangjiren/clawapp)

在 Vercel 控制台 → Project → Settings → **Environment Variables** 添加以下变量：

| 变量名 | 填写值 | 说明 |
|--------|--------|------|
| `NOTES_BASIC_AUTH_USERNAME` | `demo`（或自定义） | 演示登录用户名 |
| `NOTES_BASIC_AUTH_PASSWORD` | 自定义一个密码 | 演示登录密码，**不能留空** |
| `NEXT_PUBLIC_APP_NAME` | `inkfellow` | 显示在页面标题中 |
| `SITE_URL` | 你的 Vercel 域名（如 `https://xxx.vercel.app`） | 用于生成分享链接 |

> **注意**：Vercel 版本使用仓库内的 `vault/` 示例笔记，不支持 Git 同步和 AI 面板（两者均需要持久化服务器环境）。如需完整功能，请部署到自己的 VPS 服务器。

## 不懂技术？让 AI Agent 帮你装

不熟悉命令行也没关系——直接把仓库地址丢给 AI 编程助手，比如 **Claude Code**、**Codex**、**OpenCode** 等，跟它说：

> "帮我在服务器上部署这个项目：`https://github.com/jiangjiren/clawapp`"

Agent 会自己读 README、执行命令、完成配置，全程引导你，大多数用户不用手敲一行命令就能跑起来。

---

## 环境要求

- Node.js 20 或更高版本。
- npm。
- 一个本地 Markdown 文件夹（任意包含 `.md` 文件的目录均可，Obsidian 格式最佳）。

全新 Ubuntu / Debian VPS 可以一键安装所有依赖：

```bash
sudo apt update && sudo apt install -y git nodejs npm nginx
```

> Ubuntu 24.04 及更高版本通过 `apt` 安装的 Node.js 已经是 v20 或更高，满足版本要求。

## 快速开始

```bash
git clone <仓库地址> notes-app
cd notes-app
npm install
bash scripts/setup-vault.sh   # 自动创建 vault 目录和 git 裸仓库，并写入 VAULT_PATH
```

编辑 `.env.local`：

```bash
NEXT_PUBLIC_APP_NAME=我的笔记        # 显示在界面标题和页面 title 中
VAULT_PATH=/home/you/vault           # setup-vault.sh 已自动写入，可按需修改
SITE_URL=http://localhost:3000       # 替换为你的域名或公网 IP

# ↓ 这两行就是访问知识库时的登录账号和密码，自己设置、自己记住
NOTES_BASIC_AUTH_USERNAME=notes      # 用户名，可以改成任意字符串
NOTES_BASIC_AUTH_PASSWORD=改成强密码  # 密码，务必修改，不能留空
```

构建并启动笔记应用：

```bash
npm run build
npm start            # 默认监听 http://localhost:3000
```

在浏览器中打开 `http://localhost:3000`，浏览器会弹出一个登录框，输入你在 `.env.local` 中设置的用户名和密码即可进入。

> **登录账号从哪里来？** 就是你自己在 `.env.local` 里填写的 `NOTES_BASIC_AUTH_USERNAME`（用户名）和 `NOTES_BASIC_AUTH_PASSWORD`（密码），没有注册流程，改了配置重启服务即可生效。

### 启用 AI 面板

AI 面板加载自 `/notes-claude/`，由 `claude-chat/` 目录下的独立 Node.js 进程提供服务。

```bash
cd claude-chat
npm install
npm start            # 默认监听 http://127.0.0.1:8082
```

**AI 面板必须通过 Nginx 访问。** AI 对话使用 WebSocket 实时传输，Nginx 需要同时转发 HTTP 请求和 WebSocket 升级请求到 8082 端口。`deploy/nginx.conf.example` 中已包含带完整请求头的 `/notes-claude/` 配置块，直接参考使用即可。

> **访问 `/notes-claude/` 出现 404？** 如果你直接通过 `:3000` 端口访问（绕过了 Nginx），Next.js 不认识 `/notes-claude/` 这个路径，会返回 404。生产环境请始终通过 Nginx（80/443 端口）访问。

建议为 AI 面板设置独立密码保护，防止 API 额度被滥用：

```bash
echo "YOUR_USER:$(openssl passwd -apr1 YOUR_PASSWORD)" | sudo tee /etc/nginx/.htpasswd
```

启动后，点击笔记工具栏中的 **✦ AI** 按钮打开面板，在设置图标中连接你的服务商即可开始使用。

### 接入 AI 服务商

点击 AI 面板内的 ⚙ 设置图标，按需选择以下方式：

---

#### 方式 A — Claude 官方会员订阅（无需 API Key）

直接使用已有的 Claude Pro / Teams 订阅额度，无额外费用，无需申请 API Key。

**第一步：在服务器上安装 Claude Code CLI**

```bash
npm install -g @anthropic-ai/claude-code
```

**第二步：用 Anthropic 账号登录**

```bash
claude login
# 会弹出浏览器 OAuth 授权页面，在浏览器中完成登录即可。
# 凭据会自动保存在服务器上，长期有效。
```

**第三步：验证登录状态**

```bash
claude auth status
# 正常应输出："loggedIn": true, "subscriptionType": "pro"
```

**第四步**：打开 AI 面板设置，**Claude 会员**那一行会显示 ✅ 已登录，选中即可开始对话。

> `claude-chat` 服务会自动读取 CLI 保存的登录凭据，无需重启服务，登录后立即生效。

---

#### 方式 B — Anthropic API Key

如果你偏好按量付费而非订阅：

1. 前往 [console.anthropic.com](https://console.anthropic.com/) → API Keys 获取密钥。
2. AI 面板设置 → **添加账号** → 选择 **Anthropic** → 粘贴 `sk-ant-…` 即可。

---

#### 方式 C — DeepSeek / OpenRouter / 自定义

在设置面板添加账号并选择对应厂商，API Key 请前往各厂商官网申请。

## 将本地笔记同步到云端

应用内置了 Git 面板，支持 pull / push / 撤销 / 历史查看。要让本地笔记和云端服务器保持同步，共分两步：**先在云端建立 Git 仓库**，**再配置本地电脑向该仓库推送**。

---

### 第一步：建立云端 Git 仓库

选择以下任一方案——两种方案均可与第二步配合使用。

#### 方案 A：在服务器自建裸仓库（推荐，数据完全自控）

所有数据都留在自己服务器上。用一个**裸仓库**作为中转——本地笔记推送到裸仓库，inkfellow 从裸仓库拉取。

```
本地笔记 ──push──▶ 服务器上的裸仓库 ◀──pull── inkfellow（工作目录）
                   ~/git/notes-vault.git
```

> **✅ 如果你已运行过 `bash scripts/setup-vault.sh`**，裸仓库和工作目录均已自动创建完毕，脚本末尾也打印了 SSH remote 地址。**直接跳到第二步**。

在服务器上执行：

```bash
# 创建裸仓库
mkdir -p ~/git
git init --bare ~/git/notes-vault.git

# 克隆为工作目录（inkfellow 读这里）
git clone ~/git/notes-vault.git ~/vault
# 在 .env.local 里设置 VAULT_PATH=~/vault
```

#### 方案 B：使用 GitHub 私有仓库（最简单，多设备通用）

```
本地笔记 ──push──▶ GitHub 私有仓库 ◀──pull── 服务器上的 inkfellow
```

在 GitHub 新建一个私有仓库，然后在**服务器上** clone 并配置认证：

```bash
git clone https://github.com/yourname/my-vault.git ~/vault
# 在 .env.local 里设置 VAULT_PATH=~/vault
```

在 GitHub → Settings → Developer settings → Personal access tokens 生成 Token（权限选 `repo`），让服务器记住凭据：

```bash
git config --global credential.helper store
cd ~/vault
git pull   # 提示输入用户名和 token，输一次后自动记住
```

或者直接把 token 写进 remote URL：

```bash
git remote set-url origin https://yourname:YOUR_TOKEN@github.com/yourname/my-vault.git
```

---

### 第二步：把本地笔记同步到云端

#### 对应方案 A — SSH 认证 + Obsidian Git

**1. 把本地电脑的 SSH 公钥加到服务器**

本地如果没有 SSH 密钥，先生成一个：

```bash
ssh-keygen -t ed25519 -C "obsidian-local"
```

把公钥复制到服务器（会提示输一次服务器密码）：

```bash
ssh-copy-id user@your-server.com
```

验证是否配置成功（不需要密码直接登录即为成功）：

```bash
ssh user@your-server.com
```

**2. 本地 vault 添加服务器裸仓库为 remote**

```bash
cd /path/to/local/notes
git init                   # 已是 git 仓库则跳过
git remote add origin ssh://user@your-server.com/home/you/git/notes-vault.git
git pull origin main
```

**3. 安装 Obsidian Git 插件**

Obsidian → 设置 → 第三方插件 → 社区插件 → 搜索 **Obsidian Git**，安装并启用。建议设置：
- *Auto pull interval*：`10`（分钟，自动拉取）
- *Auto push interval*：`5`（分钟，自动提交并推送）

每次本地 push 后，在 inkfellow 网页端点 Git 面板的 **Pull** 即可将最新内容同步到服务器工作目录。

#### 对应方案 B — GitHub HTTPS + Obsidian Git

在本地 vault 目录执行：

```bash
git init
git remote add origin https://github.com/yourname/my-vault.git
git add . && git commit -m "init"
git push -u origin main
```

安装 Obsidian Git 插件（同方案 A 第 3 步），在插件设置中填入 GitHub 用户名和 Personal Access Token 完成认证。每次本地 push 后，inkfellow 网页端点 Git 面板的 **Pull** 即可同步。

---

### 同步操作汇总

| 场景 | 操作 |
|------|------|
| 本地写了新笔记 | Obsidian Git 自动 push → inkfellow 点 **Pull** |
| 网页端编辑了笔记 | inkfellow 点 **Push** → Obsidian Git 自动 pull |
| 想要每日自动备份 | 配置 `scripts/nightly-sync.js` 定时任务（见下节） |

---

### 凌晨自动同步

`scripts/nightly-sync.js` 与手动同步按钮的逻辑完全一致——拉取 → 检测改动 → AI 生成提交说明 → 推送——但每天凌晨 00:00 自动触发，无需任何人工操作。

**执行流程：**

1. `git pull --rebase --autostash` — 先拉取云端最新内容
2. 暂存所有本地改动，检查是否有新变化
3. 无改动 → 静默退出，不产生空 commit
4. 调用 AI 生成提交说明，描述今天改了什么（与同步面板使用相同的模型和提示词）；AI 不可用时自动降级为日期模板消息
5. `git commit` + `git push`

> 提交说明刻意描述的是**发生了什么改动**，而非断言"完成了什么"——写到一半的笔记和写完的笔记同等备份。

**配置方式：**

先确认 node 路径：

```bash
which node   # 例如 /home/admin/.nvm/versions/node/v25.5.0/bin/node
```

打开 crontab，每个 vault 添加一行：

```bash
crontab -e
```

```
# inkfellow 凌晨自动同步 — 按实际路径修改
0 0 * * * /home/admin/.nvm/versions/node/v25.5.0/bin/node /home/admin/apps/clawapp/scripts/nightly-sync.js /home/admin/vault/jiang-vault >> ~/.pm2/logs/nightly-sync-jiang.log 2>&1
```

日志落到 `~/.pm2/logs/nightly-sync-<vault>.log`。首次配置后可手动跑一次验证：

```bash
node scripts/nightly-sync.js /path/to/your/vault
```

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

### inkfellow

| 变量名 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` | 否 | `inkfellow` | 显示在界面和页面标题中的应用名称。 |
| `VAULT_PATH` | 是 | `./vault` | Markdown 知识库的绝对路径。 |
| `NOTES_BASIC_AUTH_USERNAME` | 是 | `notes` | 知识库登录用户名。 |
| `NOTES_BASIC_AUTH_PASSWORD` | 是 | *(空)* | 访问密码，为空时始终拒绝访问。 |
| `SHARED_NOTES_PATH` | 否 | `./shared-notes.json` | 存储分享 token 的 JSON 文件路径。 |
| `SITE_URL` | 否 | `http://localhost:3000` | 生成分享链接时使用的公开地址（域名或 IP）。 |
| `NOTES_GIT_PUSH_TARGET` | 否 | `HEAD:main` | Git push 操作的目标 refspec。 |
| `GIT_COMMIT_USER_NAME` | 否 | `Inkfellow Web` | 网页端"同步到云端"功能的 Git 提交者名称。服务器无需配置全局 git 身份。 |
| `GIT_COMMIT_USER_EMAIL` | 否 | `web-editor@inkfellow.local` | 网页端"同步到云端"功能的 Git 提交者邮箱。 |
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

# 凌晨自动同步（也可手动触发验证）
node scripts/nightly-sync.js /path/to/vault
```

## 生产部署

典型的生产环境部署方案：

1. 用 **systemd** 保持两个进程常驻。
2. 用 **Nginx** 分流请求：`/`、`/share` → 端口 3000；`/notes-claude/` → 端口 8082。

```bash
# ── 笔记应用（Next.js）──────────────────────────────────────────
sudo cp deploy/notes-app.service.example /etc/systemd/system/notes-app.service
# 编辑：填写 User、WorkingDirectory、EnvironmentFile
sudo systemctl daemon-reload
sudo systemctl enable --now notes-app

# ── AI 对话服务（claude-chat）───────────────────────────────────
sudo cp deploy/claude-chat.service.example /etc/systemd/system/claude-chat.service
# 编辑：填写 User、WorkingDirectory 以及 VAULT_PATH
sudo systemctl daemon-reload
sudo systemctl enable --now claude-chat

# ── Nginx ────────────────────────────────────────────────────────
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/notes-app
sudo ln -s /etc/nginx/sites-available/notes-app /etc/nginx/sites-enabled/
# 生成 AI 面板密码文件
echo "YOUR_USER:$(openssl passwd -apr1 YOUR_PASSWORD)" | sudo tee /etc/nginx/.htpasswd
sudo nginx -t && sudo systemctl reload nginx
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

## 多用户部署

每个用户拥有独立的 Next.js 进程、独立的 vault 目录和独立的 git 仓库，共用同一份编译好的代码，无需重复部署。

### 第一步 — 创建 vault 和 git 仓库

```bash
# 工作目录
mkdir -p /home/admin/vault/USERNAME-vault

# 裸仓库（用于同步/备份，与主 vault 保持一致的结构）
git init --bare /home/admin/git/USERNAME-vault.git

# 在工作目录初始化 git 并推送初始提交
cd /home/admin/vault/USERNAME-vault
git init
git remote add origin /home/admin/git/USERNAME-vault.git
git config user.email "USERNAME@inkfellow"
git config user.name "USERNAME"
git checkout -b main
git add .
git commit -m "init: USERNAME vault"
git push -u origin main
```

> 每个用户必须有**独立**的裸仓库，禁止多个用户共用同一个 `.git` remote。

### 第二步 — 添加 PM2 进程

编辑 `ecosystem.config.cjs`，在 `apps` 数组中追加**两个**条目——笔记应用和 AI 对话后端各一个：

```js
// 笔记应用
{
  name: "inkfellow-USERNAME",
  script: "node_modules/.bin/next",
  args: "start",
  cwd: "/home/admin/apps/clawapp",   // 必须用绝对路径，不能用 __dirname
  env: {
    PORT: "3001",                     // 选一个空闲端口（3001、3002……）
    NODE_ENV: "production",
    VAULT_PATH: "/home/admin/vault/USERNAME-vault",
    NOTES_BASIC_AUTH_USERNAME: "USERNAME",
    NOTES_BASIC_AUTH_PASSWORD: "强密码",
  },
  autorestart: true,
  watch: false,
  merge_logs: true,
  out_file: "~/.pm2/logs/inkfellow-USERNAME-out.log",
  error_file: "~/.pm2/logs/inkfellow-USERNAME-error.log",
},
// AI 对话后端——必须指向该用户自己的 vault
{
  name: "claude-chat-USERNAME",
  script: "server.js",
  cwd: "/home/admin/apps/clawapp/claude-chat",
  node_args: "--env-file-if-exists=.env",
  env: {
    PORT: "8083",                     // 选一个与主 claude-chat (8082) 不同的空闲端口
    HOST: "127.0.0.1",
    VAULT_PATH: "/home/admin/vault/USERNAME-vault",
    CLAUDE_PERMISSION_MODE: "auto",
  },
  autorestart: true,
  watch: false,
  merge_logs: true,
  out_file: "~/.pm2/logs/claude-chat-USERNAME-out.log",
  error_file: "~/.pm2/logs/claude-chat-USERNAME-error.log",
},
```

同时启动两个进程：

```bash
pm2 start ecosystem.config.cjs --only inkfellow-USERNAME,claude-chat-USERNAME
```

> **注意：** `cwd` 必须使用绝对路径。用 `__dirname` 会导致 PM2 守护进程以自身工作目录解析路径，
> 找不到 `.next` 构建产物，进程启动后立即崩溃。

> **每个用户必须有独立的 `claude-chat` 实例**，且 `VAULT_PATH` 指向各自的 vault。
> 如果多个用户共用同一个 `claude-chat`，AI Agent 会读取错误的 vault 内容。

### 第三步 — 添加 Nginx server block

在 `/etc/nginx/conf.d/mindflowinsight.conf` 中追加：

```nginx
server {
    listen 80;
    server_name USERNAME.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name USERNAME.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 50M;

    location = /notes-claude {
        return 301 /notes-claude/;
    }

    location /notes-claude/ {
        proxy_pass http://127.0.0.1:8083/;  # 对应 claude-chat-USERNAME 的 PORT
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://127.0.0.1:3001;   # 对应 inkfellow-USERNAME 的 PORT
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

测试并重载：

```bash
sudo nginx -t && sudo nginx -s reload
```

### 第四步 — DNS 解析 + SSL 证书

1. 在域名服务商处添加 A 记录，将 `USERNAME.yourdomain.com` 指向服务器 IP。
2. DNS 生效后（通常 5–10 分钟），将新子域名扩进现有证书：

```bash
sudo certbot --nginx --expand \
  -d yourdomain.com \
  -d www.yourdomain.com \
  -d USERNAME.yourdomain.com \
  --non-interactive --agree-tos -m you@example.com
```

新用户即可通过 `https://USERNAME.yourdomain.com` 访问。

---

## 常见问题排查

### 页面空白（代码更新或 `next build` 之后）

**现象：** 站点返回 HTTP 200 但响应体为空，响应头中没有 `X-Powered-By: Next.js`；不在 auth 匹配规则内的路径（如 `/share/…`）能正常返回 404。

**原因：** 偶发性构建问题——`proxy.ts` 的 middleware 编译产物损坏，拦截了 `/` 和 `/api/notes/*` 的所有请求但没有正确输出响应体。

**修复：** 重新构建并重启：

```bash
cd /home/admin/apps/clawapp

# 先停止所有实例，避免端口冲突
pm2 stop inkfellow inkfellow-USERNAME   # 按实际名称调整

npm run build

pm2 start ecosystem.config.cjs --only inkfellow,inkfellow-USERNAME
```

如果 PM2 停止后端口仍被占用，先手动 kill 残留进程：

```bash
ss -tlnp | grep 3000   # 记下 PID
kill <PID>
pm2 start inkfellow
```

### PM2 进程启动后立即崩溃（EADDRINUSE）

有残留的 `next start` 或 `next dev` 进程仍占用该端口：

```bash
ss -tlnp | grep <PORT>
kill <PID>
pm2 start inkfellow-USERNAME
```

### PM2 报错"Could not find a production build in the .next directory"

`ecosystem.config.cjs` 中的 `cwd` 路径解析有误，将 `__dirname` 替换为绝对路径：

```js
// ❌ 不可靠——PM2 守护进程对 __dirname 的解析与预期不同
const BASE = __dirname;

// ✅ 始终使用绝对路径
const BASE = "/home/admin/apps/clawapp";
```

## 安全说明

- 根路径 `/` 和 `/api/notes/*` 均需通过 Basic Auth 验证，整个知识库默认私有。
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

## 开源协议 (License)

本项目基于 [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE) 协议开源。

## 联系方式 (Contact)

- **邮箱 (Email)**: jiangjiren@hotmail.com
- **微信 (WeChat)**: jiangjiren
