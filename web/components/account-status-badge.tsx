import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import { requiresAccountApproval } from "@/lib/account-approval";
import type { ProfileRole, ProfileStatus } from "@/types/db";

// profiles.status (0052_account_approval.sql) on /users. Same shape as
// role-badge.tsx and allowance-status-badge.tsx beside it.
//
// `pending` takes the solid variant and `active` the quiet one, which is
// the opposite of how a "good state" is usually styled — deliberately. The
// admin scanning this list is not looking for accounts that are fine; they
// are looking for editor-tier rows waiting on a decision only they can make.
// Admin rows render "Not required" regardless of stored status. `rejected` gets
// `destructive` because that account cannot sign in — not because it is
// terminal, which it no longer is: Approve on that row puts it back to
// active (web/actions/account.ts's DECIDABLE_FROM).
const STATUS_VARIANT: Record<ProfileStatus, "default" | "outline" | "destructive"> = {
  pending: "default",
  active: "outline",
  rejected: "destructive",
  // Destructive, like rejected: both mean "cannot sign in". The label is
  // what distinguishes a former colleague from a refused application.
  deactivated: "destructive",
};

const STATUS_LABEL: Record<ProfileStatus, string> = {
  pending: "Pending",
  active: "Active",
  rejected: "Rejected",
  deactivated: "Deactivated",
};

export function AccountStatusBadge({
  role,
  status,
}: {
  role: ProfileRole;
  status: ProfileStatus;
}): JSX.Element {
  if (!requiresAccountApproval(role)) {
    return <Badge variant="outline">Not required</Badge>;
  }

  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>;
}
