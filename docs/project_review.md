# Excel Tool Harness — 项目全面评审报告

## 一、项目概览

本项目是一个基于 **Cordis** 插件架构的本地化 Excel 智能处理工作站，核心理念为 **"Agent as a Tool Maker"**：大模型不直接处理数据，而是生成专用的 Python 处理工具，由本地沙箱独立离线执行。

```mermaid
graph LR
    User[用户] -->|对话需求| ChatPanel[ChatPanel 对话面板]
    ChatPanel -->|SSE| WebHost[Web Host / Koa]
    WebHost -->|Agent Loop| LLM[DeepSeek LLM]
    LLM -->|Tool Call| ExcelTool[generate_excel_tool]
    ExcelTool -->|预检| Python[Python 沙箱]
    Python -->|结果| ExcelTool
    ExcelTool -->|UI Schema + Code| ToolSandbox[右侧工具沙箱]
    ToolSandbox -->|用户执行| Python
```

**技术栈**: pnpm monorepo · Cordis IoC 微内核 · Koa + SSE · Vue 3 + Pinia · Python (Pandas/Openpyxl)

**代码统计**: ~31 个源文件 · ~4,500 行 TypeScript · ~350 行 Python · ~65 行 模板

---

## 二、亮点与优秀设计 ✅

### 1. 架构理念清晰且创新
- **"Agent as Tool Maker"** 理念非常出色——大模型生成工具而非直接处理数据，兼顾了 AI 智能与执行确定性
- 左右双屏布局（对话 + 沙箱）的产品形态直观且实用

### 2. Cordis 插件架构运用得当
- 6 个 package 职责明确，依赖关系清晰：`llm → session → tools → agent-loop → excel-tool → web-host`
- 通过 `ctx.plugin()` + `Service.provide` + `declare module 'cordis'` 实现了干净的 IoC 类型扩展
- 插件间通过事件系统 (`ctx.emit`) 实现松耦合通信

### 3. 自动化预检与自愈闭环 (Self-Correction Loop)
- `generate_excel_tool` 执行后会自动在沙箱中用真实数据预检
- 预检失败时，错误 Traceback 被反馈给 LLM 自动修正，而非暴露给用户
- 系统提示词严格要求 LLM "严禁在预检失败时放弃"——这是非常务实的工程设计

### 4. 数据安全与隐私保护做得细致
- 智能敏感列嗅探（身份证/手机/姓名/邮箱/银行卡/薪资），列名 + 数据正则双重识别
- 前端实时脱敏预览 + 风险确认弹窗卡点——未勾选推荐脱敏列时强制弹窗警告
- "查看发给 AI 的数据" 预览功能增强了用户信任感

### 5. Python 子进程管理健壮
- `python-runner.ts` 考虑了：UTF-8 增量解码、2MB 日志防 OOM、进程组级超时回收 (SIGTERM → SIGKILL)、参数 input.json 落盘避 E2BIG
- 跨平台兼容：Windows `taskkill` vs Unix 负 PID 进程组信号

### 6. Excel 多层表头识别
- `inspector.py` 能自动处理合并单元格、跳过大标题行、构造复合列名——这对真实企业 Excel 非常有价值

---

## 三、设计问题与改进建议 ⚠️

### 🔴 严重问题 (安全/可靠性风险)

#### 1. `/api/download` 路由存在**路径遍历漏洞** (Critical)

> ⚠️ **高危安全漏洞**: 攻击者可构造 `filepath=C:\Windows\System32\config\SAM` 等任意路径下载系统敏感文件。

**文件**: `packages/web-host/src/index.ts` L398-L416

```typescript
// 当前代码——未做任何路径校验
router.get('/api/download', (koaCtx) => {
  const filepath = koaCtx.query.filepath as string  // ← 用户可控！
  // ...
  koaCtx.body = createReadStream(filepath)  // ← 任意文件读取
})
```

**修复建议**: 校验 `filepath` 必须以 `.sessions/` 或指定产物目录为前缀，并用 `path.resolve()` + `startsWith()` 防范 `../` 穿越。

---

#### 2. `form-upload` 路由同样缺乏文件类型校验

**文件**: `packages/web-host/src/index.ts` L367-L395

用户可上传任意文件（如 `.exe`、`.sh`），虽然不会被直接执行，但配合路径泄漏可能被恶意利用。应限制 `accept` 类型并在服务端校验扩展名。

