# Plan: admins preview every editor's creations (read-only)

Status: **plan only — not implemented.** Read `AGENTS.md` first; its rules win over
anything here.

## Goal

Today an admin can open an editor's **project** read-only (`requireProjectReadable`,
`/projects/[id]`). They cannot see what an editor made on **/create**: personal images,
personal video clips, or anything the editor deleted.

Add one admin-only, read-only place that shows, per editor:

1. **Images**: personal generated images and their attempts (runs).
2. **Videos**: clips from the editor's clip projects (including the hidden personal one),
   every take, and their runs.
3. **Deleted**: deleted scenes, deleted takes (scene versions) and binned images.

Admins must not be able to change, delete, restore, re-render or download-and-regenerate
anything here. Viewing only.

## What already exists (no migration needed)

RLS already lets an admin **read** everything this needs. Checked in the migrations:

| Table | Admin read branch | Migration |
| --- | --- | --- |
| `projects`, `scenes` | `p.user_id = auth.uid() or is_admin()` | `0002_rls.sql` |
| `scene_versions` | via scenes → projects, `or is_admin()` | `0058` |
| `runs` | `runs.user_id is not null and is_admin()` + project branch | `0085` |
| `assets` | `assets.user_id is not null and is_admin()` + project branch | `0085`, `0099` |
| `deleted_scenes` | `user_id = auth.uid() or is_admin()` | `0088` |
| `deleted_scene_versions` | `user_id = auth.uid() or is_admin()` | `0092` |

So this is a **web-only** feature: new page, new read loaders, no new tables, no new
policies, no worker change. `scenes.status` is not touched.

How deletes work today (what "deleted" can show):

- **Scene delete** → `deleted_scenes` row (whole scene + assets + versions + refs as jsonb),
  written by a BEFORE DELETE trigger. Emptying it from the bin sets `hard_deleted_at`; the
  archive row stays.
- **Take delete** → `deleted_scene_versions` row with a `clip_asset` snapshot. Purge sets
  `hard_deleted_at`; per `0092`, the Storage object is **not** removed.
- **Personal image delete** → `assets.deleted_at` set (bin). **Purge deletes the asset
  row and the Storage file** (`manage_personal_image`, `0114`), so a purged image is
  gone and cannot be previewed.

## Proposed shape

### Route

`/users/[id]/creations`, linked from a "View creations" link on each row of `/users`
(already admin-only via `requireAdmin()`).

- The page calls `requireAdmin()` first. Not `requireProject` (owner-only, rejects
  admins) and not `requireApprover`.
- Tabs as a search param, the same idiom as `/create`: `?tab=images|videos|deleted`.

### Loaders: new file `web/lib/admin-creations.ts`

Plain server functions called by the page **after** `requireAdmin()`. They are not Server
Actions, so they don't need their own UI caller. If one becomes a Server Action (for
example "load more"), it must call `requireAdmin()` itself and have a UI caller in the
same change.

Use the **session client** (`createClient()`), not the service-role client, so RLS stays
a second gate. Every query filters on the target `userId` explicitly.

Do **not** add a `userId` parameter to the existing personal loaders
(`loadPersonalImageHistory`, `loadPersonalImageAttempts`, `CreateVideoConsole`'s reads).
They are deliberately "the caller's own"; their comments say so. Write separate loaders
and copy their filters:

- `loadEditorImages(userId, cursor)`: `assets` where `user_id = userId`,
  `project_id is null`, `kind = 'generated_image'`, `deleted_at is null`.
- `loadEditorImageRuns(userId)`: `runs` where `user_id = userId`, `project_id is null`,
  `idempotency_key is not null`. Same columns as `ATTEMPT_COLUMNS`.
- `loadEditorVideos(userId)`: `projects` where `user_id = userId` and `kind = 'clip'`,
  then scenes, `scene_versions` with a clip, the assets, and `runs`, mirroring
  `CreateVideoConsole`.
- `loadEditorDeleted(userId)`:
  - `deleted_scenes` where `user_id = userId`
  - `deleted_scene_versions` where `user_id = userId`
  - `assets` where `user_id = userId`, `kind = 'generated_image'`, `deleted_at is not null`

  Sign URLs from the archived `storage_key`s with `signedUrl()`.

Resolve any scene's model through `mergeRenderSettings(project, override)`, never
`projects.render_settings` alone (AGENTS.md, Spend caps).

### UI: read-only by construction

Don't reuse components that carry actions (`CreateClipWall` has delete/iterate,
`ImageGeneratorHistory` has delete/download/iterate) unless you give them a `readOnly`
prop that removes every control. Prefer a small presentational grid:

- image or video thumbnail, prompt, model, date, cost (`formatCredits`)
- a "Deleted <date>" badge, plus "Purged" if `hard_deleted_at` is set and that option is
  chosen (see Open questions)
- `<video controls>` for clips. No Iterate, Delete, Restore or Generate buttons.

A header shows whose page this is (email/username) and a "Read-only" label.

### Why the admin cannot write through this

Every mutating action already refuses a non-owner: `requireProject` for project writes,
`requireUser` plus a `user_id` compare for personal images and elements. So even a forged
request from this page fails. The page simply renders no controls that would try.

## Tests (CI runs them; do not run locally unless asked)

- **Page guard:** a non-admin (editor, trusted_editor) is refused by
  `/users/[id]/creations`.
- **Loader scoping:** each loader filters by the target `userId`. One editor's page never
  lists another editor's rows.
- **Read-only:** the rendered page has no Delete/Restore/Iterate/Generate buttons.
- **Deleted tab:** a binned image, a deleted scene and a deleted take each appear. A purged
  image does not.

## Files expected to change

- `web/app/(app)/users/[id]/creations/page.tsx`: new page
- `web/lib/admin-creations.ts`: new loaders
- `web/components/admin-creations-grid.tsx`: new read-only grid (or a `readOnly` prop on
  an existing component)
- `web/app/(app)/users/page.tsx`: "View creations" link per row
- tests next to each

No migration. No worker change. No `EXPECTED_DB_VERSION` bump.

## Open questions (ask the owner before building)

1. **Who counts as an "editor"?** Only `editor`, or also `trusted_editor` and other admins?
2. **Purged scene and take archives** (`hard_deleted_at` set): show them, or only what is
   still in the editor's bin? Purged images cannot be shown either way; their file is gone.
3. **Deleted Elements** (`elements.deleted_at`, `0099`): include them in Deleted? Note that
   `elements_select` hides deleted rows even from admins, so including them needs a policy
   change and an RLS test.
4. **Entry point:** a link from `/users` (proposed), a new sidebar item, or both?
5. **Download:** may an admin download an editor's image or clip, or view only?

## Not in scope

- Any write by an admin on an editor's work (restore, delete, re-render).
- Notifying the editor that an admin looked.
- Changing `/create`, `/bin` or the personal loaders.
