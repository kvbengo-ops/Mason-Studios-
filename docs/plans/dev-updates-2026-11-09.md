# Dev updates (2026-11-09): implementation plan

The source is "Maison Studios Dev Updates" (Part 1: change requests; Part 2: API test results).

Two implementers work in parallel:
- **Claude Sonnet** (product and UI) owns the "S" tasks.
- **Codex** (API) owns the "C" tasks.

Each task lists its files, so the two never edit the same file in the same phase. Read `AGENTS.md` first; every rule there applies. In particular:
- `web/` never writes `rendering`, `done` or `failed`.
- No paid probing of vendors: read their docs.
- Every new table needs RLS, a policy and an RLS test.
- Do not run tests locally. Push and read CI.

## Decisions already made (owner, 2026-11-09)

| Topic | Decision |
|---|---|
| Hybrid Editor / AI Animator | A **separate "team" tag**, not a replacement for `editor` / `trusted_editor` / `admin` (those keep controlling spend and permissions). The team only controls which video models an account may use. An admin sets it in Accounts Control. |
| Online status | **Accounts Control**: a green dot means seen in the last 2 minutes, a red dot means not. Implementation: a heartbeat (below), not Realtime presence. |
| Uploaded images | **Keep PNG and JPG byte-for-byte**, so providers get the original. Convert **WebP only**, because Kling rejects WebP. |
| Seedance 2.5 (Kie) | **Remove it for new renders.** Old clips stay viewable. Regenerating or retrying such a scene moves it to Seedance 2.5 BytePlus at 480p. |
| Kie fallback | **Never.** BytePlus video and images never fall back to Kie (`worker/internal/byteplus/router.go`, `web/lib/kie.ts`). |

## Phase 0: prerequisites (before any code)

- **P0. GitHub Actions billing.** Done (2026-11-09). CI runs again, and the Quality picker (`dd798da`, plus its test fix `7007810`) is deployed.
- **R1–R4 (research only: read docs, never submit paid jobs).** Write the findings into this file, under "Research findings", before Phase 1 work that depends on them starts.

| ID | Owner | Question | Feeds |
|---|---|---|---|
| R1 | Codex | Seedance 2.5 on BytePlus (`dreamina-seedance-2-5-260628`): the maximum prompt length; maximum references **per type** (image, video, audio) and in total; maximum video-reference length, each and in total; audio limits. Sources: docs.byteplus.com ModelArk Seedance 2.5 tutorial and API reference. | C1, C2 |
| R2 | Codex | The prompt limits of Kling 4.0, Wan 3.0 and Gemini Omni (kie docs pages). | C1 |
| R3 | Codex | BytePlus video-input pricing. The quote for a 26 s clip falls from $2.673 to $1.845 when a 4 s video reference is added. Check against BytePlus's price sheet (`worker/internal/byteplus` `costUSD`, `web/lib/kie/cost.ts`), and confirm whether the drop is correct or a bug. | C9 |
| R4 | Sonnet | On kie: does ChatGPT Image 2.6 exist, and is it cheaper than 2.5? Does Gemini 1.2 Omni exist? Get model ids, prices and docs links. **Don't add either yet** (Part 1 #5 and #6 can follow later). | S8 |

## Phase 1: parallel work

### Sonnet: product and UI

