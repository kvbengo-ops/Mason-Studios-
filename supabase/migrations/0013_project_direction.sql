-- =============================================================================
-- projects.{shooting_mode,camera_movement,visual_idea,voice_profile,
--           pronunciation_guide,ugc_style} — the six directorial inputs
--
-- Per .claude/aug-14/SMN-feature-spec.md §3.1/§3.3, the compiler is the
-- product, and until now we only ever handed it the raw script. Everything
-- that makes the reference tool's output feel directed instead of generic
-- — shooting mode, the camera-shake override, a global visual override, a
-- voice profile, a pronunciation guide, and the UGC style — never reached
-- the prompt at all. This migration adds storage for those six inputs so
-- they can be collected on the Character page and interpolated into the
-- system prompt by web/lib/claude.ts.
--
-- Why plain typed columns, not jsonb like render_settings (0012):
--
-- render_settings is jsonb because its legal shape is vendor-shaped and
-- model-dependent — which keys are valid, and which values those keys
-- accept, changes every time a video model is added, and that knowledge
-- lives in a model descriptor (web/lib/models.ts), not in the schema. The
-- six columns here are the opposite case on every axis that mattered
-- there:
--
--   * They do not vary by model. shooting_mode, camera_movement,
--     visual_idea, voice_profile, pronunciation_guide and ugc_style mean
--     the same thing regardless of whether the project renders on Kling
--     or LTX. There is no descriptor these values need to be validated
--     against, because nothing downstream branches on "which vendor" to
--     decide whether they're legal.
--   * They are not vendor-shaped. They are OUR product vocabulary — the
--     wizard's own field set, not a passthrough of some provider's request
--     body. There is no vendor API whose contract could change these
--     values out from under us the way a new fal model could change what
--     render_settings needs to hold.
--   * We want to query and default them. A project row with these as
--     first-class columns can be selected, filtered, and defaulted with
--     ordinary SQL (`shooting_mode = 'selfie'` in a WHERE clause, a
--     column DEFAULT that every existing row already satisfies) instead of
--     jsonb path operators and an application-level "absent key means
--     default" convention. There's no future vendor-driven churn here to
--     buy flexibility against, so plain columns are strictly simpler and
--     strictly more useful.
--
-- Why CHECK constraints on shooting_mode and ugc_style are fine here, even
-- though 0012's comment block spent its whole second half explaining why
-- scenes_duration_s_check was wrong to encode fal's allowed clip lengths
-- into the schema:
--
-- That objection was specifically about encoding a VENDOR's enum — fal's
-- allowed LTX durations — into SQL, because a vendor can change or add to
-- that set without our schema knowing, and a second vendor (Kling, Veo)
-- can have an entirely different set, turning the constraint into
-- something that has to be edited in lockstep with unrelated model
-- additions. shooting_mode and ugc_style are not that. Selfie / static /
-- mirror and auto / talking_head / voiceover / b_roll / testimonial /
-- unboxing are OUR wizard's own vocabulary, defined by this product, not
-- read off a provider's API schema. No vendor integration can add a
-- seventh shooting mode out from under us — only a deliberate product
-- change can, and a deliberate product change updating a migration
-- alongside it is exactly the right amount of friction. A CHECK
-- constraint here catches a typo'd value at the one layer that can never
-- be bypassed (a direct SQL write, a bad backfill, a future service that
-- forgets the Zod schema), which is precisely the protection 0012 said
-- scenes_duration_s_check couldn't actually deliver for a vendor enum.
--
-- camera_movement is a boolean, not a third value tucked into
-- shooting_mode, because it is a modifier on `static`, not a mode of its
-- own — see the column comment below for what it does to the prompt.
--
-- visual_idea, voice_profile and pronunciation_guide are unconstrained
-- text: free-form operator prose has no enum to check against, so a CHECK
-- here would just be a length limit nobody asked for.
-- =============================================================================

alter table projects
  add column if not exists shooting_mode text not null default 'selfie',
  add column if not exists camera_movement boolean not null default false,
  add column if not exists visual_idea text,
  add column if not exists voice_profile text,
  add column if not exists pronunciation_guide text,
  add column if not exists ugc_style text not null default 'auto';

alter table projects
  add constraint projects_shooting_mode_check
  check (shooting_mode in ('selfie', 'static', 'mirror'));

alter table projects
  add constraint projects_ugc_style_check
  check (ugc_style in ('auto', 'talking_head', 'voiceover', 'b_roll', 'testimonial', 'unboxing'));

comment on column projects.shooting_mode is
  'One of selfie (front camera, handheld shake, direct eye contact) / static '
  '(propped phone, stable) / mirror (handheld rear cam at a mirror, phone visible '
  'in shot, shake always on). Default selfie. Drives which camera-behavior language '
  'the compiler puts in every scene''s prompt — see web/lib/claude.ts.';

comment on column projects.camera_movement is
  'Only meaningful when shooting_mode = static (ignored otherwise — under selfie/mirror '
  'shake is already inherent to the mode and the control is not offered in the UI). When '
  'true, forces handheld camera-shake and prepends an OVERRIDE clause to the compiled '
  'prompt so the model does not fall back to the "static/propped" language shooting_mode '
  '= static already put there.';

comment on column projects.visual_idea is
  'Free-text global directorial override, applied to every scene the compiler writes '
  '(e.g. "lock the camera position completely, zero zoom, zero panning"). Optional.';

comment on column projects.voice_profile is
  'Short free-text voice direction, e.g. "warm, inspiring". Optional.';

comment on column projects.pronunciation_guide is
  'Free text, one word per line: "Seranova -> seh-rah-NOH-vah". When a guided word '
  'appears in a scene''s dialogue, the compiler appends its phonetic in brackets after '
  'the word''s first occurrence in that scene. Optional.';

comment on column projects.ugc_style is
  'One of auto (default) / talking_head / voiceover / b_roll / testimonial / unboxing. '
  'Steers the compiler''s overall framing of the ad toward that format.';
