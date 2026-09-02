import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSettings,
  type SubagentsSettings,
  saveSettings,
} from "../src/settings.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";

/**
 * Tests for the `stuckNotificationTarget` setting:
 * - Sanitization: only non-empty strings pass through (default empty = main agent)
 * - Persistence round-trip via load/save
 */
describe("stuckNotificationTarget setting", () => {
  let globalDir: string;
  let projectDir: string;
  let originalAgentDirEnv: string | undefined;

  const projectFile = () => join(projectDir, ".pi", "subagents.json");

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "pi-stuck-target-global-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-stuck-target-project-"));
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalDir;
  });

  afterEach(() => {
    if (originalAgentDirEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("sanitizes stuckNotificationTarget: only non-empty strings pass", () => {
    // Empty string should be dropped (default = main agent, i.e. absent).
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), JSON.stringify({ stuckNotificationTarget: "" }));
    const settings = loadSettings(projectDir);
    expect(settings.stuckNotificationTarget).toBeUndefined();

    // Whitespace-only should also be dropped.
    writeFileSync(projectFile(), JSON.stringify({ stuckNotificationTarget: "   " }));
    const settings2 = loadSettings(projectDir);
    expect(settings2.stuckNotificationTarget).toBeUndefined();

    // A valid agent type or id should pass through.
    writeFileSync(projectFile(), JSON.stringify({ stuckNotificationTarget: "Explore" }));
    const settings3 = loadSettings(projectDir);
    expect(settings3.stuckNotificationTarget).toBe("Explore");
  });

  it("round-trips through saveSettings", () => {
    const s: SubagentsSettings = { stuckNotificationTarget: "Explore" };
    const ok = saveSettings(s, projectDir);
    expect(ok).toBe(true);
    const loaded = loadSettings(projectDir);
    expect(loaded.stuckNotificationTarget).toBe("Explore");
  });
});

/**
 * MEDIUM-1: when `stuckNotificationTarget` resolves to no running agent, the
 * `agent_stuck` nudge falls back to the main agent rather than being dropped.
 * The companion case (a running target agent) is the pre-existing routing.
 */
describe("agent_stuck nudge routing (MEDIUM-1)", () => {
  function runStuckWorkflow(): void {
    vi.mocked(runAgent).mockImplementation(
      async (_ctx: any, _type: any, _prompt: any, opts: any) => {
        opts?.onStuckState?.("stuck");
        return { responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false };
      },
    );
  }

  it("falls back to the main agent when the target resolves to no running agent", async () => {
    const hermetic = hermeticDir({ settings: { stuckNotificationTarget: "Explore" } });
    runStuckWorkflow();
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    await tools.get("SubagentWorkflow").execute(
      "wf-stuck",
      { script: 'export const meta = { name: "stuck-probe", description: "probe" };\nawait agent("do the work");\nreturn "done";' },
      undefined,
      undefined,
      ctx(),
    );
    // The nudge is held for NUDGE_HOLD_MS (200ms) before it fires.
    await new Promise((r) => setTimeout(r, 250));
    // "Explore" is an agent type with no running agent of that type, so the
    // nudge must reach the main agent via pi.sendMessage (the MEDIUM-1 fallback).
    // The completion notification also uses sendMessage, so locate the stuck nudge by its content.
    const stuckCall = pi.sendMessage.mock.calls.find((c: any[]) => typeof c[0].content === "string" && c[0].content.includes("appears stuck"));
    expect(stuckCall, "the agent_stuck nudge should be sent to the main agent").toBeTruthy();
    expect(stuckCall[0].customType).toBe("subagent-notification");
    hermetic.restore();
  });

  it("routes to the target agent when a running agent of that type exists", async () => {
    const hermetic = hermeticDir({
      settings: { stuckNotificationTarget: "Explore" },
      agentFiles: { Explore: "# Explore\nYou explore code.\n" },
    });
    // Hold the agent running past the nudge hold so it is still "running" when
    // the nudge fires.
    vi.mocked(runAgent).mockImplementation(
      (_ctx: any, _type: any, _prompt: any, opts: any) => {
        opts?.onStuckState?.("stuck");
        return new Promise<any>((resolve) => {
          setTimeout(() => {
            resolve({ responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false });
          }, 400);
        });
      },
    );
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const pending = tools.get("SubagentWorkflow").execute(
      "wf-stuck2",
      { script: 'export const meta = { name: "stuck-probe", description: "probe" };\nawait agent("do the work", { agentType: "Explore" });\nreturn "done";' },
      undefined,
      undefined,
      ctx(),
    );
    // Let the nudge fire while the Explore agent is still running (resolves at 400ms,
    // nudge fires ~200ms after the agent_stuck entry).
    await new Promise((r) => setTimeout(r, 250));
    // A running "Explore" agent exists, so the nudge is routed to it via
    // manager.steer; the main agent (pi.sendMessage) must NOT receive the stuck nudge.
    // (The completion notification does use sendMessage, so check by content.)
    const stuckCall = pi.sendMessage.mock.calls.find((c: any[]) => typeof c[0].content === "string" && c[0].content.includes("appears stuck"));
    expect(stuckCall, "the stuck nudge should have been routed to the running Explore agent, not the main agent").toBeUndefined();
    await pending;
    hermetic.restore();
  });
});
