# Workflow DAG 调度原语 Spec

## 问题
当前 workflow 脚本 API 只有 `parallel()`（全并发有屏障）和 `pipeline()`（无屏障分阶段），无法表达"任务 B 依赖任务 A"的有向无环图（DAG）调度。需要一个原语让脚本作者声明节点 + 依赖边，运行时按拓扑序调度，无依赖的节点自动并发。

## 目标
新增 `dag(nodes)` 脚本原语：
- 节点是 `{ prompt, deps?, label? }`
- `deps` 是该节点的前置依赖节点 id 列表
- 运行时做拓扑排序，无依赖的节点并发执行（受 `concurrency` 上限约束）
- 某节点 `agent()` 失败 → 所有传递依赖它的节点全部跳过
- 返回所有节点的结果 map

## API 设计

```js
const result = await dag({
  nodes: {
    research:  { prompt: "Research the feature" },
    design:    { prompt: "Design based on research", deps: ["research"] },
    implement: { prompt: "Implement the design",  deps: ["design"] },
    test:      { prompt: "Write and run tests",  deps: ["implement"] },
    docs:      { prompt: "Update documentation", deps: ["implement"] },
  }
});
// result: {
//   research: { ok: true, text: "..." },
//   design:   { ok: true, text: "..." },
//   implement:{ ok: true, text: "..." },
//   test:     { ok: true, text: "..." },
//   docs:     { ok: false, skipped: true, reason: "dependency failed" }
// }
```

## 实现要点

### `src/workflow/worker-source.ts`
- 在 sandbox 全局变量中注入 `dag` 函数
- 实现：
  1. 对 `nodes` 做拓扑排序（Kahn's algorithm），检测环 → 报错
  2. 维护一个 `completed` set；每轮调度：找出所有 `deps` 全部在 `completed` 中的节点，并发执行（受 `concurrency` 上限）
  3. 某节点 `agent()` 返回失败（`!result.ok`）→ 把该节点及其所有传递后继标记为 `skipped`
  4. 返回 `{ [nodeId]: { ok, text, skipped?, reason? } }`

### 文档
- `README.md`：功能列表加 `dag()` 一行
- `docs/workflows.md`：`dag()` 章节 + 示例
- `CHANGELOG.md` `## [Unreleased]` → `### Added`

### 测试（TDD）
`test/workflow-dag.test.ts`（新文件）：
- 线性 DAG（A→B→C）：按序执行
- 分叉 DAG（C 完成后 D、E 并发）
- 环检测：`A→B→A` 报错
- 失败传播：B 失败 → 依赖 B 的所有后继跳过
- 空 nodes：返回空 map
- mutation check：把"传递依赖跳过"逻辑破坏，确认测试变红

### 验证
- `npx vitest run test/workflow-dag.test.ts`
- `npm run check`
- `npm run test:e2e`

## DoD（工程师）
- `dag` 在 sandbox 中可用
- 拓扑排序 + 并发调度 + 失败传播有测试覆盖
- 环检测有测试
- `npm run check` 绿
- `npm run test:e2e` 绿
- 文档三处已更新
- 未 commit / push / 改 Agents.md

## 注意
- 本 spec 单独一个 pipeline 执行，与 `chain()`（上一批次）分开 commit
- 不修改 `pipeline()` / `parallel()` 现有行为
