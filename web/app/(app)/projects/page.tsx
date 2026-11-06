import Link from "next/link";
import { redirect } from "next/navigation";
import type { JSX } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser, isAdmin } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import {
  DEFAULT_PAGE_SIZE,
  pageRange,
  parsePage,
  parsePageSize,
  totalPageCount,
} from "@/lib/pagination";
import { buildIlikeOrFilter, sanitizeSearchTerm } from "@/lib/search-term";
import { parseSort } from "@/lib/sort-params";
import { LiveSearch } from "@/components/live-search";
import { PageSizeControl } from "@/components/page-size-control";
import { PaginationControls } from "@/components/pagination-controls";
import { ProjectsTable } from "@/components/projects-table";
import type { ProjectTableRow } from "@/components/projects-table";
import { ProjectFilters } from "@/components/project-filters";
import { formatUsd } from "@/lib/format-usd";
import { NewClipButton } from "@/components/new-clip-button";
import { deriveProjectStatus } from "@/lib/project-status";
import { RenderTimer } from "@/lib/perf-log";
import type { Database, ProjectKind, ProjectStatus, SceneStatus } from "@/types/db";
import {
  buildProjectsHref,
  DEFAULT_OWNER_FILTER,
  DEFAULT_SORT,
  parseOwnerFilter,
  parseStatusFilter,
  SORT_COLUMNS,
  SORT_COLUMN_TO_DB,
} from "@/lib/projects-url";
import type { OwnerFilter } from "@/lib/projects-url";
import { dateTimeFormatter } from "@/lib/datetime";
import {
  selectProjectThumbnailSources,
  signProjectThumbnails,
  type ProjectThumbnailAsset,
  type ProjectThumbnailPoster,
  type ProjectThumbnailScene,
} from "@/lib/project-thumbnails";

// Fixed locale/format rather than the bare `toLocaleDateString()` this page
// used to call: that resolves against whatever locale the running server
// happens to have, so the same row could render a different string across
// two requests handled by two different instances, and it dropped the time
// entirely — "raw" in the sense of "whatever Date's default toString-ish
// output happens to be," not in the sense of an unformatted ISO string.

// Shape of the project_directory query below (0029_project_directory.sql).
// RLS (0002_rls.sql's projects_select, transitively re-checked through
// profiles/scenes/runs — see that migration's header) already lets an
// admin read every row and an editor only their own through the session
// client, so this one query is correct for both roles — only rendering the
// owner column differs.
interface ProjectDirectoryRow {
  id: string;
  title: string;
  product_name: string | null;
  status: ProjectStatus;
  created_at: string;
  user_id: string;
  owner_email: string | null;
  scene_count: number;
  total_cost_usd: number;
  kind: ProjectKind;
  updated_at: string;
}

// Bounded per-page scenes fetch, kept separate from project_directory on
// purpose: that view carries scene_count (an aggregate) for sorting, but
// deriveProjectStatus needs the actual per-scene status/ref_frame_asset_id
// list, which isn't something a view's ORDER BY/LIMIT query can also embed
// without becoming N+1 or re-deriving status in SQL (see the migration's
// header for why that second path was rejected). Scoped to only the project
// ids already on this one page, the same "small, bounded, not per-row"
// shape getProjectCostTotals used before this view replaced it.
interface SceneStatusRow {
  id: string;
  project_id: string;
  idx: number;
  status: SceneStatus;
  ref_frame_asset_id: string | null;
}

// The six sortable columns, the sort-column-to-db-column map, DEFAULT_SORT,
// and buildProjectsHref itself now live in lib/projects-url.ts — split out
// so components/projects-table.tsx (a Client Component; see that file's
// header for why the table had to become one) can build the same hrefs its
// SortableTableHead columns need without a function prop trying to cross
// the Server/Client boundary. See that file's header for the full
// reasoning, including why `status` is deliberately not a sortable column.

// Columns every query below selects — pulled out once so the "fast path"
// (DB-paginated) and the "honest path" (status-filtered, paginated in
// TypeScript — see below) select exactly the same shape.
const PROJECT_DIRECTORY_COLUMNS =
  "id, title, product_name, status, created_at, user_id, owner_email, scene_count, total_cost_usd, kind, updated_at" as const;