---

#### 3. 会话持久化使用同步 I/O (`writeFileSync`/`readFileSync`)

**文件**: `packages/session/src/index.ts` L333-L353

在每次 `appendMessage`、`updateAssets` 等操作时都同步写整个 JSON 文件。当会话消息量增大、或多用户并发时：
- **阻塞 Node.js 事件循环**，SSE 流式响应将出现卡顿
- 大会话文件的重复全量序列化性能低下

**建议**: 改用异步 I/O (`writeFile`)，或采用 append-only 日志格式（符合需求文档中的设计意图）而非全量覆写。

---

### 🟡 中等问题 (代码质量/可维护性)

#### 4. 前后端类型定义大量重复

以下类型在**三处**独立定义了完全相同的结构：

| 类型 | 后端 session/src/index.ts | 前端 stores/chat.ts | 前端 utils/desensitize.ts |
|---|---|---|---|
| `ExcelMeta` | ✅ | ✅（重复） | — |
| `UiSchema` / `UiField` | ✅ | ✅（重复） | — |
| `DesensitizationRuleConfig` | ✅ | ✅（重复） | — |
| `MaskRuleType` | desensitizer.ts ✅ | — | ✅（重复） |
| 脱敏函数 (`maskIdCard` 等) | desensitizer.ts ✅ | — | ✅（完全重复） |

**影响**: 修改一处忘记同步另一处会导致前后端数据不一致的 bug。

**建议**: 
- 抽取 `@excel-harness/shared` 或 `@excel-harness/types` 包存放共享类型
- 脱敏算法库只保留一份（后端 `desensitizer.ts`），前端通过共享包引用或在构建时复制

---

#### 5. `web-host` 单文件承载了过多职责 (~440 行)

`packages/web-host/src/index.ts` 一个文件中混合了：
- 会话 CRUD (5 个路由)
- Excel 文件管理 (5 个路由)  
- 脱敏配置 (2 个路由)
- SSE 对话流 (1 个路由)
- 执行沙箱 (1 个路由)
- 文件上传 (1 个路由)
- 文件下载 (1 个路由)
- 中止/撤回 (2 个路由)

**建议**: 按领域拆分为 `routes/sessions.ts`、`routes/excel.ts`、`routes/chat.ts`、`routes/sandbox.ts` 等模块。

---

#### 6. `zod` 被引入但从未使用

**文件**: `packages/tools/package.json` 声明了 `zod` 依赖，但 `packages/tools/src/index.ts` 中仅 `import { z } from 'zod'`，实际从未使用 `z`。

**建议**: 移除无用依赖，或利用 zod 做工具参数的运行时校验（这其实是个好主意）。

---

#### 7. SSE `currentEvent` 变量声明位置不自然

**文件**: `apps/web/src/stores/chat.ts` L254-L291

```typescript
let buffer = ''
// currentEvent 在 handleLine 函数内引用，但声明在更内层
const handleLine = (line: string) => {
  // ...
  currentEvent = 'message'  // ← 引用了外层的 currentEvent
}
```

`currentEvent` 在 `let buffer = ''` 和 `const handleLine` 之间没有声明。虽然 JavaScript 的变量提升机制使代码不会报错，但这是一个可读性隐患。实际检查发现它确实是在后面声明的（`let assistantMsg = ''` 之后），但位置不自然。

---

#### 8. `FormRenderer` 的 `isRunning` 状态管理不可靠

**文件**: `apps/web/src/components/FormRenderer.vue` L161-L172

```typescript
async function handleSubmit() {
  isRunning.value = true
  try {
    // ...
    emit('submit', params)  // ← 只是 emit，不 await 结果
  } finally {
    setTimeout(() => { isRunning.value = false }, 500)  // ← 固定 500ms 后解锁
  }
}
```

`isRunning` 与实际的 Python 执行完全无关——无论脚本跑 50ms 还是 50s，按钮都在 500ms 后解锁。用户可能在执行中重复提交。

**建议**: 让 `isRunning` 状态与 `store.runResult` 联动，或在父组件 `ToolSandbox` 中管理异步执行生命周期。

---

### 🟢 轻微问题 (可优化)

#### 9. 助手消息内容渲染不支持 Markdown

