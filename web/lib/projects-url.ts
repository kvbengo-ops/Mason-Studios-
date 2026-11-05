// Shared `/projects` URL-building — split out of app/(app)/projects/page.tsx
// so the same sort allowlist/href builder can be imported by both that
// Server Component and components/projects-table.tsx (a Client Component:
// the checkbox/select-all state added for bulk actions needs real client
// state, so the table can no longer be plain inline JSX in the page). A
// plain function can be imported into a Client Component module directly —
// unlike a prop crossing the Server/Client boundary (see action-form.tsx's
// header for why a function CAN'T be passed as a prop) — as long as the
// module it lives in has no server-only imports of its own. Keeping this
// pure and side-effect-free (string building only, no Supabase/Next APIs)
// is what makes that safe; it must stay that way.
import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import type { PageSize } from "@/lib/pagination";
import type { ParsedSort } from "@/lib/sort-params";
import type { ProjectStatus } from "@/types/db";

// The six sortable columns, and the actual column each one orders by on
// project_directory (0029_project_directory.sql, extended by 0103).
// title/product/created/updated are
// plain projects columns; owner/scenes/cost are the aggregates that view
// exists to make sortable in the same query as the page/LIMIT. `status` is
// deliberately NOT in this list — see the migration's header for why: it is
// DERIVED (lib/project-status.ts's deriveProjectStatus), not a column, and
// re-deriving that function's scene-set logic a second time in SQL just to
// make it ORDER BY-able would create a second copy with no automated check
// that it agrees with the TypeScript (0018_derived_project_status.sql's own
// column comment already drifted from the code once, silently).
export const SORT_COLUMNS = [
  "title",
  "product",
  "owner",
  "scenes",
  "created",
  "updated",
  "cost",
] as const;
export type SortColumn = (typeof SORT_COLUMNS)[number];

export const SORT_COLUMN_TO_DB: Record<SortColumn, string> = {
  title: "title",
  product: "product_name",
  owner: "owner_email",
  scenes: "scene_count",
  created: "created_at",
  updated: "updated_at",
  cost: "total_cost_usd",
};

// Default: most recently edited first, matching the activity-oriented
// directory and its visible Updated column.
export const DEFAULT_SORT: ParsedSort<SortColumn> = { column: "updated", direction: "desc" };

// Every value `?status=` is allowed to select — the six real statuses
// (lib/project-status.ts's deriveProjectStatus never returns anything
// else). No "all" entry here on purpose: "all" is the ABSENCE of this
// param, same convention DEFAULT_SORT/DEFAULT_PAGE_SIZE already use for
// "this is the default, so omit it from the URL" rather than spelling the
// default out as its own magic string.
export const STATUS_FILTER_VALUES: readonly ProjectStatus[] = [
  "draft",
  "briefed",
  "framed",
  "rendering",
  "complete",
  "delivered",
];

// Admin-only ("Mine" / "Everyone") — see app/(app)/projects/page.tsx's
// showOwnerColumn gate. Not meaningful for a non-admin viewer at all:
// 0002_rls.sql's projects_select already restricts a non-admin to their own
// rows before this filter would ever run, so applying it there would be
// redundant, and the UI never renders the control for one in the first
// place (see components/project-filters.tsx).
export type OwnerFilter = "mine" | "everyone";

// "Mine" — an admin landing on /projects without an explicit `?owner=`
// sees their own work first, matching what a non-admin already sees
// unconditionally; "Everyone" is one click away, not the default an admin
// has to opt out of every visit.
export const DEFAULT_OWNER_FILTER: OwnerFilter = "mine";

/** Same "unrecognized input degrades to the default" contract parsePage/
 * parseSort/parsePageSize already use (lib/pagination.ts, lib/sort-
 * params.ts) — a hand-edited or stale `?status=` falls back to "no filter"
 * rather than reaching a comparison with a value that was never checked
 * against the allowlist. */
export function parseStatusFilter(raw: string | string[] | undefined): ProjectStatus | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (STATUS_FILTER_VALUES as readonly string[]).includes(value ?? "")
    ? (value as ProjectStatus)
    : null;
}

/** Same contract as parseStatusFilter — anything other than the literal
 * "everyone" degrades to DEFAULT_OWNER_FILTER, including a bare/missing
 * param and a typo'd one. */
export function parseOwnerFilter(raw: string | string[] | undefined): OwnerFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "everyone" ? "everyone" : DEFAULT_OWNER_FILTER;
}

export function buildProjectsHref(
  q: string,
  page: number,
  sort: ParsedSort<SortColumn>,
  size: PageSize,
  statusFilter: ProjectStatus | null,
  ownerFilter: OwnerFilter,
): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  if (sort.column !== DEFAULT_SORT.column || sort.direction !== DEFAULT_SORT.direction) {
    params.set("sort", sort.column);
    params.set("dir", sort.direction);
  }
  if (size !== DEFAULT_PAGE_SIZE) params.set("size", String(size));
  if (statusFilter) params.set("status", statusFilter);
  if (ownerFilter !== DEFAULT_OWNER_FILTER) params.set("owner", ownerFilter);
  const qs = params.toString();
  return qs ? `/projects?${qs}` : "/projects";
}