**S1. Image models (Part 1 #2).**
- Remove `nano-banana-2` from `IMAGE_MODELS` in `web/lib/models.ts`. Nano Banana Pro is already absent; confirm nothing still offers it.
- Image aspect ratios become **9:16, 1:1 and 16:9 only**:
  - `web/lib/image-aspect-ratios.ts` (`IMAGE_ASPECT_RATIOS`)
  - `web/lib/seedream.ts` (`SEEDREAM_PRO_ASPECT_RATIOS`)
  - `web/lib/kie/gpt-image-2-5.ts` (its ratio list)
- Update the tests that pin these lists: `lib/models.test.ts`, `lib/image-draft.test.ts`, `actions/image-generator.test.ts`, `components/image-generator-form.test.tsx`.
- Done when the image picker shows no Nano Banana 2 and offers only the three ratios on every model. An old saved draft with a removed ratio or model falls back cleanly (`getImageModel` already falls back).

**S2. Remove Seedance 2.5 (Kie) (Part 1 #3).**
- Drop `"seedance-2.5"` from `SHOWN_MODEL_IDS` (`web/lib/ugc-options.ts`), and drop the "· Kie" label special case.
- Server side, refuse `seedance-2.5` for every *new* render: `generateClip` and `regenerateClip` (`web/actions/ugc.ts`), plus the retry and rerender paths in `web/actions/enqueue.ts`. A scene saved on `seedance-2.5` is moved to `seedance-2.5-byteplus` at 480p by rewriting `render_settings_override` before it is queued. Write `status='queued'` only, per AGENTS.md.
- **Do not delete** the descriptor in `web/lib/kie/models.ts` or the worker's `seedance25` (`worker/internal/kie/models.go`): old clips and old runs still resolve through them.
- Done when no path can queue a new Kie Seedance 2.5 render, and an old Kie scene regenerates on BytePlus at 480p. Add tests.

**S3. Seedance 2.5 BytePlus: fixed 480p, quality always High (Part 1 #4).**
- `/ugc` picker: offer `seedance-2.5-byteplus` at **480p only**, in `ugc-options.ts`. Don't change `offerable()`, which also serves the API.
- Hide the Quality menu when that model is selected, and always send `quality=high` (`web/components/ugc-column.tsx`, from `dd798da`).
- Server side: `generateClip` and `regenerateClip` force `resolution: "480p"` and `quality: "high"` for `seedance-2.5-byteplus`, and refuse any other resolution with a clear error.
- Done when an editor can't pick 720p or 1080p for that model, and every new scene on it stores `{resolution:"480p", quality:"high"}`.

**S4. Team tag and model access (Part 1 #8).**
- Migration `NNNN_profiles_team.sql`: `profiles.team text null check (team in ('hybrid_editor','ai_animator'))`. RLS: it follows the existing profiles policies, and only admins may write it. Add an RLS test, and a migration-applied check following AGENTS.md (`supabase db query --linked -f`, plus a row in `schema_migrations`, plus a bump to `EXPECTED_DB_VERSION`).
- New pure module `web/lib/model-access.ts`: `canUseVideoModel(team, modelId)`.
  - `hybrid_editor`: every model **except `wan-3.0`**.
  - `ai_animator`: every model.
  - `null` (no team): **every model**, so nobody loses access on deploy. An admin assigns teams afterwards.
  - Unit-test it.
- Enforce it in the `/ugc` picker (`ugc-options.ts`, filtered by the viewer's team) and in `generateClip` / `regenerateClip`.
- Accounts Control: a Team column with a select, saved by a new admin-only action that calls `requireAdmin` (AGENTS.md: a Server Action must have its UI caller in the same change).
- Done when a Hybrid Editor can't see or submit Wan 3.0 and an AI Animator can.

**S5. Online status (Part 1 #7).**
- Migration: `profiles.last_seen_at timestamptz null`.
- `web/app/(app)/layout.tsx` mounts a small client component. Every 60 s, while `document.visibilityState === "visible"`, it calls a server action `touchPresence()`, which first calls `requireUser`, then updates the caller's own row.
- Accounts Control shows a dot next to each account: **green** when `last_seen_at` is within 2 minutes, **red** otherwise, with a "last seen" tooltip.
- Done when a second signed-in browser turns green within about 60 s, and red about 2 minutes after its tab is closed.

**S6. Keep original PNG and JPG uploads (Part 2 #4).**
- `web/lib/to-jpeg.ts` / `toJpeg`: convert **only `image/webp`**; PNG passes through unchanged.
- Check every caller of `uploadFile` (`web/lib/storage.ts`) and anything that assumes a `.jpg` key, including Kling's PNG/JPG rule (`KLING_FRAME_EXTS`).
- Raise nothing: the 10 MB image cap stays.
- Done when a PNG uploaded through the app or the API is stored and served byte-identical. WebP still becomes JPEG.

**S7. Website prompt limit (Part 1 #1).**
- `/ugc` has no overall cap today; only the per-model vendor caps apply (`maxPromptChars`).
- Add a 20,000-character cap with a live counter in the prompt editor (`web/components/ugc-prompt-editor.tsx`), plus a server check in `generateClip` / `regenerateClip` that shares the constant `MAX_PROMPT_CHARS = 20_000`, placed in a new `web/lib/prompt-limits.ts` that Codex imports in C1.
- The per-model vendor cap (from R1/R2) still applies when it's lower.

**S8. Follow-ups (Part 1 #5 and #6).** Using R4's findings, write a short proposal (id, price, receipt plan). **Don't** add either model in this phase.

### Codex: API (`web/lib/api-*.ts`, `web/app/api/v1/**`, `web/app/api/mcp/route.ts`, `docs/api.md`)

**C1. Prompt limit and error (Part 2 #1).**
- Raise the API cap from 5,000 to `MAX_PROMPT_CHARS` (20,000), imported from S7's `web/lib/prompt-limits.ts`. Wait for S7's commit, or create the file with that exact export and let Sonnet reuse it.
- An over-long prompt returns `422 prompt_too_long` with the length and the limit, not the generic `invalid_parameters` error (`web/lib/api-clip.ts:61`).
- The per-model cap from R1 applies after this, through `api-references.ts`'s existing `prompt_too_long` check.
- Done when 20,000 characters is accepted, 20,001 gets a message that names the limit, and the website uses the same number.

**C2. Reference limits per model (Part 2 #2).**
- Replace the flat `MAX_REFERENCES = 10` (`web/lib/ugc-references.ts`) with per-model, per-type limits from R1.
  - Target: Seedance 2.5 BytePlus accepts **8 images, 1 video and 3 audio (12)**, if R1 confirms BytePlus allows it.
  - Kling stays at 1–2 images. Other kie models keep 10.
  - Add a maximum video-reference length if R1 finds one; 31 s was accepted.
- Use the same limits in the `/ugc` References box. This is the one shared file: Codex owns `ugc-references.ts`, and Sonnet doesn't touch it.
- Done when 8+1+3 is accepted for `seedance-2.5-byteplus`, the per-type and total overflow gets a precise error, and tests cover it.

**C3. `aspect_ratio` and `sound` on `/quote` and `/generate` (Part 2 #3).**
- Add the optional fields:
  - `aspect_ratio`: validated with `videoAspectRatioFor`. The default is `9:16`.
  - `sound`: a boolean, default `true`. For Kling it maps to `is_talking_head` sound. For Seedance, audio is always generated while `AUDIO_ENABLED` is on; `sound: false` returns a clear error rather than being ignored.
- Store `aspect_ratio` in `render_settings_override`, as `/ugc` does.
- Document the defaults.

**C4. Element routes (Part 2 #7 and #10).**
- `GET /api/v1/elements/{id}` returns metadata plus a 1-hour `download_url`.
- `PATCH /api/v1/elements/{id}` updates `name`, `description` and `category`.
- `DELETE /api/v1/elements/{id}` soft-deletes, following the app's own element delete rules.
- Upload accepts `shared=true`, following the same rules as `saveSharedElement`.
- Every route is scoped to the token owner and re-checks `element.user_id` (AGENTS.md's elements rule). Add tests.

**C5. Allowance route (Part 2 #15).** `GET /api/v1/allowance` (read scope) returns remaining daily and weekly allowance in USD, reusing `getAccountBudgetSnapshot` (`web/lib/spend.ts`), the same source as `/profile`.

**C6. Remove the internal quote `note` (Part 2 #16).** Drop `note` from `apiClipQuote` (`web/lib/api-clip.ts`). It carries internal task ids and billing history, and the app's own UI still reads it.

**C7. Scope check proof (Part 2 #12).**
- Add a route test: a `read`+`upload` token calling `/generate` and `/images` gets `403 insufficient_scope` before any body parsing.
- This already holds in code (`requireApiToken(request, "generate")` is the first line). The partner's validation errors most likely came from `/quote`, which needs only `read`; say so in the docs.

**C8. Seedance 2.5 (Kie) and BytePlus 480p on the API (Parts 1 #3 and #4).**
- `model_id: "seedance-2.5"` returns `422 model_retired`, naming `seedance-2.5-byteplus`.
- `seedance-2.5-byteplus` accepts only `480p`. Its scenes store `quality: "high"`.
- Update the MCP tool descriptions (`web/app/api/mcp/route.ts`), and remove `nano-banana-2` from the image model examples there.

**C9. Pricing answers (Part 2 #14).** Using R3, either fix the video-reference rate or document why it's lower. In `docs/api.md`, state that:
- BytePlus quotes are its published token rate, and the charge settles at BytePlus's reported tokens.
- Refused and moderated jobs are $0; a vendor-side failure after acceptance is $0 on BytePlus.

**C10. API docs (Part 2 #11, #13 and #15).** Update `docs/api.md` with:
- every new field and route
- image model ids, after S1
- how long files are kept: check the Bin expiry (`isBinEntryExpired`) and whether assets have any automatic cleanup, then state it
- rate limits: 60 writes and 120 reads per minute **per account**, shared by every project and token on that account
- BytePlus concurrency (`BYTEPLUS_MAX_INFLIGHT`)
- that Idempotency-Keys never expire

Optionally, generate `docs/openapi.json` from the same content.

## Phase 2: integration

- **Codex**, after S4 lands: enforce `canUseVideoModel` in `/quote` and `/generate`. A Hybrid Editor's token gets `403 model_not_allowed` for `wan-3.0`.
- **Sonnet**, after C2 lands: confirm the `/ugc` References box shows the new per-type limits.
- Both: update `AGENTS.md` where a rule changed: Seedance Kie retired, BytePlus 480p, the team tag, PNG originals, the 20,000 prompt cap.

## Branches and merging

- One branch per implementer: `feat/dev-updates-product` (Sonnet) and `feat/dev-updates-api` (Codex). Each opens a PR to `main`.
- Owner's call on PR versus direct push; the default is a PR, because this touches money and access.
- Merge order:
  1. S7 / `prompt-limits.ts`
  2. S1–S6 (migrations first)
  3. C1–C10
  4. Phase 2
- Shared files:
  - `web/lib/ugc-references.ts`: Codex only.
  - `web/lib/models.ts`, `ugc-options.ts`, `ugc-column.tsx`, `actions/ugc.ts`: Sonnet only.
  - `web/lib/prompt-limits.ts`: created once, then read-only.
- Migrations get the next free numbers. Coordinate: Sonnet takes both (team, then `last_seen_at`).

## Already answered or shipped (reply to the partner; no work)

| Partner item | Status |
|---|---|
| #5 descriptions | Shipped (`703a7fe`): `description` is saved on `POST /elements`, up to 2,000 characters. |
| #6 description in prompt | Substituted for the `@tag` on Kie models when the element has one. BytePlus Seedance gets the pictures and `@Image N` only, by design. |
| #8 voice length | Shipped: 2–30 s is checked on upload (`invalid_audio_duration`). A refused render is not charged. |
| #9 >10 MB error | Shipped: `413 file_too_large`. `staged_key` (`/elements/upload-url`) is the route for large files. |
| #11 status/output route | `GET /api/v1/jobs/{id}` (status, cost, 1-hour `download_url`) and `GET /api/v1/images/{id}`. See `docs/api.md`. |
| #13 Wan 480p/720p | Shipped: resolution matching ignores case (`480P` = `480p`). |
| Seedream on BytePlus | Shipped (`737ac8d`): every Seedream 5.0 Pro image runs on BytePlus, so its faces pass Seedance 2.5. |

## Research findings

_(R1–R4 results go here, with source links, before the tasks that depend on them start.)_
