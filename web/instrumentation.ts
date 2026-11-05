// Next's hook for code that should run once when the server process
// starts, before it begins handling requests — see
// https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation.
// Its only job here is the cold-start marker: see lib/perf-log.ts's header
// for why "a render happened around this timestamp" is what tells a slow
// render shortly after a deploy/restart apart from a genuinely slow warm
// one.
export async function register(): Promise<void> {
  // register() runs for every runtime Next supports, including edge — this
  // app has no middleware or edge routes, but Next still calls this file
  // for that runtime when it exists. Guarding to nodejs keeps the marker
  // logged exactly once (not twice) and avoids running Node-specific code
  // (process.pid, in lib/perf-log.ts) under a runtime that doesn't have it.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { logColdStartMarker } = await import("@/lib/perf-log");
  logColdStartMarker();
}
