import Link from "next/link";
import { redirect } from "next/navigation";
import type { JSX } from "react";
import { requireAdmin } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import {
  DEFAULT_PAGE_SIZE,
  pageRange,
  parsePage,
  parsePageSize,
  totalPageCount,
} from "@/lib/pagination";
import type { PageSize } from "@/lib/pagination";
import { buildIlikeOrFilter, sanitizeSearchTerm } from "@/lib/search-term";
import { parseSort } from "@/lib/sort-params";
import type { ParsedSort } from "@/lib/sort-params";
import { formatUsd } from "@/lib/format-usd";
import { decideAccountApproval } from "@/actions/account";
import { AllEditorsAllowanceDialog } from "@/components/all-editors-allowance-dialog";
import {
  BULK_ALLOWANCE_SCOPE_ROLES,
  MAX_ACCOUNT_DAILY_CAP_USD,
  MAX_ACCOUNT_WEEKLY_CAP_USD,
} from "@/lib/allowance";
import { Badge } from "@/components/ui/badge";
import { UserPresenceStrip } from "@/components/user-presence-strip";
import { UserAvatar } from "@/components/user-avatar";
import { AccountsControlLiveRefresh } from "@/components/accounts-control-live-refresh";
import { DailyCapSwitch } from "@/components/daily-cap-switch";
import { UserRowActions } from "@/components/user-row-actions";
import { AccountStatusBadge } from "@/components/account-status-badge";
import { ActionForm } from "@/components/action-form";
import { RejectAccountDialog } from "@/components/reject-account-dialog";
import { SubmitButton } from "@/components/submit-button";
import { RoleBadge } from "@/components/role-badge";
import { LiveSearch } from "@/components/live-search";
import { PageSizeControl } from "@/components/page-size-control";
import { PaginationControls } from "@/components/pagination-controls";
import { SortableTableHead } from "@/components/sortable-table-head";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ProfileRole, ProfileStatus } from "@/types/db";
import type { AccountCapProfile, AccountCaps } from "@/lib/spend";
import { getUserActiveGrantsTotals, type ActiveGrantTotals } from "@/lib/db-aggregates";
import { requiresAccountApproval } from "@/lib/account-approval";
import { dateFormatter as dateTimeFormatter } from "@/lib/datetime";
import { getImageUrl } from "@/lib/storage";
import { PresenceDot } from "@/components/presence-dot";
import { lastSeenLabel, PRESENCE_WINDOW_MS } from "@/lib/presence";
import { BurnCell, type UserBurn } from "@/components/burn-cell";
import { computeBurn, manilaDayKeys, weekSpentFromDays } from "@/lib/burn";
import { getDailySpendByUser, getTeamDailySpend } from "@/lib/burn-data";
import { TeamBurnStrip } from "@/components/team-burn-strip";

// A named function type, not an inline `typeof import("@/lib/spend").
// resolveAccountCaps` — the lint config (`@typescript-eslint/consistent-
// type-imports`) forbids `import()` type annotations, and this is also
// just more readable at the one call site below that needs it. This is a
// TYPE-ONLY import (`import type`), which is erased at compile time and
// carries none of lib/spend.ts's module-load risk — the actual function is
// loaded via a dynamic import() at runtime, in the fetch block below, for
// exactly that reason (see that block's own comment).
type ResolveAccountCapsFn = (profile: AccountCapProfile) => AccountCaps;

// This page used to be read-only on purpose, on the grounds that a control
// here — changing a role, deactivating an account, deleting one, sending an
// invite, resetting a password — would be a NEW privilege surface, and that
// adding one had to be a decision somebody made on purpose rather than a
// button slipped in next to a list.
//
// Approve/Reject (0052_account_approval.sql) is that decision, made on
// purpose. It is also the narrowest possible version of it: it moves
// profiles.status between 'pending', 'active' and 'rejected' and touches
// nothing else, it cannot touch an account that is already active, and it
// grants an admin no power they did not already have — the accounts it acts
// on cannot use the app at all until it runs. Everything the original note
// refused is still refused here except one: there is no delete and no
// password reset, and the role control is now the narrowest possible slice
// of one.
//
// The editor <-> trusted_editor toggle (0062, actions/account.ts's
// setTrustedEditor) is the second decision made on purpose. It reverses the
// original note's blanket "no role control", and only for the tier where
// that note's own test still passes: it hands an admin nothing they did not
// already have, since an admin can already decide any allowance request and
// already carries the $700 weekly cap of which this grants $25. Promotion
// to 'admin' stays refused, for the reasons the blanket rule was written
// for — it is a real escalation, it is not reversible by the granting
// admin, and a demote path has to refuse unseating the last admin or this
// page becomes unreachable for everyone.
//
// The one way back IS in scope: a rejected account can be approved from the
// same button, because rejecting the wrong row on a list of near-identical
// rows is one misclick, and the alternative recovery path was a hand-written
// UPDATE in the Supabase dashboard. Reject itself is behind a confirmation
// (components/reject-account-dialog.tsx) rather than firing on first click.
//
// Gated with requireAdmin() (actions/guard.ts) directly, the same one-line
// idiom /library uses, rather than /spend's requireUser() + a manual
// isAdmin()/AuthorizationError check: the two are equivalent (requireAdmin
// IS requireUser + that same check, see guard.ts), and this page has no use
// for the non-admin `profile` requireUser alone would hand back — there's
// nothing on this page a non-admin ever partially sees. requireAdmin says
// that in one call instead of two.

