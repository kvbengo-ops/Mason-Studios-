// A strip across the top of every screen when a LOCAL dev server is writing
// to a HOSTED database. See lib/hosted-db.ts for why the condition is
// exactly that and nothing broader.
//
// Deliberately not dismissible. The whole failure it guards against is
// forgetting — an operator who is about to delete a scene has usually
// stopped reading the chrome, which is precisely when this has to still be
// there. It renders nothing at all in production.
//
// ONE LINE, full explanation on hover (2026-11-06). The old two-line
// paragraph wrapped over the top of every page and covered /create's mode
// switch. The line keeps the two facts that matter in view — the database is
// real, and whether renders are — and the rest is its `title`.
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
  // also why this is a single mode(), not two independent booleans that could
  // themselves have disagreed — see lib/mode.ts's header.
  const dev = isDev();

  // Deliberately NOT fetched from the worker: the two services share nothing
  // but Postgres by design, and the worker answers the same question itself
  // at GET /health.
  //
  // THE SENTENCE THAT USED TO COST MONEY, corrected. On 2026-08-31 a local
  // mock flag decided what a worker did AFTER it claimed a job, with no say
  // in who claimed it — the deployed worker claimed and billed it. scenes.dev
  // (written by every enqueue, filtered on by every claim) is the fix: a row
  // this MODE writes can only be claimed by a worker running the SAME mode.
  const details = dev
    ? "Scenes queued here are written dev=true and can only be claimed by a worker also running MODE=development — the deployed worker runs MODE=production and will never touch them."
    : "Scenes queued from this machine are written dev=false, the same as the deployed worker claims — any production-mode worker sharing this database, including the deployed one, can claim and bill them for real. Suspend a local production-mode worker, or expect real renders.";

  return (
    <div
      title={`${details} Check yours with curl localhost:8080/health.`}
      className="truncate border-b border-warning/40 bg-warning/10 px-4 py-1 text-center text-[11px] text-foreground"
    >
      Local dev · <strong className="font-medium">hosted database</strong>
      {ref ? <span className="font-mono"> ({ref})</span> : null} — changes here are real ·{" "}
      <span className={dev ? undefined : "font-medium text-destructive"}>
        MODE={mode()}: renders are {dev ? "mocked" : "REAL"}
      </span>
    </div>
  );
}
