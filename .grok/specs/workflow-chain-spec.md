# 串行链路（chain）Spec

## 问题
当前 `pipeline()` 是无屏障分阶段：一个 item 可以还在 stage 1，另一个 item 已在 stage 2。这对"无依赖的批量流水线"是对的，但对**有上下依赖的串行步骤**不适用——步骤 N 失败后，步骤 N+1..M 不应继续。

## 目标
新增 `chain(steps: string[])` 脚本原语：
- 步骤按顺序执行，**每一步完成后才执行下一步**
- 若某步 `agent()` 返回失败（`ok: false` 或 `null`），**立即停止**，后续步骤跳过
- 返回最终结果（最后一步的 `agent()` 返回值，或失败信息）
- 与 `pipeline()` 的区别：`pipeline` 是并行分阶段，`chain` 是严格串行 + 失败短路

## 实现要点

### `src/workflow/worker-source.ts`
- 在 worker 的 sandbox 全局变量中注入 `chain` 函数
- `chain(steps)` 实现：
  ```js
  async function chain(steps) {
    for (const step of steps) {
      const result = await agent(step);
      if (!result || !result.ok) {
        log(`chain: stopped at step "${step}" — prior step failed.`);
        return { ok: false, failedAt: step };
      }
    }
    return { ok: true };
  }
  ```
- `agent()` 的返回结构：需确认当前 `toSpawnResult` 的返回值形状（`ok` 字段）

### 文档
- `README.md`：`SubagentWorkflow` 功能列表加 `chain()` 一行
- `docs/workflows.md`：加 `chain()` 章节 + 示例
- `CHANGELOG.md` `## [Unreleased]` → `### Added`

### 测试（TDD）
- `test/workflow-runtime.test.ts`（或新增 `test/workflow-chain.test.ts`）：
  - 所有步骤成功 → `chain` 返回 `{ok: true}`
  - 第 2 步失败 → 第 3..N 步跳过，返回 `{ok: false, failedAt: "<step-2>"}`
  - 步骤 1 成功、步骤 2 失败 → 只执行了 2 次 `agent()` 调用
  - 空数组 `chain([])` → 直接 `{ok: true}`
- mutation check：把 `!result.ok` 改成 `result.ok` 确认测试变红

### 验证
- `npx vitest run test/workflow-chain.test.ts`
- `npm run check`
- `npm run test:e2e`（触及 workflow 工具路径）

## DoD（工程师）
- `chain` 在 sandbox 中可用
- 失败短路逻辑有测试覆盖
- `npm run check` 绿
- `npm run test:e2e` 绿
- 文档三处已更新
- 未 commit / push / 改 Agents.md
