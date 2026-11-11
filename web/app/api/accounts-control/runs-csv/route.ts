import { NextResponse } from "next/server";
import { AuthorizationError, requireAdmin } from "@/actions/guard";
import {
  parseWindowDays,
  providerLabel,
  runPreviewSource,
  sceneTimeKey,
} from "@/lib/accounts-control";
import { buildAccountsRunsCsv } from "@/lib/accounts-runs-csv";
import { contentDispositionHeader } from "@/lib/archive";
import { manilaWindowEndIso, manilaWindowStartIso } from "@/lib/burn";
import { MEDIA_BUCKET } from "@/lib/storage";
import { createAdminClient, createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;
// Ids per `.in()` lookup. Those go in the GET URL: 600 uuids timed out and
// 1,000 got 400 Bad Request from production (2026-11-12), so the export failed
// once 14 days held more than ~300 image runs. 200 stays well under that.
const IN_CHUNK = 200;
const PREVIEW_TTL_SECONDS = 3600;
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

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  // THE PAGE'S REPORTING WINDOW, not all time. The export used to read every
  // run ever and sign each preview one call at a time, before sending a byte;
  // past ~100 s Cloudflare dropped the connection and Chrome showed "Site
  // wasn't available" (2026-11-11). Same Manila window as the All runs table.
  const windowDays = parseWindowDays(new URL(request.url).searchParams.get("days") ?? undefined);
  const now = new Date();
  const windowStartIso = new Date(manilaWindowStartIso(now, windowDays)).toISOString();
  const windowEndIso = new Date(manilaWindowEndIso(now)).toISOString();

  const supabase = await createClient();
  const runs: RunRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("runs")
      .select(
        "asset_id, scene_id, created_at, error, model, vendor, cost_usd, user_id, projects ( user_id )",
      )
      .gte("created_at", windowStartIso)
      .lt("created_at", windowEndIso)
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
  for (let from = 0; from < userIds.length; from += IN_CHUNK) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email")
      .in("id", userIds.slice(from, from + IN_CHUNK));
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
  for (let from = 0; from < imageAssetIds.length; from += IN_CHUNK) {
    const { data, error } = await supabase
      .from("assets")
      .select("id, storage_key")
      .in("id", imageAssetIds.slice(from, from + IN_CHUNK));
    if (error) {
      return NextResponse.json(
        { error: `Failed to load image previews: ${error.message}` },
        { status: 500 },
      );
    }
    for (const asset of data ?? []) imageKeyByAssetId.set(asset.id, asset.storage_key);
  }
  for (let from = 0; from < sceneIds.length; from += IN_CHUNK) {
    const { data, error } = await supabase
      .from("assets")
      .select("scene_id, created_at, storage_key")
      .eq("kind", "clip")
      .in("scene_id", sceneIds.slice(from, from + IN_CHUNK))
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
        clipKeyBySceneAndTime.set(
          sceneTimeKey(asset.scene_id, asset.created_at),
          asset.storage_key,
        );
      }
    }
  }

  // shortcut: preview links expire after one hour; use a download route if exports need durable links.
  // Signed in BULK — one createSignedUrls call per 1,000 keys, not one call
  // per run. A key that fails to sign leaves its preview cell blank.
  const previewKeys = runs.map(
    (run) => runPreviewSource(run, imageKeyByAssetId, clipKeyBySceneAndTime)?.storageKey ?? null,
  );
  const uniqueKeys = [...new Set(previewKeys.filter((key): key is string => key !== null))];
  const signedByKey = new Map<string, string>();
  const storage = createAdminClient().storage.from(MEDIA_BUCKET);
  for (let from = 0; from < uniqueKeys.length; from += PAGE_SIZE) {
    const { data } = await storage.createSignedUrls(
      uniqueKeys.slice(from, from + PAGE_SIZE),
      PREVIEW_TTL_SECONDS,
    );
    for (const item of data ?? []) {
      if (item.path && item.signedUrl && !item.error) signedByKey.set(item.path, item.signedUrl);
    }
  }
  const previews = previewKeys.map((key) => (key ? (signedByKey.get(key) ?? null) : null));

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
      "Content-Disposition": contentDispositionHeader(`runs-last-${windowDays}-days.csv`),
      "Cache-Control": "no-store",
    },
  });
}
