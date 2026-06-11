# inkfellow 项目 Bug 检查报告

> 检查时间: 2026-06-10
> 检查范围: TypeScript 类型检查、ESLint、源代码逻辑、安全配置、构建配置

---

## 🔴 高优先级

### 1. ESLint `globalIgnores` 遗漏 `desktop-lite/vendor/` 目录

**文件**: `eslint.config.mjs:9-23`

**问题**: `globalIgnores` 只忽略了 `desktop-lite/marked.min.js`，但 `desktop-lite/vendor/` 下的三个压缩文件未被忽略：

- `vendor/codemirror.min.js`
- `vendor/continuelist.min.js`
- `vendor/markdown.min.js`

导致每次 lint 产出 **35 个 error + 562 个 warning**，全部来自第三方 vendor 文件，与项目自身代码无关。

**建议修复**: 在 `globalIgnores` 数组中添加 `"desktop-lite/vendor/**"`。

```js
globalIgnores([
  // ...existing entries...
  "desktop-lite/vendor/**",
]),
```

---

## 🟡 中优先级

### 2. `next.config.ts` 设置了 `typescript.ignoreBuildErrors: true`

**文件**: `next.config.ts:11`

```ts
typescript: {
  ignoreBuildErrors: true,
},
```

**问题**: TypeScript 类型错误在 `next build` 时被完全忽略。即使有人引入了类型错误，构建也会成功通过，可能导致运行时崩溃。

当前 `tsc --noEmit` 检查通过，但 CI/部署流水线如果只跑 `next build` 不跑 `tsc`，类型安全就没了。

**建议**: 评估是否可以移除此配置，或至少在 CI 中单独跑一次 `tsc --noEmit`。

---

### 3. Git API 路由中 `VAULT` 在模块加载时静态解析

**涉及文件**:
- `src/app/api/notes/git/route.ts:12`
- `src/app/api/notes/git/ai-log/route.ts:12`

```ts
const VAULT = path.resolve(process.env.VAULT_PATH?.trim() || DEFAULT_VAULT_PATH);
```

**问题**: 这行代码在模块加载时（cold start）就执行并缓存为常量。如果：
- 环境变量在模块加载后才被设置
- 运行时需要动态切换 vault 路径（如 Tauri 桌面端切换 vault 目录）

`VAULT` 常量不会更新，后续请求会使用旧路径。

**对比**: `notesVault.ts` 中的 `getConfiguredVaultPath()` 是每次请求时调用的函数，不存在此问题。

**建议**: 改为每次请求时解析路径，或在函数内获取。

---

### 4. Git `ai-log` 路由中 `git add -A` 的副作用

**文件**: `src/app/api/notes/git/ai-log/route.ts:71`

```ts
await git(["add", "-A"]);
```

**问题**: 这个 POST 端点将所有改动（包括可能的敏感文件）暂存到 git index 中。虽然最终只生成日志消息并返回（不 commit），但 `git add -A` 的副作用是把所有未追踪文件加入了暂存区。

如果后续有其他操作读取 index，可能看到意料之外的状态。

**建议**: 考虑用 `git status --porcelain -uall` 替代 `git add -A` 来获取文件列表，避免修改 index 状态。

---

## 🟢 低优先级

### 5. NotesExplorer.tsx 中多余的 eslint-disable 指令

**文件**: `src/app/notes/NotesExplorer.tsx:1719`

```tsx
// eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

**问题**: ESLint 自身报告 `Unused eslint-disable directive`，说明该 `useEffect` 的空依赖 `[]` 没有触发 exhaustive-deps 警告，此指令是多余的。

**建议**: 删除第 1719 行的 `// eslint-disable-next-line react-hooks/exhaustive-deps`。

---

### 6. Tauri CSP 设置为 null

**文件**: `src-tauri/tauri.conf.json:25`

```json
"security": {
  "csp": null
}
```

**问题**: 禁用了 Content Security Policy。对于个人桌面应用来说可以接受，但如果加载不受信任的 web 内容会有 XSS 风险。

**建议**: 评估是否可以设置合理的 CSP 策略，至少限制 `script-src`。

---

### 7. Tauri URL 缓存破坏依赖手动维护

**文件**: `src-tauri/tauri.conf.json:15`

```json
"url": "index.html?v=20260609-image"
```

**问题**: 使用查询参数手动做缓存破坏。每次发布需要手动更新版本号，容易遗漏，可能导致用户看到旧版前端。

**建议**: 考虑用构建时间戳或 Tauri 的版本号自动注入。

---

## ✅ 无问题确认

以下方面检查通过，未发现问题：

- **TypeScript 类型检查**: `tsc --noEmit` 通过，无类型错误
- **路径遍历防护**: `notesVault.ts` 和 Rust 代码都有完善的路径规范化和边界检查
- **认证机制**: proxy.ts 的 Basic Auth + Cookie session 实现正确
- **输入验证**: API 路由对所有输入都做了验证
- **.env 文件**: 未被提交到仓库（只有 `.env.example`）
- **Rust 代码**: Tauri 后端代码质量良好，无明显问题
- **前端组件**: React 组件逻辑清晰，无明显 bug
