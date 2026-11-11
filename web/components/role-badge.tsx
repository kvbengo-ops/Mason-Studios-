import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import type { ProfileRole } from "@/types/db";
import { ROLE_LABELS } from "@/lib/model-access";

// The chart tokens vary by theme, so each role keeps its own color in every palette.
const ROLE_STYLE: Record<ProfileRole, { dot: string; badge: string }> = {
  admin: { dot: "bg-primary-foreground", badge: "" },
  editor: { dot: "bg-chart-1", badge: "border-chart-1/40 bg-chart-1/10 text-chart-1" },
  trusted_editor: {
    dot: "bg-chart-2",
    badge: "border-chart-2/40 bg-chart-2/10 text-chart-2",
  },
  hybrid_editor: {
    dot: "bg-chart-3",
    badge: "border-chart-3/40 bg-chart-3/10 text-chart-3",
  },
  ai_animator: { dot: "bg-chart-4", badge: "border-chart-4/40 bg-chart-4/10 text-chart-4" },
};

export function RoleBadge({ role }: { role: ProfileRole }): JSX.Element {
  const style = ROLE_STYLE[role];
  return (
    <Badge variant={role === "admin" ? "default" : "outline"} className={style.badge}>
      <span aria-hidden="true" className={`size-1.5 rounded-full ${style.dot}`} />
      {ROLE_LABELS[role]}
    </Badge>
  );
}
