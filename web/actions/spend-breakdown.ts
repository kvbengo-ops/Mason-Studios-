"use server";

// The caller's OWN spending, run by run, for the allowance box on /create.
// Same sources as user_spend_usd (0085): runs owned by coalesce(runs.user_id,
// projects.user_id), plus deleted_project_cost_history — so "this week" here
// adds up to exactly what the weekly allowance counted. Admin client because
// the cost history has an admin-only policy; every query is pinned to the
// caller's id from requireUser, never to an id the client sends.

import { z } from "zod";
import { requireUser } from "@/actions/guard";
import { KIE_MODELS } from "@/lib/kie/models";
import { createAdminClient } from "@/lib/supabase/server";

export type SpendKind = "image" | "video" | "other";

export interface SpendRow {
  id: string;
  createdAt: string;
  kind: SpendKind;
  model: string;
  /** null when the vendor never billed the attempt. */
  costUsd: number | null;
  failed: boolean;
  /** From a project or scene that has since been deleted. */
  deleted: boolean;
}

/** Enough for any realistic window; the dialog says when it is hit. */
const MAX_ROWS = 1000;

const rangeSchema = z
  .object({ fromIso: z.string().datetime(), toIso: z.string().datetime() })
  .refine((r) => r.fromIso < r.toIso, "Start must be before end.");

function kindOf(run: { model: string | null; scene_id: string | null; image?: boolean }): SpendKind {
  if (run.scene_id || KIE_MODELS.some((m) => m.kieModelName === run.model)) return "video";
  if (run.image) return "image";
  return "other";
}

function labelOf(model: string | null): string {
  return KIE_MODELS.find((m) => m.kieModelName === model)?.label ?? model ?? "Unknown";
}

export async function loadMySpendBreakdown(
  fromIso: string,
  toIso: string,
): Promise<{ rows: SpendRow[]; truncated: boolean }> {
  const { user } = await requireUser();
  const range = rangeSchema.parse({ fromIso, toIso });
  const admin = createAdminClient();

  const { data: projects, error: projectsError } = await admin
    .from("projects")
    .select("id")
    .eq("user_id", user.id);
  if (projectsError) throw new Error(projectsError.message);
  const projectIds = (projects ?? []).map((p) => p.id);

  const columns = "id, created_at, model, cost_usd, error, scene_id, project_id, idempotency_key, asset_id";
  const [own, viaProjects, archived] = await Promise.all([
    admin
      .from("runs")
      .select(columns)
      .eq("user_id", user.id)
      .gte("created_at", range.fromIso)
      .lt("created_at", range.toIso)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS),
    projectIds.length > 0
      ? admin
          .from("runs")
          .select(columns)
          .is("user_id", null)
          .in("project_id", projectIds)
          .gte("created_at", range.fromIso)
          .lt("created_at", range.toIso)
          .order("created_at", { ascending: false })
          .limit(MAX_ROWS)
      : Promise.resolve({ data: [], error: null }),
    admin
      .from("deleted_project_cost_history")
      .select("run_id, run_created_at, model, cost_usd, error, scene_id")
      .eq("user_id", user.id)
      .gte("run_created_at", range.fromIso)
      .lt("run_created_at", range.toIso)
      .order("run_created_at", { ascending: false })
      .limit(MAX_ROWS),
  ]);
  for (const result of [own, viaProjects, archived]) {
    if (result.error) throw new Error(result.error.message);
  }

  const rows: SpendRow[] = [
    ...[...(own.data ?? []), ...(viaProjects.data ?? [])].map((run) => ({
      id: run.id,
      createdAt: run.created_at,
      kind: kindOf({
        model: run.model,
        scene_id: run.scene_id,
        image: run.project_id === null && (run.idempotency_key !== null || run.asset_id !== null),
      }),
      model: labelOf(run.model),
      costUsd: run.cost_usd,
      failed: run.error !== null,
      deleted: false,
    })),
    ...(archived.data ?? []).map((run) => ({
      id: run.run_id,
      createdAt: run.run_created_at ?? "",
      kind: kindOf({ model: run.model, scene_id: run.scene_id }),
      model: labelOf(run.model),
      costUsd: run.cost_usd,
      failed: run.error !== null,
      deleted: true,
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Any one source hitting its limit may have dropped older rows too.
  const truncated =
    rows.length > MAX_ROWS ||
    [own, viaProjects, archived].some((result) => (result.data?.length ?? 0) >= MAX_ROWS);
  return { rows: rows.slice(0, MAX_ROWS), truncated };
}
