import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), steerAgent: vi.fn() };
});

import { runAgent, SUBAGENT_TOOL_NAMES } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  // Each test boots a fresh manager; clear the global registry so the
  // extension re-claims the slot.
  delete (globalThis as any)[MANAGER_KEY];
});

function fakeSession() {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
  } as any;
}

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  const result = await tools.get("Agent").execute(
    "tc-spawn",
    {
      prompt: "go",
      description: "stop test agent",
      subagent_type: "general-purpose",
      run_in_background: true,
    },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(result))![1];
}

describe("stop_subagent tool", () => {
  it("is included in the extension tool names and has the required schema", () => {
    expect(SUBAGENT_TOOL_NAMES.STOP_SUBAGENT).toBe("stop_subagent");
    expect(Object.values(SUBAGENT_TOOL_NAMES)).toContain("stop_subagent");

    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const tool = tools.get("stop_subagent");
    expect(tool).toBeDefined();
    expect(tool.parameters).toMatchObject({ type: "object" });
    expect(tool.parameters.properties.id).toMatchObject({ type: "string" });
    expect(tool.parameters.required).toContain("id");
  });

  it("returns an unknown-id message for an id that was never spawned", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const result = await tools.get("stop_subagent").execute(
      "tc-unknown",
      { id: "never-spawned" },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(result)).toBe("Unknown subagent id 'never-spawned' in this session.");
    await lifecycle.get("session_shutdown")?.();
  });

  it("aborts a running agent and returns immediately", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    const id = await spawnBackground(tools);
    await flush();
    const result = await tools.get("stop_subagent").execute(
      "tc-stop",
      { id },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(result)).toContain(`Stopped subagent '${id}'.`);
    const second = await tools.get("stop_subagent").execute(
      "tc-stop-again",
      { id },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(second)).toContain("already settled");
    await lifecycle.get("session_shutdown")?.();
  });

  it("returns an idempotent message for an already-settled agent", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: fakeSession(),
      aborted: false,
      steered: false,
    } as any);

    const id = await spawnBackground(tools);
    await flush();
    const result = await tools.get("stop_subagent").execute(
      "tc-settled",
      { id },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(result)).toContain("already settled");
    await lifecycle.get("session_shutdown")?.();
  });

  it("returns an ownership error for a non-top-level agent", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    const id = await spawnBackground(tools);
    await flush();
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const record = registry.getRecord(id);
    record.parentAgentId = "parent-1";

    const result = await tools.get("stop_subagent").execute(
      "tc-owned",
      { id },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(result)).toBe(`Subagent '${id}' is owned by another agent.`);
    await lifecycle.get("session_shutdown")?.();
  });
});
