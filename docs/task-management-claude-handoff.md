# TM-05 / TM-06 handoff - Claude

Supplied by Claude for Codex to record in [task-management-todo.md](task-management-todo.md)
(Codex owns that checklist; this file is the input, not an edit to it).

## State: rebuilt for assignment-only at `33cc0e5`

**Superseded the 0107 contract.** Two backend lines existed in parallel: this
branch's `dd6d8fc`, and `0e76661` on `feat/spend-dashboard-alerts` in the main
checkout, which is the one applied to the local database. The second added
migrations `0109_task_assignment_only`, `0110_task_priority` and
`0111_task_assignment_projections`, none of which existed on this branch. They
share an identical `0107`/`0108` base, so those three were brought over here
along with `actions/tasks.ts`, `lib/tasks.ts`, `types/db.ts`, `version.ts` and
the updated contract.

What that changed for the UI:

- `0109` revokes `submit_task_assignment` and `review_task_submission` from
  authenticated callers. The submission and review UI is **deleted**, not
  hidden — `task-review-controls.tsx` and its test are gone, and
  `task-assignment-controls.tsx` is Start work only. Three actions remain:
  `createTask`, `startTaskAssignment`, `cancelTask`, each with one caller.
- `0111` renamed the read projections. `completed_count` and
  `submitted_count` no longer exist, which is why the list card rendered
  "undefined of 1 completed" until this commit.
- `0110` added `tasks.priority`; the creation form now sets it, plus the
  deadline presets that migration's comment anticipated.

Creation moved from `/tasks/new` into a dialog over the list; that route is
removed. Verified in the running app against the local database at `0111`:
the list, filters, priority and deadline pickers, and the emphasis colour all
render correctly.

Still not run, per AGENTS.md: tsc, lint, and the test suite. The three test
files were updated for the narrowed contract but have never been executed.

**Branch hazard for whoever integrates:** `feat/spend-dashboard-alerts` still
carries its own uncommitted copy of the task backend. That work needs to land
on a real feature branch, or these two lines will diverge again.