// Shape of the user_directory query below. RLS (0002_rls.sql's
// profiles_select_admin, transitively re-checked through projects/scenes/
// runs — see 0028_user_directory.sql's header) already lets an admin read
// every row through the session client, so this one query is correct for
// the whole user base, not just the caller's own row.
interface UserDirectoryRow {
  id: string;
  email: string;
  username: string;
  role: ProfileRole;
  created_at: string;
  project_count: number;
  spend_usd: number;
  status: ProfileStatus;
  burn_usd: number;
}

// The six sortable columns, and the actual column each one orders by on
// user_directory (0028_user_directory.sql). email/username/role/joined are
// plain profiles columns; project_count/spend_usd are the two aggregates
// that view exists to make sortable in the same query as the page/LIMIT —
// see that migration's header for why "sort after fetching the page of
// profiles" was the bug this whole feature had to avoid.
const SORT_COLUMNS = [
  "email",
  "username",
  "role",
  "status",
  "joined",
  "projects",
  "spend",
  "burn",
] as const;
type SortColumn = (typeof SORT_COLUMNS)[number];

const SORT_COLUMN_TO_DB: Record<SortColumn, string> = {
  email: "email",
  username: "username",
  role: "role",
  status: "status",
  joined: "created_at",
  projects: "project_count",
  spend: "spend_usd",
  // Average spend per Manila day over the last 7 days (user_directory_burn,
  // 0135) — in the view so it orders next to search and paging.
  burn: "burn_usd",
};

// Default: newest signups first — the same order this page rendered in
// before it was sortable (`.order("created_at", { ascending: false })`
// below), so shipping sort doesn't also silently change what an admin sees
// on a bare `/users` visit. Not spend-desc ("biggest spender first"): that
// would be picking a business priority (triage cost) over preserving the
// existing default, and nothing in this page's spec asks for that judgment
// call — an admin who wants that view is one header click away now.
//
// It also happens to be the right default for the approval queue
// (0052_account_approval.sql) without needing a filter control: an account
// waiting on a decision is by definition one of the newest, so it lands at
// the top of the first page on a bare /users visit.
//
// The Status column does NOT rescue the case where it doesn't (a signup
// nobody looked at for a week). It orders by the raw column, which is text,
// so it sorts alphabetically — active, pending, rejected — and neither
// direction puts pending on top: ascending buries it under every active
// account, descending under every rejected one. What it does is group the
// statuses together, so on a list with few rejections descending lands
// pending near the top. Real pending-first ordering would need a CASE
// expression in user_directory (0028), and it is not worth a migration
// while the list is this short — the same call the plan's "deliberately not
// in scope" section already makes about a ?status=pending filter.
const DEFAULT_SORT: ParsedSort<SortColumn> = { column: "joined", direction: "desc" };

