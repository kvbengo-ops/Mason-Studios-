import type { JSX } from "react";
import { requireUser } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { signedUrl, AVATAR_TRANSFORM } from "@/lib/storage";
import { getAccountBudgetSnapshot } from "@/lib/spend";
import { formatAllowanceAmount, remainingForDisplayUsd } from "@/lib/format-usd";
import type { AllowanceDisplayUnit } from "@/lib/format-usd";
import { AvatarUpload } from "@/components/avatar-upload";
import { UsernameForm } from "@/components/username-form";
import { RoleBadge } from "@/components/role-badge";
import { AllowanceStatusBadge } from "@/components/allowance-status-badge";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { signOut } from "@/actions/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Database } from "@/types/db";
import { dateTimeFormatter, weekdayFormatter } from "@/lib/datetime";

// The one place an editor's own allowance and request history are visible
// at all — today the sidebar footer (components/sidebar-budget.tsx) shows
// remaining budget in passing on every route, but an editor has never been
// able to see their active grants or what happened to a request they filed
// weeks ago. That gap, not the avatar, is this page's actual reason to
// exist — see this task's own framing.
//
// requireUser() only — every signed-in operator (editor, trusted_editor,
// admin) has exactly one profile of their own to look at here. There is no
// requireAdmin() anywhere in this file: unlike /library or /users, nothing
// on this page is a shared or cross-account resource.

/** "Sun", "Mon", … — same short form the account menu's breakdown uses (components/sidebar-budget.tsx). */

type AllowanceGrantRow = Database["public"]["Tables"]["allowance_grants"]["Row"];
type AllowanceRequestRow = Database["public"]["Tables"]["allowance_requests"]["Row"];

