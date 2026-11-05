import type { JSX } from "react";
import { createClient } from "@/lib/supabase/server";
import { isAudioEnabled, parseRenderSettings, parseCompilerModel } from "@/lib/models";
import { projectDirectionFrom } from "@/lib/direction";
import { captionStyleFrom } from "@/lib/caption-style";
import { RenderSettingsForm } from "@/components/render-settings-form";
import {
  DirectionSetupForm,
  ShootingModeFields,
  DirectionDetailFields,
  CaptionStyleFields,
  SaveButton,
} from "@/components/settings-direction-form";
import { saveDirection } from "@/actions/settings";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import type { Database } from "@/types/db";

type Project = Database["public"]["Tables"]["projects"]["Row"];

/**
 * Everything that decides how this PROJECT renders: the default model,
 * resolution and frame rate, plus Shooting Mode, Direction and Captions.
 *
 * A component rather than markup on the page that shows it. The forms were
 * briefly written out in two places at once — this file and a layout column
 * — and two places writing one row is how they drift, with only one of them
 * ever getting a fix. The /settings page renders this and nothing else.
 *
 * What is deliberately NOT here:
 *   - a scene's own model/length/resolution — components/scene-settings-panel.tsx,
 *     on the scene page, which is the only route that has a scene;
 *   - the compile model — the Script page's own picker, beside the Compile
 *     button that spends it;
 *   - the project title — renamed on the title itself in the rail
 *     (components/rail-title-edit.tsx).
 *
 * Server component. AUDIO_ENABLED is resolved here rather than inside
 * RenderSettingsForm because it is not NEXT_PUBLIC_ — the same read inside a
 * client component would see undefined.
 */
