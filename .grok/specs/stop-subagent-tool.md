# stop_subagent 工具实现 Spec

## 目标
为主 agent 增加一个 LLM 可调用的 `stop_subagent({ id })` 工具，用来主动停止一个正在运行（或排队）的 subagent。

## 背景
- 目前主 agent 对单个 subagent 只有 `steer_subagent`（软转向，不终止）。
- 硬终止路径（`manager.abort`）只经由人类 UI（会话查看器 `x`）、跨扩展 RPC `subagents:rpc:stop`、父信号/关闭。
- `StopSubagentWorkflow` 停的是 workflow，不是裸 subagent。
- `subagents:rpc:stop` handler（`src/cross-extension-rpc.ts:168-184`）是现成的实现参考。

## 实现要点

### 1. `src/agent-runner.ts`
- 在 `SUBAGENT_TOOL_NAMES` 中加 `STOP_SUBAGENT = "stop_subagent"`（约 :40-47 区域）。
- 该名称加入后，`Object.values(SUBAGENT_TOOL_NAMES)` 自动把 `stop_subagent` 纳入子代理排除列表（子代理不能再调用它）。

### 2. `src/index.ts` — 注册工具
- 定义 `stopSubagentTool`，name = `SUBAGENT_TOOL_NAMES.STOP_SUBAGENT`。
- schema：`id: string`（必填），描述说明 id 来自 `Agent` 工具返回的 agent id。
- execute：
  1. `getRecord(id)` 取记录；不存在 → 返回 `"Unknown subagent id '<id>' in this session."`
  2. `isTopLevelAgent(record)` 校验归属（`src/agent-manager.ts:121-126`）；非 top-level → 返回 `"Subagent '<id>' is owned by another agent."`
  3. `manager.abort(id)`（`src/agent-manager.ts:1470-1489`）
  4. 已 settled（completed/failed/killed/stopped）→ 返回幂等消息，不重复 abort
  5. running/queued → abort 后立即返回，不等待

- 注册与 `SubagentWorkflow` 使用同一 gate：`isSubagentsEnabled()`（或对应 gate），启用时注册，禁用时不注册。
- 加入 collision-withdraw：`decideWorkflowCollision` / 类似机制中把 `stop_subagent` 与 `Agent` 一起隐藏/撤回。

### 3. 文档
- `README.md`：Features 列表加 `stop_subagent` 一行；工具参数表加一行。
- `docs/rpc.md`：说明 `subagents:rpc:stop` 的模型层对应物 `stop_subagent` 工具。
- `CHANGELOG.md` `## [Unreleased]` → `### Added` 加一条简洁条目。

### 4. 测试（TDD）
先写失败测试（RED），再实现（GREEN）。

测试文件：`test/stop-subagent-tool.test.ts`（新建）。覆盖：
- 工具注册、名称、schema
- 对不存在的 id 返回 unknown 消息
- running 状态调用后 `manager.abort` 被调用一次
- settled 状态调用后幂等返回，不重复 abort
- 非 top-level agent 返回归属错误
- `SUBAGENT_TOOL_NAMES` 包含 `STOP_SUBAGENT`，子代理排除列表自动扩展

Mutation check：逐条破坏实现行（`manager.abort` 调用、unknown 消息、settled 幂等判断），确认测试变红，再还原。

### 5. 验证命令
```bash
npx vitest run test/stop-subagent-tool.test.ts
npm run check
```
`npm run test:e2e`：本变更新增主 agent 模型工具、触及会话路径，需运行。

## DoD（工程师）
- 目标改动已落地；影响面文件清单 = 实际改动文件
- `npx vitest run test/stop-subagent-tool.test.ts` 先 RED 后 GREEN
- `npm run check` 全绿
- `npm run test:e2e` 全绿（触及 workflow/session 路径）
- 文档三处（README / rpc.md / CHANGELOG）已更新
- 未 commit / push / 改 Agents.md

## 汇报
- 只汇报已实际执行且拿到输出的操作
- 贴 `npx vitest run` RED 失败输出、GREEN 通过输出
- 贴 `npm run check` 和 `npm run test:e2e` 退出码
- 对照 DoD 逐条 ✅/❌
