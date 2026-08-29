import { createHash } from "node:crypto";

export interface StuckDetectorConfig {
  windowMs: number;
  repeatThreshold: number;
  graceWindows: number;
  /** Number of consecutive failures required; defaults to repeatThreshold. */
  failureThreshold?: number;
  /** Optional timestamp used as the detector's initial activity point. */
  initialAt?: number;
}

export type StuckDetectorEvent =
  | { type: "tool_start"; toolName: string; toolCallId?: string; args?: unknown; at: number }
  | { type: "tool_end"; toolName: string; toolCallId?: string; args?: unknown; isError?: boolean; at: number }
  | { type: "text"; delta: string; at: number }
  | { type: "turn"; at: number }
  | { type: "activity"; at: number };

export type StuckReason = "repeated-call" | "failure-loop" | "no-output" | "no-activity";
export type StuckStatus = "healthy" | "suspicious" | "stuck";

export interface StuckDetectorEvaluation {
  status: StuckStatus;
  suspicious: boolean;
  suspiciousWindows: number;
  reason?: StuckReason;
}

export interface StuckDetector {
  record(event: StuckDetectorEvent): void;
  evaluate(now: number): StuckDetectorEvaluation;
  reset(at?: number): void;
}

interface ToolCall {
  id: number;
  toolName: string;
  toolCallId?: string;
  argsKey: string;
  startedAt: number;
  endedAt?: number;
  isError?: boolean;
}

const EMPTY_EVALUATION: StuckDetectorEvaluation = {
  status: "healthy",
  suspicious: false,
  suspiciousWindows: 0,
};

/**
 * Stable, bounded representation for tool arguments. Hashing keeps the
 * detector's memory independent of argument size while preserving equality.
 */
function argsHash(args: unknown): string {
  return createHash("sha256").update(stableSerialize(args)).digest("hex");
}

function stableSerialize(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (value === Infinity) return "number:Infinity";
    if (value === -Infinity) return "number:-Infinity";
    if (Object.is(value, -0)) return "number:-0";
    return `number:${value}`;
  }
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "symbol") return `symbol:${String(value)}`;
  if (typeof value === "function") return `function:${value.name}`;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = `[${value.map(item => stableSerialize(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }

  const record = value as Record<string, unknown>;
  const result = `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`).join(",")}}`;
  seen.delete(value);
  return result;
}

function normalizeThreshold(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value!)) : fallback;
}

function cloneEvaluation(evaluation: StuckDetectorEvaluation): StuckDetectorEvaluation {
  return { ...evaluation };
}