export default async function ProfilePage(): Promise<JSX.Element> {
  const { user, profile } = await requireUser();
  const allowanceDisplayUnit: AllowanceDisplayUnit = profile.role === "admin" ? "usd" : "credits";
  const formatAllowance = (amountUsd: number): string =>
    formatAllowanceAmount(amountUsd, allowanceDisplayUnit);

  const avatarUrl = profile.avatar_storage_key
    ? await signedUrl(profile.avatar_storage_key, 3600, AVATAR_TRANSFORM)
    : null;

  // Session client, not the admin client: allowance_grants_select and
  // allowance_requests_select (0032_allowance_requests.sql) both already
  // let a caller read their OWN rows (`user_id = auth.uid()`), and this
  // page has nothing to protect that RLS wouldn't already scope correctly
  // — unlike actions/profile.ts's writes, which go through the admin
  // client because profiles has no update policy at all (see that file's
  // header).
  const supabase = await createClient();

  // Three independent reads, fired together — same "nothing here depends
  // on another's result" reasoning lib/sidebar-budget.ts and lib/spend.ts's
  // getAccountBudgetSnapshot already use for their own parallel reads.
  // Deliberately NOT wrapped in the sidebar's fail-soft try/catch: this is
  // a dedicated page load, not a shared root layout every route depends on
  // (see lib/sidebar-budget.ts's header for why that distinction matters),
  // so a failure here throws straight through to Next's error boundary —
  // the same choice render/page.tsx already makes for this exact function.
  const [budget, grantsResult, requestsResult] = await Promise.all([
    getAccountBudgetSnapshot(user.id, profile),
    supabase
      .from("allowance_grants")
      .select("*")
      .eq("user_id", user.id)
      .gt("expires_at", new Date().toISOString())
      // Unexpired AND not revoked — the active predicate of
      // 0075_revoke_allowance_grants.sql. Without this an editor's own
      // "Active grants" list keeps showing allowance an admin took back,
      // contradicting the headroom figure right above it.
      .is("revoked_at", null)
      .order("expires_at", { ascending: true }),
    supabase
      .from("allowance_requests")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  if (grantsResult.error) {
    throw new Error(
      `Failed to load allowance grants for ${user.id}: ${grantsResult.error.message}`,
    );
  }
  if (requestsResult.error) {
    throw new Error(
      `Failed to load allowance requests for ${user.id}: ${requestsResult.error.message}`,
    );
  }

  const grants = (grantsResult.data ?? []) as AllowanceGrantRow[];
  const requests = (requestsResult.data ?? []) as AllowanceRequestRow[];

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-foreground">Profile</h1>
        <p className="text-sm text-muted-foreground">{user.email}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 px-6">
          <AvatarUpload avatarUrl={avatarUrl} />

          <UsernameForm username={profile.username} />

          {/* Email and role are READ-ONLY, deliberately: role in particular
              is never rendered as a form field anywhere on this page — see
              actions/profile.ts's header for why updateUsername is the
              ONLY write this page can perform, and why it touches exactly
              one column. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Email</span>
              <span className="text-sm text-foreground">{user.email}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Role</span>
              <RoleBadge role={profile.role} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Allowance</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-6">
          {/* Shows the arithmetic, not just the answer — Part 2 of the task
              that added this: an approved grant otherwise changes "left"
              with no visible cause. Both windows reuse
              getAccountBudgetSnapshot's own fields (dailyUsedUsd,
              weeklyBaseCapUsd, weeklyGrantUsd, …) rather than re-deriving
              them here — see that function's doc comment for why the grant
              line is guaranteed to sum to the same weeklyRemainingUsd
              enforcement checks against. */}
          <div className="grid gap-4 sm:grid-cols-2">
            {budget.dailyCapEnabled ? (
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Left today</span>
                <div className="flex flex-col text-sm tabular-nums text-muted-foreground">
                  <span>{formatAllowance(budget.dailyCapUsd)} allowance</span>
                  <span>-{formatAllowance(budget.dailyUsedUsd)} used</span>
                  <span className="mt-0.5 border-t border-border pt-0.5 font-medium text-foreground">
                    = {formatAllowance(remainingForDisplayUsd(budget.dailyRemainingUsd))} left
                  </span>
                </div>
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Left this week</span>
              <div className="flex flex-col text-sm tabular-nums text-muted-foreground">
                <span>{formatAllowance(budget.weeklyBaseCapUsd)} allowance</span>
                {budget.weeklyGrantUsd > 0 ? (
                  <span>
                    +{formatAllowance(budget.weeklyGrantUsd)} grant
                    {budget.weeklyGrantEarliestExpiresAt
                      ? ` (expires ${weekdayFormatter.format(new Date(budget.weeklyGrantEarliestExpiresAt))})`
                      : ""}
                  </span>
                ) : null}
                <span>-{formatAllowance(budget.weeklyUsedUsd)} used</span>
                <span className="mt-0.5 border-t border-border pt-0.5 font-medium text-foreground">
                  = {formatAllowance(remainingForDisplayUsd(budget.weeklyRemainingUsd))} left
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">Active grants</h3>
            {grants.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active grants.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead numeric>Amount</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grants.map((grant) => (
                    <TableRow key={grant.id}>
                      <TableCell numeric>{formatAllowance(grant.amount_usd)}</TableCell>
                      {/* whitespace-nowrap: an expiry date/time breaking
                          across two lines is the ugly regression this task
                          warns about, with no upside — unlike Note beside
                          it, which is free text and is meant to wrap. */}
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {dateTimeFormatter.format(new Date(grant.expires_at))}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-muted-foreground">
                        {grant.note ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">Request history</h3>
            {requests.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No allowance requests yet — the sidebar&rsquo;s &ldquo;Request more&rdquo; link is
                where one starts.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead numeric>Requested</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Filed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.map((request) => (
                    <TableRow key={request.id}>
                      <TableCell numeric>{formatAllowance(request.requested_usd)}</TableCell>
                      <TableCell>
                        <AllowanceStatusBadge status={request.status} />
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-muted-foreground">
                        {request.reason ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {dateTimeFormatter.format(new Date(request.created_at))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Same ActionForm + SubmitButton pattern as the sidebar footer's own
          sign-out control (app/(app)/layout.tsx) — this page's copy exists
          so sign-out is reachable from here too, not as a replacement for
          the sidebar's. */}
      <ActionForm action={signOut} fallbackErrorMessage="Failed to sign out.">
        <SubmitButton variant="outline" size="sm" pendingLabel="Signing out…">
          Sign out
        </SubmitButton>
      </ActionForm>
    </div>
  );
}
