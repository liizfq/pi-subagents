# Spec: workflow runtime 终态收敛 + watchdog（P0）

约束文档：`pi-workflow-plugin-fix-analysis.md`（只读分析，已核实源码）。
贡献者规范：根目录 `Agents.md`。
验收 gate：**abort 后 30s 内有终态记录 + 通知**。未满足 = 未完成。

本切片只做分析文档的 **P0-1 … P0-4**。P1 / P2 明确不做。

---

## 根因（已核实，不要再开题）

`src/workflow/runtime.ts` `onAbort()` → `finish({status:"killed"})` → `worker.terminate()` 硬杀脚本 worker。

- 脚本 `try/finally` 救不了 terminate（不走 JS 异常路径）。
- 终态必须由 **runtime 层**落盘；脚本层只是配套。
- `lastProgressAt` 已存在于 `src/workflow/progress.ts`，无消费者做 idle 判定。
- 调用方 `src/index.ts` `runWorkflowTask` 在 `await runWorkflow` 之后才 `notifyWorkflowFinished`。runtime 自己不 persist。

分析文档写的 `src/workflow/runtime.worker.ts` **不存在**。worker 源是内联字符串 `src/workflow/worker-source.ts`（`WORKER_SOURCE`）。abort-notice 改这里。

---

## 目标行为

### P0-1 `finish()` 落盘运行状态（不依赖脚本）

`finish()` 在 settle 之前把 summary 交给调用方（或可选路径）。建议形状：

```ts
{
  status: "completed" | "failed" | "killed",
  error?: string,
  finishedAt: string, // ISO, 由调用方/host 打戳；runtime 自身不要 Date.now() 进脚本 journal 语义
  agentCount: number,
  replayedCount: number,
  lastAgent?: { index, label, state },
  progress: /* filter state !== "start" 的精简副本，避免把整段 start 噪音写入 */
}
```

架构约束（必须遵守，分析文档的 `persistRunSummary(path)` 按本仓库现有模式落地）：

- `runtime.ts` **继续不直接做文件系统 IO**（journal 已是注入 `append`，测试才能无盘）。
- 新增可选 `RunWorkflowOptions.onTerminal?(summary)` 与可选 `persistRunSummary?(summary)`。
- 调用方（`src/index.ts` `runWorkflowTask`）注入：把 summary 写到与 journal 同级的 `<runId>.run-status.json`（session task dir，已有 `journalPath` 的目录）。**未注入则不写盘**（分析文档：默认关闭，不改历史调用）。
- 不要发明 `artifacts/runs/<runId>/` 目录，除非调用方已经有这一层；本仓库现有落盘是 session task dir 下的 `wf_*.workflow.js` / `wf_*.workflow.jsonl`。

### P0-2 abort 两段式（先通知后硬杀）

`onAbort()`：

1. `aborted = true`
2. `host.abortAgent` 每个 in-flight
3. `worker.postMessage({ type: "abort-notice" })`
4. 把未完成的 `agent()` 调用以 **可捕获错误** 回给 worker（不要 `respond(ok:true, null)`）。错误须能被脚本顶层 `try/catch` 接到。`parallel()`/`pipeline()` 会吞普通失败为 `null`——abort 必须带 `fatal`（或等价标记），否则脚本当普通 item 失败继续跑。
5. 等待 `abortGraceMs`（默认 5000，`RunWorkflowOptions` 可覆盖）让脚本 `finally` / `__onWorkflowAbort` 有机会 `complete`
6. 再 `worker.terminate()`

Worker（`worker-source.ts`）：

- `port.on("message")` 现只处理 `type === "response"`。增加 `abort-notice`。
- 若脚本全局存在 `__onWorkflowAbort`，调用它。
- 把挂起的 `callHost` reject 成可捕获的 abort 错误。
- **已经 aborted 的 signal**（worker 尚未跑脚本）：保持立即 `killed`，不要走 grace。现有测试 `settles immediately when the signal is already aborted` 必须继续绿。
- **同步死循环** `for (;;)`：grace 到期仍 terminate。现有测试 `settles a script that never yields` 必须继续绿（它就是 terminate 存在的理由，见 `worker-source.ts` 文件头）。

