let meta = #{
  name: "workflow-stuck-detection",
  description: "P3 subagent stuck detection (rules + optional AI review): plan -> TDD tests -> implement -> parallel review -> build-verify"
};

let task;
if type_of(args) == "string" {
  task = args;
} else if type_of(args) == "map" && type_of(args.task) == "string" && args.task != "" {
  task = args.task;
} else {
  task = "Implement P3 from .grok/specs/p3-stuck-detection.md.";
}

fn text(v) {
  if type_of(v) == "string" {
    return v;
  }
  if type_of(v) == "map" {
    let out = v["output"];
    let s = "";
    if type_of(out) == "map" {
      let issues = out["issues"];
      if type_of(issues) == "string" && issues != "" {
        s += "Issues: " + issues + "\n";
      }
      let evidence = out["evidence"];
      if type_of(evidence) == "string" && evidence != "" {
        s += "Evidence: " + evidence + "\n";
      }
      let gaps = out["gaps"];
      if type_of(gaps) == "string" && gaps != "" {
        s += "Gaps: " + gaps + "\n";
      }
      if s == "" {
        s = "[previous stage summary]";
      }
      return s;
    }
    return "[stage result: " + type_of(v) + "]";
  }
  return "[stage result: " + type_of(v) + "]";
}

let spec_files =
  "Read in full before acting: " +
  ".grok/specs/p3-stuck-detection.md (this slice, the constraint), " +
  "Agents.md (contributor rules), " +
  ".grok/rules/pm-orchestration.md (dispatch). " +
  "Then read the source files the spec names before editing them. " +
  "Do not commit, push, or overwrite Agents.md. " +
  "Do not touch package.json, subagents/, or pi-workflow-plugin-fix-analysis.md (unrelated working-tree changes).\n\n";

let dod =
  "DoD: rule layer (identical-call repeat >= threshold -> suspicious; consecutive windows -> stuck -> steer then abort; " +
  "workflow agent() receives a failure, existing path). Legit loops (same tool, different args) are NOT flagged. " +
  "AI layer behind stuckDetection: 'rules+ai' (default 'rules'): one complete() call per cooldown on sustained suspicion; " +
  "AI verdict 'not stuck' resets to healthy. Detector must be a pure unit-testable module " +
  "(src/stuck-detector.ts) fed events by runAgent.\n" +
  "Verify: `npx vitest run test/stuck-detector.test.ts` (new) and `npx vitest run test/agent-runner.test.ts test/agent-manager.test.ts`, " +
  "then `npm run check` (package.json:scripts.check). Do not run `npm run bench`.\n\n";

// Stage 1: Plan (read-only)
let plan = agent(
  spec_files +
  "You are the planner (plan, inherit parent model). Stay read-only.\n" +
  "Produce a concise phased plan for P3. Name exact files, symbols, existing tests to extend, and risks " +
  "(abort must flow through the existing runAgent aborted path so workflow host turns it into {ok:false}; " +
  "detector must be pure; AI layer must default off and respect cooldown; do not break the deep-read false-positive fix).\n" +
  "Which coder prompt: coder-debug (must run tests).\n\n" +
  "Task:\n" + task
);

// Stage 2: TDD — failing tests first
let tests = agent(
  spec_files + dod +
  "You are the tester (general-purpose, role coder-test, model minimax-m3). Follow tdd.\n" +
  "Write failing tests for the pure detector (src/stuck-detector.ts) FIRST: identical-call repeat, " +
  "consecutive failure wall, no-activity window, text-progress resets suspicion, same-tool-different-args NOT flagged, " +
  "graceWindows state machine, reset(). Then any wiring tests for runAgent/agent-manager that are feasible without a real session " +
  "(inject stuck config via RunOptions/SpawnOptions; assert the detector receives events).\n" +
  "RED: run them and paste failure output. Do not implement the feature in this stage beyond what the tests need to compile and fail for the right reason.\n" +
  "Do not claim GREEN. If a wiring test cannot be written without the feature, note it and leave it for the implementer.\n\n" +
  "Planner notes:\n" + text(plan) + "\n\nTask:\n" + task
);

