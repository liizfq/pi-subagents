/**
 * run-phase.js — the shape a workflow script should converge in.
 *
 * Demonstrates: the `runPhase()` wrapper (one try/catch per phase), a
 * top-level `try/catch/finally` that always returns a terminal object, and
 * the optional `__onWorkflowAbort` hook the runtime calls inside the abort
 * grace window.
 *
 * The runtime gives a stopped script a grace window before it is
 * hard-terminated: pending `agent()` calls reject with a catchable fatal
 * error (so `parallel()`/`pipeline()` rethrow instead of folding an abort
 * into a `null` item), `__onWorkflowAbort` runs, and only then is the worker
 * terminated. A script that wraps every phase and keeps its `finally` free of
 * anything that can throw therefore leaves a terminal record even when it is
 * aborted. The run-status file and the completion notification are the
 * runtime's job; this example is the script side of that contract.
 *
 * No per-phase timeouts here — the runtime's watchdog already flags an idle
 * run (warning, then stalled, then timed out). `Promise.race` against a
 * timeout would also need a timer that this sandbox does not provide.
 *
 * args: { subjects?: string[] }
 *
 * Run: ask the model — "run the workflow at examples/workflows/run-phase.js".
 */
export const meta = {
  name: 'run-phase',
  description: 'A phase-wrapped, abort-converging workflow',
  phases: [{ title: 'Audit' }, { title: 'Summarize' }],
}

// Optional: the runtime calls this once inside the abort grace window, before
// the worker is terminated. Best-effort — an abort proceeds regardless of what
// this does. A script that never assigns it simply never gets the callback.
__onWorkflowAbort = () => {
  log('abort noticed — wrapping up')
}

const subjects = args?.subjects ?? ['a.ts', 'b.ts']

/**
 * Wrap one phase so a failure or abort is recorded, then re-thrown as an
 * error carrying an `outcome` the top level can read. Deterministic by design:
 * no timestamps, no randomness — a script that varies run to run cannot be
 * replayed from its journal.
 */
async function runPhase(title, fn) {
  phase(title)
  log(`phase ${title}: started`)
  try {
    const result = await fn()
    log(`phase ${title}: done`)
    return result
  } catch (error) {
    const state = error && error.workflowFatal ? 'aborted' : 'failed'
    log(`phase ${title}: ${state} — ${error && error.message}`)
    // Thrown so the top level converges; `workflowFatal` survives the rethrow.
    error.outcome = { state, title }
    throw error
  }
}

let terminal
try {
  const audit = await runPhase('Audit', () =>
    parallel(subjects.map(subject => () =>
      agent(`Audit ${subject}`, { label: `audit:${subject}`, effort: 'low' }),
    )),
  )
  const summary = await runPhase('Summarize', () =>
    agent(`Summarize the audits of ${subjects.join(', ')}`, { label: 'summarize', effort: 'high' }),
  )
  terminal = { ok: true, audited: audit.length, summary }
} catch (error) {
  terminal = {
    ok: false,
    state: (error && error.outcome && error.outcome.state) ?? 'failed',
    phase: error && error.outcome && error.outcome.title,
    error: error && error.message ? error.message : String(error),
  }
} finally {
  // Best-effort and free of anything that can throw: the runtime settles the
  // run's own status (completed / failed / killed) on its own.
  log(`run ${terminal.ok ? 'succeeded' : 'failed'} — ${terminal.state}`)
}

return terminal
