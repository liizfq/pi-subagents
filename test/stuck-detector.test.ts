import { describe, expect, it } from "vitest";
import {
  createStuckDetector,
  type StuckDetector,
  type StuckDetectorConfig,
  type StuckDetectorEvent,
} from "../src/stuck-detector.js";

const config: StuckDetectorConfig = {
  windowMs: 100,
  repeatThreshold: 3,
  graceWindows: 3,
};

function createDetector(overrides: Partial<StuckDetectorConfig> = {}): StuckDetector {
  return createStuckDetector({ ...config, ...overrides });
}

function toolStart(
  toolName: string,
  args: unknown,
  at: number,
): StuckDetectorEvent {
  return { type: "tool_start", toolName, args, at };
}

function toolEnd(
  toolName: string,
  args: unknown,
  at: number,
  isError = false,
): StuckDetectorEvent {
  return { type: "tool_end", toolName, args, at, isError };
}

function evaluate(detector: StuckDetector, now: number) {
  return detector.evaluate(now);
}

describe("stuck detector rule layer", () => {
  it("marks identical tool calls suspicious once the repeat threshold is reached", () => {
    const detector = createDetector({ repeatThreshold: 3 });

    detector.record(toolStart("search", { query: "same" }, 0));
    detector.record(toolStart("search", { query: "same" }, 10));
    detector.record(toolStart("search", { query: "same" }, 20));

    expect(evaluate(detector, 20)).toMatchObject({
      status: "suspicious",
      reason: "repeated-call",
      suspicious: true,
    });
  });

  it("recognizes a consecutive failure wall for one tool", () => {
    const detector = createDetector({ repeatThreshold: 3 });

    detector.record(toolStart("bash", { command: "false 1" }, 0));
    detector.record(toolEnd("bash", { command: "false 1" }, 1, true));
    detector.record(toolStart("bash", { command: "false 2" }, 10));
    detector.record(toolEnd("bash", { command: "false 2" }, 11, true));
    detector.record(toolStart("bash", { command: "false 3" }, 20));
    detector.record(toolEnd("bash", { command: "false 3" }, 21, true));

    expect(evaluate(detector, 21)).toMatchObject({
      status: "suspicious",
      reason: "failure-loop",
      suspicious: true,
    });
  });

  it("marks an inactive window suspicious after the activity timeout", () => {
    const detector = createDetector({ windowMs: 100 });
    detector.record({ type: "turn", at: 0 });

    expect(evaluate(detector, 101)).toMatchObject({
      status: "suspicious",
      reason: "no-activity",
      suspicious: true,
    });
  });

  it("does not flag a no-activity window before the timeout", () => {
    const detector = createDetector({ windowMs: 100 });
    detector.record({ type: "activity", at: 0 });

    expect(evaluate(detector, 99)).toMatchObject({
      status: "healthy",
      suspicious: false,
    });
  });

  it("does not flag a single long-running open tool call as no-output", () => {
    const detector = createDetector({ windowMs: 100 });
    detector.record(toolStart("read", { path: "large.log" }, 0));

    expect(evaluate(detector, 101)).toMatchObject({
      status: "healthy",
      suspicious: false,
    });
  });

  it("returns to healthy when text progress is recorded", () => {
    const detector = createDetector({ windowMs: 100 });
    detector.record({ type: "activity", at: 0 });
    expect(evaluate(detector, 101).status).toBe("suspicious");

    detector.record({ type: "text", delta: "progress", at: 110 });

    expect(evaluate(detector, 110)).toMatchObject({
      status: "healthy",
      suspicious: false,
    });
  });

  it("does not flag a legitimate loop using the same tool with different args", () => {
    const detector = createDetector({ repeatThreshold: 3, windowMs: 1_000 });

    detector.record(toolStart("read", { path: "one.ts" }, 0));
    detector.record(toolStart("read", { path: "two.ts" }, 10));
    detector.record(toolStart("read", { path: "three.ts" }, 20));
    detector.record(toolStart("read", { path: "four.ts" }, 30));

    expect(evaluate(detector, 30)).toMatchObject({
      status: "healthy",
      suspicious: false,
    });
  });

  it("requires consecutive suspicious windows before becoming stuck", () => {
    const detector = createDetector({ repeatThreshold: 2, graceWindows: 3, windowMs: 1_000 });
    const repeated = (at: number): void => {
      detector.record(toolStart("search", { query: "same" }, at));
      detector.record(toolStart("search", { query: "same" }, at + 1));
    };

    repeated(0);
    expect(evaluate(detector, 1)).toMatchObject({ status: "suspicious", suspiciousWindows: 1 });
    repeated(100);
    expect(evaluate(detector, 101)).toMatchObject({ status: "suspicious", suspiciousWindows: 2 });
    repeated(200);
    expect(evaluate(detector, 201)).toMatchObject({ status: "stuck", suspiciousWindows: 3 });
  });

  it("reset returns a detector to healthy and clears prior activity", () => {
    const detector = createDetector({ repeatThreshold: 2 });
    detector.record(toolStart("search", { query: "same" }, 0));
    detector.record(toolStart("search", { query: "same" }, 1));
    expect(evaluate(detector, 1).suspicious).toBe(true);

    detector.reset(10);

    expect(evaluate(detector, 10)).toMatchObject({
      status: "healthy",
      suspicious: false,
      suspiciousWindows: 0,
    });
    detector.record(toolStart("search", { query: "same" }, 11));
    expect(evaluate(detector, 11).suspicious).toBe(false);
  });
});
