# 插件源码分析：workflow 终态 + watchdog 改进方案（pi-subagents）

> 状态：**只读分析 + 建议**，尚未修改插件源码（本次会话不执行修复）。
> 源码位置：`~/.pi/agent/git/github.com/tintinweb/pi-subagents/src/workflow/runtime.ts`
> 触发事件：2026-08-27 两条并行 workflow（dex-repair / x86cracker-b）于 01:35 被 abort 后，6+ 小时无任何反馈；经 workflow_reviewer 审计确认是"被 abort 但无终态收敛"。

## 一、现状分析（已核实源码）

### 1. runtime 已有 abort 框架，但缺"脚本内终态收敛 + 反馈"

`runtime.ts` 现状（已读源码确认）：

| 机制 | 现状 | 代码位置 |
|------|------|---------|
| 运行状态机 | 有 `status: "completed" \| "failed" \| "killed"` | `WorkflowRunResult` (L313) |
| Abort 信号 | 有 `onAbort()` → `finish({status:"killed"})` | L765-770 |
| 中止子 agent | `host.abortAgent(agentId)` | L756, L695/703 |
| **worker 终止** | **`worker.terminate()` 硬杀** | L768 |
| 心跳/最后活动 | 有 `lastProgressAt` 字段（progress.ts） | progress.ts L98 |
| 阶段/agent 超时 | **无** | — |
| stuck 检测 | **无**（无 idle 上限判定） | — |
| 运行时状态落盘 | **无**（只有内存 progress） | — |
| 完成/失败/中止通知 | **无**（靠调用方 await 返回值） | — |

### 2. 根因链（为什么 abort 后 6 小时无反馈）

```
用户/外部 abort
  └─ onAbort() 触发
       ├─ aborted = true
       ├─ host.abortAgent(每个 in-flight agent)   ← 子 agent 收到 "This operation was aborted"
       └─ finish({status:"killed"})
            └─ worker.terminate()                  ← 硬杀脚本 worker
                 └─ 脚本（rev-*.js）正在 await agent()
                      ├─ 无顶层 try/finally 能兜底（terminate 是硬杀，不是抛异常）
                      ├─ 后续 Verify/Debug/Audit/return/report 全部不会执行
                      └─ roundfile 停在 planner 段（01/02），无任何终态记录
```

**关键结论**：`worker.terminate()` 是硬杀——脚本里即使写 `try/catch/finally` 也救不了，因为 terminate 不触发 JS 异常路径。必须让 **runtime 层**（而非脚本层）负责终态收敛。

次要缺陷：
- runtime 虽然 resolve 了 `{status:"killed"}`，但**谁消费这个返回值**取决于调用方（SubagentWorkflow 工具/主 agent）；若主 agent 本身也挂了/等待超时，通知就断了。
- 无阶段级/agent 级 timeout：一个 `await agent()` 永远不返回，run 就永远挂着，无人判定 stalled。
- `lastProgressAt` 已存在但**没有任何消费者**去做 idle 判定。

### 3. 脚本侧问题（rev-*.js 与 work-team）

- 所有 `await agent(...)` 直接裸 await，无 `runPhase()` 包装、无状态机。
- 顶层无 `try/catch/finally` 把异常/abort 收敛成终态对象。
- 报告落盘依赖 agent 主动 `cat >>`——abort 时 agent 已死，报告必然缺失。

## 二、修改建议（P0/P1/P2，按优先级）

### P0-1：runtime 层 `finish()` 落盘运行状态（不依赖脚本）

`runtime.ts` 的 `finish()` 里，在 resolve 前把 `progress + status + error` 序列化落盘。建议写到脚本可约定共享的位置：

