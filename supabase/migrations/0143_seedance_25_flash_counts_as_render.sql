-- Seedance 2.5 Flash (BytePlus only) writes this wire id to runs.model.
create or replace function spend_category_totals(from_ts timestamptz, to_ts timestamptz)
returns table(iterate_usd numeric, render_usd numeric, total_usd numeric)
language sql stable security invoker set search_path = public as $$
  select
    coalesce(sum(t.cost_usd) filter (where t.model is null or t.model <> all (array[
      'bytedance/seedance-2-5', 'bytedance/seedance-2', 'bytedance/seedance-2-fast',
      'kling-3.0/video', 'hailuo/2-3-image-to-video-pro', 'gemini-omni-video',
      'bytedance/seedance-2-mini', 'kling-4.0/keyframe-to-video', 'wan/3-0-video',
      'kling-4.0/reference-to-video', 'google/gemini-omni-flash-1-2',
      'bytedance/seedance-2-5-flash'
    ])), 0) as iterate_usd,
    coalesce(sum(t.cost_usd) filter (where t.model = any (array[
      'bytedance/seedance-2-5', 'bytedance/seedance-2', 'bytedance/seedance-2-fast',
      'kling-3.0/video', 'hailuo/2-3-image-to-video-pro', 'gemini-omni-video',
      'bytedance/seedance-2-mini', 'kling-4.0/keyframe-to-video', 'wan/3-0-video',
      'kling-4.0/reference-to-video', 'google/gemini-omni-flash-1-2',
      'bytedance/seedance-2-5-flash'
    ])), 0) as render_usd,
    coalesce(sum(t.cost_usd), 0) as total_usd
  from (
    select r.cost_usd, r.vendor, r.model from runs r
    where r.created_at >= from_ts and r.created_at < to_ts
    union all
    select h.cost_usd, h.vendor, h.model from deleted_project_cost_history h
    where h.run_created_at >= from_ts and h.run_created_at < to_ts
  ) t;
$$;

-- Preserve 0121's projectless personal image runs in the per-user totals.
create or replace function spend_category_totals_by_user(from_ts timestamptz, to_ts timestamptz)
returns table(user_id uuid, email text, iterate_usd numeric, render_usd numeric, total_usd numeric)
language sql stable security invoker set search_path = public as $$
  select t.user_id, max(t.email) as email,
    coalesce(sum(t.cost_usd) filter (where t.model is null or t.model <> all (array[
      'bytedance/seedance-2-5', 'bytedance/seedance-2', 'bytedance/seedance-2-fast',
      'kling-3.0/video', 'hailuo/2-3-image-to-video-pro', 'gemini-omni-video',
      'bytedance/seedance-2-mini', 'kling-4.0/keyframe-to-video', 'wan/3-0-video',
      'kling-4.0/reference-to-video', 'google/gemini-omni-flash-1-2',
      'bytedance/seedance-2-5-flash'
    ])), 0) as iterate_usd,
    coalesce(sum(t.cost_usd) filter (where t.model = any (array[
      'bytedance/seedance-2-5', 'bytedance/seedance-2', 'bytedance/seedance-2-fast',
      'kling-3.0/video', 'hailuo/2-3-image-to-video-pro', 'gemini-omni-video',
      'bytedance/seedance-2-mini', 'kling-4.0/keyframe-to-video', 'wan/3-0-video',
      'kling-4.0/reference-to-video', 'google/gemini-omni-flash-1-2',
      'bytedance/seedance-2-5-flash'
    ])), 0) as render_usd,
    coalesce(sum(t.cost_usd), 0) as total_usd
  from (
    select coalesce(r.user_id, p.user_id) as user_id, prof.email, r.cost_usd, r.vendor, r.model
    from runs r
    left join projects p on p.id = r.project_id
    left join profiles prof on prof.id = coalesce(r.user_id, p.user_id)
    where coalesce(r.user_id, p.user_id) is not null
      and r.created_at >= from_ts and r.created_at < to_ts
    union all
    select h.user_id, prof.email, h.cost_usd, h.vendor, h.model
    from deleted_project_cost_history h left join profiles prof on prof.id = h.user_id
    where h.user_id is not null and h.run_created_at >= from_ts and h.run_created_at < to_ts
  ) t
  group by t.user_id order by total_usd desc;
$$;