// Stage 3: Implement until tests pass
let impl = agent(
  spec_files + dod +
  "You are the implementer (general-purpose, role coder-debug, model utmm). Follow diagnosing-bugs + tdd.\n" +
  "Implement P3 from .grok/specs/p3-stuck-detection.md so the previous stage's tests go GREEN. Minimal change.\n" +
  "Create src/stuck-detector.ts as a pure module. Wire into runAgent: feed tool/text/turn events, run the rule timer " +
  "(stuckRuleIntervalMs default 30s), on stuck steer once then abort via the existing aborted path (maxTurns-style). " +
  "AI layer: modelRegistry.complete via resolveModel(stuckAiModel), 15s timeout, per-agent cooldown stuckAiIntervalMs default 600s, " +
  "parse {stuck:true|false}; verdict false -> detector.reset(). Settings: SubagentsSettings fields + sanitize + applySettings + " +
  "SettingsAppliers + /agents menu entries. AgentRecord.stuckState.\n" +
  "Update docs (docs/workflows.md or README) and CHANGELOG.md [Unreleased] in the same change.\n" +
  "Paste GREEN output for the targeted vitest files, then npm run check.\n\n" +
  "Planner notes:\n" + text(plan) +
  "\n\nTester notes:\n" + text(tests) +
  "\n\nTask:\n" + task
);

// Stage 4: Parallel reviews
let reviews = parallel([
  #{ prompt:
    spec_files +
    "You are the code-reviewer (general-purpose, role architect-review, model xai). Stay read-only.\n" +
    "Review the P3 implementation against .grok/specs/p3-stuck-detection.md. " +
    "Flag: detector not pure (side effects/timers inside); abort not flowing through the existing path; " +
    "deep-read false-positive regression (an agent with real, varied activity being flagged); " +
    "AI layer burning tokens on every window or ignoring cooldown; missing settings sanitize/ceiling; " +
    "stuck state not surfacing to the workflow agent() failure.\n" +
    "List findings CRITICAL/HIGH/MEDIUM/LOW. No CRITICAL/HIGH still requires that sentence.\n\n" +
    "Implementation summary:\n" + text(impl)
  },
  #{ prompt:
    spec_files +
    "You are the security-reviewer (general-purpose, role architect-review, model xai). Stay read-only.\n" +
    "Check the P3 change for: args hashing correctness (no secret leakage into the detector window or AI prompt — " +
    "truncate args, never send full tool args to the AI reviewer), AI model resolution (must use config.toml-slug models, " +
    "never a bare grok-4.6 that 401s), abort as a DoS vector (stuck detection must not kill healthy long agents), " +
    "and settings injection.\n" +
    "List findings by severity.\n\n" +
    "Implementation summary:\n" + text(impl)
  }
]);

// Stage 5: Build verification
let verify = agent(
  spec_files + dod +
  "You are the build-verify checker (general-purpose, role build-verify, model xai). Do not edit product code.\n" +
  "Run the checklist and report PASS/FAIL with command + output + exit code:\n" +
  "1. npx vitest run test/stuck-detector.test.ts\n" +
  "2. npx vitest run test/agent-runner.test.ts test/agent-manager.test.ts\n" +
  "3. npm run check (package.json:scripts.check = lint + typecheck + test)\n" +
  "4. npm run test:e2e — only if src/index.ts workflow tool / session path / e2e fixtures changed; else N/A\n" +
  "5. npm run build — N/A unless verifying dist\n" +
  "Do not run npm run bench.\n" +
  "Confirm a legit-loop-not-stuck test actually ran and passed (that is the regression guard for the deep-read fix).\n" +
  "If check is red, FAIL. Do not fix code; report the failure.\n\n" +
  "Implementation summary:\n" + text(impl) +
  "\n\nCode review:\n" + text(reviews[0]) +
  "\n\nSecurity review:\n" + text(reviews[1])
);

return #{
  plan: plan,
  tests: tests,
  implementation: impl,
  code_review: reviews[0],
  security_review: reviews[1],
  build_verify: verify
};