```ts
// finish() 内（settle 之前）
const summary = {
  status: result.status,           // completed | failed | killed
  error: result.error,
  finishedAt: new Date().toISOString(),
  agentCount, replayedCount,
  // 从 progress 提取"最后活动 agent + 最后 tool 调用"做诊断
  lastAgent: lastNonSettled(progress),
  progress: progress.filter(e => e.state !== "start"),
};
await persistRunSummary(options.runStatusPath, summary); // 新增 RunWorkflowOptions.runStatusPath
```

- `runStatusPath` 由调用方（SubagentWorkflow 工具）注入，例如 `artifacts/runs/<runId>/run-status.json`。
- 这样即使脚本 worker 被杀，运行状态也已落盘，可追溯。
- **WorkflowRunResult 增加 `killed` 时强制写入 roundfile 兼容段**（若调用方能拿到 roundfile 路径）：`## runtime · terminal` 段。

### P0-2：abort 时不立即硬杀，给脚本一个收敛窗口

`onAbort()` 改为两段式：

```ts
function onAbort() {
  aborted = true;
  // 1) 先通知脚本（worker 内注入 abort 事件），给 finally 一个机会
  worker.postMessage({ type: "abort-notice" });
  // 2) 等待脚本收敛（如 5s），再硬杀
  const grace = setTimeout(() => terminateWorker(), ABORT_GRACE_MS /* 5000 */);
}
```

worker 侧（`runtime.worker.ts` 或脚本包装层）：
- 收到 `abort-notice` 后，若脚本存在全局 `__onWorkflowAbort` 回调则调用；
- 或把 abort 转成 worker 内可捕获的信号，让 `await agent()` reject（抛 `WorkflowAbortError`），这样脚本顶层 `try/catch/finally` 就能兜住并写终态报告。

> 注意：当前 `await agent()` 在 abort 时是 `respond(callId,true,null)`（脚本收到 null，继续跑），不是 reject——所以光靠脚本 try/catch 也接不住。需要让 abort 传播为可捕获错误。

### P0-3：timeout + watchdog + stuck 检测（利用已有 lastProgressAt）

`runWorkflow()` 内新增一个 watchdog 定时器：

```ts
const IDLE_WARN_MS = 3 * 60_000;     // 3min 无活动 → warning
const IDLE_STALLED_MS = 10 * 60_000; // 10min → stalled
const PHASE_TIMEOUT_MS = options.phaseTimeoutMs ?? 30 * 60_000;

const watchdog = setInterval(() => {
  const now = Date.now();
  const last = lastProgressAt(progress);
  if (now - last > PHASE_TIMEOUT_MS) {
    finish({ status: "killed", error: `Phase timed out after ${PHASE_TIMEOUT_MS}ms idle.` });
  } else if (now - last > IDLE_STALLED_MS) {
    emit([{ type: "run_status", state: "stalled", idleMs: now - last }]);
    options.onStalled?.(summary(progress));   // 通知调用方
  } else if (now - last > IDLE_WARN_MS) {
    emit([{ type: "run_status", state: "idle_warning", idleMs: now - last }]);
  }
}, 30_000); // 每 30s 检查一次
```

- `progress` 里每个 agent 事件已带 `lastProgressAt`，last-write-wins，watchdog 直接读即可，无需新事件源。
- 新增 `RunWorkflowOptions.onStalled?.(info)`，让调用方可弹通知/UI 告警。
- 用 `options.signal` 与主循环协调，`finish()` 时 clearInterval。

### P0-4：强制终态通知（completed / failed / killed / stalled）

- `finish()` 是唯一出口，在此发通知（复用现有 emit / 新增 onTerminal 回调）：
  ```ts
  options.onTerminal?.({
    status, error, runId, durationMs: Date.now() - startedAt,
    lastAgentLabel, reportPath, resumeHint: `SubagentWorkflow resumeFromRunId=...`,
  });
  ```
- 通知内容至少：workflow 名、runId、状态、阶段、持续时间、最后活动 agent、报告路径、恢复命令。
- **stalled/killed 必须与 completed 同级**，不能"无声消失"。

