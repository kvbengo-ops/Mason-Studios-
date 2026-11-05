-- Put the render settings INSIDE the version they produced.
--
-- 0058 gave a scene versions of its prompt, its reference frame and its
-- clip. It did not version the three things that decide what that clip
-- actually is: the model, the resolution/fps, and the length. Those live on
-- `scenes` — render_settings_override and duration_s — and both are
-- overwritten in place, by the scene settings panel and by
-- updateSceneDuration.
--
-- So a version is currently a partial record, and it is partial in the
-- direction that costs money. v1 rendered at 6s of Seedance 2.5 at 720p for
-- $1.89; change the scene to 15s of Kling at 1080p afterwards and v1 now
-- claims to have been built that way, because there is nowhere else for the
-- answer to come from. That is the same defect the Deliver page was fixed
-- for, where a figure labelled "already spent on this clip" was computed
-- from the scene's CURRENT settings rather than from what was billed.
--
-- Two columns, both snapshots rather than references:
--
--   render_settings — the EFFECTIVE settings (project defaults merged with
--     the scene's override, lib/models.ts's mergeRenderSettings), not the
--     override alone. An override of `{}` means "whatever the project says",
--     and the project's own settings move too, so storing the override
--     would leave the version's meaning depending on a row that is still
--     changing. The merged answer is the one that was submitted.
--
--   duration_s — a plain integer, because the length is a scene column and
--     not part of the settings jsonb.
--
-- Both nullable. A backfilled version has no honest value to record (see
-- below), and a null that says "not known" is better than a number that
-- says something false.

alter table scene_versions
  add column render_settings jsonb,
  add column duration_s integer;

comment on column scene_versions.render_settings is
  'Effective render settings at the moment this version was opened — project defaults merged with the scene override. A snapshot, never a live read: the scene''s own settings are overwritten in place, so this is the only record of what a clip was actually rendered with. Null on versions backfilled by 0058, which predate this column.';

comment on column scene_versions.duration_s is
  'Clip length in seconds at the moment this version was opened. Snapshot, for the same reason as render_settings. Null on versions backfilled by 0058.';

-- Backfill the CURRENT version only, and only where the scene has not moved
-- since.
--
-- Deliberately not a blanket copy of today's settings onto every version.
-- For any version but the newest, today's settings are not what it was
-- rendered with, and writing them would manufacture a precise-looking answer
-- that is wrong — the exact failure this migration exists to stop. Older
-- versions keep null and the UI says "not recorded".
--
-- Even the newest is only a good guess: an operator who changed the model
-- after the last render but before this migration ran gets today's value
-- stamped onto a version that predates it. Restricted to scenes whose
-- status is 'done' and whose active version is the highest-numbered one,
-- which is the case where the settings on the row are most likely still the
-- ones that produced the clip.
update scene_versions v
set
  render_settings = coalesce(p.render_settings, '{}'::jsonb)
    || coalesce(s.render_settings_override, '{}'::jsonb),
  duration_s = s.duration_s
from scenes s
  join projects p on p.id = s.project_id
where v.scene_id = s.id
  and v.id = s.active_version_id
  and s.status = 'done'
  and v.n = (select max(n) from scene_versions v2 where v2.scene_id = s.id);

-- No RLS changes. scene_versions' policies (0058) are row-level and join
-- through scenes -> projects; adding columns does not widen them.
