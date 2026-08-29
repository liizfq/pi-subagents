# Spec: P3 — subagent 卡死检测（规则层 + 可选 AI 研判）

约束文档：`pi-workflow-plugin-fix-analysis.md`（P2 观测性）+ 用户对方案的确认（两档：规则 30s / AI 研判按需）。

**问题：** workflow 的 run 级 watchdog 已改为"有 in-flight agent 永不判 idle"（修了深读误杀），代价是真卡死的 agent 无人管。卡死有两种：
1. **无活动型**：agent 完全没有事件（LLM 请求挂起、流中断）——由 `lastActivityAt` 超时兜底（本切片一起做）。
2. **伪活动型**：agent 在无意义重复/等待（反复同参数调同一工具、反复失败重试、无产出空转）——本切片核心，需检测**工作内容模式**而非活动有无。

**本切片做：**
- 规则层（纯本地，零 token）：agent 层活动窗口 + 周期检测 + 状态机（healthy → suspicious → stuck → abort）。
- AI 研判层（可选，`rules+ai`）：规则层持续可疑时，用便宜模型一次性裁决；同 agent 两次研判至少间隔 10min。
- 无活动型兜底：`lastActivityAt` 超时（归入同一检测器，规则层即可覆盖）。
- 接线：settings + `AgentRecord.stuckState` + workflow 侧感知（卡死 abort 后 agent() 返回失败，现有路径）。

**明确不做：** 不做 tool 粒度 waiting_tool 独立状态；不改 tool schema；不给 workflow 脚本加新全局；不在 workflow runtime 重复规则（检测在 agent 层，workflow 只消费结果）。

---

## 检测信号（在 `runAgent` 闭包内收集，已有事件流）

`runAgent` 已 `session.subscribe(...)`，在回调里追加采样：

| 事件 | 采样 |
|------|------|
| `tool_execution_start` | 记 `(toolName, argsHash)` 进活动窗口 |
| `tool_execution_end` | 记 `isError` 到对应条目 |
| `message_update`（text_delta） | 累积文本长度（有产出 = 活着） |
| `turn_end` | 记 turn 数 |

## 规则（每 `stuckRuleIntervalMs`=30s 评估一次窗口）

一个滑动窗口（最近 `stuckRepeatThreshold` 次 tool 调用 或 `stuckWindowMs` 时长内的调用）：

1. **重复调用**：同一 `(toolName, argsHash)` 出现 ≥ `stuckRepeatThreshold`（默认 5）次，且窗口内没有其他不同参数的调用 → 可疑。
2. **失败循环**：同一 `toolName` 连续 `isError` ≥ 阈值 → 可疑。
3. **无产出空转**：`textDelta` 不增长 且 无 tool 调用完成 超过 `stuckWindowMs` → 可疑（覆盖"等待工作"与无活动型）。
4. **无活动型**：`Date.now() - lastActivityAt > stuckWindowMs` 且窗口无任何事件 → 可疑（覆盖完全无事件）。

**参数哈希**：`args` 序列化为稳定字符串再 hash（`node:crypto` `createHash`）。不同参数的同名工具调用**不算**重复。

## 状态机

```
healthy ──(窗口判定可疑)──> suspicious ──(连续 stuckGraceWindows 个窗口仍可疑)──> stuck ──> session.abort()
```

- 每周期：窗口无违规 → 回 `healthy`（重置计数）。窗口可疑 → `suspicious` 计数 +1。
- `suspicious` 计数 ≥ `stuckGraceWindows`（默认 3，即约 90s）→ `stuck`。
- `stuck`：`session.abort()`；`runAgent` 已设置 `aborted=true` 的机制参照 maxTurns 硬限路径——但这里要在 abort 前先 `session.steer("...wrap up...")` 一次（grace，类比 maxTurns 的 softLimit），steer 后仍无进展才硬 abort。
- abort 后：record.status="aborted" → workflow host `toSpawnResult` → `{ok:false, error}` → 脚本 `agent()` 得 `null`（可 catch/重试）。**现有路径，不加新机制。**

## AI 研判层（`stuckDetection: "rules+ai"`，默认 `"rules"` 关闭）

- 触发：规则层 `suspicious` 且 `stuckAiLastAt` 距今 ≥ `stuckAiIntervalMs`（默认 600_000=10min）。
- 执行：`ctx.modelRegistry.complete(model, { systemPrompt, messages:[{role:"user",content:活动窗口摘要}] })`，模型 = `resolveModel(stuckAiModel, registry)`（默认 `deepseek-v4-flash`，本地有）。摘要 = 最近 tool 序列 + 输出片段 + turn 数。
- 裁决：回复解析出 `stuck: true|false`（提示词要求 JSON）。`true` → 直接 `stuck`（跳过剩余 grace）；`false` → 回 `healthy`。
- 超时：AI 调用自身 15s 超时（`AbortSignal.timeout`），失败按"仍 suspicious"处理（不误杀）。
- 冷却：`stuckAiLastAt` 每次调用后更新；同一 agent 至少 10min 一次。

## 配置（`SubagentsSettings` + `/agents → Settings`）

```ts
stuckDetection: "rules" | "rules+ai"  // 默认 "rules"
stuckRuleIntervalMs: number           // 默认 30_000
stuckRepeatThreshold: number          // 默认 5
stuckGraceWindows: number             // 默认 3
stuckAiModel: string                  // 默认 "deepseek-v4-flash"
stuckAiIntervalMs: number             // 默认 600_000
```

沿用现有 settings 模式：`SubagentsSettings` 字段 + `sanitize` 校验 + `applySettings` + `SettingsAppliers` + `/agents` 菜单项。

## 落点

| 文件 | 改动 |
|------|------|
| `src/agent-runner.ts` | `runAgent` 内：活动窗口采样、周期检测器、状态机、steer-then-abort；`RunOptions` 加 stuck 配置；检测器抽象为可测纯函数 |
| `src/agent-manager.ts` | `SpawnOptions` 透传 stuck 配置；`AgentRecord.stuckState` 写入 |
| `src/types.ts` | `AgentRecord.stuckState?: "suspicious"\|"stuck"` |
| `src/settings.ts` | 新字段 + sanitize + applySettings + appliers |
| `src/index.ts` | `/agents` Settings 菜单项 + setter |
| `src/workflow/host.ts` | `toSpawnResult` 把 `stuck` 原因并入 error（不新增机制） |
| 测试 + `docs/` + `README.md` + `CHANGELOG.md` | 同步 |

**检测器必须可单测**：把"窗口 + 判定"抽成纯函数（输入采样序列 → 输出状态迁移），`runAgent` 只负责喂事件和读状态。这样规则测试不需要真实 session。

## DoD

- 规则层：同参数重复 ≥5 次 → suspicious；连续 3 窗口 → stuck → abort → workflow 收到失败。
- 合法循环（不同参数的同名工具调用）不误杀。
- AI 层：`rules+ai` 时 suspicious 触发一次 AI 调用；10min 冷却生效；AI 说 not stuck 则回 healthy。
- `npm run check` 绿。

## 验证

```bash
npx vitest run test/agent-runner.test.ts test/agent-manager.test.ts
npm run check
```
