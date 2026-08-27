# Spec: P1 — 脚本侧收敛模式（本仓库范围）

约束文档：`pi-workflow-plugin-fix-analysis.md`（P1-2）。
已核实：分析文档的 P1-1（独立 TMPDIR、设备/emulator 锁、session↔workflow 映射）几乎全部在用户脚本层（`~/.pi/workflows/rev-*.js` + work-team），**不在本仓库**；session↔workflow 映射本仓库已具备（`workflowRunId` + session task dir 下的 `wf_*.workflow.js` / `.jsonl` / `.run-status.json`）。P1-2（`runPhase()` 包装示例）本仓库可落地的是：运行时已具备的钩子（P0：abort 传播为可捕获 fatal 错误、`__onWorkflowAbort`、grace 窗口）之上的**参考脚本示例 + 文档**。

**本切片只做：**
1. `examples/workflows/run-phase.js` — 展示 `runPhase()` 包装 + 顶层 `try/catch/finally` + `__onWorkflowAbort` 的参考工作流，供用户 rev-*.js 照抄。它必须能通过 `test/workflow-examples.test.ts`（stub host 跑完，`args` 缺省可容忍）。
2. `docs/workflows.md` 新增"写一个能收敛的脚本"小节：abort 语义（catchable fatal、`__onWorkflowAbort`、grace）、`runPhase` 模式、终态 return。
3. `CHANGELOG.md` `[Unreleased]` → `### Fixed` 一条（或 Added，若算新示例）。

**明确不做：** 不改 `~/.pi/workflows/rev-*.js`（不在本仓库）；不做 P1-1 的 TMPDIR/设备锁；不给运行时加新全局（`__onWorkflowAbort` 已够）；不覆盖 `Agents.md`。

**DoD：** 新示例通过 `workflow-examples.test.ts`（结构 + 执行 + return 形状可加断言）；`npm run check` 绿；文档同改。

**验证：**
```bash
npx vitest run test/workflow-examples.test.ts
npm run check
```