/**
 * Scenes for a bounded set of project ids, keyed by project id — the same
 * "small, bounded, not per-row" scenes fetch this page always did, pulled
 * into a function because it's now called from two different places (the
 * fast path's per-page ids, and the status-filtered path's full-matched-set
 * ids). `ids.length === 0` short-circuits rather than issuing `.in(...,
 * [])`, which Postgrest would otherwise happily run as a real round trip
 * for zero rows.
 */
async function fetchScenesByProject(
  supabase: SupabaseClient<Database>,
  timer: RenderTimer,
  ids: readonly string[],
): Promise<Map<string, SceneStatusRow[]>> {
  const scenesByProject = new Map<string, SceneStatusRow[]>();
  if (ids.length === 0) {
    return scenesByProject;
  }

  // Chunked ids, and paged within each chunk. Both bounds are real, and
  // the second one bites much earlier than it looks.
  //
  // A single `.in("project_id", ids)` over the whole set puts every id in
  // the query string — a thousand UUIDs is roughly 40KB of URL, past what
  // proxies will carry. That one at least fails loudly.
  //
  // The dangerous one is silent: PostgREST caps a response at max_rows
  // (1000, supabase/config.toml), and this reads SCENES, not projects. Six
  // scenes per project means the cap lands at ~170 projects, not 1000 —
  // and a project whose scenes fall past the cut arrives here with an empty
  // list, which deriveProjectStatus reads as `draft`. Not a missing row: a
  // WRONG status, on the column the new filter selects by, with no error
  // anywhere. This page already had that bug latent; it only became
  // reachable when the status filter started passing the whole matched set
  // in rather than one page of at most 50.
  const ID_CHUNK = 200;
  const FETCH_PAGE = 1000;
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const chunk = ids.slice(start, start + ID_CHUNK);
    for (let offset = 0; ; offset += FETCH_PAGE) {
      const { data: sceneRows, error: scenesError } = await timer.step(
        "scenes_query",
        Promise.resolve(
          supabase
            .from("scenes")
            .select("id, project_id, idx, status, ref_frame_asset_id")
            .in("project_id", [...chunk])
            .range(offset, offset + FETCH_PAGE - 1),
        ),
      );

      if (scenesError) {
        throw new Error(`Failed to load scenes for projects: ${scenesError.message}`);
      }

      const rows = (sceneRows ?? []) as SceneStatusRow[];
      for (const scene of rows) {
        const list = scenesByProject.get(scene.project_id);
        if (list) {
          list.push(scene);
        } else {
          scenesByProject.set(scene.project_id, [scene]);
        }
      }
      if (rows.length < FETCH_PAGE) break;
    }
  }

  return scenesByProject;
}

/**
 * Poster assets can outnumber the projects on a page by many render retries,
 * so this is paged as well as chunked. The directory may only show a bounded
 * page of projects, but PostgREST's max_rows limit applies to ASSETS, not
 * projects; treating a full 1000-row response as complete would silently
 * leave later projects without their available poster.
 */
async function fetchPosterAssetsByScene(
  supabase: SupabaseClient<Database>,
  timer: RenderTimer,
  sceneIds: readonly string[],
): Promise<ProjectThumbnailPoster[]> {
  if (sceneIds.length === 0) return [];

  const posters: ProjectThumbnailPoster[] = [];
  const ID_CHUNK = 200;
  const FETCH_PAGE = 1000;
  for (let start = 0; start < sceneIds.length; start += ID_CHUNK) {
    const chunk = sceneIds.slice(start, start + ID_CHUNK);
    for (let offset = 0; ; offset += FETCH_PAGE) {
      const { data, error } = await timer.step(
        "project_thumbnail_posters_query",
        Promise.resolve(
          supabase
            .from("assets")
            .select("scene_id, storage_key, created_at")
            .eq("kind", "poster")
            .in("scene_id", [...chunk])
            .order("created_at", { ascending: false })
            .order("id", { ascending: true })
            .range(offset, offset + FETCH_PAGE - 1),
        ),
      );
      if (error) throw new Error(`Failed to load project thumbnail posters: ${error.message}`);

      const rows = data ?? [];
      for (const row of rows) {
        if (row.scene_id) {
          posters.push({
            sceneId: row.scene_id,
            storageKey: row.storage_key,
            createdAt: row.created_at,
          });
        }
      }
      if (rows.length < FETCH_PAGE) break;
    }
  }
  return posters;
}