export async function ProjectSettingsSidebar({
  project,
  isOwner,
  showRenderDefaults = true,
  frozenReason,
}: {
  project: Project;
  isOwner: boolean;
  /**
   * Why these fields are read-only right now, when something other than
   * delivery has frozen them — today, a scene the worker is rendering.
   *
   * Passed rather than derived here: this component knows the project, not
   * which scene the operator is standing on. Null means nothing extra is
   * freezing them.
   */
  frozenReason?: string | null;
  /**
   * Whether to draw the project's RENDER defaults (model, resolution, fps
   * and the per-30s-ad total).
   *
   * False on a scene page. There, the Scene Settings panel directly above
   * carries the same three pickers for the scene actually in front of the
   * operator, and two model rows stacked in one narrow column is a question
   * about which one you are touching, not a comparison. The rest of this
   * component — Shooting Mode, Direction, Captions — has no per-scene twin
   * and stays.
   */
  showRenderDefaults?: boolean;
}): Promise<JSX.Element> {
  const supabase = await createClient();
  const { data: scenes, error } = await supabase
    .from("scenes")
    .select("duration_s, render_settings_override")
    .eq("project_id", project.id);

  if (error) {
    throw new Error(`Failed to load scenes for project ${project.id}: ${error.message}`);
  }

  const sceneRows = scenes ?? [];
  const longestSceneS = sceneRows.reduce(
    (longest, scene) => Math.max(longest, scene.duration_s),
    0,
  );

  const renderSettings = parseRenderSettings(project.render_settings);
  const compilerModel = parseCompilerModel(project.render_settings);
  const direction = projectDirectionFrom(project);
  const captionStyle = captionStyleFrom(project);

  // Direction/Captions lock the same way Character/Product/Script do: they
  // are pre-render inputs (voice, camera, captions) that already shaped
  // whatever has rendered — see actions/settings.ts's saveDirection for the
  // exact gate. Title never locks — see settings-title-form.tsx.
  const locked = project.status === "delivered";
  // Direction, Shooting Mode and Captions shape the prompt the worker is
  // reading RIGHT NOW. Editing them while a scene renders does not change
  // that clip — it is already submitted — but it does leave the settings
  // describing something the clip was not built from, which is the same
  // drift scene_versions (0058) exists to stop for the prompt itself.
  const fieldsLocked = locked || !isOwner || Boolean(frozenReason);

  return (
    // Borderless sections divided by a rule rather than a stack of framed
    // cards. In a 400px column a border around every group draws four boxes
    // competing for the same edge, and the frame carried no meaning the
    // heading did not already carry. `divide-y` puts the separation on the
    // gap between sections, which is the only place it says anything.
    <div className="flex flex-col divide-y divide-border [&>*]:py-5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
      {/* No scene block here. A scene's own model/length/resolution lives on
          the scene page itself (components/scene-settings-panel.tsx), which
          is the only route that has a scene to talk about. */}

      {frozenReason ? (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          {frozenReason}
        </p>
      ) : null}

      {showRenderDefaults ? (
        <RenderSettingsForm
          projectId={project.id}
          initialRenderSettings={renderSettings}
          compilerModel={compilerModel}
          longestSceneS={longestSceneS}
          audioEnabled={isAudioEnabled()}
          sceneCount={sceneRows.length}
          overriddenSceneCount={
            sceneRows.filter((scene) => scene.render_settings_override !== null).length
          }
          readOnly={!isOwner}
        />
      ) : null}

      <DirectionSetupForm
        action={saveDirection.bind(null, project.id)}
        fallbackErrorMessage="Failed to save direction settings."
        // These are scene-shaping preferences, not a purchase: nothing here
        // spends, and every field is a choice that is already made the
        // moment it is clicked. A Save button asked the operator to confirm
        // it a second time, and forgetting cost them silently — the fields
        // showed one thing and the next render used another.
        autoSave
      >
        <Card className="gap-3 border-0 bg-transparent p-0 shadow-none">
          <CardHeader className="p-0">
            <CardTitle>Shooting Mode</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ShootingModeFields initialDirection={direction} locked={fieldsLocked} />
          </CardContent>
        </Card>

        <Card className="gap-3 border-0 bg-transparent p-0 shadow-none">
          <CardHeader className="p-0">
            <CardTitle>Direction</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DirectionDetailFields initialDirection={direction} locked={fieldsLocked} />
          </CardContent>
        </Card>

        {/* Captions sit next to Direction rather than on their own page:
            the pronunciation guide above is a caption setting already — the
            phonetic it appends is what a caption renders — and separating
            the two would mean editing one without seeing the other.

            THE COPY BELOW IS PAST TENSE ON PURPOSE. Caption burning was
            deleted, not disabled, when fal was decommissioned: the word
            timings came from fal-ai/whisper and there is no replacement
            transcription vendor, so loop/assemble.go's captionOrFallback,
            buildCaptionTrack and recordCaptionRun are gone and an assembled
            final now carries no captions at all.

            The fields are kept rather than removed because the rest of the
            machinery is dormant, not deleted — BuildChunks, GenerateASS and
            media.Runner.BurnCaptions never had a fal dependency and are
            waiting on word timings, nothing else. So a style saved today is
            a style that will apply when a vendor returns.

            What could NOT stay is the old description. It described the
            burning as something that happens, in the present tense, and that
            has been false since fal went. An operator picking colours for
            something that silently never renders is a worse failure than the
            missing feature.

            lib/caption-promise.test.ts holds the two halves together, and it
            reads this file as text — so do not restore the old wording here,
            even inside a comment. */}
        <Card className="gap-3 border-0 bg-transparent p-0 shadow-none">
          <CardHeader className="p-0">
            <CardTitle>Captions</CardTitle>
            <CardDescription>
              <strong>Not currently burned.</strong> Caption timing came from the transcription
              vendor that was retired with fal, and nothing has replaced it yet — an assembled
              video comes out with no captions on it. These settings are saved and will apply
              when word timings are available again; the words will still come from each
              scene&rsquo;s script line rather than speech recognition, so a brand name stays
              spelled the way you wrote it.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <CaptionStyleFields initialStyle={captionStyle} locked={fieldsLocked} />
          </CardContent>
        </Card>

        <SaveButton locked={locked} readOnly={!isOwner} />
      </DirectionSetupForm>

      {/* No Project title card. Renaming happens in the rail now, on the
          title itself (components/rail-title-edit.tsx) — the name is on
          screen on every route, so an editable second copy of it down here
          was a form competing with a label for one fact. */}
    </div>
  );
}
