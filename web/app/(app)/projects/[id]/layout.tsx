import type { JSX, ReactNode } from "react";
import { requireProjectReadable } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { ProjectRail, RailBusyProvider } from "@/components/project-rail";
import { buildRailModel } from "@/lib/project-rail";
import { getProjectSpend } from "@/lib/db-aggregates";

// Wraps every /projects/[id]/* route (character, brief, frames, render,
// deliver — and the bare [id]/page.tsx redirector) with the vertical
// project rail (components/project-rail.tsx), which replaced the old
// horizontal five-step StepRail: a scene gets revisited 3-8 times before an
// editor accepts it, so the rail's unit is the scene, not the pipeline
// step — see lib/project-rail-types.ts's header for the full reasoning.
// `reached`, not `project.status`, still drives which routes the rail links
// to — see lib/project-status.ts's deriveReachedSteps doc comment for why
// "current derived status" is the wrong signal for "can the operator
// navigate here": status can legitimately move backwards (a reopened scene,
// or a scene added after rendering already started) while the rendered
// clips it moved past stay exactly as reachable as before. lib/project-
// rail.ts's buildRailModel is the one place that turns `reached` (plus the
// project, its scenes, and the two vendor balances fetched below) into the
// RailModel the component renders — see that file for the rest.
//
// Uses requireProjectReadable, not requireProject: an admin browsing
// someone else's project via /projects (0002_rls.sql's projects_select
// deliberately grants that read) must not 404 here. See guard.ts's doc
// comment on requireProjectReadable for why this is the one, specially
// named, place that's allowed to be permissive — every write still goes
// through requireProject, unchanged, inside each page/action.
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  const { project, reached, isOwner } = await requireProjectReadable(id);

  const supabase = await createClient();

  // Same two columns /users already shows every admin (email, username) —
  // nothing more. Session client, not createAdminClient(): profiles_select_admin
  // (0002_rls.sql) already lets an admin read every profile row, same reasoning
  // app/(app)/users/page.tsx documents for its own admin-facing query, so the
  // database boundary does the enforcement here too rather than an
  // RLS-bypassing client this read doesn't need.
  let ownerLabel: string | null = null;
  if (!isOwner) {
    const { data: ownerProfile } = await supabase
      .from("profiles")
      .select("email, username")
      .eq("id", project.user_id)
      .maybeSingle();
    ownerLabel = ownerProfile?.email ?? ownerProfile?.username ?? "another user";
  }

  // What lib/project-rail.ts's buildRailModel needs beyond `project` and
  // `reached` (both already fetched above by requireProjectReadable): the
  // scenes themselves, the spend, and whether a final has been assembled
  // yet. Fetched in parallel — three independent reads, none depends on
  // another's result.
  const [{ data: scenesRaw, error: scenesError }, spend, { data: finalAsset, error: finalError }] =
    await Promise.all([
      supabase
        .from("scenes")
        // submitted_at is the origin for the rail's elapsed clock on a running
        // row (lib/project-rail.ts's buildSceneEntry) — the worker's own claim
        // time, so it survives reloads instead of restarting whenever this
        // layout re-renders.
        .select("id, idx, is_talking_head, status, duration_s, submitted_at")
        .eq("project_id", id)
        .order("idx", { ascending: true }),
      // Actual spend for the subtitle. Fetched alongside the others rather
      // than on the pages that show money, because the rail is the one thing
      // visible from every route.
      getProjectSpend(supabase, id),
      // Not actions/deliver.ts's hasFinalAsset, which goes through
      // requireProject and would throw for the admin read-only case this
      // layout deliberately allows (requireProjectReadable, above). The
      // session client is enough on its own: 0002_rls.sql's assets_select
      // already grants an admin the same read it grants the owner, so the
      // database boundary does the enforcement here exactly as it does for the
      // profiles read above.
      // Resolved through the ACTIVE final version (0060_final_versions.sql),
      // not `kind = 'final'`: finals are kept now, so "this project has a
      // final asset somewhere" stopped meaning "the cut on the Deliver page is
      // built". The rail's Cut step would have read as finished the moment any
      // old version existed, while the one the operator just asked for was
      // still assembling.
      // Skipped entirely when the project has never been assembled: `.eq("id",
      // "")` against a uuid column is a Postgres type error, not an empty
      // result, so the null has to be handled before the query rather than
      // inside it.
      !project.active_final_version_id
        ? Promise.resolve({ data: null, error: null })
        : supabase
            .from("final_versions")
            .select("final_asset_id")
            .eq("id", project.active_final_version_id)
            .limit(1)
            .maybeSingle(),
    ]);

  if (scenesError) {
    throw new Error(`Failed to load scenes for project ${id}: ${scenesError.message}`);
  }
  if (finalError) {
    throw new Error(`Failed to load the final asset for project ${id}: ${finalError.message}`);
  }

  const railModel = buildRailModel({
    project: {
      id: project.id,
      title: project.title,
      character_desc: project.character_desc,
      product_name: project.product_name,
      script_raw: project.script_raw,
      render_settings: project.render_settings,
    },
    scenes: scenesRaw ?? [],
    reached,
    spentUsd: spend.totalUsd,
    hasFinalAsset: (finalAsset?.final_asset_id ?? null) !== null,
    // The rail's Add scene row goes through actions/brief.ts's addScene,
    // which is requireProject-guarded — so an admin reading someone else's
    // project doesn't get offered a control the server would refuse.
    canAddScene: isOwner,
  });

  return (
    // data-project-shell: read by app/(app)/layout.tsx's has-[] rule to drop
    // the centred max-width for this route, so the rail sits flush.
    <div data-project-shell className="flex flex-col">
      {!isOwner ? (
        <div className="p-6 pb-0">
          {/* Calm, not alarming — an admin looking at another user's
              project is expected, everyday behaviour (RLS's projects_select
              already grants the read), not an error state. Reuses the same
              muted informational-banner styling character/page.tsx's
              "already delivered, read-only" notice uses, rather than
              MockModeBanner's destructive/red treatment, which this
              codebase reserves for "something here may be fake or
              incomplete," not "you're allowed to be here, but read-only." */}
          <p
            role="status"
            className="rounded-md border border-border bg-muted/40 p-4 text-sm text-foreground"
          >
            You&apos;re viewing {ownerLabel}&apos;s project in read-only mode. As an admin you can
            look, but you cannot make changes here.
          </p>
        </div>
      ) : null}
      {/* Two columns, not two stacked blocks. StepRail was a horizontal strip
          and this container was `flex flex-col` to sit it above the page; the
          rail is vertical now, so the same container rendered it as a
          full-width band across the top with the page pushed beneath it.
          The rail keeps its own width and scrolls independently; `min-w-0` on
          the content column is what stops a wide child (the clip grid, a long
          prompt) from forcing the whole row wider instead of scrolling itself. */}
      {/* Wraps the rail AND the page, which is the whole point: it is what
          lets a screen's in-flight server action spin its own rail row while
          it runs, and keep spinning it after the operator has walked to
          another screen. See RailBusyProvider / useRailBusyWhile
          (components/project-rail.tsx) for why those four calls cannot be
          derived from the database the way a scene render can. */}
      <RailBusyProvider>
        <div className="flex flex-1 flex-col md:flex-row md:items-stretch">
          {/* Sticky at md+, where app/(app)/layout.tsx caps <main> at the
            viewport height and makes it the scrollport — the same condition
            step-rail.tsx's own sticky rule keyed on. Below md there is no
            capped scrollport to stick inside, so it scrolls with the page.
            self-start matters: a stretched flex child cannot stick, and this
            aside is in an items-stretch row. */}
          {/* min-h-svh AND max-h-svh, which sound contradictory and are not.
            min-h-svh gives the border-r a full-height line to draw — without
            it the aside ends where its content does, and the divider stops
            halfway down the page leaving the content column looking
            unbounded. max-h-svh keeps it a scrollport once a long project
            genuinely outgrows the viewport.
            `md:flex md:flex-col` is what turns that guaranteed height into
            something the rail can distribute. The vendor balances used to be
            pinned to the bottom edge of it; they were removed on request. */}
          <aside className="max-h-64 overflow-y-auto border-b border-border md:sticky md:top-0 md:flex md:max-h-svh md:min-h-svh md:w-52 md:shrink-0 md:flex-col md:self-start md:overflow-y-auto md:border-b-0 md:border-r">
            <ProjectRail model={railModel} />
          </aside>
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </RailBusyProvider>
    </div>
  );
}
