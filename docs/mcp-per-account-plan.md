# Per-account MCP server — plan

2026-10-27 · status: proposal, nothing built

Each account connects its own MCP client (Claude, etc.) to the app with a personal
token, and can create and queue `/ugc` clips through it. Everything it does runs
as that account: same guards, same spend caps, same projects. There is **one**
endpoint (`/api/mcp`), not one server per account.

## Goal and scope

v1 lets an account, from an MCP client:

- list its projects
- start a new clip project
- see which model / resolution / duration pairs it can buy, and at what price
- generate a clip from a prompt (prompt-only, no references)
- check render status of a project's scenes

Out of scope for v1: uploads, references and `@tag` elements, Kling frames,
rerender/retry, delivery, admin and approver actions, OAuth.

## How it works

```
MCP client ──Bearer token──▶ web /api/mcp ──▶ token → user ──▶ existing Server Action
                                                                  │
                                                     writes scenes.status='queued'
                                                                  ▼
                                                   worker dispatch loop (unchanged)
```

1. The user creates a token in the app (shown once, stored only as a hash).
2. They paste `https://<app>/api/mcp` and the token into their MCP client.
3. Each request: hash the token, find the row, reject if revoked or expired,
   load the profile, reject if `canUseApp(profile)` fails (pending, rejected,
   deactivated).
4. The tool runs the same code the UI runs, as that user.

The worker does not change. `/api/mcp` lives in `web/`, writes `queued` and stops,
like the Generate button.

### The hard part: guards read the cookie session

`requireUser()` (`web/actions/guard.ts`) and `createClient()`
(`web/lib/supabase/server.ts`) get the user from the Supabase session cookie, and
`redirect("/login")` when there is none. An MCP request has a bearer token, no
cookie, so the Server Actions can't be called as-is.

Recommended: an **identity seam at the one chokepoint**. `/api/mcp` resolves the
token, then runs the tool inside an `AsyncLocalStorage` context holding the user
id. `createClient()` checks that context first: if set, it builds a client whose
`Authorization` header is a short-lived Supabase access token minted for that
user, so `auth.getUser()`, RLS and every guard work unchanged. Every action then
works over MCP with no per-action edits.

Alternative: split each wrapped action into a core function that takes
`userId` and is called by both the action and the MCP tool. More diff, touches
every action wrapped, but no token minting. Choose after the spike (build step 1).

## Tools in v1

| Tool | Wraps | Notes |
| --- | --- | --- |
| `list_projects` | user-scoped `projects` select, same as `/projects` | id, title, kind, derived status |
| `create_clip_project` | insert shared with `createClipProject` | that action `redirect()`s, so pull the insert into a helper both call |
| `list_models` | `offerable()` (`web/lib/kie/offerable.ts`) | model id, resolution, duration range, credits per clip; only receipt-priced pairs |
| `generate_clip` | `generateClip` (`web/actions/ugc.ts`) | builds the FormData: `projectId`, `prompt`, `modelId`, `resolution`, `durationS`; prompt-only models only (`supportsPromptOnlyVideo`) |
| `get_render_status` | `getSceneStatuses` (`web/actions/enqueue.ts`) | per scene: status, failure reason; clip link is an open question |

Tool errors return the action's `{ error }` text as an MCP tool error, so a spend-cap
refusal reads the same as in the UI.

## Data model

New migration (next free number, currently `0116_api_tokens.sql`):

```sql
create table public.api_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  token_hash   text not null unique,   -- sha256 of the token; the token itself is never stored
  prefix       text not null,          -- first 8 chars, shown in the UI to tell tokens apart
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);
alter table public.api_tokens enable row level security;
create policy api_tokens_owner on public.api_tokens
  for select using (user_id = auth.uid());
```

- Writes go through Server Actions with the admin client, after `requireUser()`.
- Needs an RLS test in `worker/internal/store/` (a user sees only their own rows;
  `anon` sees none) — RLS with zero policies returns 0 rows silently.
- Bump `EXPECTED_DB_VERSION` and apply to prod per `AGENTS.md` before deploy.

## Guardrails

- **Spend:** `generate_clip` goes through `generateClip`, so `assertWithinSpendCaps`,
  `offerable()` and `runs` rows all apply. No MCP-only path to kie.
- **Ownership:** every tool goes through the same guards (`requireUser`,
  `requireProject`). An admin token gets no extra write power — `requireProject` is
  owner-only.
- **Status contract:** web writes `queued` only. Nothing in `/api/mcp` touches
  `rendering`, `done` or `failed`.
- **MODE:** inherited — `generateClip` already writes `scenes.dev` from `MODE`.
- **Account state:** checked on every request, so deactivating an account kills
  its tokens immediately. Revoking a token kills only that token.
- **Proxy:** add `api/mcp` to the matcher exclusions in `web/proxy.ts`, or the
  middleware redirects token requests to `/login`.
- **Rate limit:** none in v1; the global daily cap bounds the bill. Revisit if
  tokens are shared outside the team.
- **Logging:** never log the token or the `Authorization` header.

## UI

Settings → **API tokens**, so the actions have a caller:

- list: name, prefix, created, last used, revoke button
- create: name field → shows the full token once, with the endpoint URL and a
  copy-paste MCP client config snippet
- revoke: sets `revoked_at`

Actions: `createApiToken`, `revokeApiToken` in `web/actions/api-tokens.ts`, both
`requireUser()` first and re-check `user_id` on revoke.

## Build steps

1. **Spike the identity seam:** confirm we can mint a Supabase access token for a
   user id (depends on the project's JWT signing setup) and that `requireUser()`
   passes with it. If not, switch to the core-function alternative.
2. Migration `0116_api_tokens.sql` + RLS test.
3. Token actions + Settings → API tokens UI.
4. `/api/mcp` route with the official `@modelcontextprotocol/sdk` (Streamable HTTP
   transport), token resolution, proxy exclusion.
5. Tools: `list_projects`, `list_models`, `get_render_status` first (read-only),
   then `create_clip_project`, then `generate_clip`.
6. Verify (below), then deploy migration before code.

**Verification**

- Token for user A cannot list or generate in user B's project.
- Revoked token, expired token and deactivated account all get 401.
- `generate_clip` with `MODE=development` creates a `dev = true` scene, a `runs`
  row, and counts against A's caps; over the cap it returns the cap error and
  writes nothing.
- Connect a real MCP client (Claude) to a local run and queue one clip end to end.

## Open questions

- Can we mint user access tokens with this Supabase project's JWT keys, or do we
  go the core-function route?
- Token expiry: none by default, or 90 days?
- Should `get_render_status` return a signed download URL for finished clips?
- Who may create tokens: every approved account, or trusted and admin only?

## Later

- OAuth ("Connect" button, no token copy) once v1 is used.
- Elements and `@tag` references, Kling start/end frames, rerender/retry tools.
- Per-token rate limits and usage view.