**文件**: `apps/web/src/components/ChatPanel.vue` L181-L189

```typescript
function renderContent(content?: string | null) {
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}
```

LLM 回复通常包含 Markdown 格式（代码块、列表、表格等），当前仅做了换行转换，用户看到的是 raw Markdown 文本。

**建议**: 引入 `marked` 或 `markdown-it` + `DOMPurify` 进行安全渲染。

---

#### 10. 未配置 ESLint / Prettier / 代码质量工具

项目没有任何代码格式化或 lint 配置。对于一个 monorepo 项目，建议在根目录配置统一的代码规范。

---

#### 11. 缺少自动化测试

整个项目没有任何测试文件（`.spec.ts` / `.test.ts`），虽然 `tsconfig.json` 的 `exclude` 中预留了 `**/*.spec.ts`，但从未实际创建。

核心业务逻辑（脱敏算法、Excel 检查器、Agent Loop 历史构建等）非常适合单元测试。

---

#### 12. Windows 路径兼容性潜在问题

**文件**: `packages/excel-tool/src/python-runner.ts` L270

```typescript
const inspectorScript = join(dirname(new URL(import.meta.url).pathname), 'inspector.py')
```

在 Windows 上，`new URL(import.meta.url).pathname` 返回 `/E:/work/...` 形式的路径（带前导 `/`），`dirname()` 后会保留该前导斜杠。当传给 `execFile` 时可能导致路径解析错误。

**建议**: 使用 `fileURLToPath(import.meta.url)` 替代 `new URL().pathname`。

---

#### 13. 会话标题生成过于简单

**文件**: `packages/session/src/index.ts` L190-L192

```typescript
session.title = msg.content.slice(0, 30) + (msg.content.length > 30 ? '…' : '')
```

直接截断前 30 字符。如果用户输入很长的需求描述，标题缺乏语义摘要能力。

**建议**: 后续可利用 LLM 异步生成会话摘要标题。

---

#### 14. `SIGINT` 优雅退出未处理 `SIGTERM`

**文件**: `apps/server/src/index.ts` L63-L67

只监听了 `SIGINT`（Ctrl+C），未处理 `SIGTERM`（Docker/PM2 的标准停止信号）。生产部署时可能导致不优雅的进程终止。

---

## 四、综合评分与总结

| 维度 | 评分 | 说明 |
|---|---|---|
| **架构设计** | ⭐⭐⭐⭐☆ (4/5) | Cordis 插件架构运用成熟，职责划分清晰。但 web-host 单文件过大 |
| **产品理念** | ⭐⭐⭐⭐⭐ (5/5) | "Agent as Tool Maker" + 脱敏安全 + 自愈闭环，产品设计出色 |
| **代码质量** | ⭐⭐⭐☆☆ (3/5) | 注释充分、变量命名清晰，但前后端类型重复、缺少测试和 lint |
| **安全性** | ⭐⭐☆☆☆ (2/5) | 路径遍历漏洞是硬伤，文件上传缺校验 |
| **可维护性** | ⭐⭐⭐☆☆ (3/5) | 类型重复会导致维护负担，但模块拆分思路正确 |
| **完成度** | ⭐⭐⭐⭐☆ (4/5) | MVP 功能完整，Excel 解析/脱敏/沙箱/下载全链路打通 |

### 综合评价

这是一个**完成度很高的 MVP 项目**，产品理念新颖（Agent 造工具而非直接处理数据），架构上合理运用了 Cordis 微内核模式。数据隐私保护做得尤为出色——从智能嗅探到前端实时预览再到风险卡点，形成了完整的安全闭环。自动化预检 + 自愈循环的设计也体现了对 LLM 工程化的深刻理解。

最需要**优先修复的是下载接口的路径遍历漏洞**——这是一个任何用户都可以利用的严重安全问题。其次是将前后端重复的类型定义收敛为共享包、补齐基础的代码质量工具和测试覆盖。

### 优先修复路线图

```
P0 (立即) → 修复 /api/download 路径遍历漏洞
P1 (本周) → form-upload 文件类型校验 · Windows fileURLToPath 修复
P2 (近期) → 共享类型包 · web-host 路由拆分 · 异步 I/O 持久化
P3 (迭代) → Markdown 渲染 · ESLint/Prettier · 单元测试 · 会话标题智能摘要
```
