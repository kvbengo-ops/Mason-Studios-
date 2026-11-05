// The project's trash — every scene 0088_deleted_scenes.sql's BEFORE DELETE
// trigger rescued one step ahead of the cascade, for this project, newest
// deletion first. Restore is the one write here (actions/ugc.ts's
// restoreScene); nothing else in this file can act on a row it lists.
//
// A native <details>/<summary> rather than a bespoke accordion: nothing
// under web/components/ui already renders a collapsible section, and the
// browser's own disclosure widget gets the collapsed/expanded state, the
// keyboard handling and the initial-collapsed default for free.

import type { JSX } from "react";
import { ChevronRightIcon } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { restoreScene } from "@/actions/ugc";

export interface UgcDeletedScene {
  /** deleted_scenes.scene_id — what restoreScene's sceneId field expects. */
  sceneId: string;
  /** deleted_scenes.scene_idx: this scene's idx at the moment it was deleted. Display only — restoring never reuses it. */
  idx: number | null;
  /** First line of the archived video_prompt, already dug out of the `scene` jsonb server-side. A placeholder, never empty, for a scene that had none. */
  promptFirstLine: string;
  /** Pre-formatted with lib/datetime.ts's dateTimeFormatter — same convention as every other timestamp this app shows (see projects-table.tsx). */
  deletedAtLabel: string;
}

export function UgcDeletedScenes({
  scenes,
  readOnly = false,
}: {
  readonly scenes: readonly UgcDeletedScene[];
  /**
   * True for an admin viewing someone else's project. restoreScene refuses
   * them in the server exactly like deleteClipScene does (both go through
   * requireProject, owner-only, admin excluded) — this only stops the page
   * offering a Restore that would only fail, same reasoning UgcSceneStrip's
   * own readOnly gives for hiding Delete.
   */
  readOnly?: boolean;
}): JSX.Element | null {
  // Nothing at all, not an empty box — a project that has never lost a scene
  // should not carry a permanent "Recently deleted" husk at its foot.
  if (scenes.length === 0) return null;

  return (
    <details className="group rounded-lg border bg-card">
      <summary
        className="flex cursor-pointer select-none list-none items-center justify-between gap-3 rounded-t-[7px] border-b bg-muted/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-foreground [&::-webkit-details-marker]:hidden"
        // Rounded bottom too while COLLAPSED, since the summary is then the
        // whole box — group-open below only re-squares it once the list
        // beneath is actually there to justify a flat seam.
      >
        <span className="flex items-center gap-1.5">
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3 shrink-0 transition-transform group-open:rotate-90"
          />
          Recently deleted
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {scenes.length} scene{scenes.length === 1 ? "" : "s"}
        </span>
      </summary>

      <ul className="divide-y">
        {scenes.map((scene) => (
          <li
            key={scene.sceneId}
            className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
          >
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {scene.idx === null ? "—" : `#${scene.idx}`}
              </span>
              <span className="truncate text-sm">{scene.promptFirstLine}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                · Deleted {scene.deletedAtLabel}
              </span>
            </div>

            {readOnly ? null : (
              <ActionForm
                action={restoreScene}
                fallbackErrorMessage="Could not restore this scene."
              >
                <input type="hidden" name="sceneId" value={scene.sceneId} />
                <SubmitButton pendingLabel="Restoring" variant="outline" size="sm">
                  Restore
                </SubmitButton>
              </ActionForm>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
