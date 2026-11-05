import type { JSX } from "react";
import { requireProjectReadable } from "@/actions/guard";
import { ProjectSettingsSidebar } from "@/components/project-settings-sidebar";

/**
 * The project's settings: render defaults, Shooting Mode, Direction,
 * Captions.
 *
 * The only route that holds them. A SCENE's own model, length and
 * resolution are not here — those live in a column on the scene page
 * (components/scene-settings-panel.tsx), which is the only route with a
 * scene to talk about. Renaming is not here either; that happens on the
 * title itself in the rail (components/rail-title-edit.tsx).
 *
 * The body is `ProjectSettingsSidebar`, a component rather than markup
 * inlined here, because an earlier pass had these forms written out twice —
 * once on this page and once in a column — and two places writing one row is
 * how they drift, with only one of them ever getting a fix.
 */
export default async function SettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  const { project, isOwner } = await requireProjectReadable(id);

  return (
    <div className="mx-auto max-w-2xl p-6">
      <ProjectSettingsSidebar project={project} isOwner={isOwner} />
    </div>
  );
}
