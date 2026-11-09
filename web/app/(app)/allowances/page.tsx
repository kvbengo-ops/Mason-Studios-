import Link from "next/link";
import { redirect } from "next/navigation";
import type { JSX } from "react";
import { isAdmin, isApprover, requireApprover, requireUser } from "@/actions/guard";
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
import { decisionBlockReason, defaultGrantAmountUsd } from "@/lib/allowance";
import { formatUsd } from "@/lib/format-usd";
import { getKieAccountBalanceUsd, formatAccountFundsUsd } from "@/lib/kie-balance";
import { getBytePlusBalanceUsd } from "@/lib/byteplus-balance";
import { getOutstandingAllowanceUsd, getUserActiveGrantsTotals } from "@/lib/db-aggregates";
import { LiveSearch } from "@/components/live-search";
import { PageSizeControl } from "@/components/page-size-control";
import { PaginationControls } from "@/components/pagination-controls";
import { SortableTableHead } from "@/components/sortable-table-head";
import { DecideAllowanceRequestDialog } from "@/components/decide-allowance-request-dialog";
import { AllowanceRequestRow } from "@/components/allowance-request-row";
import { AllowanceStatusBadge } from "@/components/allowance-status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AllowanceRequestStatus } from "@/types/db";
import type { AccountCapProfile, AccountCaps } from "@/lib/spend";
import { dateTimeFormatter } from "@/lib/datetime";

// Type-only import, same reasoning as /users' own ResolveAccountCapsFn: this
// is erased at compile time (no module-load risk from lib/spend.ts's
// parseCapEnvUsd throw), and the actual function is loaded via a dynamic
// import() at runtime, in the fetch block below, for exactly that reason.
type ResolveAccountCapsFn = (profile: AccountCapProfile) => AccountCaps;

// Approver worklist for the allowance request -> grant workflow
// (0032_allowance_requests.sql, web/actions/allowance.ts) — same
// requireApprover()-gated, session-client, sortable/paginated/searchable shape
// as /users (web/app/(app)/users/page.tsx) and /projects, reusing the same
// table/search/pagination components rather than growing a fourth table
// style. Read-only visibility PLUS the two mutating controls this page
// actually needs (Approve/Deny) live in DecideAllowanceRequestDialog —
// every other admin surface in this codebase (/users) is read-only for the
// same "don't grow a new privilege surface" reasoning /users' own header
// gives, but this page's entire reason to exist IS deciding requests, so
// that reasoning doesn't transfer here.

// Shape of the allowance_request_directory query below
// (0032_allowance_requests.sql) — see that view's header for why this page
// reads it instead of allowance_requests directly (sortable/searchable
// requester email in the same query as the ORDER BY + LIMIT/OFFSET).
interface AllowanceRequestDirectoryRow {
  id: string;
  user_id: string;
  user_email: string;
  user_username: string;
  requested_usd: number;
  reason: string | null;
  status: AllowanceRequestStatus;
  decided_by_email: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

const SORT_COLUMNS = ["user", "requested", "status", "created"] as const;
type SortColumn = (typeof SORT_COLUMNS)[number];

const SORT_COLUMN_TO_DB: Record<SortColumn, string> = {
  user: "user_email",
  requested: "requested_usd",
  status: "status",
  created: "created_at",
};

// Newest first — the admin's actual worklist is "what showed up recently",
// same default-preserving reasoning /users' own DEFAULT_SORT comment gives.
const DEFAULT_SORT: ParsedSort<SortColumn> = { column: "created", direction: "desc" };

function buildAllowancesHref(
  q: string,
  page: number,
  sort: ParsedSort<SortColumn>,
  size: PageSize,
): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  if (sort.column !== DEFAULT_SORT.column || sort.direction !== DEFAULT_SORT.direction) {
    params.set("sort", sort.column);
    params.set("dir", sort.direction);
  }
  if (size !== DEFAULT_PAGE_SIZE) params.set("size", String(size));
  const qs = params.toString();
  return qs ? `/allowances?${qs}` : "/allowances";
}

