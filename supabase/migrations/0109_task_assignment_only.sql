-- Task assignment is the active web feature. The submission/review scaffold from
-- 0107 remains in the database for Darwin's follow-up work, but authenticated
-- callers must not invoke those RPCs while the assignment-only surface is live.
revoke all on function public.submit_task_assignment(uuid, text, text) from public, anon, authenticated;
revoke all on function public.review_task_submission(uuid, integer, text, text) from public, anon, authenticated;
