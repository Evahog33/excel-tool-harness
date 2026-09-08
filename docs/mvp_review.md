# MVP 对比分析报告

> 对照图片 MVP 清单（P0：必须有，缺一个就不叫 MVP），逐条核查当前项目实现状态。

---

## ✅ / ❌ MVP 逐条核查

### #1 `run_python` 工具（一次性进程 + 结果文件协议）
**状态：✅ 完整实现**

- [`python-runner.ts`](file:///Users/777hoog/Desktop/work/mine5/agent/excel-tool-harness/packages/excel-tool/src/python-runner.ts) — 基于 `child_process.spawn` 的一次性子进程执行器，完全符合"一次性进程"语义
- 参数通过 `input.json` 落盘（彻底规避 `E2BIG` 环境变量长度上限），结果文件通过扫描 `outputDir` 目录实现"结果文件协议"
- 具备：超时保护（SIGTERM → SIGKILL 两段式）、进程组清理（`detached: true`）、OOM 防护（2MB 日志上限）、UTF-8 跨 chunk 解码

---

### #2 Excel playbook skill
**状态：⚠️ 部分实现 / 未独立成 playbook 格式**

- 功能上等价的东西都在：`generate_excel_tool` 让 LLM 生成 Python + UI Schema，系统 prompt 里有详细规范约束
- **但**没有一个独立的「playbook」文件或模板库（templates 目录下只有一个 `processor.py` 骨架，无任何预制任务 playbook）
- 没有可供用户选择的"常用 playbook 列表"，每次都从零 LLM 生成

> [!WARNING]
> 这是 MVP 里「决定成功率的大头」，当前更像是 raw LLM 生成而非有积累的 playbook skill。缺少经过验证的 playbook 模板集合。

---

### #3 写前自动备份 + 强制输出到新路径
**状态：✅ 强制新路径已实现 / ❌ 写前自动备份未实现**

- `runPython` 中通过注入 `OUTPUT_DIR`（每次执行都是全新的 UUID 目录），天然强制输出到新路径，不会覆盖原文件 ✅
- System prompt 里也明确要求 Python 代码 `os.path.join(OUTPUT_DIR, ...)` 写出结果 ✅
- **但**：没有对用户上传的原始 Excel 做写前自动备份机制。上传文件存于 `.sessions/<id>/uploads/`，万一代码 bug 写到了原路径，没有 fallback ❌

> [!WARNING]
> 写前自动备份尚未实现。MVP 描述的"唯一的灾难兜底，5 行代码"还缺失。

---

### #4 `validate_workbook`（回读扫描）
**状态：❌ 未实现**

- 无任何 `validate_workbook` 工具的注册或实现
- `inspector.py` 是上传时的结构嗅探（读取表头/敏感列），不是产物回读校验
- 产物生成后没有自动用 openpyxl 回读校验文件完整性、sheet 存在性、行列数合理性等

> [!CAUTION]
> 这是"裸模型的唯一护城河"，属于 P0 未完成项。

---

### #5 结果预览（前 N 行渲染成 markdown 表）
**状态：⚠️ 基础具备 / 未系统化**

- `inspector.py` 提取了前 15 行样例数据，并在 agent-loop 的 `_formatExcelFilesContext` 中渲染成 markdown 表格注入 system prompt ✅
- `generate_excel_tool` 返回的 `testStdout` 会回传给 LLM，LLM 可以据此描述结果
- **但**：UI 上并不渲染产物 Excel 的前 N 行预览表格。用户只能下载文件后手动打开查看结果，没有"人眼秒扫"的 inline markdown 预览 ❌

> [!WARNING]
> 信任瓶颈仍在：产物生成后前端展示的只是"✅ 执行成功 + 下载按钮"，没有前 N 行 markdown 预览。

---

### #6 文件入口：本地绝对路径 + web 上传
**状态：✅ 完整实现（web 上传已有）**

- Web 上传：`POST /api/sessions/:id/upload-excel`，支持多文件、自动 inspect、脱敏配置 ✅
- 本地绝对路径：Python 代码中硬编码了 `meta.filepath`（真实本地路径）作为兜底 fallback ✅
- DataDock.vue 提供了完整的上传 + 多文件管理 UI

---

### #7 Trace 里能看到生成的完整 py 代码
**状态：✅ 完整实现**

- `generate_excel_tool` 的完整参数（含 `python_code`）会被记录到 session messages 中，前端 ChatPanel 展示所有消息
- `tools/before-execute` / `tools/after-execute` 事件可供扩展追踪
- 会话 JSON 持久化在 `.sessions/<id>.json` 中，完整保留所有 tool call 参数

---

### #8 20 任务 eval 集 + 一键跑分脚本
**状态：❌ 完全未实现**

- 项目中无任何 eval 任务集文件
- 无跑分脚本
- `package.json` 的 `test` 脚本只是 `node --test`（跑的是 runner.test.ts 单元测试，不是 eval）
- 唯一的测试 `runner.test.ts` 是 python 执行器的基础单元测试，非业务 eval

> [!CAUTION]
> MVP 清单里工作量最大（3-5天）、"最值钱"的项目，完全空白。

---

## 📊 MVP 完成度汇总

| # | 功能 | 状态 | 备注 |
|---|------|------|------|
| 1 | `run_python` 工具 | ✅ 完整 | 实现质量很高 |
| 2 | Excel playbook skill | ⚠️ 部分 | 有 LLM 生成能力，无 playbook 模板集 |
| 3 | 写前自动备份 + 强制新路径 | ⚠️ 一半 | 新路径 ✅，写前备份 ❌ |
| 4 | `validate_workbook` 回读扫描 | ❌ 未实现 | P0 缺口 |
| 5 | 结果预览（前 N 行 markdown） | ⚠️ 部分 | 输入侧有，产物侧无 |
| 6 | 文件入口（本地路径 + web 上传） | ✅ 完整 | 支持多文件 |
| 7 | Trace 可见完整 py 代码 | ✅ 完整 | session 全量持久化 |
| 8 | 20 任务 eval 集 + 跑分脚本 | ❌ 未实现 | 完全空白 |

**MVP 严格达标：6/8 → 实际 P0 只能算 4.5/8（#2、#3、#5 各有缺口）**

---

## 🌟 加分项（项目中有、MVP 清单里没有的）

这些是超出 MVP 范围的实现，属于显著加分：

### 1. 🔥 自动预检自愈闭环（Self-Correction Loop）
`generate_excel_tool` 调用时自动后台沙箱试跑，失败则将 Traceback 反哺 LLM 自动修正，直到 `status: success`。这是超越 MVP 的核心差异化能力。

### 2. 🔥 智能敏感列嗅探 + 脱敏配置 UI
`inspector.py` 用正则+列名语义双重识别身份证/手机/邮箱/银行卡等 6 种敏感类型，`DesensitizeModal.vue` 提供完整的逐列脱敏规则配置 UI，并将脱敏后的样本注入 LLM 上下文，MVP 完全没提这个。

### 3. 🔥 标杆文件对账验收系统（Ground Truth Benchmark）
`diff_excel.py` + `compare-benchmark` API + ToolSandbox 的 Diff 对账 UI — 上传预期标准结果，一键验收对账并出具匹配率报告。这是独特的质量保证机制。

### 4. 多文件并行处理支持
DataDock 支持同时挂载多个 Excel 文件，agent-loop 自动构建多文件 context，预检时智能按列名语义分配文件到 UI 表单字段。MVP 里没提多文件场景。

### 5. 预检微样本切片（大文件性能优化）
对 >150 行的大文件自动裁切 80 行样本做预检，将预检时间压缩到几百毫秒，防止 60s 超时死循环。

### 6. 超时两段式进程组清理
SIGTERM 宽限 2s → SIGKILL 兜底，跨平台（Unix 进程组 / Windows taskkill）孤儿进程安全回收。

### 7. 多会话管理 + 会话级别删除
完整的多会话管理，含按时间排序的侧边栏、会话标题自动生成、会话+磁盘文件一键删除。

### 8. 推理流（Reasoning）可视化
ChatPanel 中独立展示 DeepSeek/Qwen 模型的 `reasoning_content` 思考过程，有脉冲动效的思考卡片。

### 9. 最后一条消息"修改并重发"
类似 Antigravity 的 edit-and-resend 功能（`popLastUserMessage` + 按钮回填输入框），MVP 未提及。

### 10. 产物下载安全防穿越
`isPathSafe` 白名单根目录限制，防止 path traversal 攻击下载任意系统文件。

---

## 🎯 优先级建议（补完 MVP 最短路径）

按 ROI 排序，最值得立即补的：

1. **`validate_workbook` 回读扫描**（P0 缺口，约 0.5 天）— 产物生成后用 openpyxl 回读，验证 sheet/行数/列完整性，返回 LLM
2. **产物前 N 行 markdown 预览**（P0 信任瓶颈，约 0.5 天）— run 成功后在 ToolSandbox 里读取输出 xlsx 首 5 行渲染成 markdown 表
3. **写前自动备份**（P0 灾难兜底，约 0.5 天）— 上传文件时在 `.sessions/<id>/backups/` 做副本
4. **20 任务 eval 集 + 跑分脚本**（最值钱，约 3-5 天）— 这个最重要但工作量最大
5. **Excel playbook 模板库**（决定成功率，持续迭代）— 沉淀经过验证的常用任务 playbook JSON 文件
