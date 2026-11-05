import { redirect } from "next/navigation";
import type { JSX } from "react";
import { requireProjectReadable } from "@/actions/guard";
import { STATUS_ROUTE } from "@/lib/project-status";

// This route has no UI of its own — it exists so a bare /projects/[id]
// link (e.g. from the projects list) always lands the operator on their
// CURRENT step. See lib/project-status.ts for the status → route mapping.
//
// Deliberately still "current step," not "furthest step ever reached":
// project.status can legitimately point earlier in the pipeline than a step
// the project has already paid for (see lib/project-status.ts's
// deriveReachedSteps doc comment) — a reopened scene, or a scene added
// after rendering started — and this redirect is right to land there
// anyway, since that's where the thing needing the operator's attention
// actually is. What must NOT regress is whether the operator can still get
// to Render/Deliver from here — that's step-rail.tsx's job
// (components/step-rail.tsx), driven by `reached`, not by this route's
// target.
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  const { project } = await requireProjectReadable(id);

  redirect(`/projects/${id}/${STATUS_ROUTE[project.status]}`);
}
