-- Retire team chat and task management while keeping their existing rows.
-- The web app no longer exposes these workflows; revoke their RPC entrypoints
-- so old clients cannot continue creating or changing records.

revoke all on function public.can_access_chat_conversation(uuid) from public, anon;
revoke all on function public.chat_people() from public, anon, authenticated;
revoke all on function public.send_direct_chat_message(uuid, text) from public, anon, authenticated;
revoke all on function public.mark_direct_chat_read(uuid) from public, anon, authenticated;
revoke all on function public.direct_chat_unread_count() from public, anon, authenticated;

revoke all on function public.task_eligible_assignees() from public, anon, authenticated;
revoke all on function public.my_task_assignments() from public, anon, authenticated;
revoke all on function public.managed_tasks() from public, anon, authenticated;
revoke all on function public.task_assignment_directory(uuid) from public, anon, authenticated;
revoke all on function public.create_task(text, text, text, timestamptz, text, uuid[], uuid, text)
  from public, anon, authenticated;
revoke all on function public.start_task_assignment(uuid) from public, anon, authenticated;
revoke all on function public.complete_task_assignment(uuid) from public, anon, authenticated;
revoke all on function public.reopen_task_assignment(uuid) from public, anon, authenticated;
revoke all on function public.cancel_task(uuid) from public, anon, authenticated;
revoke all on function public.submit_task_assignment(uuid, text, text) from public, anon, authenticated;
revoke all on function public.review_task_submission(uuid, integer, text, text)
  from public, anon, authenticated;
