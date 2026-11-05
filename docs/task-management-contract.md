# Task assignment contract

This contract defines the active task feature: an active trusted editor creates a task and assigns it to active regular editors. Submission and review are outside this lane.

The database scaffold for future submissions remains from migration `0107_task_management.sql`. Migration `0109_task_assignment_only.sql` revokes authenticated access to its submission/review RPCs, while `0110` adds priority and `0111` removes submission fields from active assignment projections.

## Product decisions

- An active `trusted_editor` is the only role that can create, assign, or cancel tasks.
- **All regular editors** means one assignment per active account with `role = 'editor'` and `status = 'active'` at creation time.
- **Selected editors** requires a non-empty set of active regular editors. The recipient set is snapshotted; later signups do not receive an existing task.
- The creator chooses a priority: `urgent`, `high`, `normal`, or `low`. `urgent` is the same-day signal; it does not change authorization or spend behavior.
- The creator may choose no deadline, today, tomorrow, this week, or a custom date/time. The server stores the resulting explicit UTC timestamp in `due_at` (or `null` for no deadline).
- A task is independent of projects, scenes, rendering, allowances, and spend caps. Assigning work never grants project access or starts generation.
- Admins have a **read-only** task-management surface (`0118_task_admin_read.sql`): the sidebar entry, every task in the workspace, and each task's roster. They cannot create, cancel, assign, start or complete anything — the write RPCs still demand `is_active_task_manager()` or the assignee themselves, so the read widened and nothing else did. If the creator is later demoted, existing records remain for audit and are not reassigned automatically.

## Data model used by assignment

### `tasks`

`id uuid`, `created_by uuid`, `title text`, `brief text`, `deliverable_description text`, `due_at timestamptz null`, `priority text` (`urgent`, `high`, `normal`, or `low`), `audience text` (`all` or `selected`), `request_key uuid`, timestamps, and `cancelled_at`.

The creator must be an active trusted editor. `request_key` is unique per creator so a retried create request returns the same task. Title is 1–160 characters; brief is 1–10,000; deliverable description is 1–2,000.

### `task_assignments`

`id uuid`, `task_id uuid`, `assignee_id uuid`, `status`, timestamps, and cancellation/start markers. Unique `(task_id, assignee_id)` prevents duplicate recipients.

Assignment statuses currently stored by the database are `assigned`, `in_progress`, `submitted`, `changes_requested`, `completed`, and `cancelled`. This lane uses only `assigned`, `in_progress`, and `cancelled`; the remaining values are retained for Darwin's future submission workflow.

## Active server interface

Actions return `ActionResult` (`undefined` on success or `{ error: string }` for an expected refusal). Unexpected database failures throw.

```ts
createTask(input: CreateTaskInput): Promise<{ taskId?: string; error?: string }>
startTaskAssignment(assignmentId: string): Promise<ActionResult>
cancelTask(taskId: string): Promise<ActionResult>
```

`createTask` accepts `title`, `brief`, `deliverableDescription`, `dueAt` (nullable ISO timestamp), `priority` (`urgent`, `high`, `normal`, or `low`; defaults to `normal`), `audience`, `assigneeIds` (required for `selected`, ignored for `all`), and a UUID `requestKey`. Server code never accepts `createdBy` or an actor role.

The active database RPCs are `task_eligible_assignees`, `my_task_assignments`, `managed_tasks`, `task_assignment_directory`, `create_task`, `start_task_assignment`, and `cancel_task`. The submission/review RPCs are present only as dormant Darwin scaffolding and are not executable by authenticated callers.

## Reads and visibility

- `listEligibleTaskAssignees()` returns only active regular-editor IDs, usernames, and emails to an active trusted editor.
- `listMyTaskAssignments()` returns assignments belonging to the caller, bounded to 100 rows and ordered by due date.
- `listManagedTasks()` returns tasks created by the caller with assignment counts, bounded to 100 rows.
- `getTask(taskId)` returns the task and assignment directory to an authorized participant. It does not load submission rows.

Task participants are the creator and the assigned editor. A participant read never grants access to another editor's assignment or project. RLS remains enabled on all task tables, and writes happen through guarded transactional RPCs.

Due dates are stored in UTC. Overdue display is derived from `due_at` and a non-terminal assignment status.

## Assignment lifecycle

```text
assigned -> in_progress
assigned/in_progress -> cancelled
```

Only the assigned active regular editor can start work. Only the task creator can cancel the task. Each lifecycle RPC locks the target row and checks its current status in the same transaction, so stale requests cannot overwrite a newer assignment state.

## Notifications

Active assignment events are `task_assigned` and `task_cancelled`. They carry `task_id` and `task_assignment_id` references and notify the assigned editor. Existing submission-related notification kinds and constraints remain in the database for Darwin's follow-up, but the assignment-only web surface does not emit or render them.

## Validation and error text

- “Choose at least one active regular editor.”
- “That editor is no longer eligible. Reload and choose recipients again.”
- “This assignment has already moved on. Reload to see its current status.”
- “Only the assignee can update this assignment.”
- “Choose a valid task priority.”

Every mutation revalidates `/tasks`, `/tasks/[id]`, and the root layout. A UI caller is still required before any action is considered shipped.
