-- Index assets by scene for the clip / thumbnail lookups.
--
-- The web app reads a scene's assets as `scene_id = $1 AND kind = $2 ORDER BY
-- created_at` (and `scene_id = ANY($2)` for a strip). assets had no index on
-- scene_id, so each of those ~880k calls (2026-11-11 to 11-21) scanned all
-- ~64k rows to return about one: 10-16 ms each, 31 billion rows read, the
-- largest load on the database. Index only; no behaviour change.
--
-- Not CONCURRENTLY: migrations run in a transaction, and the build on ~64k
-- rows takes well under a second.
create index if not exists assets_scene_id_kind_created_at_idx
  on public.assets (scene_id, kind, created_at)
  where scene_id is not null;