/** Own rows through RLS; peer names come only from the existing recipient directory. */
async function readPassHistory(userId: string): Promise<JSX.Element> {
  try {
    const supabase = await createClient();
    const { startOfManilaWeekIso, endOfManilaWeekIso } = await import("@/lib/spend");
    const [{ data: passes, error }, { data: peers, error: peersError }] = await Promise.all([
      supabase
        .from("allowance_grants")
        .select("id, amount_usd, transfer_peer_id, created_at, note")
        .eq("user_id", userId)
        .not("transfer_peer_id", "is", null)
        .gte("created_at", startOfManilaWeekIso())
        .lt("created_at", endOfManilaWeekIso())
        .order("created_at", { ascending: false }),
      supabase.rpc("transfer_recipients"),
    ]);
    if (error) throw error;
    if (peersError) throw peersError;
    const names = new Map((peers ?? []).map((peer) => [peer.id, peer.username || peer.email]));
    return (
      <Card>
        <CardHeader>
          <CardTitle>Passes this week</CardTitle>
        </CardHeader>
        <CardContent>
          {passes?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Colleague</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Passed at</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {passes.map((pass) => (
                  <TableRow key={pass.id}>
                    <TableCell>
                      {pass.amount_usd > 0 ? "From " : "To "}
                      {names.get(pass.transfer_peer_id ?? "") ?? "Unavailable colleague"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pass.amount_usd > 0 ? "+" : "−"}
                      {formatUsd(Math.abs(pass.amount_usd))}
                    </TableCell>
                    <TableCell>{dateTimeFormatter.format(new Date(pass.created_at))}</TableCell>
                    <TableCell>{pass.note || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No passes this week.</p>
          )}
        </CardContent>
      </Card>
    );
  } catch (error) {
    console.error("Failed to load own pass history", error);
    return (
      <Card>
        <CardHeader>
          <CardTitle>Passes this week</CardTitle>
        </CardHeader>
        <CardContent>Pass history could not be loaded. Refresh to try again.</CardContent>
      </Card>
    );
  }
}

export default async function AllowancesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    page?: string | string[];
    sort?: string | string[];
    dir?: string | string[];
    size?: string | string[];
  }>;
}): Promise<JSX.Element> {
  const { user, profile } = await requireUser();
  const passHistory = !isAdmin(profile) ? await readPassHistory(user.id) : null;
  // Editors get only their own history. The existing worklist still passes
  // requireApprover before any queue, requester, or account-funds reads.
  if (!isApprover(profile)) {
    return <div className="flex flex-col gap-6 p-6">{passHistory}</div>;
  }
  await requireApprover();
  const adminViewer = isAdmin(profile);

  // Session client, same as /users: allowance_requests_select (0074) lets
  // approvers read the queue via can_approve_allowance(), so the database
  // still does the scoping.
  const supabase = await createClient();

  const resolvedSearchParams = await searchParams;
  const q = sanitizeSearchTerm(resolvedSearchParams.q ?? "");
  const requestedPage = parsePage(resolvedSearchParams.page);
  const pageSize = parsePageSize(resolvedSearchParams.size);
  const { from, to } = pageRange(requestedPage, pageSize);
  const sort = parseSort(
    SORT_COLUMNS,
    DEFAULT_SORT,
    resolvedSearchParams.sort,
    resolvedSearchParams.dir,
  );

  const baseQuery = supabase
    .from("allowance_request_directory")
    .select(
      "id, user_id, user_email, user_username, requested_usd, reason, status, decided_by_email, decided_at, decision_note, created_at",
      { count: "exact" },
    );
  const orFilter = buildIlikeOrFilter(["user_email", "user_username"], q);
  const filteredQuery = orFilter ? baseQuery.or(orFilter) : baseQuery;

  const { data, error, count } = await filteredQuery
    .order(SORT_COLUMN_TO_DB[sort.column], { ascending: sort.direction === "asc" })
    .order("id", { ascending: true })
    .range(from, to);

  if (error) {
    throw new Error(`Failed to load allowance requests: ${error.message}`);
  }

  const totalCount = count ?? 0;
  const totalPages = totalPageCount(totalCount, pageSize);

  if (requestedPage > totalPages && totalCount > 0) {
    redirect(buildAllowancesHref(q, totalPages, sort, pageSize));
  }

  const requests = (data ?? []) as AllowanceRequestDirectoryRow[];

  // The default grant expiry is the SAME for every pending row on this page
  // (the end of the current Manila week — lib/spend.ts's endOfManilaWeekIso)
  // regardless of when each request was filed, so it's computed once here
  // rather than per row. lib/spend.ts is imported dynamically, same
  // fail-soft reasoning as /users and the sidebar (this file's own header):
  // a malformed cap env var must not take down the one page an admin needs
  // to act on a request from.
  //
  // The fallback used to be `new Date().toISOString()` — "expires now" — so
  // an admin who hit the import failure and approved without editing the
  // pre-filled field wrote a grant that was already expired at the moment
  // it was created (user_active_grants_usd's `expires_at > at_ts` excludes
  // it immediately). +7 days is a plain-arithmetic fallback with no
  // dependency on lib/spend.ts (the thing that just failed to load) that at
  // least writes a LIVE grant if the admin doesn't notice and edit the
  // field — decideAllowanceRequest's own grantExpiryError check (lib/
  // allowance.ts) is the actual backstop either way, this only makes the
  // pre-filled default not actively wrong while that backstop is doing its
  // job.
  const fallbackExpiry = new Date();
  fallbackExpiry.setDate(fallbackExpiry.getDate() + 7);
  let defaultExpiresAtIso = fallbackExpiry.toISOString();
  // The two figures Part 3 of the task that added this puts in front of an
  // admin at the moment of decision: kie's real funds (never
  // shown to an editor, but this IS the admin surface that gets it — same
  // reasoning /spend already follows) and the total outstanding allowance
  // across every non-admin account, so the gap between "$200 authorised"
  // and "$31 funded" is visible before an approval makes it worse. null
  // means "couldn't compute it" — rendered as "Unknown" (kieBalanceUsd, via
  // formatAccountFundsUsd) or omitted (outstandingAllowanceUsd), never as a
  // silent $0 that would misread as "nothing outstanding."
  let resolveAccountCaps: ResolveAccountCapsFn | null = null;
  let outstandingAllowanceUsd: number | null = null;
  let peerMaxGrantUsd: number | null = null;
  try {
    const spend = await import("@/lib/spend");
    defaultExpiresAtIso = spend.endOfManilaWeekIso();
    resolveAccountCaps = spend.resolveAccountCaps;
    peerMaxGrantUsd = adminViewer ? null : spend.TRUSTED_WEEKLY_CAP_USD;
    if (adminViewer) {
      outstandingAllowanceUsd = await getOutstandingAllowanceUsd(
        supabase,
        spend.TRUSTED_WEEKLY_CAP_USD,
        spend.TRUSTED_WEEKLY_CAP_USD,
        spend.HYBRID_EDITOR_WEEKLY_CAP_USD,
        spend.AI_ANIMATOR_WEEKLY_CAP_USD,
      );
    }
  } catch (importError) {
    console.error("Failed to load lib/spend for /allowances", importError);
  }

  // Admin-only (CX-2): getKieAccountBalanceUsd is a /spend-grade figure and
  // /spend stays admin-only. Not called at all for a peer rather than called
  // and discarded.
  const [kieBalanceUsd, bytePlusBalanceUsd] = adminViewer
    ? await Promise.all([getKieAccountBalanceUsd(), getBytePlusBalanceUsd()])
    : [null, null];
  // Allowance can be spent on either vendor now (Seedance 2.5 on BytePlus,
  // everything else on kie), so funds are the two together. Unknown while
  // kie's is unknown; BytePlus unreadable (no IAM keys) counts as kie alone,
  // and the card says so.
  const accountFundsUsd = kieBalanceUsd !== null ? kieBalanceUsd + (bytePlusBalanceUsd ?? 0) : null;

  // Per-requester "current allowance / used this week" for the approve
  // dialog (Part 3: "their current allowance and what they have used this
  // week") — same batched, per-page-scoped pattern /users' own Today/This
  // week columns use, restricted to the pending rows actually reachable
  // through DecideAllowanceRequestDialog on this page.
  const pendingUserIds = requests
    .filter((request) => request.status === "pending")
    .map((request) => request.user_id);
  const overrideByUserId = new Map<
    string,
    {
      role: AccountCapProfile["role"];
      daily_cap_override_usd: number | null;
      weekly_cap_override_usd: number | null;
    }
  >();
  const spendWindowByUserId = new Map<string, { spent_this_week_usd: number }>();
  const activeGrantsByUserId = new Map<string, { totalUsd: number; count: number }>();
  if (pendingUserIds.length > 0) {
    const nowIso = new Date().toISOString();
    const [{ data: overridesData }, { data: windowsData }, activeGrantsTotals] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, role, daily_cap_override_usd, weekly_cap_override_usd")
        .in("id", pendingUserIds),
      supabase
        .from("account_spend_windows")
        .select("user_id, spent_this_week_usd")
        .in("user_id", pendingUserIds),
      getUserActiveGrantsTotals(supabase, pendingUserIds, nowIso).catch(
        (activeGrantsError: unknown) => {
          console.error(
            "Failed to load active allowance grant totals for /allowances",
            activeGrantsError,
          );
          return new Map<string, { totalUsd: number; count: number }>();
        },
      ),
    ]);
    for (const row of overridesData ?? []) overrideByUserId.set(row.id, row);
    for (const row of windowsData ?? []) spendWindowByUserId.set(row.user_id, row);
    for (const [userId, totals] of activeGrantsTotals) activeGrantsByUserId.set(userId, totals);
  }

  if (totalCount === 0 && !q) {
    return (
      <div className="flex flex-col gap-6 p-6">
        {passHistory}
        <div className="flex flex-col items-center justify-center gap-2 p-16 text-center">
          <h1 className="text-2xl font-medium text-foreground">No allowance requests yet</h1>
          <p className="text-sm text-muted-foreground">
            Requests show up here once an editor asks for more weekly allowance.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {passHistory}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-foreground">Allowance requests</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <p className="text-sm text-muted-foreground">
            {totalCount} {totalCount === 1 ? "request" : "requests"}
          </p>
          <PageSizeControl
            size={pageSize}
            buildHref={(size) => buildAllowancesHref(q, 1, sort, size)}
          />
        </div>
      </div>

      {/* Part 3 of the task that added this: the number nobody has today,
          in front of the admin at the moment of decision — kie's
          real funds next to the total outstanding allowance across every
          non-admin account, so a gap like "$200 authorised vs. ~$31 funded"
          is visible before an approval makes it worse, not discovered later
          on an invoice. Warns rather than blocks: an admin may have good
          reason to approve anyway (not every editor spends their full
          allowance every week) — this is a number to weigh, not a hard
          stop. */}
      {adminViewer ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Account funds</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold text-foreground">
                {accountFundsUsd !== null
                  ? formatUsd(accountFundsUsd)
                  : formatAccountFundsUsd(null)}
              </p>
              <p className="text-xs text-muted-foreground">
                kie {kieBalanceUsd !== null ? formatUsd(kieBalanceUsd) : "unavailable"} · BytePlus{" "}
                {bytePlusBalanceUsd !== null ? formatUsd(bytePlusBalanceUsd) : "unavailable"}
                {bytePlusBalanceUsd === null && kieBalanceUsd !== null
                  ? " (not counted — set BYTEPLUS_ACCESS_KEY_ID / BYTEPLUS_SECRET_ACCESS_KEY to read it)"
                  : ""}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Outstanding allowance (all accounts)</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold text-foreground">
                {outstandingAllowanceUsd !== null ? formatUsd(outstandingAllowanceUsd) : "Unknown"}
              </p>
              <p className="text-xs text-muted-foreground">
                What every editor and trusted editor could still spend this week if they used their
                full allowance. Admins excluded — see 0035_outstanding_allowance.sql.
              </p>
              {outstandingAllowanceUsd !== null &&
              accountFundsUsd !== null &&
              outstandingAllowanceUsd > accountFundsUsd ? (
                <p className="mt-2 text-sm font-medium text-warning">
                  Outstanding allowance exceeds account funds — approving more without funding the
                  account risks everyone failing at once.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : null}

      <LiveSearch
        q={q}
        placeholder="Search by requester email or username…"
        ariaLabel="Search allowance requests"
        action="/allowances"
        hiddenFields={{
          ...(sort.column !== DEFAULT_SORT.column || sort.direction !== DEFAULT_SORT.direction
            ? { sort: sort.column, dir: sort.direction }
            : {}),
          ...(pageSize !== DEFAULT_PAGE_SIZE ? { size: String(pageSize) } : {}),
        }}
        clearHref={q ? buildAllowancesHref("", 1, sort, pageSize) : null}
      >
        {requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-16 text-center">
            <p className="text-base font-medium text-foreground">
              No requests match &ldquo;{q}&rdquo;.
            </p>
            <p className="text-sm text-muted-foreground">
              Try a different email or username, or{" "}
              <Link href={buildAllowancesHref("", 1, sort, pageSize)} className="underline">
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
                  <SortableTableHead
                    column="user"
                    label="Requester"
                    sort={sort}
                    defaultDirection="asc"
                    buildHref={(next) => buildAllowancesHref(q, 1, next, pageSize)}
                  />
                  <SortableTableHead
                    column="requested"
                    label="Requested"
                    align="right"
                    sort={sort}
                    buildHref={(next) => buildAllowancesHref(q, 1, next, pageSize)}
                  />
                  <TableHead>Reason</TableHead>
                  <SortableTableHead
                    column="status"
                    label="Status"
                    sort={sort}
                    defaultDirection="asc"
                    buildHref={(next) => buildAllowancesHref(q, 1, next, pageSize)}
                  />
                  <SortableTableHead
                    column="created"
                    label="Requested at"
                    sort={sort}
                    buildHref={(next) => buildAllowancesHref(q, 1, next, pageSize)}
                  />
                  <TableHead>Decision</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((request) => (
                  <AllowanceRequestRow
                    key={request.id}
                    requestId={request.id}
                    userId={request.user_id}
                    username={request.user_username}
                    email={request.user_email}
                    requestedUsd={request.requested_usd}
                    reason={request.reason}
                    status={request.status}
                    createdAt={request.created_at}
                    decidedByEmail={request.decided_by_email}
                    decidedAt={request.decided_at}
                    decisionNote={request.decision_note}
                  >
                    <TableCell className="font-medium text-foreground">
                      {request.user_email}
                    </TableCell>
                    <TableCell numeric>{formatUsd(request.requested_usd)}</TableCell>
                    <TableCell
                      className="max-w-xs truncate text-muted-foreground"
                      title={request.reason ?? undefined}
                    >
                      {request.reason ?? "—"}
                    </TableCell>
                    <TableCell>
                      <AllowanceStatusBadge status={request.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {dateTimeFormatter.format(new Date(request.created_at))}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {request.decided_at ? (
                        <span>
                          {request.decided_by_email ?? "—"} ·{" "}
                          {dateTimeFormatter.format(new Date(request.decided_at))}
                          {request.decision_note ? ` · ${request.decision_note}` : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {request.status === "pending"
                        ? ((): JSX.Element => {
                            const blockReason = decisionBlockReason({
                              approverRole: profile.role,
                              approverId: user.id,
                              requesterId: request.user_id,
                              requestedUsd: request.requested_usd,
                              peerMaxGrantUsd,
                            });
                            if (blockReason) {
                              return (
                                <span className="text-sm text-muted-foreground">{blockReason}</span>
                              );
                            }

                            // Part 3: "their current allowance and what they
                            // have used this week" — resolved the same way
                            // /users' own Today/This week columns are, from
                            // the batched reads above. null (import failure,
                            // or no row for this user yet) renders as "—" in
                            // the dialog rather than a wrong number.
                            const override = overrideByUserId.get(request.user_id);
                            const activeGrants = activeGrantsByUserId.get(request.user_id) ?? {
                              totalUsd: 0,
                              count: 0,
                            };
                            const currentAllowanceUsd =
                              resolveAccountCaps && override
                                ? resolveAccountCaps({
                                    role: override.role,
                                    daily_cap_override_usd: override.daily_cap_override_usd,
                                    weekly_cap_override_usd: override.weekly_cap_override_usd,
                                  }).weeklyCapUsd + activeGrants.totalUsd
                                : null;
                            const usedThisWeekUsd =
                              spendWindowByUserId.get(request.user_id)?.spent_this_week_usd ?? null;
                            return (
                              <DecideAllowanceRequestDialog
                                requestId={request.id}
                                requesterEmail={request.user_email}
                                requestedUsd={request.requested_usd}
                                reason={request.reason}
                                defaultGrantAmountUsd={defaultGrantAmountUsd(request.requested_usd)}
                                defaultExpiresAtIso={defaultExpiresAtIso}
                                peerMaxGrantUsd={peerMaxGrantUsd}
                                currentAllowanceUsd={currentAllowanceUsd}
                                usedThisWeekUsd={usedThisWeekUsd}
                                accountFundsUsd={accountFundsUsd}
                                outstandingAllowanceUsd={outstandingAllowanceUsd}
                              />
                            );
                          })()
                        : null}
                    </TableCell>
                  </AllowanceRequestRow>
                ))}
              </TableBody>
            </Table>
            <PaginationControls
              page={requestedPage}
              totalPages={totalPages}
              previousHref={
                requestedPage > 1 ? buildAllowancesHref(q, requestedPage - 1, sort, pageSize) : null
              }
              nextHref={
                requestedPage < totalPages
                  ? buildAllowancesHref(q, requestedPage + 1, sort, pageSize)
                  : null
              }
            />
          </>
        )}
      </LiveSearch>
    </div>
  );
}
