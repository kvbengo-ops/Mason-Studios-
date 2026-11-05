import { NextResponse } from "next/server";
import { issueImageStorageKey, signedUrl } from "@/lib/storage";

// The redirect the "Report a problem" dialog links to instead of a ~500-char
// signed URL. No auth check: GitHub's own image proxy fetches this with no
// session, so the unguessable uuid in the filename is the access control.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
): Promise<NextResponse> {
  const { file } = await params;
  const key = issueImageStorageKey(file);
  if (!key) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const url = await signedUrl(key, 3600);
    return NextResponse.redirect(url, {
      status: 302,
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
