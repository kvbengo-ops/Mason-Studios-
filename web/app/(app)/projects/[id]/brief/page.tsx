// Gate 1 — brief review (docs/architecture.md § "User flow" step 4). The
// operator reads every prompt here before any render money is spent
// (§ "Cost model": everything up to this screen costs under a dollar).

import type { JSX } from "react";
import Link from "next/link";
import { requireProjectReadable } from "@/actions/guard";
import { approveBrief } from "@/actions/brief";
import { createClient } from "@/lib/supabase/server";
import { getImageUrl } from "@/lib/storage";
import { SceneTable } from "@/components/scene-table";
import {
  applySceneCostUsd,
  isAudioEnabled,
  parseCompilerModel,
  parseRenderSettings,
} from "@/lib/models";
import { isEditable } from "@/lib/editable-guard";
import { isDescriptionStale } from "@/lib/description-staleness";
import { assertScenesComplete } from "@/lib/brief-guard";
import { isDev } from "@/lib/mode";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { MockModeBanner } from "@/components/mock-mode-banner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export default async function BriefPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  const { project, isOwner } = await requireProjectReadable(id);

  const supabase = await createClient();
  const { data: scenes, error } = await supabase
    .from("scenes")
    .select("*")
    .eq("project_id", id)
    .order("idx", { ascending: true });

  if (error) {
    throw new Error(`Failed to load scenes for project ${id}: ${error.message}`);
  }

  // The character reference photo, loaded UNCONDITIONALLY — not only when
  // there is no typed description, which is what this used to do.
  //
  // The effect of that condition was that a project with both (the normal
  // case: you describe the character, then generate a photo from the
  // description) showed the description alone. One line of text — "an
  // athletic woman" — was the entire Character card on the screen whose
  // whole job is deciding whether to start spending render money. The face
  // is the thing that has to stay consistent across every clip, and it was
  // the one thing this gate could not show.
  //
  // Both are shown together now. They are not alternatives: the compiler
  // reads the description, the image model is conditioned on the photo, and
  // an operator approving a brief needs to see that those two agree.
  const { data: characterAsset } = await supabase
    .from("assets")
    .select("storage_key, created_at")
    .eq("project_id", id)
    .eq("kind", "character_ref")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let characterImageUrl: string | null = null;
  if (characterAsset) {
    // The 400px "thumb" copy: the box beside the description is w-40 (160px
    // CSS at every viewport), so it covers DPR2. Display-only; this asset's
    // use as vendor conditioning input (actions/frames.ts) signs the original.
    characterImageUrl = await getImageUrl(characterAsset.storage_key, "thumb");
  }

  // The same comparison the Character screen draws on the portrait itself.
  // It belongs here too, and arguably more: this is the last screen before
  // money is spent, and "the photo below is older than the description
  // beside it" is exactly the kind of thing an approval gate exists to
  // catch. Silent everywhere it cannot be sure — see isDescriptionStale.
  const characterPhotoStale = isDescriptionStale(
    project.character_desc_edited_at,
    characterAsset?.created_at ?? null,
  );

  const sceneRows = scenes ?? [];

  // Whenever a step is locked, its forward action must be locked with it.
  // The row-level lock landed first and left "Approve brief" clickable on a
  // project that had already rendered — a disabled table under a live
  // primary button is the same lie, just moved. The condition mirrors
  // approveBrief's own server-side assertAllEditable exactly (which refuses
  // if ANY scene has left draft/frame_ready), so the button is offered
  // exactly when the action would succeed.
  const briefLocked = sceneRows.some((scene) => !isEditable(scene.status));

  // Same reasoning as briefLocked above: approveBrief's own
  // assertScenesComplete refuses this server-side, so the button must not
  // sit there offering an action that will just error. Reusing the guard
  // directly (rather than re-deriving the same condition here) means the
  // message the operator reads before clicking can never drift from the
  // one the server would return after.
  let incompleteScenesMessage: string | null = null;
  try {
    assertScenesComplete(sceneRows);
  } catch (err) {
    incompleteScenesMessage =
      err instanceof Error ? err.message : "Some scenes are missing a script line or video prompt.";
  }

  const approveBriefForProject = approveBrief.bind(null, id);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium text-foreground">{project.title}</h1>
          <p className="text-sm text-muted-foreground">Review brief</p>
        </div>
        {/* Read-only export for review/sharing outside the app — e.g.
            handing the compiled brief to someone without an account.
            Deliberately NOT called "Export" alone or anything implying a
            save file: this CSV cannot be pasted back into the script
            import box (comma-separated text defeats
            parseTwoColumnScript's tab-then-pipe split — see
            lib/brief-csv.ts's header for the full reasoning). Plain <a>,
            not a client component: the route responds with
            Content-Disposition: attachment, so the browser downloads it
            without any JS on this end. */}
        <a
          href={`/api/projects/${id}/brief-csv`}
          className="shrink-0 whitespace-nowrap text-sm font-medium text-accent-foreground underline-offset-4 hover:underline"
        >
          Download CSV (for review)
        </a>
      </div>

      {isDev() ? (
        <MockModeBanner>
          MODE=development — this brief is a deterministic fixture, not something Claude wrote from
          the script. Nothing below reflects the actual compile.
        </MockModeBanner>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Character</CardTitle>
        </CardHeader>
        <CardContent>
          {characterImageUrl || project.character_desc ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              {characterImageUrl ? (
                /* Same reserved-box + object-contain treatment as
                   character/page.tsx's reference images: aspect-square +
                   overflow-hidden avoids the reflow an unsized img caused,
                   and object-contain avoids cropping a photo of unknown
                   aspect ratio. NOT lazy, unlike those — this Card is the
                   first thing on the page below the title/subtitle, so this
                   is the above-the-fold image here; lazy-loading it would
                   only delay it.
                   shrink-0 so the description takes the squeeze instead of
                   the face, which is the half that has to stay readable. */
                <div
                  className={cn(
                    "aspect-square w-40 shrink-0 overflow-hidden rounded-md border bg-muted",
                    characterPhotoStale ? "border-warning" : "border-border",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed URL, not a static import */}
                  <img
                    src={characterImageUrl}
                    alt="Character reference"
                    className={cn(
                      "h-full w-full object-contain",
                      // Dimmed, matching character-portrait-card.tsx: a stale
                      // photo is still the photo, so it stays visible, but it
                      // must not read as confirmation of the text beside it.
                      characterPhotoStale && "opacity-60",
                    )}
                    loading="eager"
                    decoding="async"
                  />
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                {project.character_desc ? (
                  <p className="text-sm text-foreground">{project.character_desc}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Character reference comes from an uploaded photo (no typed description).
                  </p>
                )}
                {/* Gated on the photo being ON SCREEN, not merely on the
                    comparison being true: this sentence points at "this
                    photo", and saying it with nothing to point at is a
                    warning the operator cannot act on or even check. */}
                {characterImageUrl && characterPhotoStale ? (
                  <p className="text-sm text-warning">
                    This photo was generated before the description was last edited, so it shows the
                    older character. Regenerate it on the{" "}
                    <Link
                      href={`/projects/${id}/character`}
                      className="font-medium underline underline-offset-4"
                    >
                      Character step
                    </Link>{" "}
                    before approving.
                  </p>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No character description set.</p>
          )}
        </CardContent>
      </Card>

      {/* applySceneCostUsd is derived here rather than inside the table:
          parseRenderSettings drops compileModel (RenderSettings is
          model/resolution/fps only), so the table cannot price an Apply from
          what it receives — the compiler descriptor lives in the raw jsonb
          this page still has in hand. Passing the figure rather than the raw
          column keeps the derivation in lib/models.ts instead of giving a
          client component a second opinion about what a scene compile
          costs. */}
      <SceneTable
        projectId={id}
        // Actual per-scene spend, for the Reopen dialog's "already spent on
        // the clip being discarded" figure. It used to print the
        // current-settings estimate there, which restates a sunk cost in
        // today's prices — and a done scene's settings are not frozen.

        initialScenes={sceneRows}
        audioEnabled={isAudioEnabled()}
        renderSettings={parseRenderSettings(project.render_settings)}
        applySceneCostUsd={applySceneCostUsd(parseCompilerModel(project.render_settings))}
        readOnly={!isOwner}
      />

      {isOwner ? (
        <div className="flex justify-end">
          {briefLocked ? (
            <p className="text-sm text-muted-foreground">
              {/* Same escape-hatch fix as frames/page.tsx's framesLocked
                  message: an actual link, not just the step's name in text —
                  this screen has no forward action of its own once
                  briefLocked is true. */}
              Rendering has started — the brief is locked and cannot be re-approved. Follow the
              render on the{" "}
              <Link
                href={`/projects/${id}/render`}
                className="font-medium text-accent-foreground underline-offset-4 hover:underline"
              >
                Render step
              </Link>
              .
            </p>
          ) : incompleteScenesMessage ? (
            <p className="text-sm text-muted-foreground">{incompleteScenesMessage}</p>
          ) : (
            <ActionForm
              action={approveBriefForProject}
              fallbackErrorMessage="Failed to approve brief."
            >
              <SubmitButton size="lg" pendingLabel="Approving…">
                Approve brief →
              </SubmitButton>
            </ActionForm>
          )}
        </div>
      ) : null}
    </div>
  );
}
