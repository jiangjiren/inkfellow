# 欢迎使用 Notes App 👋

这是一个 **LLM Wiki** 演示知识库。

把你的 Markdown 笔记文件夹，变成一个可以在任意设备、任意地点通过浏览器**浏览、整理、同步、分享**的云端个人知识库。内置 AI Agent 对话面板，以 LLM Wiki 的方式让 AI 真正读懂你写的每一篇笔记——随时问、随时答。

## 演示内容

左侧文件树里有几篇示例笔记，展示了主要功能：

- 📁 **Getting Started** — 快速上手指南
- 📁 **Demo Notes** — Markdown 渲染效果演示

## 试试 AI 面板

点击右上角的 **✦ AI** 按钮，打开 AI 对话面板。

选中这段文字，它会自动出现在 AI 输入框里作为引用——这就是 LLM Wiki 的核心体验。

## 部署你自己的知识库

```bash
git clone https://github.com/jiangjiren/clawapp
cd clawapp
npm install
cp .env.example .env.local
# 编辑 .env.local，填写你的笔记路径和密码
npm run build && npm start
```

> 这个演示库的笔记是只读的。部署到自己的服务器后，你可以随时添加、编辑、同步自己的笔记。
