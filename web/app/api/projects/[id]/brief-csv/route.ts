// Gate 1's "Export CSV" download, linked from the Brief page
// (app/(app)/projects/[id]/brief/page.tsx). A route handler, not a Server
// Action: a Server Action's return value is serialized RSC payload, not an
// HTTP response with its own Content-Type/Content-Disposition, so there is
// no way to make a browser treat an action's result as a file download.
// This is the same reason the existing "Download all" archive
// (app/api/projects/[id]/archive/route.ts) is a route handler too.
//
// Guard: requireProjectReadable, NOT requireProject. This is a plain read
// (scenes SELECT, same query the Brief page itself runs) and must be
// reachable by exactly the same people who can view the Brief page —
// including a non-owning admin, whom requireProjectReadable admits with
// isOwner:false per 0002_rls.sql's read-only admin SELECT policy (see that
// function's doc comment in actions/guard.ts). Using the strict,
// owner-only requireProject here would 404 an admin who had just been
// let into the Brief page itself, the exact "correct in isolation, wrong
// at the seam" bug lib/guard-seam.test.ts exists to catch for Server
// Actions awaited during render. This route isn't a Server Action awaited
// during render — it's hit by a plain <a> navigation, after the page has
// already rendered — so that particular render-time sweep doesn't reach
// it. But lib/guard-seam.test.ts carries a second, independent mechanism
// just for this directory: an explicit registry of every route.ts under
// app/api/projects/[id]/ (API_ROUTE_GUARD_REGISTRY there) that asserts
// each route's actual guard call matches its declared reason, and this
// route has an entry in it — so the underlying rule is still enforced by
// a test, just a different one: a read surface must use the same guard as
// the page it's reached from, not the strict one every WRITE action uses.
//
// Note this diverges from the existing archive route, which the comment
// on components/clip-grid.tsx's readOnly prop documents as "deliberately
// still owner-only" — that route serves clip video files (paid render
// output, the thing this app charges for), a narrower read than "can this
// person view the Brief page." A CSV of the same scene rows the Brief page
// already renders for a readable viewer has no reason to be any stricter
// than the page itself.

import { NextResponse } from "next/server";
import { AuthorizationError, requireProjectReadable } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { briefCsvFilename, buildBriefCsv } from "@/lib/brief-csv";
import { contentDispositionHeader } from "@/lib/archive";

export const dynamic = "force-dynamic";

// Excel on Windows only reliably renders non-ASCII UTF-8 text (accented
// characters, curly quotes pasted from elsewhere) without a leading
// byte-order mark; Sheets and Excel on macOS ignore the BOM either way.
// Added here, not inside lib/csv.ts/lib/brief-csv.ts, so those stay plain
// text in and plain text out for their unit tests — the BOM is presentation
// for "a spreadsheet app opened this file," not part of the CSV data model.
const UTF8_BOM = "﻿";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  let project: { title: string };
  try {
    ({ project } = await requireProjectReadable(id));
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  const supabase = await createClient();
  const { data: scenes, error } = await supabase
    .from("scenes")
    .select("*")
    .eq("project_id", id)
    .order("idx", { ascending: true });

  if (error) {
    return NextResponse.json(
      { error: `Failed to load scenes for project ${id}: ${error.message}` },
      { status: 500 },
    );
  }

  const csv = buildBriefCsv(
    (scenes ?? []).map((scene) => ({
      idx: scene.idx,
      scriptLine: scene.script_line,
      videoPrompt: scene.video_prompt,
      isTalkingHead: scene.is_talking_head,
      durationS: scene.duration_s,
    })),
  );

  return new Response(UTF8_BOM + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDispositionHeader(briefCsvFilename(project.title)),
      "Cache-Control": "no-store",
    },
  });
}
