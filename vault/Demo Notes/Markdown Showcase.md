# Markdown 渲染效果展示

这篇笔记展示 inkfellow 支持的 Markdown 语法。

## 文字样式

**粗体**、*斜体*、~~删除线~~、`行内代码`

> 引用块：知识不在于拥有，而在于能随时调用。

## 列表

**无序列表：**
- 第一项
  - 嵌套项
  - 另一个嵌套项
- 第二项

**有序列表：**
1. 规划
2. 执行
3. 复盘

**任务列表：**
- [x] 部署 inkfellow
- [x] 配置 AI 面板
- [ ] 导入我的笔记库
- [ ] 建立知识索引习惯

## 表格

| 功能 | 传统笔记 | LLM Wiki |
|------|----------|----------|
| 查找内容 | 搜索关键词 | 直接问 AI |
| 整理笔记 | 手动分类 | AI 辅助归纳 |
| 跨设备访问 | 需要同步软件 | 浏览器直接访问 |
| 分享笔记 | 导出文件 | 一键生成链接 |

## 代码块

```python
# 用 AI 读懂你的笔记
def ask_your_notes(question):
    context = load_vault()          # 加载笔记库
    answer = llm.chat(              # 让 AI 回答
        context=context,
        question=question
    )
    return answer

ask_your_notes("我上周对这个项目的核心判断是什么？")
```

```bash
# 一键启动
npm run build && npm start
```

## 数学公式（如需启用）

行内公式：$E = mc^2$

块级公式：

$$
\sum_{i=1}^{n} x_i = x_1 + x_2 + \cdots + x_n
$$

## 分割线

---

## 链接

- [项目 GitHub](https://github.com/jiangjiren/clawapp)
- [Obsidian 官网](https://obsidian.md)
- [Anthropic Claude](https://anthropic.com)
