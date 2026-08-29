let meta = #{
  name: "workflow-stuck-fix-review",
  description: "Fix P3 code-review findings: HIGH deep-read false-positive in no-output rule + MEDIUM collapsed steer grace -> tests -> review -> build-verify"
};

let task;
if type_of(args) == "string" {
  task = args;
} else if type_of(args) == "map" && type_of(args.task) == "string" && args.task != "" {
  task = args.task;
} else {
  task = "Fix the code-review findings on the P3 stuck-detection work.";
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
  ".grok/specs/p3-stuck-detection.md (the slice contract), " +
  "Agents.md, .grok/rules/pm-orchestration.md. " +
  "Then read the source files you touch in full before editing. " +
  "Do not commit, push, or overwrite Agents.md. " +
  "Do not touch package.json, subagents/, or pi-workflow-plugin-fix-analysis.md (unrelated working-tree changes).\n\n";

let dod =
  "DoD for this fix slice:\n" +
  "1. HIGH: src/stuck-detector.ts no-output rule must NOT flag an agent mid-way through a single long tool call " +
  "(e.g. 60s bash/read) with no text_delta. Fix per review direction: flag no-output only when there are NO completed tool calls " +
  "in the window AND text has not grown for windowMs. A regression test must reproduce the old false positive (long single open call, no text) and now pass.\n" +
  "2. MEDIUM: src/agent-runner.ts markStuck() must give the steer a real chance: after steer, wait at least one evaluation window " +
  "(or a grace delay) for progress (text/tool activity resets suspicion) before session.abort(). Only abort on a subsequent still-stuck evaluation. " +
  "Regression test: steer precedes abort by at least one window and progress after steer cancels the abort.\n" +
  "3. LOW (cheap, same change): remove the dead activeAiController reference (keep the 15s race timeout); " +
  "align settings sanitize floors/ceilings with the runner setters.\n" +
  "Keep: detector purity, AI cooldown, legit-loop guard, existing P3 tests green.\n" +
  "Verify: `npx vitest run test/stuck-detector.test.ts test/agent-runner.test.ts test/agent-manager.test.ts`, " +
  "then `npm run check`. Do not run `npm run bench`.\n\n";

let plan = agent(
  spec_files +
  "You are the planner (plan, inherit parent model). Stay read-only.\n" +
  "Produce a concise phased plan for the two real findings (HIGH no-output false positive, MEDIUM collapsed steer grace) and the two LOWs. " +
  "Name exact files/lines, the new regression tests, and risks (must not break the legit-loop guard or detector purity; " +
  "the steer-then-abort delay must not make real stuck agents wait forever — cap the extra wait).\n\n" +
  "Task:\n" + task
);

let tests = agent(
  spec_files + dod +
  "You are the tester (general-purpose, role coder-test, model minimax-m3). Follow tdd.\n" +
  "Write failing tests FIRST for the two regressions: (1) a detector fed a single long open tool call with no text for > windowMs " +
  "must stay healthy (currently fails as suspicious/stuck); (2) a stuck transition must steer, then on the next still-stuck window abort, " +
  "and progress (text delta) after the steer must reset to healthy instead of aborting. Extend test/stuck-detector.test.ts and " +
  "test/agent-runner.test.ts. RED: run them, paste failure output. Do not implement the fix in this stage.\n\n" +
  "Planner notes:\n" + text(plan) + "\n\nTask:\n" + task
);

let impl = agent(
  spec_files + dod +
  "You are the implementer (general-purpose, role coder-debug, model utmm). Follow diagnosing-bugs + tdd.\n" +
  "Make the previous stage's failing tests GREEN. Minimal change to src/stuck-detector.ts and src/agent-runner.ts " +
  "(plus settings alignment if you do the LOW). Keep the detector pure. Do not change the abort/agent() failure contract " +
  "or the AI layer's cooldown/timeout. Paste GREEN output for the targeted vitest files, then npm run check.\n\n" +
  "Planner notes:\n" + text(plan) +
  "\n\nTester notes:\n" + text(tests) +
  "\n\nTask:\n" + task
);

let reviews = parallel([
  #{ prompt:
    spec_files + dod +
    "You are the code-reviewer (general-purpose, role architect-review, model xai). Stay read-only.\n" +
    "Verify the two findings are actually fixed, not papered over: (1) a single long open tool call with no text is not flagged; " +
    "(2) steer gets a real window and progress after steer cancels the abort; and that the LOWs are resolved without new smells. " +
    "Check for regressions: legit-loop guard, detector purity, AI cooldown, abort contract.\n" +
    "List findings CRITICAL/HIGH/MEDIUM/LOW. No CRITICAL/HIGH still requires that sentence.\n\n" +
    "Implementation summary:\n" + text(impl)
  },
  #{ prompt:
    spec_files + dod +
    "You are the security-reviewer (general-purpose, role architect-review, model xai). Stay read-only.\n" +
    "Check the fix for: the new no-output condition cannot mislabel a stuck agent as healthy (false negative), " +
    "the steer-grace cannot be abused to extend a genuinely stuck agent forever (cap the wait), " +
    "and no secrets/args leak. List findings by severity.\n\n" +
    "Implementation summary:\n" + text(impl)
  }
]);

let verify = agent(
  spec_files + dod +
  "You are the build-verify checker (general-purpose, role build-verify, model xai). Do not edit product code.\n" +
  "Run the checklist and report PASS/FAIL with command + output + exit code:\n" +
  "1. npx vitest run test/stuck-detector.test.ts\n" +
  "2. npx vitest run test/agent-runner.test.ts test/agent-manager.test.ts\n" +
  "3. npm run check (package.json:scripts.check)\n" +
  "4. npm run test:e2e — only if src/index.ts session path changed; else N/A\n" +
  "Do not run npm run bench. Confirm the two new regression tests actually ran and passed " +
  "(re-run them by name with -t). If check is red, FAIL. Do not fix code; report the failure.\n\n" +
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
