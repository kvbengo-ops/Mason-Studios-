import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import type { AllowanceRequestStatus } from "@/types/db";

// Factored out of app/(app)/allowances/page.tsx's own STATUS_VARIANT/
// STATUS_LABEL maps so /profile's own request-history table (an ordinary
// editor's OWN requests, not the admin queue) can show the identical badge
// without a second copy of the same four-way switch — same reasoning
// project-status-badge.tsx already gives this shape for ProjectStatus.
const STATUS_VARIANT: Record<AllowanceRequestStatus, "default" | "outline" | "destructive"> = {
  pending: "default",
  approved: "outline",
  denied: "destructive",
  cancelled: "outline",
};

const STATUS_LABEL: Record<AllowanceRequestStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  denied: "Denied",
  cancelled: "Cancelled",
};

export function AllowanceStatusBadge({ status }: { status: AllowanceRequestStatus }): JSX.Element {
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>;
}
