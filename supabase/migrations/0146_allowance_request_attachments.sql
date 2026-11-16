-- Up to two images attached to an allowance request (owner, 2026-11-16): a screenshot of the
-- task or a receipt, so the approver sees why. Storage keys in the private media bucket
-- (users/<id>/allowance/<uuid>.<ext>), written by requestAllowance with the service client.
-- The row's RLS already scopes who reads it (the requester and approvers, 0074); the files are
-- only ever reached through a signed URL minted after that read.

alter table allowance_requests
  add column attachment_keys text[] not null default '{}'
    check (cardinality(attachment_keys) <= 2);

comment on column allowance_requests.attachment_keys is
  'Storage keys (media bucket) of up to 2 images the requester attached. See 0146.';
