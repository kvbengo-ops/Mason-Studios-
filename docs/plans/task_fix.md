# task_fix: implementation briefs

Each brief below is self-contained. Paste it into the agent as-is. The full plan, with context, decisions and file ownership, is in `docs/plans/dev-updates-2026-11-09.md`. Both agents must read that file and `AGENTS.md` before starting.

**Order**
1. **Research first:** Codex does R1–R3, Sonnet does R4. Results go into the plan's "Research findings" section.
2. **Phase 1, in parallel:** Sonnet does S1–S8; Codex does C1 and C3–C10. C2 waits for R1.
3. **Phase 2:** Codex adds team checks to the API (needs S4). Both update `AGENTS.md`.

**Merge order:** `web/lib/prompt-limits.ts` (S7) → Sonnet's migrations (S4, S5) → the rest of Sonnet → Codex → Phase 2.

CI is working again: billing is fixed, and run #81's fix deployed as `7007810`.

---

## Brief for Codex (API)

```
Repo: kvbengo-ops/Mason-Studios- (Next.js web/ + Go worker/, one Supabase Postgres).
Read AGENTS.md and docs/plans/dev-updates-2026-11-09.md first. Their rules override
anything here. Key rules:
- web/ never writes scenes.status rendering/done/failed.
- Never submit paid vendor jobs to probe limits: read the docs.
- BytePlus never falls back to Kie.
- Don't run tests locally: push and read CI.

Branch: feat/dev-updates-api from main. Open one PR to main when done.

You own ONLY these files: web/lib/api-*.ts, web/app/api/v1/**,
web/app/api/mcp/route.ts, web/lib/ugc-references.ts, docs/api.md, and new files you
create for these tasks. Don't edit web/lib/models.ts, web/lib/ugc-options.ts,
web/components/ugc-column.tsx or web/actions/ugc.ts: Sonnet owns them.

STEP 0: research. Read docs only, then write the findings with source links into
docs/plans/dev-updates-2026-11-09.md under "Research findings":
- R1: BytePlus Seedance 2.5 (dreamina-seedance-2-5-260628):
  - maximum prompt length
  - maximum references per type (image, video, audio) and in total
  - maximum video-reference length, each and in total
  - audio limits
- R2: prompt limits for Kling 4.0, Wan 3.0 and Gemini Omni on kie.
- R3: BytePlus video-input pricing. Explain why a 26 s quote falls from $2.673 to
  $1.845 when a 4 s video reference is added. Fix it if it's a bug.

TASKS (each one: done = code + a test + docs/api.md updated):
C1. API prompt cap 5,000 -> 20,000.
    - Import MAX_PROMPT_CHARS from web/lib/prompt-limits.ts (Sonnet's S7). If S7
      hasn't landed, create the file with exactly:
        export const MAX_PROMPT_CHARS = 20_000;
    - Over the cap -> 422 prompt_too_long, naming the length and the limit
      (today it's the generic invalid_parameters at web/lib/api-clip.ts:61).
    - The per-model vendor cap still applies after this.
C2. (after R1) Per-model, per-type reference limits, replacing the flat
    MAX_REFERENCES=10 in web/lib/ugc-references.ts.
    - Target for seedance-2.5-byteplus: 8 images + 1 video + 3 audio (12), if R1
      allows it.
    - Kling: 1-2 images. Other kie models: 10.
    - Return a precise error for per-type and total overflow.
    - The /ugc References box uses the same limits.
C3. Optional fields on /quote and /generate:
    - aspect_ratio: validate with videoAspectRatioFor; default 9:16; store it in
      render_settings_override.
    - sound: boolean, default true. Kling maps it to is_talking_head sound.
      Seedance always generates audio, so sound:false is a clear 422, never
      silently ignored.
C4. Element routes:
    - GET /api/v1/elements/{id}: metadata + a 1-hour download_url
    - PATCH /api/v1/elements/{id}: name, description, category
    - DELETE /api/v1/elements/{id}: soft delete, the same rules as the app's
      element delete
    - POST /elements accepts shared=true, the same rules as saveSharedElement
    - Scope everything to the token owner and re-check element.user_id
      (AGENTS.md).
C5. GET /api/v1/allowance (read scope): remaining daily and weekly USD, reusing
    getAccountBudgetSnapshot (web/lib/spend.ts).
C6. Remove `note` from apiClipQuote (web/lib/api-clip.ts). It leaks internal task
    ids and billing history.
C7. Route test: a read+upload token calling /generate and /images gets
    403 insufficient_scope before any body parsing.
C8. Model changes on the API:
    - model_id "seedance-2.5" -> 422 model_retired, naming seedance-2.5-byteplus.
    - seedance-2.5-byteplus accepts only 480p, and its scenes store
      quality:"high".
    - Update the MCP tool descriptions, and drop nano-banana-2 from the examples.
C9. Pricing (from R3): fix or document the video-reference rate. In docs/api.md,
    state that:
    - BytePlus quotes are its published rate and settle at BytePlus's reported
      tokens.
    - Refused or moderated jobs cost $0, and a failed BytePlus job costs $0.
C10. docs/api.md:
    - every new field and route
    - image model ids
    - how long files are kept (check isBinEntryExpired and any asset cleanup)
    - rate limits: 60 writes and 120 reads per minute per ACCOUNT
    - BytePlus concurrency (BYTEPLUS_MAX_INFLIGHT)
    - Idempotency-Keys never expire
    - optional: docs/openapi.json

PHASE 2 (after Sonnet's S4 merges): enforce canUseVideoModel (web/lib/model-access.ts)
in /quote and /generate. A blocked model -> 403 model_not_allowed.

Report when finished: the PR link, CI status, and which research questions stayed
unresolved.
```

