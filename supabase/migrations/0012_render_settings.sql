-- =============================================================================
-- projects.render_settings — per-project render configuration
--
-- Until now every render was submitted with fal's defaults for everything we
-- did not explicitly set. That turned out to be three separate bugs, all
-- invisible because the request simply succeeded:
--
--   * generate_audio defaults to TRUE on fal-ai/ltx-2.3/image-to-video/fast,
--     so every clip we called "silent" was in fact generated with audio.
--   * aspect_ratio defaults to 'auto', so fal guessed the framing from the
--     reference frame instead of being told 9:16, which is the only aspect
--     ratio this product delivers.
--   * fps defaults to 25, and ffmpeg then resampled it to 24 on ingest — a
--     generation-quality loss for no reason at all.
--
-- Resolution and fps are the two knobs worth exposing to the operator, and
-- resolution is the one that moves the bill: 1080p $0.04/s, 1440p $0.08/s,
-- 2160p $0.16/s. That is a 4x spread on the single most expensive step in
-- the product, so it has to be a stored, per-project decision the render
-- gate can price — not an env var, and not a hardcoded constant.
--
-- Shape (all keys optional; absent keys fall back to the defaults below):
--
--   {"model": "ltx-2.3-fast", "resolution": "1080p", "fps": 24}
--
-- DEFAULT '{}' rather than the populated object on purpose: existing rows
-- and new rows then read identically through the same "absent key means
-- default" path, so there is exactly one place that decides what the
-- default is (web/lib/models.ts DEFAULT_RENDER_SETTINGS and its Go mirror
-- fal.DefaultRenderSettings) instead of two that can disagree. A populated
-- server default would freeze today's defaults into every row ever written
-- and make changing them a data migration.
--
-- NO CHECK CONSTRAINT ON THE JSON, deliberately. See the section below —
-- the same reasoning that removes scenes_duration_s_check applies here in
-- advance. Validation lives in Zod (web/lib/models.ts RenderSettings, run
-- by actions/render-settings.ts before every write) and in the model
-- descriptor (worker/internal/fal/models.go), both of which know which
-- values are legal *for the selected model*. SQL does not and cannot.
--
-- =============================================================================
-- DROP scenes_duration_s_check (added in 0010)
--
-- 0010 encoded fal-ai/ltx-2.3's allowed clip lengths — 6, 8, 10, 12, 14, 16,
-- 18, 20 — directly into the table:
--
--   check (duration_s in (6, 8, 10, 12, 14, 16, 18, 20))
--
-- That was right when there was exactly one video model and no prospect of
-- another. It is wrong now: it hardcodes ONE vendor's input enum into the
-- schema, so adding a second model whose allowed durations differ (Kling
-- and Veo both do) cannot be a data change — it requires a migration, and a
-- migration that must be deployed in lockstep with the code that offers the
-- new model. A schema constraint that has to be edited every time a vendor
-- ships a variant is a constraint in the wrong layer.
--
-- What replaces it, and why that is enough:
--
--   1. web/lib/claude.ts — the compiler's Zod schema builds duration_s's
--      literal enum from the selected model's descriptor. This is the
--      strongest layer, because the schema feeds zodOutputFormat() and so
--      steers what Claude generates rather than only rejecting it after.
--   2. web/lib/enqueue-guard.ts — assertRenderableDurations() is handed the
--      same descriptor and refuses to enqueue a batch containing a duration
--      the selected model rejects. This is the render gate: nothing reaches
--      fal without passing it.
--   3. web/actions/brief.ts — clampDuration() snaps operator-typed values to
--      the descriptor's nearest allowed length before writing.
--
-- What is genuinely lost: a direct SQL write can now store an unrenderable
-- duration_s. That is accepted. Such a row is not dangerous — it is caught
-- at the gate before any money moves, with an error naming the fix — and the
-- constraint was already `not valid`, so pre-v1-template rows sitting at
-- 2s/2.5s/4s were never covered by it anyway. The constraint's real-world
-- protection was already partial; its cost was total.
--
-- duration_s keeps `> 0` implicitly through nothing at all now, so the
-- positivity half of the original 0001 constraint is restored explicitly
-- below — that part is model-independent and belongs in the schema.
-- =============================================================================

alter table projects
  add column if not exists render_settings jsonb not null default '{}'::jsonb;

comment on column projects.render_settings is
  'Per-project render config: {"model","resolution","fps"}. Absent keys fall back to '
  'the defaults in web/lib/models.ts / worker/internal/fal/models.go. Deliberately '
  'unconstrained in SQL — validation is per-model and lives in the descriptor; see 0012.';

alter table scenes drop constraint if exists scenes_duration_s_check;

-- Model-independent floor only. Every model on the market rejects a
-- non-positive duration, so this one is safe to keep in the schema; the
-- per-model allowed *set* is not, which is the whole point of 0012.
alter table scenes
  add constraint scenes_duration_s_positive
  check (duration_s > 0)
  not valid;

comment on constraint scenes_duration_s_positive on scenes is
  'Model-independent floor. The per-model allowed duration set moved to the model '
  'descriptor (web/lib/models.ts, worker/internal/fal/models.go) in 0012.';
