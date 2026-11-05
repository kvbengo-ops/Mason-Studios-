// "Am I a local dev server writing to a hosted database?"
//
// WHY THIS EXISTS
//
// web/.env's SUPABASE_URL is the same project the deployed app uses. That is
// convenient — a local dev server sees real projects, real scenes, real
// assets — and it means every click in local development is a write to
// production. On 2026-08-30 that produced four unwanted final_versions
// (v2–v5) in a shared test project, created by a local dev server nobody
// thought of as "production". Nothing was lost, and only because the project
// they landed in was a test one.
//
// The two mock switches do not cover this. They decide whether a VENDOR is
// called; they say nothing about which database the row is written to. A
// fully mocked local run still deletes a real scene if you press Delete.
//
// So this answers a narrower question than "is this production", which the
// app cannot know: is a non-production build talking to a database that is
// not on this machine. That is decidable from the URL alone, and it is the
// condition worth warning about — a local run against localhost is a
// sandbox, a local run against anything else is not.

/** Hosts that mean "this database lives on this machine". */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/**
 * True when this process is NOT a production build and its Supabase URL
 * points somewhere other than this machine.
 *
 * `nodeEnv` and `supabaseUrl` are parameters rather than direct
 * process.env reads so this is testable without mutating the environment —
 * the same reason lib/mock-flags.ts's callers pass their scenes in.
 *
 * An unparseable or missing URL answers FALSE. A warning banner that fires
 * on a misconfigured environment teaches the operator to ignore it, and
 * this one is only useful if it is never noise.
 */
export function isDevAgainstHostedDb(
  nodeEnv: string | undefined,
  supabaseUrl: string | undefined,
): boolean {
  if (nodeEnv === "production") return false;
  if (!supabaseUrl) return false;
  try {
    return !LOCAL_HOSTS.has(new URL(supabaseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The project ref from a Supabase URL — the subdomain of
 * `https://<ref>.supabase.co` — or null when there isn't one.
 *
 * Shown in the warning so the operator can tell WHICH hosted database at a
 * glance, rather than being told only that it is hosted. Two hosted
 * databases (a staging project and the live one) are a very different
 * situation from one, and the banner should not flatten them.
 */
export function supabaseProjectRef(supabaseUrl: string | undefined): string | null {
  if (!supabaseUrl) return null;
  try {
    const { hostname } = new URL(supabaseUrl);
    if (LOCAL_HOSTS.has(hostname)) return null;
    const [ref] = hostname.split(".");
    return ref && ref.length > 0 ? ref : null;
  } catch {
    return null;
  }
}