---

## Brief for Claude Sonnet (product and UI)

```
Repo: kvbengo-ops/Mason-Studios- (Next.js web/ + Go worker/, one Supabase Postgres).
Read AGENTS.md and docs/plans/dev-updates-2026-11-09.md first. Their rules override
anything here. Key rules:
- web/ writes scenes.status 'queued' at most, never rendering/done/failed.
- Every new table or column needs RLS, a policy and an RLS test.
- A Server Action ships with its UI caller in the same change.
- Never submit paid vendor jobs.
- BytePlus never falls back to Kie.
- Don't run tests locally: push and read CI.

Branch: feat/dev-updates-product from main. Open one PR to main when done.

You own: web/lib/models.ts, web/lib/ugc-options.ts, web/components/ugc-column.tsx,
web/actions/ugc.ts, web/actions/enqueue.ts, web/lib/image-aspect-ratios.ts,
web/lib/seedream.ts, web/lib/kie/gpt-image-2-5.ts, web/lib/to-jpeg.ts,
web/lib/storage.ts, the image-generator files, Accounts Control, web/app/(app)/layout.tsx,
supabase/migrations (new files), and new files for these tasks.
Don't edit web/lib/api-*.ts, web/app/api/**, web/lib/ugc-references.ts or
docs/api.md: Codex owns them.

STEP 0: research (R4). Read kie's docs only. Does ChatGPT Image 2.6 exist, and is it
cheaper than 2.5? Does Gemini 1.2 Omni exist? Get ids, prices and links. Write them
into the plan's "Research findings". DON'T add either model.

TASKS (each one: done = code + tests updated or added):
S7 FIRST (Codex imports it):
    - Create web/lib/prompt-limits.ts with
        export const MAX_PROMPT_CHARS = 20_000;
    - /ugc prompt editor (web/components/ugc-prompt-editor.tsx): a live counter
      and a block above the limit.
    - Server check in generateClip / regenerateClip.
    - Per-model vendor caps (maxPromptChars) still apply when lower.
S1. Image models:
    - Remove nano-banana-2 from IMAGE_MODELS. Confirm Nano Banana Pro is
      offered nowhere.
    - Image aspect ratios become 9:16, 1:1, 16:9 ONLY: IMAGE_ASPECT_RATIOS,
      SEEDREAM_PRO_ASPECT_RATIOS, GPT 2.5's list.
    - Fix the tests that pin these lists. Old drafts must fall back cleanly.
S2. Retire Seedance 2.5 (Kie):
    - Drop "seedance-2.5" from SHOWN_MODEL_IDS and the "· Kie" label special
      case.
    - generateClip, regenerateClip and the retry/rerender paths in enqueue.ts
      must never queue it. A scene saved on seedance-2.5 is rewritten to
      seedance-2.5-byteplus at 480p before queueing.
    - KEEP the descriptors in web/lib/kie/models.ts and worker seedance25:
      old clips still use them.
    - Old clips stay viewable.
S3. Seedance 2.5 BytePlus:
    - /ugc offers 480p only (filter in ugc-options.ts; don't change
      offerable()).
    - Hide the Quality menu for this model and always send quality=high.
    - Server: force {resolution:"480p", quality:"high"} for this model in
      generateClip / regenerateClip, and refuse any other resolution.
S4. Team tag (owner decision: separate from editor/trusted/admin):
    - Migration: profiles.team text null
      check (team in ('hybrid_editor','ai_animator')). Admins only may write
      it. Add an RLS test.
    - Apply it per AGENTS.md (supabase db query --linked -f, the
      schema_migrations row, EXPECTED_DB_VERSION).
    - New pure module web/lib/model-access.ts, with unit tests:
        canUseVideoModel(team, modelId)
        hybrid_editor -> every model except "wan-3.0"
        ai_animator   -> every model
        null          -> every model (nobody loses access on deploy)
    - Enforce it in the /ugc picker and in generateClip / regenerateClip.
    - Accounts Control: a Team column with a select, saved by a new action
      that calls requireAdmin.
S5. Online status in Accounts Control:
    - Migration: profiles.last_seen_at timestamptz null.
    - In web/app/(app)/layout.tsx, a client component calls a server action
      touchPresence() every 60 s while the tab is visible. touchPresence
      calls requireUser, then updates only the caller's own row.
    - Accounts Control: a green dot within the last 2 minutes, red
      otherwise, with a "last seen" tooltip.
S6. Keep originals:
    - toJpeg converts ONLY image/webp; PNG and JPG pass through unchanged.
    - Check every uploadFile caller, anything that assumes a .jpg key, and
      Kling's PNG/JPG rule.
    - The 10 MB cap stays.
S8. A short proposal from R4's findings (id, price, receipt plan) in the plan doc.
    No code.

PHASE 2: after Codex's C2 merges, confirm the /ugc References box shows the new
per-type limits. Update AGENTS.md for:
- Seedance Kie retired
- BytePlus 480p + High
- the team tag
- PNG originals
- the 20,000 prompt cap

Report when finished: the PR link, CI status, the migration numbers used, and
anything you couldn't verify.
```
