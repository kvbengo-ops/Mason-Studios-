-- Clip expiry (owner, 2026-11-15): a finished scene moves to the bin 14 days
-- after its newest take, unless it is marked Keep. The worker's hourly
-- expire-clips loop reads this flag; the web's Keep button writes it.
alter table scenes add column keep boolean not null default false;

comment on column scenes.keep is
  'Exempt from the 14-day clip expiry (worker ExpireClips). Set by the owner''s Keep button, '
  'and by a restore from the bin so a restored clip does not expire again at once.';

-- What the hourly loop scans: finished, unkept scenes by age.
create index scenes_expiry_idx on scenes (created_at) where status = 'done' and not keep;
