import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-auth";
import { providerReferencePromptFromScene } from "@/lib/api-references";
import { apiError } from "@/lib/api-v1";
import { mergeRenderSettings } from "@/lib/models";
import { signedUrlWithExpiry } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireApiToken(request, "read");
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return apiError("Job was not found.", "not_found", 404);

  try {
    const admin = createAdminClient();
    const { data: scene, error: sceneError } = await admin
      .from("scenes")
      .select(
        "id, project_id, status, video_prompt, ai_generated_prompt, duration_s, is_talking_head, render_settings_override, estimated_cost_usd",
      )
      .eq("id", id)
      .maybeSingle();
    if (sceneError) throw new Error(`Failed to read API job: ${sceneError.message}`);
    if (!scene) return apiError("Job was not found.", "not_found", 404);

    const { data: project, error: projectError } = await admin
      .from("projects")
      .select("id, user_id, render_settings")
      .eq("id", scene.project_id)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (projectError) throw new Error(`Failed to verify API job owner: ${projectError.message}`);
    if (!project) return apiError("Job was not found.", "not_found", 404);

    const [referencesResult, runsResult, outputResult] = await Promise.all([
      admin
        .from("scene_references")
        .select("asset_id, kind, ordinal, tag, category, description")
        .eq("scene_id", id)
        .order("kind", { ascending: true })
        .order("ordinal", { ascending: true }),
      admin
        .from("runs")
        .select("id, cost_usd, created_at")
        .eq("scene_id", id)
        .order("created_at", { ascending: false }),
      admin
        .from("assets")
        .select("id, storage_key, created_at")
        .eq("scene_id", id)
        .eq("kind", "clip")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (referencesResult.error) {
      throw new Error(`Failed to read API job references: ${referencesResult.error.message}`);
    }
    if (runsResult.error)
      throw new Error(`Failed to read API job attempts: ${runsResult.error.message}`);
    if (outputResult.error)
      throw new Error(`Failed to read API job output: ${outputResult.error.message}`);

    const references = referencesResult.data ?? [];
    const runs = runsResult.data ?? [];
    const settings = mergeRenderSettings(project.render_settings, scene.render_settings_override);
    const totalCostUsd = runs.reduce(
      (sum, run) => sum + (run.cost_usd === null ? 0 : Number(run.cost_usd)),
      0,
    );
    const output = outputResult.data
      ? await signedUrlWithExpiry(outputResult.data.storage_key, 3600, true).then(
          ({ url, expiresInSeconds }) => ({
            asset_id: outputResult.data!.id,
            download_url: url,
            url_expires_in_s: expiresInSeconds,
          }),
        )
      : null;

    return NextResponse.json({
      job_id: scene.id,
      status: scene.status,
      inputs: {
        prompt: scene.video_prompt,
        provider_reference_prompt: providerReferencePromptFromScene(
          scene.video_prompt ?? "",
          settings.model,
          references,
        ),
        references,
        model_id: settings.model,
        resolution: settings.resolution,
        duration_s: scene.duration_s,
        is_talking_head: scene.is_talking_head,
      },
      estimated_cost_usd:
        scene.estimated_cost_usd === null ? null : Number(scene.estimated_cost_usd),
      latest_attempt_cost_usd:
        runs.length > 0 && runs[0]!.cost_usd !== null ? Number(runs[0]!.cost_usd) : null,
      total_cost_usd: totalCostUsd,
      attempts_count: runs.length,
      output,
    });
  } catch (error) {
    console.error(`GET /api/v1/jobs/${id} failed`, error);
    return apiError("Could not read this job.", "job_read_failed", 500);
  }
}