/** One asset row per reference-frame id, so a 200-id chunk cannot hit
 * PostgREST's 1000-row response ceiling. */
async function fetchRefFrameAssets(
  supabase: SupabaseClient<Database>,
  timer: RenderTimer,
  assetIds: readonly string[],
): Promise<ProjectThumbnailAsset[]> {
  const ids = [...new Set(assetIds)];
  if (ids.length === 0) return [];

  const assets: ProjectThumbnailAsset[] = [];
  const ID_CHUNK = 200;
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const chunk = ids.slice(start, start + ID_CHUNK);
    const { data, error } = await timer.step(
      "project_thumbnail_ref_frames_query",
      Promise.resolve(supabase.from("assets").select("id, storage_key").in("id", chunk)),
    );
    if (error)
      throw new Error(`Failed to load project thumbnail reference frames: ${error.message}`);
    for (const row of data ?? []) {
      assets.push({ id: row.id, storageKey: row.storage_key });
    }
  }
  return assets;
}

async function loadProjectThumbnailUrls(
  supabase: SupabaseClient<Database>,
  timer: RenderTimer,
  scenesByProject: ReadonlyMap<string, readonly SceneStatusRow[]>,
): Promise<Map<string, string | null>> {
  const scenes: ProjectThumbnailScene[] = [];
  for (const rows of scenesByProject.values()) {
    for (const scene of rows) {
      scenes.push({
        id: scene.id,
        projectId: scene.project_id,
        idx: scene.idx,
        refFrameAssetId: scene.ref_frame_asset_id,
      });
    }
  }

  const [posters, refFrameAssets] = await Promise.all([
    fetchPosterAssetsByScene(
      supabase,
      timer,
      scenes.map((scene) => scene.id),
    ),
    fetchRefFrameAssets(
      supabase,
      timer,
      scenes.flatMap((scene) => (scene.refFrameAssetId ? [scene.refFrameAssetId] : [])),
    ),
  ]);

  return timer.step(
    "project_thumbnail_signing",
    signProjectThumbnails(selectProjectThumbnailSources(scenes, posters, refFrameAssets)),
  );
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    page?: string | string[];
    sort?: string | string[];
    dir?: string | string[];
    size?: string | string[];
    status?: string | string[];
    owner?: string | string[];
  }>;
}): Promise<JSX.Element> {
  // See lib/perf-log.ts for the flag this is gated behind and the safety
  // contract .step()/.finish() follow. Not logged on either stale-page
  // redirect path below (redirect() throws before finish() is reached) —
  // that's a rare, cheap bookmark-recovery path, not the render this
  // instrumentation exists to measure.
  const timer = new RenderTimer("/projects");

  const { user, profile } = await timer.step("require_user", requireUser());
  const supabase = await createClient();
  const showOwnerColumn = isAdmin(profile);

  const resolvedSearchParams = await searchParams;
  const q = sanitizeSearchTerm(resolvedSearchParams.q ?? "");
  const requestedPage = parsePage(resolvedSearchParams.page);
  const pageSize = parsePageSize(resolvedSearchParams.size);
  const sort = parseSort(
    SORT_COLUMNS,
    DEFAULT_SORT,
    resolvedSearchParams.sort,
    resolvedSearchParams.dir,
  );
  const statusFilter = parseStatusFilter(resolvedSearchParams.status);
  // Only an admin's choice is honored — a non-admin's own `?owner=` (typed
  // by hand, or a stale link from before this control existed) is ignored
  // rather than applied: 0002_rls.sql's projects_select already restricts
  // them to their own rows, so the value has nothing to change, and letting
  // it flip DEFAULT_OWNER_FILTER for a non-admin would make buildProjectsHref
  // start emitting `?owner=` links this viewer's page never shows a control
  // for.
  const ownerFilter: OwnerFilter = showOwnerColumn
    ? parseOwnerFilter(resolvedSearchParams.owner)
    : DEFAULT_OWNER_FILTER;

  // ilike over title/product_name — not a vector/embedding search. See
  // lib/search-term.ts's header: substring match on a short, mostly-literal
  // string (a title, a product name) gets nearly all the value a real
  // editor wants here, for a fraction of the cost of standing up pgvector
  // and an embeddings pipeline.
  //
  // Reads from project_directory (0029_project_directory.sql), not
  // `projects` directly: that view already carries owner_email, scene_count
  // and total_cost_usd alongside every projects column this page renders,
  // computed with LEFT JOINs + GROUP BY in Postgres, in the SAME query as
  // the ORDER BY + LIMIT/OFFSET below — the only way "sort by an aggregate"
  // can be correct for the whole table rather than just the 20 rows a
  // created_at-ordered page happened to land on. See that migration's
  // header for the bug this avoids.
  const orFilter = buildIlikeOrFilter(["title", "product_name"], q);

  // Search + owner scoping only — status is deliberately NOT filterable
  // here (see the big comment on the statusFilter branch below for why).
  // Rebuilt fresh on every call rather than reused, because a Postgrest
  // query builder is meant to be `.select()`ed and awaited once; the fast
  // path below calls this once, the status-filtered path calls it twice
  // (once for a head:true count, once for the actual rows).
  // No explicit return type: it's whatever PostgrestFilterBuilder<...>
  // Supabase infers for this exact `.select(selectClause, options)` call,
  // which varies with the (generic, literal) `selectClause` type — writing
  // it out by hand would just be re-deriving what `typeof` already knows,
  // for a builder that's immediately chained further at each call site
  // anyway (`.order(...).range(...)`, or a bare `.select("id", {head:
  // true})`).
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  function scopedQuery<S extends string>(
    selectClause: S,
    options?: { count?: "exact"; head?: boolean },
  ) {
    // is_personal: the hidden project /create queues clips into (0117) is not
    // a project the operator manages, so it never lists.
    const base = supabase
      .from("project_directory")
      .select(selectClause, options)
      .eq("is_personal", false);
    const searched = orFilter ? base.or(orFilter) : base;
    // Applied at the DB level (a real column, `user_id`) — unlike status,
    // there is no derivation problem here: ownership is a stored fact, not
    // something deriveProjectStatus computes from scenes.
    return showOwnerColumn && ownerFilter === "mine" ? searched.eq("user_id", user.id) : searched;
  }

  let projects: ProjectDirectoryRow[];
  let totalCount: number;

  if (statusFilter) {
    // ---------------------------------------------------------------------
    // Honest path: a status filter is active.
    // ---------------------------------------------------------------------
    // Status is DERIVED in TypeScript from a project's scenes
    // (deriveProjectStatus, lib/project-status.ts) — it is not a queryable
    // column, and 0029_project_directory.sql's own header explains at
    // length why re-deriving that function's scene-set logic a second time
    // in SQL was rejected (a documented history of exactly that kind of
    // copy drifting silently — 0018's column comment vs deriveProjectStatus
    // is the example that migration's authors cite). So this can't push
    // `status = ?` into the query the way `owner` does above.
    //
    // What it CAN'T do either: derive status from a page's raw 20 DB rows
    // AFTER a normal `.range()` fetch. That page might contain anywhere
    // from 0 to 20 rows matching the requested status — the pager (total
    // count, "page X of Y", whether Next is enabled) would be reporting
    // numbers for the UNFILTERED set while the table shows a filtered one.
    // That's a pager that lies, which this task's own spec calls out as
    // worse than the alternative below.
    //
    // So: fetch every row that matches search+owner (bounded by those, not
    // by page size), derive status for the whole set, filter, and only THEN
    // compute count/pages/the current slice — in memory. Cost: a status-
    // filtered view costs a full (unpaginated) fetch of the matching
    // project set plus its scenes on every request, instead of one bounded
    // page — worse under load, and it stops scaling once the matching set
    // itself gets large (thousands of rows). Given this is an internal ops
    // tool, not a public listing, that trade favors a pager that's always
    // honest over one that's cheap but wrong exactly when someone narrows
    // the list — the situation where an accurate count/page-count matters
    // most. If this ever needs to scale past that, the fix is a
    // materialized/denormalized status column kept in sync by the write
    // paths (actions/compile.ts, actions/brief.ts, actions/enqueue.ts,
    // actions/deliver.ts) or a trigger — NOT a second SQL derivation.
    const { count: matchCount, error: countError } = await timer.step(
      "project_directory_count_query",
      Promise.resolve(scopedQuery("id", { count: "exact", head: true })),
    );
    if (countError) {
      throw new Error(`Failed to count projects: ${countError.message}`);
    }
    const totalMatches = matchCount ?? 0;

    // Paged, NOT one `.range(0, totalMatches - 1)`. PostgREST caps a
    // response at max_rows (1000, supabase/config.toml) and an explicit
    // range does not lift that cap — it silently returns the first 1000
    // rows with no error. This branch exists precisely to avoid a lying
    // pager, and an unpaged read would have reintroduced the same lie one
    // order of magnitude further out: totalMatches would report the true
    // count while the status filter ran over a truncated set, so both the
    // page count and the rows themselves would be wrong. Same shape as
    // actions/reconcile.ts's loadLedgerLines and lib/spend.ts's
    // getInFlightSpend, for the same reason.
    const FETCH_PAGE = 1000;
    const allMatched: ProjectDirectoryRow[] = [];
    for (let offset = 0; offset < totalMatches; offset += FETCH_PAGE) {
      const { data: pageData, error: pageError } = await timer.step(
        "project_directory_all_matches_query",
        Promise.resolve(
          scopedQuery(PROJECT_DIRECTORY_COLUMNS)
            .order(SORT_COLUMN_TO_DB[sort.column], { ascending: sort.direction === "asc" })
            .order("id", { ascending: true })
            .range(offset, offset + FETCH_PAGE - 1),
        ),
      );
      if (pageError) {
        throw new Error(`Failed to load projects: ${pageError.message}`);
      }
      const rows = (pageData ?? []) as ProjectDirectoryRow[];
      allMatched.push(...rows);
      // A short page means the end, even if totalMatches disagrees — rows
      // can be deleted between the count and these reads.
      if (rows.length < FETCH_PAGE) break;
    }

    const allScenesByProject = await fetchScenesByProject(
      supabase,
      timer,
      allMatched.map((project) => project.id),
    );

    const filtered = allMatched.filter(
      (project) =>
        deriveProjectStatus(project.status, allScenesByProject.get(project.id) ?? []) ===
        statusFilter,
    );

    totalCount = filtered.length;
    const computedTotalPages = totalPageCount(totalCount, pageSize);
    if (requestedPage > computedTotalPages && totalCount > 0) {
      redirect(buildProjectsHref(q, computedTotalPages, sort, pageSize, statusFilter, ownerFilter));
    }
    const { from: sliceFrom, to: sliceTo } = pageRange(requestedPage, pageSize);
    projects = filtered.slice(sliceFrom, sliceTo + 1);
  } else {
    // ---------------------------------------------------------------------
    // Fast path: no status filter — the original DB-paginated query.
    // ---------------------------------------------------------------------
    const { from, to } = pageRange(requestedPage, pageSize);

    // Secondary `.order("id")` tiebreaker: without it, rows tied on the
    // primary sort column (two drafts created in the same second, two
    // projects with the same owner) have no guaranteed stable order across
    // two separate `.range()` calls — a row could legally appear on both
    // page 2 and page 3, or on neither, depending on how Postgres happens
    // to order the tied group each time. `id` is unique, so every page
    // boundary is deterministic regardless of which column is being
    // sorted.
    // Promise.resolve(...), not the query builder passed directly:
    // Supabase's PostgrestBuilder is only PromiseLike (a bare `.then`), not
    // a real Promise — it has no `.finally`, which RenderTimer.step relies
    // on. This is the one adaptation needed to time these; it does not add
    // an await or change when the query actually runs.
    const { data, error, count } = await timer.step(
      "project_directory_query",
      Promise.resolve(
        scopedQuery(PROJECT_DIRECTORY_COLUMNS, { count: "exact" })
          .order(SORT_COLUMN_TO_DB[sort.column], { ascending: sort.direction === "asc" })
          .order("id", { ascending: true })
          .range(from, to),
      ),
    );

    if (error) {
      throw new Error(`Failed to load projects: ${error.message}`);
    }

    totalCount = count ?? 0;
    const computedTotalPages = totalPageCount(totalCount, pageSize);

    // A stale/hand-edited `?page=` past the real last page (a bookmark into
    // a list that's since shrunk, or a `?size=` change that made the
    // current page number no longer exist — going from 50/page to 10/page
    // while on page 3 leaves nothing at offset 20-29 once there are only,
    // say, 25 rows) would otherwise render a page 1 doesn't recognize as
    // itself — an empty table with pagination controls claiming there IS a
    // page 4 of 4 while showing nothing on it. Land back on the real last
    // page instead. Only possible when there's at least one result; an
    // all-zero list already renders totalPages = 1 (lib/pagination.ts), so
    // this can't loop.
    //
    // The size selector itself never triggers this redirect: it always
    // links to page 1 (see PageSizeControl's buildHref below), and page 1
    // is never greater than totalPages. This guard only fires for a
    // genuinely stale URL — a bookmark, or hand-edited `?page=`/`?size=` —
    // same as before size was pageable at all.
    if (requestedPage > computedTotalPages && totalCount > 0) {
      redirect(buildProjectsHref(q, computedTotalPages, sort, pageSize, statusFilter, ownerFilter));
    }

    projects = (data ?? []) as ProjectDirectoryRow[];
  }

  const totalPages = totalPageCount(totalCount, pageSize);

  // Second, bounded round trip — scenes for only the project ids actually
  // being rendered, so deriveProjectStatus can compute the real (non-
  // fossil) status per row. On the honest/status-filtered path above, this
  // re-fetches scenes for just the current page's ids (a subset of the
  // ids already fetched for filtering) — a little redundant, but keeps
  // this line identical on both paths rather than threading a second map
  // through. RLS scopes this exactly like the old embed did.
  const scenesByProject = await fetchScenesByProject(
    supabase,
    timer,
    projects.map((project) => project.id),
  );
  const thumbnailUrls = await loadProjectThumbnailUrls(supabase, timer, scenesByProject);

  timer.finish({ userId: user.id });

  // Plain, pre-formatted props for the client-side ProjectsTable
  // (components/projects-table.tsx) — see that file's header for why
  // date/currency formatting happens here (server-side, once) rather than
  // in the client component itself. `canDelete` is computed exactly like
  // the old inline Delete button's own conditional was: write policies are
  // owner-only on every table (0002_rls.sql), so an admin viewing someone
  // else's project must not be offered a checkbox/menu action that implies
  // they can delete it — deleteProject's requireProject check would 404 on
  // anyone else's row.
  const tableRows: ProjectTableRow[] = projects.map((project) => {
    const scenes = scenesByProject.get(project.id) ?? [];
    return {
      id: project.id,
      title: project.title,
      ownerEmail: project.owner_email,
      sceneCount: project.scene_count,
      readySceneCount: scenes.filter((scene) => scene.status === "done").length,
      thumbnailUrl: thumbnailUrls.get(project.id) ?? null,
      updatedAtLabel: dateTimeFormatter.format(new Date(project.updated_at)),
      costLabel: formatUsd(project.total_cost_usd),
      costSecondaryLabel:
        showOwnerColumn && project.total_cost_usd > 0 ? formatUsd(project.total_cost_usd) : null,
      canDelete: project.user_id === user.id,
      kind: project.kind,
    };
  });

  const filtersActive = statusFilter !== null || ownerFilter !== DEFAULT_OWNER_FILTER;

  // "No projects yet" (a genuinely empty workspace) reads differently from
  // "no projects matched this search/filter" — collapsing them into one
  // message would make a working search or filter feel like a broken app
  // on the first use. This is the true empty state: no search term, no
  // status/owner filter narrowing the list, and the table has nothing in
  // it at all.
  if (totalCount === 0 && !q && !filtersActive) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-16 text-center">
        <h1 className="text-2xl font-medium text-foreground">No projects yet</h1>
        <p className="text-sm text-muted-foreground">
          Write a prompt, attach an image, get a clip.
        </p>
        <NewClipButton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-medium text-foreground">Studio</h1>
          {/* The count stays in the page summary; row density now belongs in
              the table footer beside pagination. */}
          <p className="text-sm text-muted-foreground">
            {totalCount} {totalCount === 1 ? "project" : "projects"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* ONE button, and it opens /ugc.
              Two sat here — "New project" to the six-screen wizard and a gold
              "New clip" to /ugc. Removing the gold one left the wizard as the
              only entry, which is backwards: /ugc is the route this product
              is built around now, and the wizard is the thing kept alive
              rather than the default.
              So the survivor is the clip route wearing the plain name. A form
              rather than a <Link>, because it WRITES: /ugc needs a project id
              in its path and this is what creates the project it opens.
              The wizard remains reachable at /projects/new. */}
          <NewClipButton />
        </div>
      </div>

      {/* Live search, debounced 500ms — see components/live-search.tsx for
          the full reasoning (no API route, focus/cursor survival, the
          no-JS fallback). `buildHref` resets to page 1 on every query
          change and carries `sort`/`dir`/`size`/`status`/`owner` forward
          exactly like the header/pager/size-control/filter hrefs already
          do — a search result set has its own page count, not the
          unfiltered list's. */}
      <LiveSearch
        q={q}
        placeholder="Search projects…"
        ariaLabel="Search projects"
        action="/projects"
        hiddenFields={{
          ...(sort.column !== DEFAULT_SORT.column || sort.direction !== DEFAULT_SORT.direction
            ? { sort: sort.column, dir: sort.direction }
            : {}),
          ...(pageSize !== DEFAULT_PAGE_SIZE ? { size: String(pageSize) } : {}),
          ...(statusFilter ? { status: statusFilter } : {}),
          ...(ownerFilter !== DEFAULT_OWNER_FILTER ? { owner: ownerFilter } : {}),
        }}
        clearHref={q ? buildProjectsHref("", 1, sort, pageSize, statusFilter, ownerFilter) : null}
        leadingControls={
          showOwnerColumn ? (
            <ProjectFilters
              statusFilter={statusFilter}
              ownerFilter={ownerFilter}
              showOwnerFilter={showOwnerColumn}
              buildHref={(nextStatus, nextOwner) =>
                buildProjectsHref(q, 1, sort, pageSize, nextStatus, nextOwner)
              }
            />
          ) : undefined
        }
      >
        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-16 text-center">
            <p className="text-base font-medium text-foreground">
              {q ? <>No projects match &ldquo;{q}&rdquo;.</> : <>No projects match this filter.</>}
            </p>
            <p className="text-sm text-muted-foreground">
              Try a different {q ? "title or product name" : "status or owner"}
              {q && filtersActive ? ", or filter" : ""}, or{" "}
              {/* Resets everything (search text + both filters) rather than
                  guessing which one the operator meant to relax — with both
                  a search term and a filter narrowing the list to zero, a
                  link that only cleared one would still show an empty
                  table. */}
              <Link
                href={buildProjectsHref("", 1, sort, pageSize, null, DEFAULT_OWNER_FILTER)}
                className="underline"
              >
                clear{" "}
                {q && filtersActive ? "the search and filters" : q ? "the search" : "the filters"}
              </Link>
              .
            </p>
          </div>
        ) : (
          <>
            {/* Selection/bulk-delete/per-row "…" menu all live in this
                Client Component now — see components/projects-table.tsx's
                header for why the table had to stop being plain inline JSX
                here. This page still does 100% of the data fetching/
                formatting above; `tableRows` is the only thing crossing the
                Server -> Client boundary, as plain serializable data. */}
            <ProjectsTable
              projects={tableRows}
              showOwnerColumn={showOwnerColumn}
              sort={sort}
              q={q}
              pageSize={pageSize}
              statusFilter={statusFilter}
              ownerFilter={ownerFilter}
            />
            <div className="flex flex-col gap-4 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between [&>nav]:min-w-0 [&>nav]:flex-1 [&>nav]:border-t-0 [&>nav]:pt-0">
              <PageSizeControl
                size={pageSize}
                buildHref={(size) => buildProjectsHref(q, 1, sort, size, statusFilter, ownerFilter)}
              />
              <PaginationControls
                page={requestedPage}
                totalPages={totalPages}
                previousHref={
                  requestedPage > 1
                    ? buildProjectsHref(
                        q,
                        requestedPage - 1,
                        sort,
                        pageSize,
                        statusFilter,
                        ownerFilter,
                      )
                    : null
                }
                nextHref={
                  requestedPage < totalPages
                    ? buildProjectsHref(
                        q,
                        requestedPage + 1,
                        sort,
                        pageSize,
                        statusFilter,
                        ownerFilter,
                      )
                    : null
                }
              />
            </div>
          </>
        )}
      </LiveSearch>
    </div>
  );
}