`finish()` 在 grace 窗口内若已 `settled`，不得二次 terminate/resolve。

### P0-3 watchdog + stuck 检测

`runWorkflow()` 内 `setInterval`（默认 30s，测试可注入更短）：

| 阈值 | 默认 | 行为 |
|------|------|------|
| idle warn | 3min | emit `run_status` `idle_warning` |
| idle stalled | 10min | emit `run_status` `stalled` + `options.onStalled?.(info)`；**不**自动 kill |
| phase timeout | `options.phaseTimeoutMs ?? 30min` | `finish({ status: "killed", error: "Phase timed out after …ms idle." })` |

空闲时钟读已有 `lastProgressAt`（last-write-wins）。`finish()` 必须 `clearInterval`。

**`progress.ts` 新事件类型必须接入 collapse，禁止掉进 phase 分支。** 今日 `collapse()`：

```
if workflow_agent → map
else if workflow_log → logs
else → phaseTitles.set(entry.index, entry.title)
```

未识别的 `run_status` 会当 phase 写进 `phaseTitles`，UI 分组会坏。新增：

```ts
export interface WorkflowRunStatusEntry {
  type: "run_status";
  state: "idle_warning" | "stalled";
  idleMs: number;
}
```

`WorkflowEntry` 联合类型加上它。`collapse()` ignore 或另存，**绝不**当 phase。

`WorkflowRunResult.status` **不要**增加 `stalled`（stalled 是进行中告警；超时才 `killed`）。`AttemptReason` 已有 `"stalled"`，不要混用。

渲染：`src/ui/workflow-card.ts`、`src/ui/workflow-dialog.ts` 凡 `switch (entry.type)` / 假设只有三种 type 的地方，必须容忍 `run_status`（至少不抛）。能显示一行 log 最好，没有现成 UI 也不要为此新做 inspector。补 `test/workflow-progress.test.ts` 与相关 render 测试。

所有阈值经 `RunWorkflowOptions` 可覆盖，便于单测用几十毫秒，而不是真等 10 分钟。

### P0-4 终态通知

`finish()` 是唯一出口，在此调 `onTerminal`。`killed` / `failed` 与 `completed` 同级，禁止无声消失。

调用方把 `onTerminal` / `onStalled` 接到现有通知通道（`notifyWorkflowFinished` / `scheduleNudge` / fleet+widget update）。stalled 是非终态：更新 UI + 通知，不 `completeWorkflowTask`。

`formatWorkflowNotification` 对 killed/failed 至少带：workflow 名、runId、status、error、duration、last agent label。resume 提示沿用现有 `resumeFromRunId` 文案即可，不要新发明命令。

---

## 明确不做（P1 / P2 / 分析文档里的脚本侧示例）

- 不改用户的 `.pi/workflows/rev-*.js` / work-team（不在本仓库）。
- 不引入独立 TMPDIR / emulator 锁 / session↔workflow 映射（P1-1）。
- 不把 `runPhase()` 示例推进本仓库的 `examples/workflows/`，除非实现时发现 runtime 缺全局才能让脚本收敛——若缺，只加 runtime 钩子（`__onWorkflowAbort`），不写用户脚本。
- 不做 60s heartbeat、pending-tool 监控、占位 gate 契约（P2）。
- 不把 `worker.terminate()` 删掉；grace 到期仍硬杀。
- 不破坏 Claude Code 脚本兼容：新全局必须是可选的；没写 `__onWorkflowAbort` 的脚本只是收不到回调，abort 仍 killed。
- 不覆盖 `Agents.md`。不 commit。

---

## 文件清单（只动这些，除非测试/类型强迫多改一处调用）

