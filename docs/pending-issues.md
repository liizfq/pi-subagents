# 待修复问题清单（未修复）

记录日期：2026-09-02。由 pipeline-9 代码评审与安全评审发现，先落盘，不立即修复。

## MEDIUM（代码评审）

### M1 — `finish()` lastAgent 正向扫描误报已收敛 agent
- **位置：** `src/workflow/runtime.ts`（`finish()`，约 L956-960）
- **问题：** 正向遍历 progress 日志，命中同一 agent 的旧 `start`/`progress` 条目，导致已完成/已收敛的 agent 被误报为"最后未收敛"。
- **修复方向：** 改用与 `waitingAgentLabel`（runtime.ts:624-633）相同的反向遍历语义——只取每个 index 的最新条目；只有最新状态为 `start`/`progress` 才算未收敛。

### M2 — 全量并行跑时 watchdog 测试 flaky
- **位置：** `test/workflow-runtime.test.ts:1075-1092`（"does not flag a suspicious in-flight agent as an ordinary workflow stall"）
- **问题：** `agent()` 在 worker 线程发起，progress 日志的 `start` 条目要等主线程 `handleAgent` 处理 `agent-call` 消息才写入。在"脚本已发起 agent 调用但日志尚未记录"的窗口内，idle 时钟在走；CPU 负载下该窗口可超过测试的 `idleWarnMs=30ms`，误发 `idle_warning`。
- **修复方向（实现侧）：** worker 侧上报 pending agent 调用，运行时据此暂停 idle 时钟；测试侧修法（在 `await running` 后清空 `statuses`）会掩盖实现缺口，不推荐。

### M3 — Agent 名称冲突撤回列表不完整
- **位置：** `src/index.ts:2781`
- **问题：** `resolveAgentCollisions` 只撤回 `stop_subagent`，但 `steer_subagent`（index.ts:2871）与 `get_subagent_result`（index.ts:2960）同样是孤儿工具，`Agent` 被外部扩展抢占后它们也无从调用。
- **修复方向：** 把 `STEER`、`GET_RESULT` 一并加入撤回列表，或在注释/文档中说明保留原因。

## CRITICAL（安全评审）

### S1 — `meta` 沙箱逃逸
- **位置：** `src/workflow/meta.ts:240-250`
- **问题：** `new Script(...).runInContext(createContext({}))` 的空上下文仍可通过 `this.constructor.constructor("require")` 拿到宿主 `require`，恶意 workflow 可在 `extractMeta` 阶段读写文件系统或执行 `child_process`。该代码在宿主线程运行，早于 worker 沙箱启动。
- **修复方向：** 用真正的 JS 解析器（AST 白名单）替代 `vm.Script.runInContext`；或在 `createContext` 中锁定 `globalThis.constructor` 链。

## MEDIUM（安全评审）

### S2 — `scriptPath` 信任边界
- **位置：** `src/workflow/saved.ts:120-135`
- **问题：** `scriptPath` 接受任意绝对路径，无符号链接/安全读取防护，可暴露用户目录下意外文件给 workflow 执行。
- **修复方向：** 若路径应限于项目目录，拒绝 `ctx.cwd` 外路径并沿用 `safeReadFile` 的符号链接策略；若允许用户路径，需显式确认 + 大小/控制字符检查。