### P1-1：调度层隔离（已在 workflow 侧落地，插件补充）

- runId + `artifacts/runs/<runId>/tmp`（独立 TMPDIR，禁止裸 `/tmp`）。
- 设备/emulator 按 serial 加锁（防并行流互相破坏验证）。
- session↔workflow 映射表（本次出现 dex 会话跑 x86 脚本的串流）。

### P1-2：脚本侧统一 `runPhase()` 包装（示例，供 rev-*.js 引用）

```js
async function runPhase({ runId, phase, label, timeoutMs, fn }) {
  emitProgress({ runId, type: "phase_started", phase, label });
  try {
    const r = await Promise.race([fn(), timeout(timeoutMs, `${phase}/${label}`)]);
    emitProgress({ runId, type: "phase_finished", phase, label });
    return { state: "completed", result: r };
  } catch (e) {
    const outcome = { state: isAbort(e) ? "aborted" : "failed", phase, label, error: String(e) };
    emitProgress({ runId, type: "phase_terminal", ...outcome });
    throw new WorkflowPhaseError(outcome);   // 顶层 finally 收敛
  }
}
```

脚本顶层统一：

```js
try {
  ...全流程...
  return { ok: true, ... }
} catch (e) {
  return { ok: false, state: e?.outcome?.state ?? "failed", ... }
} finally {
  await persistTerminal({ runId, roundfile: RF, state, lastPhase, lastToolCall }); // 尽力而为
}
```

### P2：可观测性增强

- heartbeat 每 60s（UI/日志/状态文件）——显示"等待哪个 tool"，而非假装活着。
- pending tool 监控：某 tool 调用超过其 timeout → 显示 waiting_tool。
- 占位 gate（如 `<新增或修正的校验入口>`）改为 preflight 可验证契约（SavePlan 后立即解析成真实命令）。

## 三、落地文件清单（下次会话执行）

| 文件 | 改动 |
|------|------|
| `src/workflow/runtime.ts` | finish() 落盘 run-status；onAbort 两段式（先通知后硬杀）；watchdog 定时器；onTerminal/onStalled 回调；RunWorkflowOptions 扩展（runStatusPath/phaseTimeoutMs/onTerminal/onStalled/abortGraceMs） |
| `src/workflow/runtime.worker.ts`（或对应 worker 包装） | abort-notice 处理；让 abort 传播为可捕获 WorkflowAbortError；脚本全局 abort 回调 |
| `src/workflow/progress.ts` | run_status 事件类型（idle_warning/stalled） |
| `src/workflow/journal.ts` | 终态段写入（若 roundfile 路径可注入） |
| 调用方（SubagentWorkflow 工具入口） | 注入 runStatusPath/runId；把 WorkflowRunResult 的 killed/failed 转成用户可见通知 |
| `.pi/workflows/rev-*.js` + work-team | 顶层 try/catch/finally；runPhase 包装；roundfile 由 runner 落盘终态段（不依赖 agent） |

## 四、风险与兼容性

- `worker.terminate()` 改两段式后，脚本若在 grace 窗口内挂死，仍需硬杀兜底（超时强制）。
- 新增回调都是可选（`options.x?.()`），不破坏现有调用方。
- 状态落盘路径默认关闭（仅在调用方注入 runStatusPath 时启用），避免所有历史调用行为改变。
- watchdog 默认值可通过 RunWorkflowOptions 覆盖，兼容短任务。

## 五、本次会话结论

- 已核实：`abort → finish(killed) → worker.terminate()` 是根因——硬杀使脚本终态/报告全部丢失，且无任何通知。
- **修复必须发生在 runtime 层**（脚本层 try/finally 对 terminate 无效），配套脚本层 runPhase + 顶层收敛。
- 本会话**不修改插件源码**，仅此分析落盘；下次会话派 coder 按上表实施，并以"abort 后 30s 内有终态记录 + 通知"为验收 gate。