export function createStuckDetector(config: StuckDetectorConfig): StuckDetector {
  const windowMs = Math.max(1, config.windowMs);
  const repeatThreshold = normalizeThreshold(config.repeatThreshold, 1);
  const failureThreshold = normalizeThreshold(config.failureThreshold, repeatThreshold);
  const graceWindows = normalizeThreshold(config.graceWindows, 1);

  let events: StuckDetectorEvent[] = [];
  let calls: ToolCall[] = [];
  let nextCallId = 1;
  let pendingByTool = new Map<string, number[]>();
  let pendingById = new Map<string, number>();
  let lastActivityAt = config.initialAt;
  let firstObservedAt = config.initialAt;
  let lastTextAt = config.initialAt;
  let lastEvaluationAt: number | undefined;
  let suspiciousWindows = 0;
  let status: StuckStatus = "healthy";
  let lastEvaluation: StuckDetectorEvaluation = EMPTY_EVALUATION;

  const clearState = (at?: number) => {
    events = [];
    calls = [];
    nextCallId = 1;
    pendingByTool = new Map();
    pendingById = new Map();
    lastActivityAt = at;
    firstObservedAt = at;
    lastTextAt = at;
    lastEvaluationAt = undefined;
    suspiciousWindows = 0;
    status = "healthy";
    lastEvaluation = EMPTY_EVALUATION;
  };

  const prune = (now: number) => {
    const cutoff = now - windowMs;
    events = events.filter(event => event.at >= cutoff && event.at <= now);
    // Keep an open call even after its start leaves the window: in-flight work
    // suppresses the idle rules and must still match its eventual end event.
    calls = calls.filter(call =>
      call.endedAt === undefined
        ? call.startedAt <= now
        : call.endedAt >= cutoff && call.startedAt <= now,
    );
    for (const [toolName, ids] of pendingByTool) {
      const kept = ids.filter(id => calls.some(call => call.id === id && call.endedAt === undefined));
      if (kept.length === 0) pendingByTool.delete(toolName);
      else pendingByTool.set(toolName, kept);
    }
    for (const [toolCallId, id] of pendingById) {
      if (!calls.some(call => call.id === id && call.endedAt === undefined)) pendingById.delete(toolCallId);
    }
  };

  const record = (event: StuckDetectorEvent): void => {
    firstObservedAt = Math.min(firstObservedAt ?? event.at, event.at);
    lastActivityAt = Math.max(lastActivityAt ?? event.at, event.at);
    if (event.type === "tool_start") {
      const call: ToolCall = {
        id: nextCallId++,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        argsKey: argsHash(event.args),
        startedAt: event.at,
      };
      calls.push(call);
      const pending = pendingByTool.get(event.toolName) ?? [];
      pending.push(call.id);
      pendingByTool.set(event.toolName, pending);
      if (event.toolCallId !== undefined) pendingById.set(event.toolCallId, call.id);
    } else if (event.type === "tool_end") {
      let call = event.toolCallId === undefined
        ? undefined
        : calls.find(candidate => candidate.toolCallId === event.toolCallId && candidate.endedAt === undefined);
      const pending = pendingByTool.get(event.toolName);
      if (call === undefined && pending) {
        while (pending.length > 0 && call === undefined) {
          const candidateId = pending.shift();
          call = calls.find(candidate => candidate.id === candidateId && candidate.endedAt === undefined);
        }
        if (pending.length === 0) pendingByTool.delete(event.toolName);
      }
      if (!call) {
        call = {
          id: nextCallId++,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          argsKey: argsHash(event.args),
          startedAt: event.at,
        };
        calls.push(call);
      } else if (event.args !== undefined) {
        call.argsKey = argsHash(event.args);
      }
      call.endedAt = event.at;
      call.isError = event.isError === true;
      if (call.toolCallId !== undefined) pendingById.delete(call.toolCallId);
    }

    lastEvaluationAt = undefined;
    events.push(event);
    // Output is an immediate recovery signal for the current suspicious streak.
    if (event.type === "text" && event.delta.length > 0) {
      lastTextAt = Math.max(lastTextAt ?? event.at, event.at);
      suspiciousWindows = 0;
      status = "healthy";
      lastEvaluation = { ...EMPTY_EVALUATION };
    }
  };

  const evaluate = (now: number): StuckDetectorEvaluation => {
    if (lastEvaluationAt === now) return cloneEvaluation(lastEvaluation);
    lastEvaluationAt = now;

    if (status === "stuck") return cloneEvaluation(lastEvaluation);
    prune(now);

    const cutoff = now - windowMs;
    const recent = events.filter(event => event.at >= cutoff && event.at <= now);
    const recentStarts = calls.filter(call => call.startedAt >= cutoff && call.startedAt <= now);
    const recentEnds = calls
      .filter(call => call.endedAt !== undefined && call.endedAt >= cutoff && call.endedAt <= now)
      .sort((a, b) => (a.endedAt! - b.endedAt!));

    let reason: StuckReason | undefined;
    if (recentStarts.length >= repeatThreshold) {
      const counts = new Map<string, number>();
      for (const call of recentStarts) {
        const key = `${call.toolName}\u0000${call.argsKey}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const repeated = [...counts.entries()].find(([, count]) => count >= repeatThreshold);
      if (repeated && counts.size === 1) reason = "repeated-call";
    }

    if (reason === undefined && recentEnds.length >= failureThreshold) {
      const last = recentEnds[recentEnds.length - 1];
      let count = 0;
      for (let i = recentEnds.length - 1; i >= 0; i--) {
        const end = recentEnds[i];
        if (end.toolName !== last.toolName || end.isError !== true) break;
        count++;
      }
      if (count >= failureThreshold) reason = "failure-loop";
    }

    if (reason === undefined) {
      // An open tool is active work, not an idle window: a single long bash or
      // read must not be mistaken for no output while it is still running.
      const hasOpenCall = calls.some(call => call.endedAt === undefined);
      if (!hasOpenCall) {
        const hasRecentEvent = recent.length > 0;
        const noCompletedToolCall = recentEnds.length === 0;
        const noTextGrowth = lastTextAt === undefined || now - lastTextAt >= windowMs;
        if (!hasRecentEvent && lastActivityAt !== undefined && now - lastActivityAt >= windowMs) {
          reason = "no-activity";
        } else if (hasRecentEvent && noCompletedToolCall && noTextGrowth
          && firstObservedAt !== undefined && now - firstObservedAt >= windowMs) {
          reason = "no-output";
        }
      }
    }

    if (reason === undefined) {
      suspiciousWindows = 0;
      status = "healthy";
      lastEvaluation = { ...EMPTY_EVALUATION };
      return cloneEvaluation(lastEvaluation);
    }

    suspiciousWindows++;
    status = suspiciousWindows >= graceWindows ? "stuck" : "suspicious";
    lastEvaluation = {
      status,
      suspicious: true,
      suspiciousWindows,
      reason,
    };
    return cloneEvaluation(lastEvaluation);
  };

  return {
    record,
    evaluate,
    reset: clearState,
  };
}
