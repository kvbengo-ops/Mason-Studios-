# Spending limits QA — 2026-11-10

## Fixed

- The bulk dialog reads saved limits when opened, after saving, and when changing its role scope. It no longer starts every refreshed page at $10/week, $2/day, and $0.50/hour.
- Reads cover the entire selected scope in pages of 500, independently of the Users table's search and pagination. Different account amounts display as “Mixed — unchanged”; a read failure disables saving instead of supplying invented defaults.
- Bulk and per-account saves write only edited amounts. Editing an hourly limit no longer rewrites a daily amount that was clamped for display or re-applies an untouched weekly zero and revokes grants. Explicitly re-entering zero still performs the existing zero-limit action.
- “All editor tiers” includes editor, trusted_editor, hybrid_editor, and ai_animator. Admins remain excluded from bulk writes; the displayed account count uses the same role set.
- Empty weekly/daily inputs and an empty global team cap are rejected instead of being converted to zero. Empty hourly inputs in the per-account dialog still explicitly remove that optional cap.
- Reopening per-account and team-cap forms discards abandoned edits and uses their current server-provided values. The Users row mounts a fresh per-account dialog each time it opens.
- Daily amounts are saved before turning the installation-wide daily guard on. Failed bulk saves reload current values and explain that earlier writes may have succeeded.
- Weekly changes invalidate the budget layout for positive amounts and clearing overrides as well as zero.
- Zero-weekly copy now describes the existing transfer rule accurately: zero removes the base allowance and approver grants; allowance received from colleagues is retained.

## Validation

Passed locally, with exit code 0:

- 255 tests across 12 suites: bulk dialog, per-account dialog, global team cap, account actions, allowance actions, allowance validation, grant revocation, spending enforcement, spend call sites, Users page, allowance API, and Server/Client boundaries.
- TypeScript: `bunx --no-install tsc --noEmit`.
- ESLint on changed TypeScript/TSX files, without warnings.

New regression cases exercise save followed by remount (refresh), scope changes, reopen, mixed and zero values, blank inputs, amount ceilings, role defaults, daily enable ordering, hourly disable, partial save failure, read failure, pagination beyond the first 500 accounts, and admin authorization. Existing enforcement tests cover Manila day/week boundaries, exact-cap versus over-cap amounts, global and hourly caps, grants, in-flight estimates, and queue outcome handling.

UI tests use jsdom and mocked server actions. Action tests use a mocked Supabase client. These checks do not prove a production database write/read round trip, a real SQL concurrency run, or a deployed browser session. No production limits were changed during QA.

## Remaining findings

### Multi-field saves and grant revocation are not atomic

`web/components/all-editors-allowance-dialog.tsx` and `web/components/weekly-allowance-dialog.tsx` call separate actions for each amount and the daily switch. `web/actions/account.ts` also writes a weekly zero before revoking grants. If a later operation fails, earlier changes persist. The forms now make partial success explicit, and the bulk dialog reloads saved values, but there is no transaction that rolls the whole operation back. Fully resolving this requires a database transaction/RPC covering the intended update and grant effects.

### Bulk writes can undercount or miss grant revocations above 1,000 accounts

`setAllEditorsWeeklyCap`, `setAllEditorsDailyCap`, and `setAllEditorsHourlyCap` derive their returned update counts from `.select("id")` results. `supabase/config.toml` sets `max_rows = 1000`. The weekly zero action also uses those returned IDs to revoke grants. If an update affects more accounts than the API returns, counts can be truncated and approver grants for omitted accounts can remain active. This is a code-review finding, not a live reproduction. The new paginated read does not repair this existing write-side limit; the bulk mutation needs complete affected-ID handling or a transaction/RPC.

### A zero weekly base is not a universal spending suspension

`revokeActiveGrantsFor` intentionally leaves both sides of peer transfers intact, and those transfers still count toward the effective weekly limit. Removing one side would corrupt the transfer ledger. The UI now states this behavior; no transfer policy was changed.