function buildUsersHref(
  q: string,
  page: number,
  sort: ParsedSort<SortColumn>,
  size: PageSize,
  archived = false,
): string {
  const params = new URLSearchParams();
  if (archived) params.set("archived", "1");
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  if (sort.column !== DEFAULT_SORT.column || sort.direction !== DEFAULT_SORT.direction) {
    params.set("sort", sort.column);
    params.set("dir", sort.direction);
  }
  if (size !== DEFAULT_PAGE_SIZE) params.set("size", String(size));
  const qs = params.toString();
  return qs ? `/users?${qs}` : "/users";
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    page?: string | string[];
    sort?: string | string[];
    dir?: string | string[];
    size?: string | string[];
    archived?: string | string[];
  }>;
}): Promise<JSX.Element> {
  const { user: viewer } = await requireAdmin();

  // Session client, not createAdminClient() — profiles_select_admin
  // (0002_rls.sql) already lets an admin read every profile, so the database
  // does the scoping and this page doesn't have to remember to, the same
  // deliberate choice /projects' own comment makes for the same reason.
  const supabase = await createClient();

  const resolvedSearchParams = await searchParams;
  const q = sanitizeSearchTerm(resolvedSearchParams.q ?? "");
  // Deactivated accounts are archived: hidden from the list, the bulk limit
  // counts and Top accounts, shown only in this view. Nothing is deleted, so
  // Reactivate still works and their spend history stays.
  const archived = resolvedSearchParams.archived === "1";
  const usersHref = (
    hrefQ: string,
    page: number,
    hrefSort: ParsedSort<SortColumn>,
    size: PageSize,
  ): string => buildUsersHref(hrefQ, page, hrefSort, size, archived);
  const requestedPage = parsePage(resolvedSearchParams.page);
  const pageSize = parsePageSize(resolvedSearchParams.size);
  const { from, to } = pageRange(requestedPage, pageSize);
  const sort = parseSort(
    SORT_COLUMNS,
    DEFAULT_SORT,
    resolvedSearchParams.sort,
    resolvedSearchParams.dir,
  );

  // ilike over email/username — same reasoning as the projects list and
  // Character Library search boxes (lib/search-term.ts's header): a
  // substring match on two short, mostly-literal strings covers what an
  // admin actually wants here, for a fraction of standing up real search.
  //
  // Reads from user_directory (0028_user_directory.sql), not `profiles`
  // directly: that view already carries project_count and spend_usd
  // alongside every profiles column this page renders, computed with a
  // single LEFT JOIN + GROUP BY in Postgres. That means this is the ONLY
  // database round trip this page render makes — down from three
  // (`profiles`, then user_project_counts and spend_totals_by_user in
  // parallel) — and it stays exactly one no matter how large PAGE_SIZE
  // gets, the same way the query it replaces already did (nothing here was
  // ever per-row; the win is collapsing three queries, two of them gated
  // behind the first one's round trip, into one).
  const baseQuery = supabase
    .from("user_directory_burn")
    .select("id, email, username, role, created_at, project_count, spend_usd, status, burn_usd", {
      count: "exact",
    });
  const orFilter = buildIlikeOrFilter(["email", "username"], q);
  const viewQuery = archived
    ? baseQuery.eq("status", "deactivated")
    : baseQuery.neq("status", "deactivated");
  const filteredQuery = orFilter ? viewQuery.or(orFilter) : viewQuery;

  // Secondary `.order("id")` tiebreaker: without it, rows tied on the
  // primary sort column (e.g. two users with the same role, or the same
  // to-the-second created_at) have no guaranteed stable order across two
  // separate `.range()` calls — a row could legally appear on both page 2
  // and page 3, or on neither, if Postgres orders the tied group
  // differently between requests. `id` is unique, so this makes every page
  // boundary deterministic regardless of which column is being sorted.
  const { data, error, count } = await filteredQuery
    .order(SORT_COLUMN_TO_DB[sort.column], { ascending: sort.direction === "asc" })
    .order("id", { ascending: true })
    .range(from, to);

  if (error) {
    throw new Error(`Failed to load users: ${error.message}`);
  }

  const totalCount = count ?? 0;

  // How many accounts the bulk allowance control would touch. `head: true`
  // so this is a COUNT, not a page of rows — the number is only ever read
  // as copy in a dialog. Whole-table on purpose, unlike every other read on
  // this page: the control it feeds acts on every editor, not on the page
  // the admin happens to be looking at.
  // Per ROLE, not one editor-tier total: the bulk dialog now scopes by role
  // (lib/allowance.ts's BULK_ALLOWANCE_SCOPE_ROLES) and names the count it
  // is about to affect, so a single combined number would have it promising
  // to change more accounts than the chosen scope actually writes to. Two
  // head counts rather than one grouped read — PostgREST's `count: exact`
  // has no GROUP BY, and both are index-only counts on a column already
  // indexed for every other role filter on this page.
  const burnNow = new Date();
  const burnDates = manilaDayKeys(burnNow, 7);
  const presenceCutoff = new Date(new Date().getTime() - PRESENCE_WINDOW_MS).toISOString();
  const [
    { count: plainEditorCount },
    { count: trustedEditorCount },
    { count: hybridEditorCount },
    { count: aiAnimatorCount },
    { count: followingDefaultCount },
    { count: archivedCount },
    presenceTotal,
    presenceOnline,
    onlineProfiles,
    teamDaily,
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "editor")
      .neq("status", "deactivated"),
    supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "trusted_editor")
      .neq("status", "deactivated"),
    supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "hybrid_editor")
      .neq("status", "deactivated"),
    supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "ai_animator")
      .neq("status", "deactivated"),
    // Every editor-tier account, which since 0078 is exactly the set the
    // installation default decides for — there is no per-account override
    // left to exempt anyone. Named in the disable dialog so an admin sees
    // who it moves, not just that it moves someone.
    supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .in("role", [...BULK_ALLOWANCE_SCOPE_ROLES.all])
      .neq("status", "deactivated"),
    supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("status", "deactivated"),
    supabase.from("profiles").select("id", { count: "exact", head: true }),
    supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .gte("last_seen_at", presenceCutoff),
    supabase
      .from("profiles")
      .select("id, username, email, avatar_storage_key")
      .gte("last_seen_at", presenceCutoff)
      .order("last_seen_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(6),
    // Whole team, archived (deactivated) accounts' past spend included. Not
    // page-bound, but one row per day. Fail-soft: the strip says unavailable.
    getTeamDailySpend(supabase, 7, burnNow).catch((error: unknown) => {
      console.error("Failed to load team daily spend for /users burn strip", error);
      return null;
    }),
  ]);
  const totalPages = totalPageCount(totalCount, pageSize);

  // Same stale-bookmark guard /projects, /library, and /spend all use: land
  // back on the real last page instead of rendering an empty table with a
  // pager that claims a later page exists. This also covers shrinking
  // `?size=` while deep in the pages of the old size (e.g. 50/page page 3 ->
  // 10/page, where page 3 no longer exists) for a hand-edited URL; the size
  // selector itself never needs this path since it always links straight to
  // page 1 (PageSizeControl's buildHref below), and page 1 always exists.
  if (requestedPage > totalPages && totalCount > 0) {
    redirect(usersHref(q, totalPages, sort, pageSize));
  }

  // "Spend to date" is all-time — see user_directory's own header
  // (0028_user_directory.sql) for why the view sums every run ever rather
  // than taking a date-range argument the way spend_totals_by_user does:
  // this page has no date picker, unlike /spend, so "what has this account
  // cost us, total" is the only number that makes sense in this column, and
  // an unbounded upper edge is a no-op since `runs.created_at` never lands
  // in the future.
  const users = (data ?? []) as UserDirectoryRow[];

  // Per-account allowance vs. current usage — the proposal's own words are
  // "clear usage visibility for each editor," and an admin doing the job
  // the proposal describes (varying an allowance, spotting who's about to
  // hit theirs) needs more than "Spend to date" (all-time, above) to do it.
  // Two extra queries, each scoped to just the ids on THIS page — the same
  // bounded pattern getUserProjectCounts uses (lib/db-aggregates.ts), not
  // one round trip per row:
  //
  //   - profiles' own daily_cap_override_usd/weekly_cap_override_usd
  //     (0031_account_allowances.sql) — user_directory (0028) doesn't carry
  //     these, and account_spend_windows (0031) deliberately doesn't either
  //     (resolving an override against its role default needs lib/spend.ts's
  //     role-keyed env vars, which no SQL view has access to — see that
  //     migration's header on account_spend_windows for why).
  //   - account_spend_windows (0031) for this-Manila-day / this-Manila-week
  //     spend, aggregated in SQL exactly like every other figure on this
  //     page, using the exact boundary lib/spend.ts enforces.
  //
  // lib/spend.ts is loaded via a dynamic import(), not a static one — the
  // exact reason lib/sidebar-budget.ts's file header gives: a static import
  // would pull parseCapEnvUsd's module-load throw into /users' module
  // graph, and /users is precisely the page an admin needs to still load
  // when a cap env var IS the thing that's broken. Any failure here
  // degrades every allowance cell to "—" (same fail-soft contract as the
  // sidebar) instead of taking the whole page down.
  const userIds = users.map((user) => user.id);
  const overrideByUserId = new Map<
    string,
    {
      daily_cap_override_usd: number | null;
      weekly_cap_override_usd: number | null;
      hourly_cap_override_usd: number | null;
      global_cap_exempt: boolean;
      daily_cap_enabled: boolean | null;
    }
  >();
  const spendWindowByUserId = new Map<
    string,
    { spent_today_usd: number; spent_this_week_usd: number }
  >();
  const avatarUrlByUserId = new Map<string, string>();
  const lastSeenByUserId = new Map<string, string | null>();
  // Per-user sum + count of unexpired allowance_grants
  // (0033_allowance_requests_rls_fix.sql's user_active_grants_usd_by_user) —
  // "clear usage visibility for each editor" (the proposal's own words,
  // quoted above) has to include what an admin has ALREADY granted before
  // they grant more, or /allowances' Approve dialog becomes the only place
  // that fact is visible at all. This USED to be a plain `.from(
  // "allowance_grants").select(...).in(...).gt(...)` fetched and reduced in
  // application code — the exact under-reporting shape 0026_cost_
  // aggregates.sql's header describes: PostgREST's `max_rows = 1000`
  // (supabase/config.toml) truncates a result past that count with no
  // error, so it looked correct for as long as no account's page happened
  // to cross that row count, then would have quietly under-reported the
  // moment one did. Aggregated in SQL now instead (SUM/GROUP BY has no row
  // cap to silently cross), and via a batched RPC rather than
  // getUserActiveGrantsUsd called once per row, for the same "one bounded
  // query per page, not one per user" reason getUserProjectCounts documents.
  const activeGrantsByUserId = new Map<string, ActiveGrantTotals>();
  // Per-day spend for the Burn column: one bounded read for this page's ids
  // (spend_daily_by_user, 0135). Fail-soft like the grants read: the column
  // shows "—" rather than taking the page down.
  let dailySpendByUserId = new Map<string, number[]>();
  let resolveAccountCaps: ResolveAccountCapsFn | null = null;
  // The largest weekly allowance any role gets, and therefore the ceiling on
  // a per-account override (weeklyCapOverrideError, lib/allowance.ts). Read
  // through the same dynamic import as resolveAccountCaps below and for the
  // same reason: lib/spend.ts throws at module load on a malformed cap env
  // var, so it must never be reached from a Client Component or a static
  // import here. null leaves the allowance control unrendered rather than
  // rendering one that cannot validate what it accepts.
  let maxWeeklyCapUsd: number | null = null;
  let maxDailyCapUsd: number | null = null;
  // The INSTALLATION default (app_settings, 0077). Per-account overrides are
  // resolved per row below — this is the value the Enable/Disable control
  // shows and the fallback for accounts that have no opinion.
  let dailyCapEnabled = false;

  if (userIds.length > 0) {
    const nowIso = new Date().toISOString();
    const [{ data: overridesData }, { data: windowsData }, activeGrantsTotals, dailySpend] =
      await Promise.all([
        supabase
          .from("profiles")
          .select(
            "id, avatar_storage_key, last_seen_at, daily_cap_override_usd, weekly_cap_override_usd, hourly_cap_override_usd, global_cap_exempt, daily_cap_enabled",
          )
          .in("id", userIds),
        supabase
          .from("account_spend_windows")
          .select("user_id, spent_today_usd, spent_this_week_usd")
          .in("user_id", userIds),
        // Fail-soft, same contract as the resolveAccountCaps dynamic import
        // just below: a broken RPC must degrade this one column to "—", not
        // take down the whole page an admin needs when something else (a
        // cap env var, say) is ALSO broken.
        getUserActiveGrantsTotals(supabase, userIds, nowIso).catch((error: unknown) => {
          console.error("Failed to load active allowance grant totals for /users", error);
          return new Map<string, ActiveGrantTotals>();
        }),
        getDailySpendByUser(supabase, userIds, burnDates.length, burnNow).catch(
          (error: unknown) => {
            console.error("Failed to load daily spend for /users burn column", error);
            return new Map<string, number[]>();
          },
        ),
      ]);
    dailySpendByUserId = dailySpend;
    for (const row of overridesData ?? []) {
      overrideByUserId.set(row.id, row);
      lastSeenByUserId.set(row.id, row.last_seen_at);
    }
    const avatarEntries = await Promise.all(
      (overridesData ?? []).map(async (row) => {
        if (!row.avatar_storage_key) return null;
        try {
          return [row.id, await getImageUrl(row.avatar_storage_key, "thumb", 3600)] as const;
        } catch (error) {
          console.error(`Failed to sign avatar URL for /users row ${row.id}`, error);
          return null;
        }
      }),
    );
    for (const entry of avatarEntries) {
      if (entry) avatarUrlByUserId.set(entry[0], entry[1]);
    }
    for (const row of windowsData ?? []) spendWindowByUserId.set(row.user_id, row);
    for (const [userId, totals] of activeGrantsTotals) activeGrantsByUserId.set(userId, totals);

    try {
      const spend = await import("@/lib/spend");
      resolveAccountCaps = spend.resolveAccountCaps;
      maxWeeklyCapUsd = MAX_ACCOUNT_WEEKLY_CAP_USD;
      maxDailyCapUsd = MAX_ACCOUNT_DAILY_CAP_USD;
      dailyCapEnabled = await spend.getUserDailyCapEnabled();
    } catch (error) {
      console.error("Failed to load lib/spend for /users allowance columns", error);
    }
  }

  const onlineUsers = await Promise.all(
    (onlineProfiles.data ?? []).map(async (profile) => {
      let avatarUrl = avatarUrlByUserId.get(profile.id);
      if (!avatarUrl && profile.avatar_storage_key) {
        try {
          avatarUrl = await getImageUrl(profile.avatar_storage_key, "thumb", 3600);
        } catch (error) {
          console.error(`Failed to sign online avatar URL for /users row ${profile.id}`, error);
        }
      }
      return { id: profile.id, username: profile.username, email: profile.email, avatarUrl };
    }),
  );

  // The true empty state: no search term in play, and there are no profiles
  // at all. Distinct from "no users match this search" below — collapsing
  // the two would make a working search feel like a broken page on the
  // first typo, same reasoning as /projects and /library.
  if (totalCount === 0 && !q) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-16 text-center">
        <h1 className="text-2xl font-medium text-foreground">No users yet</h1>
        <p className="text-sm text-muted-foreground">
          Users show up here once someone has signed up.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <AccountsControlLiveRefresh />
      {/* Two groups, not one row of four things. The left is what this PAGE
          is — a title, how many accounts, how many per page. The right is
          SPEND POLICY: two controls that change behaviour for every editor
          at once and belong to nothing on screen in particular.
          They read as peers when they sit in one flex row, and an admin
          scanning for "how do I change everyone's allowance" has to sort
          them out from a pagination control first. Splitting them also
          matches /allowances, whose header is title-then-count with no
          actions mixed in. */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-medium text-foreground">Users</h1>
          {/* Total count always renders, whether or not PaginationControls
              below has anything to show — same reasoning as /projects: with
              few enough users at the current page size there's only one page,
              and the count here is how an operator can tell that's the whole
              list rather than a broken control. The size selector sits beside
              it for the same reason: it must be reachable even on a
              single-page result, since shrinking the size can turn it into
              more than one page. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <p className="text-sm text-muted-foreground">
              {totalCount} {archived ? "archived" : totalCount === 1 ? "user" : "users"}
            </p>
            <Link
              href={buildUsersHref("", 1, sort, pageSize, !archived)}
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {archived ? "Back to active accounts" : `Archived (${archivedCount ?? 0})`}
            </Link>
            <PageSizeControl size={pageSize} buildHref={(size) => usersHref(q, 1, sort, size)} />
          </div>
        </div>

        {/* Page-level, not per-row: both act on every editor at once, so
            putting either in a row would misrepresent its blast radius.
            The switch renders whatever lib/spend did — it sets a boolean and
            needs no cap ceiling to validate against — while the amounts
            control hides entirely when the ceiling could not be resolved,
            same rule as the per-account one: a limit editor that cannot
            validate its own input should not exist. */}
        {/* One "Spending limits" button holds the daily switch and the
            by-role amounts. If lib/spend failed the amounts can't validate,
            so only the switch shows, on its own. */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {maxWeeklyCapUsd !== null ? (
            <AllEditorsAllowanceDialog
              maxWeeklyCapUsd={maxWeeklyCapUsd}
              maxDailyCapUsd={maxDailyCapUsd ?? 0}
              editorCount={plainEditorCount ?? 0}
              trustedEditorCount={trustedEditorCount ?? 0}
              hybridEditorCount={hybridEditorCount ?? 0}
              aiAnimatorCount={aiAnimatorCount ?? 0}
              followingDefaultCount={followingDefaultCount ?? 0}
            />
          ) : (
            <DailyCapSwitch
              enabled={dailyCapEnabled}
              followingDefaultCount={followingDefaultCount ?? 0}
            />
          )}
        </div>
      </div>

      <UserPresenceStrip
        total={presenceTotal.error ? null : presenceTotal.count}
        online={presenceOnline.error ? null : presenceOnline.count}
        users={onlineUsers}
      />

      <TeamBurnStrip dates={burnDates} days={teamDaily} now={burnNow} />

      {/* Live search, debounced 500ms — see components/live-search.tsx for
          the full reasoning (no API route, focus/cursor survival, the
          no-JS fallback). `buildHref` resets to page 1 on every query
          change and carries `sort`/`dir`/`size` forward exactly like the
          header/pager/size-control hrefs already do — a search result set
          has its own page count, not the unfiltered list's. */}
      <LiveSearch
        q={q}
        placeholder="Search by email or username…"
        ariaLabel="Search users"
        action="/users"
        hiddenFields={{
          ...(sort.column !== DEFAULT_SORT.column || sort.direction !== DEFAULT_SORT.direction
            ? { sort: sort.column, dir: sort.direction }
            : {}),
          ...(pageSize !== DEFAULT_PAGE_SIZE ? { size: String(pageSize) } : {}),
          ...(archived ? { archived: "1" } : {}),
        }}
        clearHref={q ? usersHref("", 1, sort, pageSize) : null}
      >
        {users.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-16 text-center">
            <p className="text-base font-medium text-foreground">
              {q ? (
                <>No users match &ldquo;{q}&rdquo;.</>
              ) : archived ? (
                "No archived accounts."
              ) : (
                "No users yet."
              )}
            </p>
            <p className="text-sm text-muted-foreground">
              Try a different email or username, or{" "}
              <Link href={usersHref("", 1, sort, pageSize)} className="underline">
                clear the search
              </Link>
              .
            </p>
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  {/* Clicking a header always lands on page 1 (buildUsersHref
                    below doesn't carry `page`) — a re-sorted list's "page 3"
                    means something different from the previous sort's, the
                    same reasoning /users' search box already resets `page`
                    on submit. */}
                  <SortableTableHead
                    column="email"
                    label="Email"
                    sort={sort}
                    defaultDirection="asc"
                    buildHref={(next) => usersHref(q, 1, next, pageSize)}
                  />
                  <SortableTableHead
                    column="username"
                    label="Username"
                    sort={sort}
                    defaultDirection="asc"
                    buildHref={(next) => usersHref(q, 1, next, pageSize)}
                  />
                  <SortableTableHead
                    column="role"
                    label="Role"
                    sort={sort}
                    defaultDirection="asc"
                    buildHref={(next) => usersHref(q, 1, next, pageSize)}
                  />
                  <SortableTableHead
                    column="status"
                    label="Status"
                    sort={sort}
                    defaultDirection="asc"
                    buildHref={(next) => usersHref(q, 1, next, pageSize)}
                  />
                  <SortableTableHead
                    column="joined"
                    label="Joined"
                    sort={sort}
                    buildHref={(next) => usersHref(q, 1, next, pageSize)}
                  />
                  <SortableTableHead
                    column="projects"
                    label="Projects"
                    align="right"
                    sort={sort}
                    buildHref={(next) => usersHref(q, 1, next, pageSize)}
                  />
                  <SortableTableHead
                    column="spend"
                    label="Used to date"
                    align="right"
                    sort={sort}
                    buildHref={(next) => usersHref(q, 1, next, pageSize)}
                  />
                  <SortableTableHead
                    column="burn"
                    label="Burn"
                    align="right"
                    sort={sort}
                    buildHref={(next) => usersHref(q, 1, next, pageSize)}
                  />
                  {/* Not sortable, unlike the columns above: these come from
                      a per-page join (profiles' overrides + account_spend_
                      windows), not user_directory — there is no single
                      relation carrying an already-resolved cap for Postgres
                      to ORDER BY (see this page's fetch above).
                      "Used today"/"Used this week", not bare "Today"/"This
                      week" — this admin surface shows the USED direction
                      (Part 4 of the task that added this rule): a bare
                      period label can't tell a reader whether it's spent or
                      remaining, which is the exact defect this task exists
                      to fix. */}
                  <TableHead numeric>Used today</TableHead>
                  <TableHead numeric>Used this week</TableHead>
                  <TableHead numeric>Active grants</TableHead>
                  {/* Labelled now that it is never empty: every editor-tier
                      row carries either a decision to make or an actions
                      menu. The old sr-only header existed because the cell
                      WAS blank for most rows, which made a visible heading
                      read like data had failed to load. */}
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => {
                  const override = overrideByUserId.get(user.id);
                  const spendWindow = spendWindowByUserId.get(user.id);
                  const caps =
                    resolveAccountCaps && override
                      ? resolveAccountCaps({
                          role: user.role,
                          daily_cap_override_usd: override.daily_cap_override_usd,
                          weekly_cap_override_usd: override.weekly_cap_override_usd,
                        })
                      : null;
                  const activeGrants = activeGrantsByUserId.get(user.id) ?? {
                    totalUsd: 0,
                    count: 0,
                    endableCount: 0,
                    latestTransferAmountUsd: null,
                  };
                  // caps.weeklyCapUsd + active grants — lib/spend.ts's
                  // getEffectiveWeeklyCapUsd's own arithmetic, inlined here
                  // rather than calling that function per row: it makes its
                  // own (single-user) DB round trip for the grants sum,
                  // which this page has already fetched in ONE batched query
                  // above (activeGrantsByUserId) — calling it per row would
                  // turn one query into up to `pageSize` of them, exactly
                  // the N+1 pattern this page's other columns already avoid.
                  const effectiveWeeklyCapUsd = caps
                    ? caps.weeklyCapUsd + activeGrants.totalUsd
                    : null;

                  // Burn: this account's last 7 Manila days, and the pace those
                  // days imply against the weekly total shown in the next
                  // columns. null (read failed) renders "—".
                  const burnDays = dailySpendByUserId.get(user.id);
                  const burn: UserBurn | null = burnDays
                    ? {
                        dates: burnDates,
                        days: burnDays,
                        ...computeBurn({
                          days: burnDays,
                          weekSpentUsd:
                            spendWindow?.spent_this_week_usd ??
                            weekSpentFromDays(burnDays, burnNow),
                          weekTotalUsd: effectiveWeeklyCapUsd,
                          now: burnNow,
                        }),
                      }
                    : null;

                  // Read four times in the trust toggle below (direction,
                  // pending label, label, and which of the two it is). Named
                  // once here so the row cannot end up offering "Make
                  // trusted" while sending "untrust".
                  // This account's own switch (0134) over the installation default.
                  const rowDailyCapEnabled = override?.daily_cap_enabled ?? dailyCapEnabled;
                  const allowance =
                    caps && maxWeeklyCapUsd !== null && maxDailyCapUsd !== null
                      ? {
                          effectiveWeeklyCapUsd: caps.weeklyCapUsd,
                          activeGrantsUsd: activeGrants.totalUsd,
                          hasDailyCapSwitch: override?.daily_cap_enabled != null,
                          hasOverride: override?.weekly_cap_override_usd != null,
                          maxWeeklyCapUsd,
                          effectiveDailyCapUsd: caps.dailyCapUsd,
                          hasDailyOverride: override?.daily_cap_override_usd != null,
                          maxDailyCapUsd,
                          effectiveHourlyCapUsd: override?.hourly_cap_override_usd ?? null,
                          hasHourlyOverride: override?.hourly_cap_override_usd != null,
                          globalCapExempt: override?.global_cap_exempt === true,
                          dailyCapEnabled: rowDailyCapEnabled,
                        }
                      : null;

                  return (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium text-foreground">
                        <div className="flex items-center gap-3">
                          <UserAvatar
                            username={user.username}
                            email={user.email}
                            avatarUrl={avatarUrlByUserId.get(user.id)}
                          >
                            <PresenceDot
                              lastSeenAt={lastSeenByUserId.get(user.id)}
                              className="absolute bottom-0 right-0 size-3 ring-2 ring-background"
                              offlineClassName="bg-muted-foreground/50"
                            />
                          </UserAvatar>
                          <span>{user.email}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="text-muted-foreground">{user.username}</span>
                          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <PresenceDot
                              lastSeenAt={lastSeenByUserId.get(user.id)}
                              offlineClassName="bg-muted-foreground/50"
                            />
                            {lastSeenLabel(lastSeenByUserId.get(user.id))}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <RoleBadge role={user.role} />
                      </TableCell>
                      <TableCell>
                        <AccountStatusBadge role={user.role} status={user.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {dateTimeFormatter.format(new Date(user.created_at))}
                      </TableCell>
                      <TableCell numeric>{user.project_count}</TableCell>
                      <TableCell numeric>{formatUsd(user.spend_usd)}</TableCell>
                      <TableCell numeric>
                        <BurnCell burn={burn} />
                      </TableCell>
                      <TableCell numeric className="text-muted-foreground">
                        {caps && spendWindow
                          ? rowDailyCapEnabled
                            ? `${formatUsd(spendWindow.spent_today_usd)} / ${formatUsd(caps.dailyCapUsd)}`
                            : formatUsd(spendWindow.spent_today_usd)
                          : "—"}
                      </TableCell>
                      <TableCell numeric className="text-muted-foreground">
                        {effectiveWeeklyCapUsd !== null && spendWindow
                          ? `${formatUsd(spendWindow.spent_this_week_usd)} / ${formatUsd(effectiveWeeklyCapUsd)}`
                          : "—"}
                      </TableCell>
                      {/* Read-only totals with the latest active transfer direction. */}
                      <TableCell numeric className="text-muted-foreground">
                        {activeGrants.count > 0 ? (
                          <span className="inline-flex items-center justify-end gap-2">
                            {`${formatUsd(activeGrants.totalUsd)} (${activeGrants.count})`}
                            {activeGrants.latestTransferAmountUsd !== null ? (
                              <Badge variant="secondary" title="Latest allowance transfer">
                                {activeGrants.latestTransferAmountUsd < 0 ? "Passed" : "Received"}
                              </Badge>
                            ) : null}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      {/* Admins and active editors have nothing to approve or
                          reject. Other editor statuses carry
                          Approve: 'pending' because that is the decision
                          being asked for, 'rejected' because that decision
                          has to be undoable — decideAccountApproval accepts
                          both server-side (DECIDABLE_FROM), so this is the
                          honest rendering of that rule rather than a
                          second, softer copy of it. Reject only appears on
                          a pending row: this page deliberately cannot cut
                          off an account that is already working.
                          Approve is a plain form and Reject is a dialog,
                          not two forms as before — an approval grants
                          exactly what the account applied for, a rejection
                          locks a colleague out. The button names the
                          account it acts on for a screen reader; "Approve"
                          repeated once per row is unusable out of visual
                          context. */}
                      <TableCell>
                        {user.role === "admin" ? (
                          allowance || user.id !== viewer.id ? (
                            <UserRowActions
                              userId={user.id}
                              email={user.email}
                              role={user.role}
                              allowance={allowance}
                              allowanceOnly
                              canDemote={user.id !== viewer.id}
                            />
                          ) : null
                        ) : !requiresAccountApproval(user.role) ? null : (
                          <div className="flex items-center justify-end gap-3">
                            <Link
                              href={`/users/${user.id}/creations`}
                              className="whitespace-nowrap text-sm font-medium text-foreground underline-offset-4 hover:underline"
                            >
                              View creations <span className="sr-only"> for {user.email}</span>
                            </Link>
                            {user.status === "active" ? (
                              /* An ACTIVE editor tier is the only row with a role
                                 to change: promotion is meaningless before the
                                 account is approved (can_approve_allowance()
                                 requires status = 'active' too), and an admin row
                                 has no legal transition here at all. So this cell
                                 carries the approval decision until it is made,
                                 and the actions menu afterwards — never both,
                                 because they are never both available. */
                              <UserRowActions
                                userId={user.id}
                                email={user.email}
                                role={user.role}
                                /* Null when lib/spend did not load: the caps
                                   pre-fill the numbers the admin just read in
                                   this row, and a limit editor that cannot
                                   validate its own input is worse than none. */
                                allowance={allowance}
                              />
                            ) : (
                              <div className="flex items-center justify-end gap-2">
                                {/* A deactivated row gets Reactivate, never
                                    Approve. They are different decisions on the
                                    server (DECIDABLE_FROM), and Approve here
                                    would match zero rows and report a race that
                                    never happened — the honest control is the one
                                    that can actually succeed. */}
                                {user.status === "deactivated" ? (
                                  <ActionForm
                                    action={decideAccountApproval.bind(null, user.id, "reactivate")}
                                    fallbackErrorMessage="Failed to reactivate that account."
                                  >
                                    <SubmitButton size="sm" pendingLabel="Reactivating…">
                                      Reactivate
                                      <span className="sr-only"> {user.email}</span>
                                    </SubmitButton>
                                  </ActionForm>
                                ) : (
                                  <>
                                    <ActionForm
                                      action={decideAccountApproval.bind(null, user.id, "approve")}
                                      fallbackErrorMessage="Failed to approve that account."
                                    >
                                      <SubmitButton size="sm" pendingLabel="Approving…">
                                        Approve
                                        <span className="sr-only"> {user.email}</span>
                                      </SubmitButton>
                                    </ActionForm>
                                    {user.status === "pending" ? (
                                      <RejectAccountDialog userId={user.id} email={user.email} />
                                    ) : null}
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <PaginationControls
              page={requestedPage}
              totalPages={totalPages}
              previousHref={
                requestedPage > 1 ? usersHref(q, requestedPage - 1, sort, pageSize) : null
              }
              nextHref={
                requestedPage < totalPages ? usersHref(q, requestedPage + 1, sort, pageSize) : null
              }
            />
          </>
        )}
      </LiveSearch>
    </div>
  );
}