| 文件 | 改动 |
|------|------|
| `src/workflow/runtime.ts` | `RunWorkflowOptions` 扩展；`finish()` 调 onTerminal/persist；onAbort 两段式；watchdog |
| `src/workflow/worker-source.ts` | abort-notice；挂起 call reject；可选 `__onWorkflowAbort` |
| `src/workflow/progress.ts` | `WorkflowRunStatusEntry`；`collapse()` 正确处理 |
| `src/workflow/journal.ts` | 仅当终态段有现成注入点；没有 roundfile 路径就不要为它新开 IO 概念 |
| `src/workflow/task.ts` | 通知文案；如需把 stalled 反映到 task 但不改 `WorkflowRunResult.status` |
| `src/index.ts` | `runWorkflowTask` 注入 persist 路径、onTerminal、onStalled |
| `src/ui/workflow-card.ts` / `workflow-dialog.ts` | 不因新 type 崩溃 |
| `test/workflow-runtime.test.ts` | abort grace、persist/onTerminal、watchdog（短阈值） |
| `test/workflow-progress.test.ts` | run_status 不污染 phase 分组 |
| 相关 render 测试 | 新 type 不炸 |
| `docs/workflows.md` | abort / 终态文件 / stalled 告警 |
| `README.md` | 仅当用户可见行为进入功能列表时 |
| `CHANGELOG.md` | 只追加 `## [Unreleased]` → `### Fixed`（或 Added，若算新能力）。一条 bullet。 |

---

## TDD 顺序（必须）

先写失败测试，再最小实现。至少覆盖：

1. **abort 终态回调：** 跑中的 `await agent()` 被 abort → `onTerminal` 收到 `{status:"killed"}`；若注入了 `persistRunSummary`，它被调用且 payload 含 status/error/agentCount。现有 “terminates the run and aborts every in-flight child” 仍绿。
2. **grace 窗口：** 注入 `abortGraceMs`（例如 80–200ms）。脚本顶层 catch/finally 在窗口内 `return` 仍使 run settle 为 `killed`（不要 completed）。同步 `for (;;)` 在 grace 后仍 `killed`，CPU 不再空转（沿用现有断言）。
3. **abort 传播为错误：** worker 内 `await agent()` 在 abort 时 reject，而不是 resolve `null`。用短脚本 `try { await agent("hang") } catch (e) { return { caught: true } }` 证明 catch 能跑到（grace 足够）。
4. **已 aborted 的 signal：** 立即 killed，0 次 spawn（现有测试）。
5. **watchdog：** 阈值缩到毫秒级。无进度 → 先 `idle_warning` 再 `stalled`（`onStalled` 被调），再 `phaseTimeoutMs` → killed。`finish` 后 interval 不再 tick（可用计数器/假时钟，或 abort 后再等一个 interval 确认无新 emit）。
6. **collapse：** `run_status` 条目不进入 `phaseTitles`，`buildPhaseGroups` 不把它当 phase。

Mutation-check：每条新断言改一行源码确认变红，再还原。汇报里写你打破了哪一行。

跑测试：

```bash
npx vitest run test/workflow-runtime.test.ts
npx vitest run test/workflow-progress.test.ts
# 若动了 UI type 切换:
npx vitest run test/workflow-render.test.ts test/workflow-dialog.test.ts
npm run check
```

不要跑 `npm run bench`。`npm run build` 只在验证员需要产物时。

---

## 兼容性

- 新回调全可选（`options.x?.()`）。
- 不注入 persist → 不写盘。
- watchdog 默认值可覆盖。
- `worker.terminate()` 仍是兜底。
- 不保后向兼容的产品承诺（`Agents.md`：用户没要求就不保）；但可选回调 + 默认不写盘，是为了不让现有 `runWorkflow({script, host})` 测试全炸。
- 公开工具 schema（`SubagentWorkflow` 参数）尽量不改。新能力是 runtime/host 行为，不是新 tool 参数。

---

## 文档

- `docs/workflows.md`：abort 后会有终态；run-status 文件与 journal 同目录；stalled 是告警不是完成。
- `README.md`：只在功能列表需要反映“killed 必通知 / idle 告警”时改一句。
- `CHANGELOG.md` `[Unreleased]` 一条，简洁，禁止复述调查过程。
