/**
 * Turns a Supabase signed URL into one the browser will SAVE rather than open.
 *
 * WHY THE `download` ATTRIBUTE IS NOT ENOUGH. `<a download>` is ignored for
 * cross-origin hrefs — every browser drops it — and a Supabase signed URL is
 * always cross-origin here: the app is on onrender.com and storage is on
 * supabase.co. So pressing Download navigated to the file and the video
 * played in a tab instead of landing in Downloads, which is the whole point
 * of the button on a route whose output goes into CapCut.
 *
 * Supabase Storage honours a `download` query parameter by answering with
 * `Content-Disposition: attachment`, and a filename as its value names the
 * saved file. That is server-side, so it survives the cross-origin rule.
 *
 * NOT applied to the <video src>. The same URL feeds the inline player, and
 * an attachment disposition there is a download prompt where a preview
 * should be — the two uses want opposite answers from the same object.
 *
 * Pure and client-safe on purpose: both callers are Client Components, so
 * this must not reach for anything server-only.
 */
export function asAttachment(url: string, filename?: string | null): string {
  try {
    const parsed = new URL(url);
    // Value, not bare flag: Supabase uses it as the saved filename, and a
    // signed key is a uuid — without this the file lands named after the
    // storage object rather than the scene.
    parsed.searchParams.set("download", filename && filename.trim() ? filename : "");
    return parsed.toString();
  } catch {
    // A relative or malformed href is not something to throw over on a
    // control whose failure mode should be "opens the file" rather than "the
    // page crashed". The `download` attribute still applies to same-origin
    // URLs, which is what a relative href is.
    return url;
  }
}
