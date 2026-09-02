/**
 * workflow-chain.test.ts — the `chain()` script primitive.
 *
 * `pipeline()` is the barrier-less, per-item fan-out. `chain()` is the
 * strictly-serial, failure-short-circuiting path: step N+1 runs only after
 * step N completes, and the first failed step stops the chain.
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

const HEAD = 'export const meta = { name: "probe", description: "a test workflow" };\n';

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

/** Run `body` as a workflow, with `meta` prepended. */
function run(body: string, options: Omit<RunWorkflowOptions, "script">): Promise<WorkflowRunResult> {
  return runWorkflow({ script: HEAD + body, ...options });
}

describe("chain", () => {
  it("runs every step strictly in order and returns {ok: true}", async () => {
    const { host, calls } = stubHost();
    const result = await run('return await chain(["step-1", "step-2", "step-3"]);', { host });

    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ ok: true });
    // Strictly serial: the calls land in the given order.
    expect(calls.map((c) => c.prompt)).toEqual(["step-1", "step-2", "step-3"]);
    expect(calls).toHaveLength(3);
  });

  it("short-circuits at the first failed step and names it", async () => {
    const { host, calls } = stubHost((req) =>
      req.prompt === "step-2"
        ? { ok: false, error: "step-2 failed" }
        : { ok: true, text: `ok:${req.prompt}` },
    );
    const result = await run('return await chain(["step-1", "step-2", "step-3", "step-4"]);', { host });

    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ ok: false, failedAt: "step-2" });
    // Only the steps up to and including the failing one actually ran.
    expect(calls.map((c) => c.prompt)).toEqual(["step-1", "step-2"]);
    expect(calls).toHaveLength(2);
  });

  it("returns {ok: true} immediately for an empty chain", async () => {
    const { host, calls } = stubHost();
    const result = await run('return await chain([]);', { host });

    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-array argument", async () => {
    const { host } = stubHost();
    const result = await run('return await chain("not-an-array");', { host });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("chain(steps) expects an array");
  });

  it("rejects a non-string step up front", async () => {
    const { host } = stubHost();
    const result = await run('return await chain(["ok", 42]);', { host });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("requires a non-empty string");
  });
});
