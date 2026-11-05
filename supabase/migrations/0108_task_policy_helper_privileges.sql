-- Policy helpers are security-definer functions. They are hidden from anon,
-- but authenticated SELECT policy evaluation still needs EXECUTE privilege.
-- Keep the helper grants separate because 0107 may already be applied locally.

grant execute on function is_active_task_manager() to authenticated;
grant execute on function can_read_task(uuid) to authenticated;
grant execute on function can_read_assignment(uuid) to authenticated;
