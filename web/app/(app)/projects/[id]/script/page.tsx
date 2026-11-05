import type { JSX } from "react";
import { requireProjectReadable } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { compileScript, recompile } from "@/actions/compile";
import { saveScript } from "@/actions/setup";
import {
  ScriptSetupForm,
  ScriptDraftProvider,
  ScriptField,
  CompileAction,
  UnlocksForecast,
  SaveButton,
} from "@/components/script-setup-form";
import { SetupLockBanner } from "@/components/setup-lock-banner";
import { hasStartedRendering } from "@/lib/recompile-guard";
import { assertHasCharacter } from "@/lib/compile-guard";
import { isDev } from "@/lib/mode";
import { MockModeBanner } from "@/components/mock-mode-banner";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { estimatedRefFrameCostUsd, parseCompilerModel } from "@/lib/models";

// Spec's Script step: the paste/upload textarea, its live two-column
// preview, and Compile — the gate everything downstream hangs off. Split
// out of the single Character Setup page — see actions/setup.ts's header
// for why the write split the same way.

export default async function ScriptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;

  const { project, isOwner } = await requireProjectReadable(id);
  const supabase = await createClient();

  const [{ data: characterAsset }, { data: sceneStatuses }] = await Promise.all([
    supabase
      .from("assets")
      .select("storage_key")
      .eq("project_id", id)
      .eq("kind", "character_ref")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from("scenes").select("status").eq("project_id", id),
  ]);

  const locked = project.status === "delivered";
  // hasStartedRendering, NOT isEditable. isEditable widened to include
  // rendered scenes (a re-render opens a new version instead of overwriting
  // a clip), which silently flipped this gate: a project with six finished
  // clips started reporting "nothing committed yet" and the Recompile
  // button came back — offering an action the server still refuses, on the
  // one screen where confusing the two would delete paid work.
  const hasCommittedScenes = hasStartedRendering(sceneStatuses ?? []);

  // compileScript's own two boundary checks (script present, character
  // present — actions/compile.ts's runCompile) refuse this server-side, so
  // "Compile script" must not sit there offering an action that will just
  // error.
  const hasScript = !!project.script_raw?.trim();
  let characterMessage: string | null = null;
  try {
    assertHasCharacter(!!project.character_desc?.trim(), !!characterAsset);
  } catch (err) {
    characterMessage = err instanceof Error ? err.message : "Add a character before compiling.";
  }

  const hasScenes = (sceneStatuses ?? []).length > 0;
  const mockClaude = isDev();

  const frameCostUsd = estimatedRefFrameCostUsd();

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          UGC Pipeline
        </p>
        <p className="text-sm text-muted-foreground">{project.title}</p>
        {/* The subtitle that used to sit here moved onto the panel header
            below, where the design puts it: one "Script" heading with its
            meta line beside it, not a page title and a card title saying
            the same word twice with a sentence in between. */}
        <h1 className="text-2xl font-medium text-foreground">Script</h1>
      </div>

      {mockClaude ? (
        <MockModeBanner>
          MODE=development — &quot;Compile script&quot; below will produce a deterministic fixture
          brief, not one Claude wrote from this script.
        </MockModeBanner>
      ) : null}

      <SetupLockBanner projectId={id} locked={locked} hasCommittedScenes={hasCommittedScenes} />

      <ScriptSetupForm
        action={saveScript.bind(null, id)}
        fallbackErrorMessage="Failed to save script."
      >
        {/* Shares the textarea's live text with the "What this unlocks"
            forecast below the Compile button — see ScriptDraftProvider. */}
        <ScriptDraftProvider initialValue={project.script_raw ?? ""}>
          <Card id="setup-script" className="scroll-mt-6">
            <CardHeader>
              <CardTitle>Script</CardTitle>
              <CardAction>
                <span className="text-xs text-muted-foreground">
                  the last step before scenes exist
                </span>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <ScriptField
                initialValue={project.script_raw ?? ""}
                initialIncludeVisualIdea={project.include_visual_idea}
                locked={locked || !isOwner}
              />
              {!locked && hasScenes ? (
                <p className="text-xs text-muted-foreground">
                  A brief has already been compiled from this script. Saving an edit here does not
                  touch the compiled scenes — they keep rendering the old text until you{" "}
                  <a href="#compile-action" className="font-medium text-foreground underline">
                    recompile
                  </a>
                  .
                </p>
              ) : null}
            </CardContent>
          </Card>

          <SaveButton locked={locked} readOnly={!isOwner} />

          {!isOwner ? null : locked ? (
            <p className="text-sm text-muted-foreground">
              This project has already been delivered, so the script step is read-only. Reopen the
              project from the Deliver page to make changes.
            </p>
          ) : !hasScript ? (
            <p className="text-sm text-muted-foreground">
              Add a script before compiling — there&apos;s nothing to split into scenes yet.
            </p>
          ) : characterMessage ? (
            <p className="text-sm text-muted-foreground">
              {characterMessage} Add one on the{" "}
              <a
                href={`/projects/${id}/character`}
                className="font-medium text-foreground underline"
              >
                Character
              </a>{" "}
              page.
            </p>
          ) : hasCommittedScenes ? (
            // Recompile is a DIFFERENT, stricter gate than `locked` above —
            // recompile() (actions/compile.ts) runs assertRecompilable
            // (lib/recompile-guard.ts), which still refuses once any scene has
            // left draft/frame_ready, not just once the project is delivered.
            <p className="text-sm text-muted-foreground">
              This project has scenes that have already rendered — recompiling would delete rows
              that cost real money to produce, so it&apos;s disabled here. Duplicate the project
              from the projects list to iterate on the script instead.
            </p>
          ) : (
            <>
              {/* Recompiling is a DELETE and re-insert of every scene row
                  (actions/compile.ts), not an update in place. Rendered
                  scenes are already refused above, so no paid clip can be
                  lost here — but hand-edited prompts and the reference
                  frames those scenes already generated go with the rows,
                  and both cost something: the frames in money, the edits in
                  work. Now that scene_versions hangs off scenes with ON
                  DELETE CASCADE, a scene's whole history goes too. */}
              {hasScenes ? (
                <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                  <strong className="font-semibold">
                    Recompiling starts the scenes over from scratch.
                  </strong>{" "}
                  Your edited prompts and the frames you already generated are deleted. Your script
                  stays.
                </p>
              ) : null}
              <CompileAction
                action={(hasScenes ? recompile : compileScript).bind(null, id)}
                saveAction={saveScript.bind(null, id)}
                label={hasScenes ? "Recompile script" : "Compile script"}
                dirtyLabel={hasScenes ? "Save & recompile" : "Save & compile"}
                pendingLabel={hasScenes ? "Recompiling…" : "Compiling…"}
                fallbackErrorMessage={
                  hasScenes ? "Failed to recompile script." : "Failed to compile script."
                }
                projectId={id}
                initialCompilerModel={parseCompilerModel(project.render_settings).id}
              />
              {/* Only before the first compile: once scenes exist this is no
                longer a forecast of what you'd unlock, it's a worse copy of
                the Brief. */}
              {hasScenes ? null : <UnlocksForecast frameCostUsd={frameCostUsd} />}
            </>
          )}
        </ScriptDraftProvider>
      </ScriptSetupForm>
    </div>
  );
}
