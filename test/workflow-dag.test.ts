/**
 * workflow-dag.test.ts — the `dag()` script primitive.
 *
 * `parallel()` is an all-in barrier, `pipeline()` is a barrier-less per-item
 * stage chain, `chain()` is a strictly-serial short-circuiting path. `dag()`
 * is the directed-acyclic-graph scheduler: nodes declare their prerequisites
 * with `deps`, the runtime topologically sorts and runs ready nodes
 * concurrently (the host's semaphore bounds real concurrency), and a failed
 * node marks all of its transitive dependents `skipped`.
 */
import { describe, expect, it } from "vitest";
import {
  type RunWorkflowOptions,
  runWorkflow,
  type WorkflowHost,
  type WorkflowRunResult,
  type WorkflowSpawnRequest,
  type WorkflowSpawnResult,
} from "../src/workflow/runtime.js";

const HEAD = 'export const meta = { name: "dag-probe", description: "a dag test workflow" };\n';

interface Stub {
  host: WorkflowHost;
  calls: WorkflowSpawnRequest[];
}

/**
 * A host that answers each `agent()` call. `reply` decides the outcome; the
 * default echoes the prompt so a script can assert plumbing.
 */
function stubHost(
  reply?: (request: WorkflowSpawnRequest) => Promise<WorkflowSpawnResult> | WorkflowSpawnResult,
): Stub {
  const calls: WorkflowSpawnRequest[] = [];
  return {
    calls,
    host: {
      spawnAgent(request) {
        calls.push(request);
        return Promise.resolve(reply ? reply(request) : { ok: true, text: `ok:${request.prompt}` });
      },
      abortAgent() {},
    },
  };
}

/**
 * A host that holds each agent for a short delay so independent nodes can be
 * observed overlapping. `peak()` reports the maximum concurrency observed.
 */
function concurrentStub(
  reply?: (request: WorkflowSpawnRequest) => Promise<WorkflowSpawnResult> | WorkflowSpawnResult,
) {
  const calls: WorkflowSpawnRequest[] = [];
  const running = new Set<string>();
  let peak = 0;
  const host: WorkflowHost = {
    spawnAgent(request) {
      calls.push(request);
      running.add(request.prompt);
      if (running.size > peak) peak = running.size;
      return new Promise<WorkflowSpawnResult>(resolve => {
        setTimeout(() => {
          running.delete(request.prompt);
          resolve(reply ? reply(request) : { ok: true, text: `ok:${request.prompt}` });
        }, 20);
      });
    },
    abortAgent() {},
  };
  return { host, calls, peak: () => peak };
}

/** Run `body` as a workflow, with `meta` prepended. */
function run(body: string, options: Omit<RunWorkflowOptions, "script">): Promise<WorkflowRunResult> {
  return runWorkflow({ script: HEAD + body, ...options });
}

describe("dag", () => {
  it("runs a linear DAG strictly in topological order", async () => {
    const { host, calls } = stubHost();
    const result = await run(
      `return await dag({ nodes: {
        a: { prompt: "step-a" },
        b: { prompt: "step-b", deps: ["a"] },
        c: { prompt: "step-c", deps: ["b"] },
      } });`,
      { host },
    );

    expect(result.status).toBe("completed");
    expect(result.value).toEqual({
      a: { ok: true, text: "ok:step-a" },
      b: { ok: true, text: "ok:step-b" },
      c: { ok: true, text: "ok:step-c" },
    });
    // Topological order: the calls land a, then b, then c.
    expect(calls.map((c) => c.prompt)).toEqual(["step-a", "step-b", "step-c"]);
    expect(calls).toHaveLength(3);
  });

  it("runs independent nodes concurrently", async () => {
    const { host, calls, peak } = concurrentStub();
    const result = await run(
      `return await dag({ nodes: {
        c: { prompt: "c" },
        d: { prompt: "d", deps: ["c"] },
        e: { prompt: "e", deps: ["c"] },
      } });`,
      { host },
    );

    expect(result.status).toBe("completed");
    // d and e share the same prerequisite, so the worker fans them out in the
    // same tick; the held stub observes two agents running at once.
    expect(peak()).toBeGreaterThanOrEqual(2);
    expect(result.value).toEqual({
      c: { ok: true, text: "ok:c" },
      d: { ok: true, text: "ok:d" },
      e: { ok: true, text: "ok:e" },
    });
    expect(calls).toHaveLength(3);
  });

  it("detects a dependency cycle and names the nodes in it", async () => {
    const { host } = stubHost();
    const result = await run(
      `return await dag({ nodes: {
        a: { prompt: "a", deps: ["b"] },
        b: { prompt: "b", deps: ["a"] },
      } });`,
      { host },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("cycle");
    expect(result.error).toContain("a");
    expect(result.error).toContain("b");
  });

  it("skips all transitive dependents of a failed node", async () => {
    const { host, calls } = stubHost((req) =>
      req.prompt === "step-b" ? { ok: false, error: "step-b failed" } : { ok: true, text: `ok:${req.prompt}` },
    );
    const result = await run(
      `return await dag({ nodes: {
        a: { prompt: "step-a" },
        b: { prompt: "step-b", deps: ["a"] },
        c: { prompt: "step-c", deps: ["b"] },
        d: { prompt: "step-d", deps: ["c"] },
      } });`,
      { host },
    );

    expect(result.status).toBe("completed");
    expect(result.value).toEqual({
      a: { ok: true, text: "ok:step-a" },
      b: { ok: false, skipped: true, reason: "agent failed" },
      c: { ok: false, skipped: true, reason: "dependency failed" },
      d: { ok: false, skipped: true, reason: "dependency failed" },
    });
    // Only a and b actually ran; c and d were never launched.
    expect(calls.map((c) => c.prompt)).toEqual(["step-a", "step-b"]);
    expect(calls).toHaveLength(2);
  });

  it("returns an empty map for empty nodes", async () => {
    const { host, calls } = stubHost();
    const result = await run(`return await dag({ nodes: {} });`, { host });

    expect(result.status).toBe("completed");
    expect(result.value).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("rejects a node that depends on an unknown node id", async () => {
    const { host } = stubHost();
    const result = await run(
      `return await dag({ nodes: {
        a: { prompt: "a" },
        b: { prompt: "b", deps: ["ghost"] },
      } });`,
      { host },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("unknown node");
  });
});
