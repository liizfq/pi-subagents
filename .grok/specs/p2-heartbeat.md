# Spec: P2 — 可观测性：heartbeat 活性信号（本仓库范围）

约束文档：`pi-workflow-plugin-fix-analysis.md`（P2 前两条）。
已核实：分析文档 P2 的第三条（占位 gate 改 preflight 契约）在用户脚本层（`~/.pi/workflows/rev-*.js`），**不在本仓库**。P2 的 heartbeat / pending-tool 在本仓库可落地的是：**运行时周期 emit 活性信号 + UI 显示"当前在等哪个 agent"**。

P0 已做 watchdog（idle 3min 警告 → 10min stalled → 30min 超时 kill），但那是"异常才出声"。P2 补的是**正常长跑时的活性心跳**：一个 agent 跑很久、没有任何新进度时，用户看到 run 还在、卡在哪个 agent 上，而不是一张静止的卡。

**本切片只做：**
1. `src/workflow/runtime.ts`：新增可选 `heartbeatIntervalMs`（默认 60_000，测试可注入毫秒级；0 或缺省关闭？——**默认开**，因为这是活性信号而非 watchdog 告警）。运行中且未 settle 时，周期 emit `run_status { state: "heartbeat", agentLabel }`，`agentLabel` 取当前 in-flight（progress 里最后一条 `state: start|progress` 的 workflow_agent 的 label）。settle 时 clearInterval。
2. `src/workflow/progress.ts`：`WorkflowRunStatusEntry` 扩展 `state: "idle_warning" | "stalled" | "heartbeat"`，加可选 `agentLabel?: string`。`collapse()` 继续忽略 run_status（不污染 phaseTitles）。
3. UI 可见：
   - `src/ui/workflow-card.ts`：布局时扫描 progress 找最后一条 heartbeat run_status；若 run 仍在跑且 `agentLabel` 存在，在 subtext 行下加一行 `⏳ waiting on <label>`（dim）。运行结束不再显示。
   - `src/ui/workflow-dialog.ts`：同样容忍 + 显示 heartbeat（标题行附近加 `waiting on <label>`），至少不崩。
4. 测试：
   - `test/workflow-runtime.test.ts`：注入 `heartbeatIntervalMs` 毫秒级；跑中的 hang agent 会收到 heartbeat run_status 且 `agentLabel` 正确；settle 后 interval 停止（无新 heartbeat）。
   - `test/workflow-progress.test.ts`：heartbeat entry 不污染 phaseTitles / 不进 logs（沿用现有 run_status 用例组）。
   - `test/workflow-render.test.ts` / `workflow-dialog.test.ts`：card 显示 `waiting on` 行；结束后不显示；dialog 不崩。
5. `docs/workflows.md`：heartbeat 段落（60s 默认、`waiting on <label>`、与 watchdog 的区别）。
6. `CHANGELOG.md` `[Unreleased]` → `### Added` 一条。

**明确不做：** pending-tool 独立 `waiting_tool` 状态（heartbeat 的 `agentLabel` 已覆盖"等待哪个 agent"，不要为 workflow 另造 tool 粒度）；占位 gate preflight（用户脚本层）；改 tool schema；给脚本加新全局。

**DoD：** heartbeat 相关测试绿；`npm run check` 绿；文档/changelog 同改。

**验证：**
```bash
npx vitest run test/workflow-runtime.test.ts test/workflow-progress.test.ts test/workflow-render.test.ts test/workflow-dialog.test.ts
npm run check
```
