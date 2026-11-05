# Credit system hardening plan

This is an implementation handoff for Claude. It covers the spend-control findings from
the credit audit. The credit display model stays the same: persistence and enforcement use
USD, while the UI converts at `1 credit = $0.005`.

## Goals

1. Prevent concurrent paid requests from passing the same remaining allowance.
2. Prevent new paid work when the data required to enforce a cap cannot be read.
3. Make in-flight spend calculation consistent under queue churn.
4. Make budget figures refresh after actions that change them.

Do not add a per-user wallet or decrementable credit balance. Do not change the credit
conversion or existing role/override/grant semantics.

## Phase 1: map every paid path

Before editing, inventory every Server Action that can create a billable Kie attempt or
write a paid `runs` row. Confirm whether it currently uses `assertWithinSpendCaps` or the
atomic image reservation path. The inventory must include video renders, image generation,
reference-frame generation, audio/video description, character work, compilation, and
retries.

The result should identify one canonical reservation seam and any paths that must remain
non-billable. A path that writes `scenes.status = 'queued'` must reserve its estimate before
the write, and a path that calls `reserve_image_attempt` must not also call the generic cap
check.

## Phase 2: add one atomic spend-reservation RPC

Add a new Supabase migration after the current migration head. The RPC should:

- accept the project or scene identity, idempotency key, estimate, model, Manila day/week
  bounds, effective weekly cap, daily cap, daily-cap setting, and mode partition;
- derive the owning user from a locked project/scene row instead of trusting a user id from
  the browser;
- take locks in a documented, consistent order: global cap first, then owner;
- check idempotency before checking caps;
- count settled spend, deleted-project history, and queued/rendering estimates;
- check global → weekly → optional daily in the same order as the UI messages;
- insert the reservation or queued attempt in the same transaction as the checks;
- return a typed outcome: reserved, duplicate, or blocked with the binding cap;
- reject null, negative, NaN, or infinite numeric inputs;
- be executable only by the server-side service role.

Reuse the existing aggregate functions rather than reimplementing spend sums. Keep the
existing `reserve_image_attempt` behavior compatible, or replace it with the shared RPC if
that produces one clearer reservation path. Do not leave image-vs-video as a separate race.

Update the TypeScript wrapper and migrate each paid action to the RPC. Remove duplicate
preflight checks only after the reservation itself covers that path; otherwise an estimate
may be counted twice or a paid path may become unguarded.

## Phase 3: choose safe failure behavior

Change production enforcement so a failed Kie balance read or failed in-flight spend read
does not silently allow new paid work. Return a temporary, user-readable refusal such as:

> Spending is temporarily unavailable while the account limit is being checked. Try again
> shortly.

Keep development mode vendor-free. In development, the Kie balance check remains skipped,
but malformed cap configuration must still fail loudly. Log the underlying server error
without exposing credentials or vendor secrets.

The refusal must be distinguishable from an exhausted user allowance so the UI does not tell
someone to wait until Monday for an infrastructure outage.

## Phase 4: replace in-flight pagination

Add a SQL aggregate/RPC for queued and rendering scenes, grouped by owning user and with a
global total. It must:

- use the same `dev` partition as the worker;
- merge project render settings with scene overrides before pricing;
- use the canonical estimate/rate inputs;
- include all rows in one database snapshot rather than offset pagination;
- return zero totals only when the query genuinely finds no rows;
- surface query errors to the reservation path so Phase 3 can fail safely.

Use this RPC from enforcement and budget snapshots. Remove the offset loop from
`web/lib/spend.ts` after callers have moved.

## Phase 5: refresh the web UI

After a successful or blocked credit-changing action, revalidate the relevant layout and
budget routes. Cover:

- render and retry actions;
- image generation and recovery;
- allowance grants and decisions;
- credit passing;
- cancellation or cleanup that releases an in-flight reservation.

Keep server-side enforcement authoritative. The UI may show a stale snapshot, but the next
action must always use the atomic reservation result. Display temporary infrastructure
failures separately from personal, weekly, daily, and global cap refusals.

## Phase 6: configuration cleanup

Update `render.yaml` comments and operational documentation to refer to Kie rather than Fal.
Document that cap environment changes require a rebuild/redeploy, and keep the actual cap
values in one reviewed configuration location. Do not change cap amounts as part of this
hardening work unless separately approved.

## Validation required before merge

Claude should add focused automated coverage for:

- two concurrent reservations with only one remaining slot;
- image and video reservations racing against the same global cap;
- duplicate idempotency keys not consuming a second reservation;
- null, NaN, negative, and non-finite inputs being rejected;
- balance and in-flight read failures refusing production work;
- development mode skipping only the vendor balance read;
- queue churn producing one complete in-flight aggregate;
- correct global → weekly → daily refusal ordering;
- grants and passed-out grants preserving the existing zero-sum behavior;
- UI refresh and separate infrastructure-error messaging.

Apply the migration to the local database, read back the RPC result, run the repository's
normal CI checks, then deploy to a staging/Render environment before production. Verify
the production logs and spend page after one successful render and one intentionally blocked
reservation. Do not use a real vendor render for concurrency testing unless the spend and
approval are explicitly authorized.

## Out of scope

- changing the credit conversion rate;
- introducing stored user balances or wallets;
- redesigning the credit UI;
- changing role caps, grants, or pass limits;
- adding a REST/GraphQL service between web and worker.
