-- =============================================================================
-- projects.product_appearance — the operator's own description of what the
-- product physically looks like, so the compiler has something to render it
-- from.
-- =============================================================================
-- The compiler (web/lib/claude.ts's compileBrief/compileScene) never sees a
-- reference image. It gets projects.product_name (a string like "Kinoko
-- coffee") and a boolean hasProduct — that's it (verified at
-- web/lib/claude.ts's compileBrief, ~line 519-ish before this migration).
-- When a scene needs to put the product on screen, Claude has no way to
-- know what it looks like and invents packaging: "a jar", "a bottle", "a
-- container". The Kinoko product is a green pouch — this had to be typed in
-- by hand, twice, in two different projects, after the compiler kept
-- describing something else. A stronger compiler model does not fix this;
-- no model can see an image it was never given.
--
-- product_appearance is free text the operator writes once (mirroring
-- projects.character_desc, 0001_init.sql, which solves the identical
-- problem for the character): form and material, colour, label treatment.
-- Threaded into the compiler prompt as its own section, right next to the
-- product-name line (web/lib/claude.ts's buildProductAppearanceSection),
-- deliberately worded as a constraint on what the product LOOKS like, not
-- as material the compiler could work into dialogue.
--
-- Nullable, no default: null means "operator hasn't described it yet" — the
-- correct starting state for every project that predates this column and
-- every new project going forward. An empty/whitespace value is treated as
-- "not set" by the prompt-assembly code, same as character_desc and
-- product_name — never sent as an empty or placeholder line, which would
-- invite the model to fill the gap itself.
--
-- =============================================================================
-- Grants/RLS check (verified, not assumed, per this migration's own
-- instructions)
-- =============================================================================
-- No new grant or policy needed, for the same reasons 0034_profile_avatar.sql
-- and 0039_cut_order.sql's own columns needed none:
--   - 0007_grants.sql's `alter default privileges ... grant select, insert,
--     update, delete on tables to authenticated` was issued once, at the
--     TABLE level, before this column existed, and is not re-evaluated per
--     column — a plain `alter table ... add column` on an already-granted
--     table needs nothing further from that file.
--   - 0002_rls.sql's `projects_update_own` policy (`using (user_id =
--     auth.uid()) with check (user_id = auth.uid())`) is also not
--     column-scoped: an owner who may UPDATE the row at all may set any
--     column on it, this one included.
--   - In practice every write in web/actions/ goes through
--     createAdminClient() (service_role, which bypasses RLS entirely per
--     0007's own header) once requireProject has already checked ownership
--     in code, so this column is reachable in production regardless — the
--     check above is about not leaving a session-client path silently
--     broken, not about unblocking the real write path.
alter table projects
  add column product_appearance text;

comment on column projects.product_appearance is
  'Operator-authored free text describing what the product physically looks like — form/material, '
  'colour, label treatment (e.g. "matte green stand-up pouch, kraft-paper texture, white logo top '
  'centre"). The compiler (web/lib/claude.ts) never sees a reference image, only product_name and '
  'hasProduct, so without this it invents packaging — see this migration''s header for the Kinoko '
  'green-pouch incident that motivated it. Null/blank means unset and is omitted from the compiler '
  'prompt entirely, same convention as character_desc.';
-- =============================================================================
