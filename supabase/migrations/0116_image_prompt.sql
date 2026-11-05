-- The prompt an image attempt was generated from, as the operator typed it
-- (@tags intact, not substituted), so opening a generated image can show its
-- prompt and tagged elements. Read through runs.asset_id. NULL for video runs
-- and for every image generated before this migration.

alter table runs add column if not exists prompt text;
