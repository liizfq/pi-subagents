let meta = #{
  name: "workflow-runtime-fix",
  description: "P0 workflow abort terminal-state + watchdog: plan -> TDD tests -> implement -> parallel review -> build-verify"
};

let task;
if type_of(args) == "string" {
  task = args;
} else if type_of(args) == "map" && type_of(args.task) == "string" && args.task != "" {
  task = args.task;
} else {
  task = "Implement P0 from .grok/specs/workflow-runtime-fix.md (pi-workflow-plugin-fix-analysis.md).";
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
  "pi-workflow-plugin-fix-analysis.md (constraint), " +
  ".grok/specs/workflow-runtime-fix.md (this slice), " +
  "Agents.md (contributor rules), " +
  ".grok/rules/pm-orchestration.md (dispatch). " +
  "Then read the files that spec names before editing them. " +
  "Do not commit, push, or overwrite Agents.md. P1/P2 are out of scope.\n\n";

let dod =
  "Acceptance gate: after abort, a terminal record and a notification exist within 30s. " +
  "Verify with `npx vitest run test/workflow-runtime.test.ts` and `npx vitest run test/workflow-progress.test.ts` " +
  "(plus render tests if UI type-switches changed), then `npm run check` " +
  "(package.json:scripts.check). Do not run `npm run bench`.\n\n";

// Stage 1: Plan (read-only)
let plan = agent(
  spec_files +
  "You are the planner (plan, inherit parent model). Stay read-only.\n" +
  "Produce a concise phased plan for the P0 runtime abort/watchdog work. " +
  "Name exact files, symbols, existing tests to extend, and risks " +
  "(especially: worker.terminate() must remain the grace fallback; " +
  "runtime.ts must not grow filesystem IO; run_status must not pollute phaseTitles).\n" +
  "Which coder prompt: coder-debug (must run tests). Not coder-modify (no shell).\n\n" +
  "Task:\n" + task
);

// Stage 2: TDD — failing tests first
let tests = agent(
  spec_files + dod +
  "You are the tester (general-purpose, role coder-test, model minimax-m3). Follow tdd.\n" +
  "Write the failing tests listed in .grok/specs/workflow-runtime-fix.md (TDD 顺序) BEFORE any product implementation.\n" +
  "RED: run them and paste the failure output. Do not implement the runtime fix in this stage " +
  "beyond the minimum needed for tests to compile and fail for the right reason " +
  "(e.g. optional option types on RunWorkflowOptions if the test cannot even typecheck).\n" +
  "Do not claim GREEN. Mutation-check at least one new assertion if you can without implementing the feature.\n\n" +
  "Planner notes:\n" + text(plan) + "\n\nTask:\n" + task
);

// Stage 3: Implement until those tests pass
let impl = agent(
  spec_files + dod +
  "You are the implementer (general-purpose, role coder-debug, model utmm). Follow diagnosing-bugs + tdd.\n" +
  "Implement P0-1..P0-4 from .grok/specs/workflow-runtime-fix.md so the tests from the previous stage go GREEN. Minimal change.\n" +
  "Keep worker.terminate() as the grace-timeout fallback. Keep runtime.ts free of direct fs IO. " +
  "Wire persist/onTerminal/onStalled from src/index.ts runWorkflowTask. " +
  "Add WorkflowRunStatusEntry and teach collapse() not to treat it as a phase.\n" +
  "Update docs/workflows.md and CHANGELOG.md [Unreleased] in the same change. README.md only if the feature list needs a sentence.\n" +
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
    "Review the P0 implementation against .grok/specs/workflow-runtime-fix.md. " +
    "Flag: filesystem IO inside runtime.ts; abort resolving agent() as null instead of a catchable fatal error; " +
    "run_status falling into phaseTitles; deleting terminate(); expanding into P1/P2; missing tests for grace / already-aborted / spin-loop.\n" +
    "List findings CRITICAL/HIGH/MEDIUM/LOW. No CRITICAL/HIGH still requires that sentence.\n\n" +
    "Implementation summary:\n" + text(impl)
  },
  #{ prompt:
    spec_files +
    "You are the security-reviewer (general-purpose, role architect-review, model xai). Stay read-only.\n" +
    "Check the P0 change for path injection on the persist file (must stay in the existing session task dir), " +
    "secrets in run-status.json, and abort/watchdog as a denial-of-service against the host event loop.\n" +
    "List findings by severity.\n\n" +
    "Implementation summary:\n" + text(impl)
  }
]);

// Stage 5: Build verification
let verify = agent(
  spec_files + dod +
  "You are the build-verify checker (general-purpose, role build-verify, model xai). Do not edit product code.\n" +
  "Run the checklist and report PASS/FAIL with command + output + exit code:\n" +
  "1. npx vitest run test/workflow-runtime.test.ts\n" +
  "2. npx vitest run test/workflow-progress.test.ts\n" +
  "3. npx vitest run test/workflow-render.test.ts test/workflow-dialog.test.ts — only if those files or UI type-switches changed; else N/A\n" +
  "4. npm run check (package.json:scripts.check = lint + typecheck + test)\n" +
  "5. npm run test:e2e (package.json:scripts.test:e2e) — only if src/index.ts workflow tool / session path / e2e fixtures changed; else N/A\n" +
  "6. npm run build (package.json:scripts.build) — N/A unless verifying dist\n" +
  "Do not run npm run bench.\n" +
  "Confirm the abort-within-30s gate is covered by a test you actually ran, not by reading the spec.\n" +
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
