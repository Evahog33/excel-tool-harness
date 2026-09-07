# Excel Tool Harness

> 基于 [Cordis](https://github.com/cordiverse/cordis) 框架构建的本地化 Excel 智能处理工作站。
> 参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 架构设计。

## 核心理念

**"Agent as a Tool Maker"** —— 大模型不直接处理数据，而是为你生成专用的处理工具。

- **左侧**：与 AI 对话，描述 Excel 处理需求
- **右侧**：AI 生成的工具沙箱，独立离线执行，不依赖大模型

## 项目结构

```
excel-tool-harness/
├── apps/
│   ├── server/           # 服务入口（Cordis Context 启动点）
│   └── web/              # Vue 3 前端（双屏布局）
│       └── src/
│           ├── components/ChatPanel.vue      # 左侧对话区
│           ├── components/ToolSandbox.vue    # 右侧沙箱
│           └── components/FormRenderer.vue  # JSON Schema → 表单渲染
└── packages/
    ├── llm/              # LLM 服务插件（DeepSeek API 适配器）
    ├── session/          # 会话管理插件（append-only 日志）
    ├── tools/            # 工具注册表插件
    ├── agent-loop/       # Agent 驱动循环插件
    ├── excel-tool/       # Excel 专属工具插件（核心业务）
    │   └── templates/    # Python 执行引擎模板
    └── web-host/         # Web 宿主插件（Koa + SSE）
```

## 快速开始

### 1. 环境要求

- Node.js >= 22
- pnpm >= 9（`corepack enable`）
- Python >= 3.10 + `pandas` + `openpyxl`

```bash
pip install pandas openpyxl
```

### 2. 配置

```bash
cp .env.example .env
# 编辑 .env，填写你的 DEEPSEEK_API_KEY
```

### 3. 安装依赖

```bash
pnpm install
```

### 4. 启动服务（一键前后端同启）

```bash
pnpm dev
# 同时拉起前后端：
# 后端 API : http://127.0.0.1:3080
# 前端页面 : http://localhost:5173
```

> 若需单独启动：
> - 仅后端：`pnpm dev:server`
> - 仅前端：`pnpm dev:web`

## 架构说明

本项目沿用 dsh 的 **Cordis 插件架构**：

| 概念 | 本项目实现 |
|---|---|
| Profile/Bundle | `apps/server/src/index.ts` 中的插件挂载顺序 |
| ctx.llm | `packages/llm` — LlmService |
| ctx.sessions | `packages/session` — SessionService |
| ctx.tools | `packages/tools` — ToolRegistry |
| ctx.agentLoop | `packages/agent-loop` — AgentLoop |
| 自研插件 | `packages/excel-tool` — ExcelTool |

## License

[MIT](LICENSE)
