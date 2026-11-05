import type { JSX } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

// The authenticated 404. Separate from app/not-found.tsx on purpose: this
// one renders INSIDE (app)/layout.tsx, so a signed-in operator who follows
// a dead project link keeps the sidebar, their budget readout, and the nav
// — they are still in the app, they just asked for something that isn't
// there. The root page would drop them out of the shell entirely, which
// reads like being signed out.
//
// This is also what `notFound()` reaches from any Server Component under
// (app) — most usefully requireProject(), where a project id that doesn't
// exist (or belongs to someone else, which RLS makes indistinguishable
// from "doesn't exist", deliberately) lands here rather than throwing.
export default function AppNotFound(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-6 px-6 py-24 text-center">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium tracking-widest text-muted-foreground">404</p>
        <h1 className="text-2xl font-medium text-foreground">We couldn&apos;t find that</h1>
        {/* Says "or you don't have access" because it genuinely might be
            that, and we cannot tell the operator which: projects_select
            (0002_rls.sql) filters other people's rows out of the query
            rather than refusing it, so a project belonging to someone else
            arrives here looking exactly like one that was deleted. Naming
            both possibilities is the honest version — claiming it doesn't
            exist would be a guess presented as fact. */}
        <p className="max-w-md text-sm text-muted-foreground">
          This project may have been deleted, or you may not have access to it.
        </p>
      </div>

      <Button asChild>
        <Link href="/projects">Back to projects</Link>
      </Button>
    </div>
  );
}
