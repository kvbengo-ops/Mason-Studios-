# Create redesign — plan

Goal: `/create` is the whole product. Images and video are made in one place,
with no project step, no versions to manage, and Generate always live.

Two agents work in parallel: **Claude** owns the image side and the video
data model; **Codex** owns the video prompt bar. The split is by file so
nobody edits the same file at the same time. Read `AGENTS.md` first — every
rule there applies (status contract, receipts before sale, MODE, guards).

## Status

Done (Claude, branch `feat/image-generate-live`): **T1, T2, T3, T7, T8**.
Open: T4–T6 and T10 (Codex), T9 (Kyle, spends money).

Decisions (Kyle): old versions show as takes; private assets = the Elements
library (images are filed as private elements pointing at the generated
asset, no copy); projects stay for client work.

Notes for Codex: the video bar is `UgcColumn layout="bar"`
(`components/ugc-column.tsx`). Takes and Iterate: `lib/video-iterate.ts`
(window event the bar listens to). Migration `0117` adds `projects.is_personal`
and must be applied to prod before deploy (see AGENTS.md).

## Tasks

| # | Task | Owner | Main files | Spends money |
|---|------|-------|------------|--------------|
| T1 | Generate stays live + rendering placeholder (images) | Claude | `image-generator-form.tsx`, `image-attempt-panel.tsx`, `image-generator-history.tsx` | No |
| T2 | Image shape on the wall + Reuse button | Claude | `image-generator-history.tsx`, `image-lightbox.tsx`, `image-generator-form.tsx` | No |
| T3 | Generated images become private elements ⛔ Q2 | Claude | `actions/image-generator.ts`, migration | No |
| T4 | Pop-up menus for duration, aspect ratio, resolution | Codex | `ugc-column.tsx` | No |
| T5 | Multi-select in the `@` element picker | Codex | `ugc-reference-picker.tsx` | No |
| T6 | Hover preview on `@tags` (image / play video / play audio) | Codex | `ugc-prompt-editor.tsx` | No |
| T7 | Video without projects (hidden personal project) ⛔ Q3 | Claude | migration, `actions/ugc.ts`, `create-video-console.tsx` | No |
| T8 | Takes instead of versions + clip viewer ⛔ Q1 | Claude | `ugc/[id]/page.tsx`, `create-video-console.tsx`, new clip viewer | No |
| T9 | Price receipts for new tiers | Kyle | `scripts/kie/measure-price.mjs` | **Yes** |
| T10 | Wire measured tiers: sound on/off, video/image resolution, Kling 4.0 refs | Codex | `lib/kie/*`, `lib/ugc-options.ts`, `lib/models.ts`, migration | No (after T9) |

Order: T1 → T2 → T3 (Claude) runs alongside T4 → T5 → T6 (Codex). Then T7 →
T8 (Claude, after Codex's `ugc-column.tsx` work is merged). T9 any time;
T10 only after T9's receipts land.

One branch and one PR per task. CI must pass before merge.

## Task details

### T1 — Generate stays live (Claude)
- Remove the "An image is still generating" lock in `image-generator-form.tsx`;
  each press gets its own idempotency key and runs on its own.
- A placeholder tile with a spinner sits first on the wall per in-flight
  attempt (from `useImageAttempts`), replaced by the image when it lands.
- Caps still checked per press (`assertWithinSpendCaps`) — no client cap.
- Done: two presses back to back give two tiles, two images, two `runs` rows.
- Video already queues in parallel; Regenerate on a rendering clip stays
  refused (it would bill twice).

### T2 — Image shape + Reuse (Claude)
- Tiles stay uniform 3:4, but the image is `object-contain` on a dark ground,
  uncropped, with a ratio badge (e.g. `16:9`). Thumbnails: drop the server crop.
- Viewer gets **Reuse**: fills the bar with that image's prompt, `@tags`,
  model and aspect ratio. Needs `runs` to return the model id and ratio
  (`getPersonalImageDetails`).
- Done: Reuse then Generate reproduces the same settings.

### T3 — Images into private assets (Claude) ⛔ Q2
- When an image finishes, insert a private element (`is_shared = false`)
  named `img_NNNN` pointing at the same asset. Deleting the image removes it.
- `@` menu sorts pictures first, newest first, so auto names don't bury refs.
- Needs RLS + policy + RLS test on anything new (AGENTS.md gotcha).

### T4 — Pop-up menus (Codex)
- In bar layout, Length and Aspect ratio become `DropdownMenu`s like Model
  (`ugc-column.tsx`, search `layout === "bar"`). Price shown per option.
- Resolution menu shows only tiers `offerable()` returns; others hidden.
- Done: no `Dialog` left for these three controls on the bar.

### T5 — Multi-select elements (Codex)
- `@` picker (Elements tab): checkboxes + "Add N". Respects `MAX_REFERENCES`
  (10) and the box's `boxTags`/`boxLimit`.
- Done: pick 3, press Add, 3 chips appear and 3 `@tags` are insertable.

### T6 — Hover preview on `@tags` (Codex)
- Hovering a resolved `@tag` in the prompt shows a popover: image thumbnail,
  or a small `<video>`/`<audio>` player for video/audio elements.
- The prompt editor draws a highlight mirror over the textarea — do not change
  padding or font metrics (see `UgcPromptEditorProps.textareaClassName`).

### T7 — Video without projects (Claude) ⛔ Q3
- Migration: `projects.is_personal boolean`, unique per user where true. Never
  match on title.
- Video-tab Generate finds-or-creates it and queues; no name prompt, no
  navigation. Remove `createNamedClipProject`'s dialog field.
- Clips open in a viewer on `/create` (player, prompt, Download, Iterate,
  Delete). Show bitrate there (read off the asset after render).

### T8 — Takes (Claude) ⛔ Q1
- Each Generate/Iterate = a new scene; the wall shows takes newest first.
- Versions rail and "Make current" leave the UI (data untouched).
- Iterate refills the bar with that take's prompt, model, refs, length.

### T9 — Receipts (Kyle, spends money)
Run each at the LONGEST duration with `AUDIO=1` unless measuring silent:
- Seedance 2.5 silent (`AUDIO=0`) — needed for sound off.
- Each video resolution tier wanted (720p, 1080p) per model.
- Each image resolution tier wanted (2K, 4K) per model.
- Kling 4.0 — only after its docs confirm reference inputs (page was empty
  when checked).

```bash
AUDIO=1 node scripts/kie/measure-price.mjs \
  --model <model> --duration <max> --resolution <tier> --yes-this-spends
```

### T10 — Wire measured tiers (Codex, after T9)
- Sound on/off pill for every model with both receipts; others show a fixed
  "Sound on" with a reason.
- Resolution tiers appear in T4's menu once `offerable()` sells them.
- A model added to the rate table needs the `spend_category_totals`
  migration (`spend-category-sql.test.ts`).

## Not doing

- **Choosing bitrate:** kie has no bitrate input (Seedance 2.5, Wan 3.0
  checked). Re-encoding can only lower quality. Bitrate is shown, not set (T7).
