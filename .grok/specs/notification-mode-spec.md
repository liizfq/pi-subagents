# 监控改为通知模式 + 通知目标可配置 Spec

## 目标
1. Agent 级 `stuckDetection`：stuck 只发 `agent_stuck` 通知，不再自动 abort（条件判断保留，用于生成准确的错误信息）
2. Workflow idle watchdog 的 `killed`（30min）改为通知（`run_status: "killed"`），不再调用 `finish({status:"killed"})`；`idle_warning`/`stalled` 保持现状（已是通知）
3. 新增设置 `stuckNotificationTarget`（或类似名）：允许将通知路由到指定 agent（type 或 id），默认 main agent

## 改动范围

### `src/agent-runner.ts`
- `markStuck()`（约 :1237-1252）：删除 `stuckAbortReason = ...` 和 `aborted = true; session.abort()`，保留 `reportState("stuck")` 和 steer 消息
- 条件判断保留：`detector.evaluate()` 的 `suspicious`/`stuck` 状态判断不变
- 新增 `stuckNotificationTarget` 设置项（string，agent type 或 id）
- 若 `stuckNotificationTarget` 为空 → 通知 main agent（现状）；若指定 → 通过该 agent 的 session 投递

### `src/index.ts`
- `agent_stuck` 的 nudge 投递：当前是 `pi.sendMessage(..., {deliverAs:"followUp", triggerTurn:true})`
- 若 `stuckNotificationTarget` 已设置，改为向目标 agent 的 session 投递（查 `agent-manager.getRecord(target)` 后调用其 session 的 `steer`，或直接通过 `pi.sendMessage` 加 `to` 参数）
- 实际机制：用 `steerAgent(targetId, message)` 或 `manager.steer` 投递给目标 agent

### `src/workflow/runtime.ts`
- `finish({status:"killed"})`（约 :1077）改为：emit `run_status: "killed"` 通知，不终止 run
- `idle_warning`（:1090）和 `stalled`（:1080）保持不变
- 新增 `killed` 的 nudge 在 `src/index.ts` 的 `onProgress` handler 中处理（`run_status: "killed"` 触发 follow-up 通知）

### `src/settings.ts` / 设置
- 新增 `stuckNotificationTarget` 设置项（string，默认空 = main agent）
- 在 `/agents → Settings` 菜单暴露

### 文档
- `README.md`：stuckDetection 段更新为"通知模式，不自动 abort；可用 `stop_subagent` 显式停止"
- `docs/workflows.md`：`killed` 状态说明更新
- `CHANGELOG.md` `## [Unreleased]`：加一条

## 测试（TDD）
- `test/agent-runner.test.ts`：`markStuck` 不再 abort 的断言
- `test/workflow-runtime.test.ts`：`killed` 不再调用 `finish` 的断言
- 新增 `test/stuck-notification-target.test.ts`（或扩展现有测试文件）：`stuckNotificationTarget` 设置时通知投递到目标 agent

## DoD（工程师）
- 改动落地，影响面文件清单 = 实际改动文件
- 相关测试先 RED 后 GREEN
- `npx vitest run <file>.test.ts` 绿
- `npm run check` 绿
- `npm run test:e2e` 绿（触及 workflow 工具/session 路径）
- 文档三处（README / docs/workflows.md / CHANGELOG.md）已更新
- 未 commit / push / 改 Agents.md

## 汇报
- 只汇报已实际执行且拿到输出的操作
- 贴 RED 失败输出、GREEN 通过输出
- 贴 `npm run check` 和 `npm run test:e2e` 退出码
- 对照 DoD 逐条 ✅/❌
