import { NextResponse } from "next/server";
import { AuthorizationError, requireAdmin } from "@/actions/guard";
import { providerLabel, runPreviewSource, sceneTimeKey } from "@/lib/accounts-control";
import { buildAccountsRunsCsv } from "@/lib/accounts-runs-csv";
import { contentDispositionHeader } from "@/lib/archive";
import { signedUrl } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;
const UTF8_BOM = "\uFEFF";

interface RunRow {
  asset_id: string | null;
  scene_id: string | null;
  created_at: string;
  error: string | null;
  model: string;
  vendor: string;
  cost_usd: number | null;
  user_id: string | null;
  projects: { user_id: string } | null;
}

export async function GET(_request: Request): Promise<Response> {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  const supabase = await createClient();
  const runs: RunRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("runs")
      .select(
        "asset_id, scene_id, created_at, error, model, vendor, cost_usd, user_id, projects ( user_id )",
      )
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      return NextResponse.json({ error: `Failed to load runs: ${error.message}` }, { status: 500 });
    }
    const batch = (data ?? []) as unknown as RunRow[];
    runs.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  const userIds = [
    ...new Set(
      runs
        .map((run) => run.user_id ?? run.projects?.user_id)
        .filter((userId): userId is string => Boolean(userId)),
    ),
  ];
  const emails = new Map<string, string>();
  for (let from = 0; from < userIds.length; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email")
      .in("id", userIds.slice(from, from + PAGE_SIZE));
    if (error) {
      return NextResponse.json(
        { error: `Failed to load run emails: ${error.message}` },
        { status: 500 },
      );
    }
    for (const profile of data ?? []) emails.set(profile.id, profile.email);
  }

  const imageAssetIds = [...new Set(runs.flatMap((run) => (run.asset_id ? [run.asset_id] : [])))];
  const videoRuns = runs.filter((run) => !run.asset_id && run.scene_id && run.cost_usd !== null);
  const sceneIds = [...new Set(videoRuns.map((run) => run.scene_id!))];
  const times = videoRuns.map((run) => run.created_at).sort();
  const imageKeyByAssetId = new Map<string, string>();
  const clipKeyBySceneAndTime = new Map<string, string>();
  for (let from = 0; from < imageAssetIds.length; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("assets")
      .select("id, storage_key")
      .in("id", imageAssetIds.slice(from, from + PAGE_SIZE));
    if (error) {
      return NextResponse.json(
        { error: `Failed to load image previews: ${error.message}` },
        { status: 500 },
      );
    }
    for (const asset of data ?? []) imageKeyByAssetId.set(asset.id, asset.storage_key);
  }
  for (let from = 0; from < sceneIds.length; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("assets")
      .select("scene_id, created_at, storage_key")
      .eq("kind", "clip")
      .in("scene_id", sceneIds.slice(from, from + PAGE_SIZE))
      .gte("created_at", times[0]!)
      .lte("created_at", times[times.length - 1]!);
    if (error) {
      return NextResponse.json(
        { error: `Failed to load video previews: ${error.message}` },
        { status: 500 },
      );
    }
    for (const asset of data ?? []) {
      if (asset.scene_id) {
        clipKeyBySceneAndTime.set(sceneTimeKey(asset.scene_id, asset.created_at), asset.storage_key);
      }
    }
  }

  // shortcut: preview links expire after one hour; use a download route if exports need durable links.
  const previews: (string | null)[] = [];
  for (let from = 0; from < runs.length; from += 50) {
    previews.push(
      ...(await Promise.all(
        runs.slice(from, from + 50).map(async (run) => {
          const source = runPreviewSource(run, imageKeyByAssetId, clipKeyBySceneAndTime);
          if (!source) return null;
          try {
            return await signedUrl(source.storageKey);
          } catch {
            return null;
          }
        }),
      )),
    );
  }

  const csv = buildAccountsRunsCsv(
    runs.map((run, index) => {
      const userId = run.user_id ?? run.projects?.user_id;
      return {
        preview: previews[index] ?? null,
        userEmail: userId ? (emails.get(userId) ?? null) : null,
        provider: providerLabel(run.vendor),
        model: run.model,
        costUsd: run.cost_usd,
        details: run.error,
      };
    }),
  );

  return new Response(UTF8_BOM + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDispositionHeader("all-runs.csv"),
      "Cache-Control": "no-store",
    },
  });
}
