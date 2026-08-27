let meta = #{
  name: "pi-subagents-pipeline",
  description: "pi-subagents dev pipeline: plan -> implement -> parallel review (code + security) -> build-verify (project commands)"
};

// args may be a plain task string, or a map with a "task" key.
let task;
if type_of(args) == "string" {
  task = args;
} else {
  task = args.task;
}

// Stringify an agent() result (a structured map) into a short readable summary
// to feed the next stage's prompt. Agent results carry a nested "output" map.
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

let spec_prefix =
  "Follow .grok/rules/pm-orchestration.md and Agents.md. " +
  "DoD/Report: ~/.grok/prompts for your role. " +
  "Do not commit, push, or overwrite Agents.md.\n\n";

// Stage 1: Plan
let plan = agent(
  spec_prefix +
  "You are the planner agent (plan, inherit parent model). Produce a concise, phased implementation plan.\n" +
  "Read Agents.md, README.md, docs/workflows.md if the task touches SubagentWorkflow, and the task below.\n" +
  "Identify dependencies, risks, files, and which coder prompt (coder-create / coder-modify / coder-debug) fits.\n" +
  "Stay read-only. Do not edit the tree.\n\nTask:\n" + task
);

// Stage 2: Implement
let impl = agent(
  spec_prefix +
  "You are the implementer (general-purpose, role coder-debug, model utmm). " +
  "Follow the TDD skill (tdd): write the failing test first, then the minimal implementation, then refactor.\n" +
  "Verify with `npx vitest run test/<file>.test.ts` on files you touch, then `npm run check` " +
  "(package.json:scripts.check = lint + typecheck + test).\n" +
  "Do not run `npm run bench`. Run `npm run build` only if you need the dist artifact.\n\nTask:\n" + task +
  "\n\nPlanner notes:\n" + text(plan)
);

// Stage 3: Parallel reviews
let reviews = parallel([
  #{ prompt: spec_prefix + "You are the code-reviewer (general-purpose, role architect-review, model xai). Review the implementation for quality, maintainability, error handling, and edge cases. List findings by severity (CRITICAL/HIGH/MEDIUM/LOW). Stay read-only.\n\nImplementation summary:\n" + text(impl) },
  #{ prompt: spec_prefix + "You are the security-reviewer (general-purpose, role architect-review, model xai). Check the implementation for: hardcoded secrets, input validation, injection/XSS/CSRF risks, and authn/authz gaps. List findings by severity. Stay read-only.\n\nImplementation summary:\n" + text(impl) }
]);

// Stage 4: Build verification — PROJECT-SPECIFIC COMMANDS below.
let verify = agent(
  spec_prefix +
  "You are the build-verify checker (general-purpose, role build-verify, model xai). " +
  "Run the project's verify checklist and confirm each command actually passed with real output (no 'should pass'). Checklist:\n" +
  "npm run check (package.json:scripts.check = lint + typecheck + test; what CI runs)\n" +
  "npm run lint (package.json:scripts.lint = biome check src/ test/) — covered by check; isolate only on failure\n" +
  "npm run typecheck (package.json:scripts.typecheck = tsc --noEmit) — covered by check; isolate only on failure\n" +
  "npm run test (package.json:scripts.test = vitest run) — covered by check; isolate only on failure\n" +
  "npm run test:e2e (package.json:scripts.test:e2e) — only if the change touches the SubagentWorkflow tool, session path, or e2e fixtures; otherwise N/A\n" +
  "npm run build (package.json:scripts.build) — only when verifying dist output; otherwise N/A\n" +
  "Do not run npm run bench (opt-in, not in the check suite).\n" +
  "Also confirm the artifact is real, fresh, and traceable to this worktree/commit where applicable. Report PASS/FAIL per command with provenance evidence. Do not edit product code.\n\nImplementation summary:\n" + text(impl)
);

return #{
  plan: plan,
  implementation: impl,
  code_review: reviews[0],
  security_review: reviews[1],
  build_verify: verify
};
