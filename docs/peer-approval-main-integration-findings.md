# Peer approval × latest `main`: integration findings

**For Claude, Codex, and the developer who integrates these branches.**

Inspection date: 2026-09-02. No merge, rebase, migration rename, or code resolution was
performed as part of this inspection.

> **Live update after the inspection:** another process started an interactive rebase of
> `feat/peer-allowance-approval` onto `472fd11`. At last read, Git reported the first commit
> (`0b10db6`) applied, the second (`71addd3`) still queued, and the rebase paused on exactly
> the two predicted conflicts: `web/app/(app)/allowances/page.tsx` and
> `web/lib/version.ts`. These findings files remain untracked. Do not run `rebase --continue`,
> `--abort`, or `--skip` unless you own that operation. The rebase does not by itself settle
> the duplicate `0062` production-history problem. A later status read showed the active
> rebase had staged the peer file as `0074_peer_allowance_approval.sql`; the two code
> conflicts were still unresolved.

Renaming peer approval to `0074` is a plausible tree-level choice, but it is not sufficient
production reconciliation by itself. If production recorded version `0062` when the peer
migration ran, then a merged tree whose `0062` is the template seed can cause migration
tooling to consider that different seed already applied. At the same time, the new `0074`
peer file may look unapplied and be replayed. Confirm the ledger and logical database state,
then choose an explicit forward-only repair for whichever change the ledger would otherwise
skip.

## Current Git state inspected

- Feature branch: `feat/peer-allowance-approval`
- Feature HEAD: `71addd3` (`Give /users a trusted-editor toggle`)
- Feature-only commits from merge base `24fcba0`: `0b10db6`, `71addd3`
- Latest `origin/main` inspected: `472fd11`, containing the new UGC route work from
  `b05fe51` plus the project-button follow-up
- The feature branch matched `origin/feat/peer-allowance-approval` when inspected.
- The working tree also contained untracked `DEV_A_TODO.md`, `PEER_APPROVAL_TODO.md`, and
  `PR_BODY.md`. Preserve them before any operation that rewrites the worktree.

The branch/HEAD changed during the inspection itself (an earlier local state had a third
commit). Treat the hashes above as the recorded comparison point and run `git fetch` plus the
commands at the end again immediately before integration.

## Size and severity

The overall UGC change on `main` is large, but its direct overlap with peer approval is
narrow: five files. The merge is **not a large rewrite**. Four resolutions are trivial or
mechanical; one migration-history collision requires deliberate coordination.

| File | What overlaps | Assessment / intended resolution |
|---|---|---|
| `AGENTS.md` | Peer-approval rules vs. `MODE=development`, Kie, and caption updates | Minor; separate documentation regions and merge-tree can combine them automatically. Preserve both sets of facts. |
| `web/app/(app)/allowances/page.tsx` | Peer approver/admin visibility and cap logic vs. Fal → Kie balance rename | Moderate but mechanical; predicted textual conflict. Keep all peer-approval gates, use `getKieAccountBalanceUsd`, and make the Kie balance read admin-only: `adminViewer ? await getKieAccountBalanceUsd() : null`. Rename the local balance variable and UI text consistently. |
| `web/components/decide-allowance-request-dialog.tsx` | Peer ceiling validation vs. Fal → Kie wording | Minor; only the main-side comments/wording overlap and merge-tree combines it automatically. Keep peer validation and Kie wording. |
| `web/components/nav-links.tsx` | Trusted-editor allowance link vs. UGC navigation explanation | Minor; separate additions and merge-tree combines them automatically. Preserve both. |
| `web/lib/version.ts` | Both branches bump `EXPECTED_DB_VERSION` | Trivial code conflict, but its correct value depends on resolving the migration collision below. Do not resolve this file first. |

A three-way `git merge-tree` preview predicted textual conflict markers only in:

1. `web/app/(app)/allowances/page.tsx`
2. `web/lib/version.ts`

## The real blocker: duplicate migration version `0062`

Both branches independently added a migration with the same Supabase migration version:

- Feature: `supabase/migrations/0062_peer_allowance_approval.sql`
- Main: `supabase/migrations/0062_seed_template_v10.sql`

Main then continues through `0073_element_location_category.sql`. The peer-approval TODO
records that its `0062` is already applied to production and that
`applied_schema_version()` returned `0062` at that time. Therefore this is not merely a
filename preference and must not be fixed by blindly renaming the peer migration.

Before integrating:

1. Run `supabase migration list` against the linked production project and record which
   `0062` history the database knows, plus whether main's `0063`–`0073` are already applied.
2. Confirm the peer objects exist (`can_approve_allowance()` and the three policy changes)
   and confirm the template-v10 seed state independently. A version number alone cannot
   prove which logical migration ran.
3. Coordinate with the UGC-route owner on a forward-only reconciliation. The merged tree
   needs unique migration versions and must preserve any migration already recorded in the
   live history. If the two environments already have different histories for `0062`, write
   an explicit reconciliation plan/migration rather than rewriting history silently.
4. Only after that decision, set `EXPECTED_DB_VERSION` to the actual highest migration in
   the reconciled tree and run its drift test.

Do not apply SQL merely to test this merge. Per the repository rules, SQL application and
read-back target selection must be explicit, and production already contains at least the
peer-approval change.

## Shared-checkout warning

During this inspection, HEAD moved from an earlier three-commit feature state to `71addd3`,
and the TODO files changed from tracked/modified to untracked. That is evidence that another
process or developer is operating on this exact checkout. Before merging or rebasing:

- coordinate ownership of the terminal/checkout;
- preserve the three untracked handoff files;
- confirm the dev server can tolerate the branch switch; and
- rerun the comparison because remote refs may move again.

This source-control overlap is separate from the runtime warning in the app: local web is
also pointed at the hosted production database, so UI writes can affect another developer's
data even when Git files do not conflict.

## Reproduce the comparison safely

These commands are read-only apart from `git fetch` updating remote-tracking refs:

```bash
git fetch --prune origin
git status --short --branch
base=$(git merge-base HEAD origin/main)
git log --oneline "$base..HEAD"
git log --oneline "$base..origin/main"
git diff --name-only "$base..HEAD"
git diff --name-only "$base..origin/main"
git merge-tree "$base" HEAD origin/main
```

On PowerShell, assign `$base = git merge-base HEAD origin/main` and use
`"$base..HEAD"` / `"$base..origin/main"` in the same commands.

## Handoff conclusion

The code merge is small. The allowances page needs a careful but obvious combined version;
the other overlapping code is minor. The duplicate applied `0062` is the only material
integration risk and must be settled before the PR is merged.
