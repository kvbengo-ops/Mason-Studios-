// A strip across the top of every screen when a LOCAL dev server is writing
// to a HOSTED database. See lib/hosted-db.ts for why the condition is
// exactly that and nothing broader.
//
// Deliberately not dismissible. The whole failure it guards against is
// forgetting — an operator who is about to delete a scene has usually
// stopped reading the chrome, which is precisely when this has to still be
// there. It costs one line of vertical space in development and renders
// nothing at all in production.
//
// Also deliberately not styled as an error. Nothing is wrong: this is a
// legitimate setup that makes local development useful. It is a standing
// fact about where the writes go, so it reads as a fact.

import type { JSX } from "react";
import { isDevAgainstHostedDb, supabaseProjectRef } from "@/lib/hosted-db";
import { isDev, mode } from "@/lib/mode";

export function HostedDbWarning(): JSX.Element | null {
  // SUPABASE_URL, not NEXT_PUBLIC_: this renders on the server, and the
  // server-side name is the one the admin client actually writes through.
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!isDevAgainstHostedDb(process.env.NODE_ENV, url)) return null;

  const ref = supabaseProjectRef(url);

  // What THIS process is actually doing, read from the same function the
  // code paths read — not from a .env file. On 2026-08-31 worker/.env said
  // MOCK_FAL_VIDEO=1 while the running worker had it false (godotenv does
  // not override a variable already in the shell), and the file was quoted
  // three times as proof that local was mocked before a real $2.52 render
  // said otherwise. A file is a claim; this is the answer. That incident is
  // also why this is a single mode(), not two independent isMockFalImage()/
  // isMockClaude() booleans that could themselves have disagreed — see
  // lib/mode.ts's header.
  const dev = isDev();

  return (
    <div className="border-b border-warning/40 bg-warning/10 px-4 py-1.5 text-center text-xs text-foreground">
      Local dev, <strong className="font-medium">hosted database</strong>
      {ref ? <span className="font-mono"> ({ref})</span> : null} — every project, scene and delete
      on this screen is real.{" "}
      <span className={dev ? undefined : "font-medium text-destructive"}>
        MODE={mode()}: images and compiler are {dev ? "mocked" : "REAL"} here.
      </span>{" "}
      {/* Deliberately NOT fetched from the worker. The two services share
          nothing but Postgres by design (render.yaml's own header), and a
          cross-service call here would be the first exception to that for a
          diagnostic. The worker answers the same question itself, at
          GET /health — and its /mock/clip.mp4 route exists ONLY in mock mode,
          so a 200 there is proof no code can fake. */}
      {/* THE SENTENCE THAT USED TO COST MONEY, corrected. On 2026-08-31 an
          operator tested locally with MOCK_FAL_VIDEO=1 and was billed for
          real renders anyway: the deployed worker polled this same database
          every 30s, and whichever worker claimed a queued scene first was
          the one that rendered it — a local mock flag decided what a worker
          did AFTER it claimed a job, with no say in who claimed it first.
          scenes.dev (written by every enqueue, filtered on by every claim —
          see lib/mode.ts's header) is the fix: it is no longer a coin flip,
          because a row this MODE writes can only ever be claimed by a
          worker running the SAME mode. */}
      {dev ? (
        <>
          Scenes queued here are written <code className="font-mono">dev=true</code> and can only
          be claimed by a worker also running <code className="font-mono">MODE=development</code>{" "}
          — the deployed worker runs <code className="font-mono">MODE=production</code> and will
          never touch them.
        </>
      ) : (
        <>
          <strong className="font-medium">MODE=production here</strong>: scenes queued from this
          machine are written <code className="font-mono">dev=false</code>, the same as the
          deployed worker claims — any production-mode worker sharing this database, including
          the deployed one, can claim and bill them for real. Suspend a local production-mode
          worker, or expect real renders.
        </>
      )}{" "}
      Check yours with <code className="font-mono">curl localhost:8080/health</code>.
    </div>
  );
}
