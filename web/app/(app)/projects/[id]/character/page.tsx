import type { JSX } from "react";
import { redirect } from "next/navigation";
import { requireProjectReadable, isAdmin } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { getImageUrl, type ImageSize } from "@/lib/storage";
import { uploadCharacterRef, regenerateCharacter, removeCharacterRef } from "@/actions/character";
import { saveCharacter } from "@/actions/setup";
import {
  CharacterLibraryPanel,
  buildCharacterLibraryHref,
  buildCharacterLibraryOpenHref,
} from "@/components/character-library-panel";
import { CharacterLibraryTrigger } from "@/components/character-library-trigger";
import { CharacterLibraryDialog } from "@/components/character-library-dialog";
import { ActionForm } from "@/components/action-form";
import { RailBusyWhileSubmitting } from "@/components/project-rail";
import { RAIL_ENTRY_CHARACTER } from "@/lib/project-rail";
import { PendingFieldset } from "@/components/pending-fieldset";
import { ReferenceDropzone } from "@/components/reference-dropzone";
import { CharacterPortraitCard } from "@/components/character-portrait-card";
import { InfoHint } from "@/components/info-hint";
import { Card, CardContent } from "@/components/ui/card";
import {
  CharacterSetupForm,
  CharacterDescriptionField,
  GenerateReferenceAction,
  SaveButton,
} from "@/components/character-setup-form";
import { SetupLockBanner } from "@/components/setup-lock-banner";
import { isEditable } from "@/lib/editable-guard";
import { assertHasCharacter } from "@/lib/compile-guard";
import { isDev } from "@/lib/mode";
import { MockModeBanner } from "@/components/mock-mode-banner";
import { estimatedRefFrameCostUsd, parseCompilerModel, applySceneCostUsd } from "@/lib/models";
import { isDescriptionStale } from "@/lib/description-staleness";
import { parsePage } from "@/lib/pagination";
import { sanitizeSearchTerm } from "@/lib/search-term";
import { fetchCharacterLibraryPage } from "@/lib/character-library-query";
import { signCharacterThumbnails } from "@/lib/character-thumbnails";
import { RenderTimer } from "@/lib/perf-log";

// Peek vs browse, same split /library uses for this same table — see
// lib/character-library-query.ts, shared by both.
const LIBRARY_PEEK_COUNT = 12;
const LIBRARY_BROWSE_PAGE_SIZE = 24;

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

// docs/architecture.md § "User flow" step 2: persona description or
// reference photo, ~$0.02. This page used to be the whole of Step 2 plus
// Product and Script — it now covers only the character reference/
// description half; Product and Script are their own routes
// (/product, /script), and Direction/Captions/render settings live on
// /settings. See actions/setup.ts's header for why the write split the
// same way the page did.

export default async function CharacterPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; page?: string | string[]; library?: string | string[] }>;
}): Promise<JSX.Element> {
  const { id } = await params;

  const timer = new RenderTimer("/projects/[id]/character");

  const { user, project, profile, isOwner } = await timer.step(
    "require_project",
    requireProjectReadable(id),
  );
  // Every admin-only write below (upload/regenerate character reference)
  // must ALSO require ownership now that requireProjectReadable lets a
  // non-owner admin reach this page at all.
  const admin = isAdmin(profile) && isOwner;
  const supabase = await createClient();

  const resolvedSearchParams = await searchParams;
  const libraryQ = sanitizeSearchTerm(resolvedSearchParams.q ?? "");
  const libraryBrowsing = resolvedSearchParams.page !== undefined || libraryQ.length > 0;
  const libraryRequestedPage = parsePage(resolvedSearchParams.page);
  const libraryPageSize = libraryBrowsing ? LIBRARY_BROWSE_PAGE_SIZE : LIBRARY_PEEK_COUNT;
  const libraryOpen = resolvedSearchParams.library !== undefined;

  const [
    { data: characterAsset },
    { data: sceneStatuses },
    libraryPage,
    { data: sourceCharacter },
  ] = await Promise.all([
    timer.step(
      "character_asset_query",
      Promise.resolve(
        supabase
          .from("assets")
          .select("storage_key, created_at")
          .eq("project_id", id)
          .eq("kind", "character_ref")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    ),
    timer.step(
      "scene_statuses_query",
      Promise.resolve(supabase.from("scenes").select("status").eq("project_id", id)),
    ),
    timer.step(
      "library_page_query",
      fetchCharacterLibraryPage(supabase, {
        q: libraryQ,
        browsing: libraryBrowsing,
        requestedPage: libraryRequestedPage,
        peekCount: LIBRARY_PEEK_COUNT,
        pageSize: libraryPageSize,
      }),
    ),
    timer.step(
      "source_character_query",
      Promise.resolve(
        project.source_character_id
          ? supabase
              .from("characters")
              .select("name")
              .eq("id", project.source_character_id)
              .maybeSingle()
          : supabase.from("characters").select("name").limit(0).maybeSingle(),
      ),
    ),
  ]);

  const {
    rows: libraryCharacters,
    totalCount: libraryTotalCount,
    totalPages: libraryTotalPages,
  } = libraryPage;

  if (libraryBrowsing && libraryRequestedPage > libraryTotalPages && libraryTotalCount > 0) {
    redirect(buildCharacterLibraryHref(id, libraryQ, libraryTotalPages));
  }

  const locked = project.status === "delivered";
  const hasCommittedScenes = (sceneStatuses ?? []).some((scene) => !isEditable(scene.status));
  const fieldsLocked = locked || !isOwner;

  const improveDescriptionCostUsd = applySceneCostUsd(parseCompilerModel(project.render_settings));

  const portraitStale = isDescriptionStale(
    project.character_desc_edited_at,
    characterAsset?.created_at ?? null,
  );

  const signOrNull = (key: string, size: ImageSize): Promise<string | null> =>
    getImageUrl(key, size).catch(
      (reason: unknown) => {
        console.warn(`character page: could not sign ${key}`, reason);
        return null;
      },
    );

  const libraryCharacterIds = libraryCharacters.map((character) => character.id);

  const [characterImageUrl, libraryImageUrls, { data: libraryUsageRows }] = await Promise.all([
    timer.step(
      "character_image_signing",
      characterAsset ? signOrNull(characterAsset.storage_key, "medium") : Promise.resolve(null),
    ),
    timer.step(
      "library_thumbnail_signing",
      signCharacterThumbnails(libraryCharacters, "character setup: library grid"),
    ),
    // "in use in N projects" per library card — the design's fastest read on
    // which saved character actually works. One query for the whole grid, not
    // one per card: at most LIBRARY_BROWSE_PAGE_SIZE ids go in and the tally
    // is done below.
    //
    // Counts only what THIS VIEWER can select from `projects` — under
    // 0002_rls.sql's projects_select that is their own projects, or every
    // project for an admin. And source_character_id is a CURRENT label,
    // blanked when the description is edited (actions/setup.ts) or the photo
    // removed — so this is "in use in", never "has ever been used in", and
    // the card's wording says exactly that.
    timer.step(
      "library_usage_query",
      Promise.resolve(
        libraryCharacterIds.length > 0
          ? supabase
              .from("projects")
              .select("source_character_id")
              .in("source_character_id", libraryCharacterIds)
          : { data: [] as { source_character_id: string | null }[] },
      ),
    ),
  ]);

  const libraryUsageCounts: Record<string, number> = {};
  for (const row of libraryUsageRows ?? []) {
    const characterId = row.source_character_id;
    if (!characterId) continue;
    libraryUsageCounts[characterId] = (libraryUsageCounts[characterId] ?? 0) + 1;
  }

  timer.finish({ userId: user.id });

  let characterMessage: string | null = null;
  try {
    assertHasCharacter(!!project.character_desc?.trim(), !!characterImageUrl);
  } catch (err) {
    characterMessage = err instanceof Error ? err.message : "Add a character before compiling.";
  }

  const hasCharacter = !!characterImageUrl || !!project.character_desc?.trim();

  const imagesAreMocked = isDev();

  const libraryPanel = (
    <CharacterLibraryPanel
      projectId={id}
      q={libraryQ}
      totalCount={libraryTotalCount}
      characters={libraryCharacters}
      imageUrls={libraryImageUrls}
      browsing={libraryBrowsing}
      requestedPage={libraryRequestedPage}
      totalPages={libraryTotalPages}
      peekCount={LIBRARY_PEEK_COUNT}
      sourceCharacterId={project.source_character_id}
      projectHasDescription={!!project.character_desc?.trim()}
      fieldsLocked={fieldsLocked}
      usageCounts={libraryUsageCounts}
      canCreate={admin}
      closeHref={`/projects/${id}/character`}
    />
  );

  const libraryEntryPoint =
    libraryTotalCount === 0 && !libraryQ ? (
      <p className="text-sm text-muted-foreground">
        {admin ? (
          <>
            No characters in the library yet — add one on the{" "}
            <a href="/library" className="font-medium text-foreground underline">
              Character Library
            </a>{" "}
            page.
          </>
        ) : (
          "No characters in the library yet — ask an admin to add one."
        )}
      </p>
    ) : (
      <CharacterLibraryTrigger
        href={buildCharacterLibraryOpenHref(id)}
        count={libraryTotalCount}
        inUseName={sourceCharacter?.name ?? null}
      />
    );

  // Always visible, never behind a disclosure. Upload is one of the three
  // ways a character gets onto this project (library pick, upload, generate
  // from the description) and the design puts it on the surface beside the
  // photo it replaces rather than inside a collapsed "Change character".
  const uploadOption = (
    <div className="flex flex-col gap-3">
      {admin ? (
        <>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-foreground">
              {characterImageUrl ? "Upload a different photo" : "Upload a reference photo"}
            </p>
            <InfoHint>
              {characterImageUrl
                ? "A real photo of the person who should appear in every scene. Uploading replaces the photo above."
                : "A real photo of the person who should appear in every scene."}
            </InfoHint>
          </div>
          <ActionForm
            action={uploadCharacterRef.bind(null, id)}
            fallbackErrorMessage="Failed to upload character reference."
          >
            {/* A phone photo over a slow connection is seconds of upload
                plus a storage write. Same reason as the generate form
                below it. */}
            <RailBusyWhileSubmitting entryId={RAIL_ENTRY_CHARACTER} />
            <PendingFieldset>
              <ReferenceDropzone name="file" disabled={fieldsLocked} />
            </PendingFieldset>
          </ActionForm>
        </>
      ) : (
        // Not a styled placeholder pretending to be a control: uploading and
        // generating a character photo are admin-only in the server actions
        // themselves (uploadCharacterRef and regenerateCharacter both call
        // isAdmin, actions/character.ts), so offering the button to anyone
        // else would only produce a refusal on click. What a non-admin owner
        // needs is the route that IS open to them, which is the library.
        <p className="text-xs text-muted-foreground">
          Uploading or generating a character photo is admin-only. Pick one from the Character
          Library instead, or ask an admin to add one there.
        </p>
      )}
    </div>
  );

  const regenerateCostLabel = usdFormatter.format(estimatedRefFrameCostUsd());

  const generateFromDescription = characterImageUrl ? (
    <p className="text-xs text-muted-foreground">
      No generate button here — a reference photo is already set. Remove it first if you want to
      generate a new one from this description instead.
    </p>
  ) : admin ? (
    <GenerateReferenceAction
      action={regenerateCharacter.bind(null, id)}
      saveAction={saveCharacter.bind(null, id)}
      label={`Generate reference image (${regenerateCostLabel})`}
      dirtyLabel={`Save & generate (${regenerateCostLabel})`}
      pendingLabel="Generating…"
      fallbackErrorMessage="Failed to generate reference image."
      locked={locked}
      hasSavedDescription={Boolean(project.character_desc)}
    />
  ) : // Deliberately nothing. The upload block below already says
  // "Uploading or generating a character photo is admin-only. Pick one from
  // the Character Library instead" — one sentence covering both verbs. This
  // used to say the same thing again a few lines above it, so a non-admin
  // met the identical refusal twice on one screen, which reads as two
  // separate walls rather than one rule.
  null;

  // The one description column, shared by the two states this screen has —
  // it used to be built twice, once beside the portrait and once as the
  // empty state's third option, and the two had already drifted (only one
  // of them ever showed the staleness flag).
  const descriptionField = (
    <CharacterDescriptionField
      initialValue={project.character_desc ?? ""}
      locked={fieldsLocked}
      projectId={id}
      improveCostUsd={improveDescriptionCostUsd}
    />
  );

  /* The shortcut, above both steps rather than beside "Rewrite my words".
     Using a saved character copies its description AND its photo, so it
     answers steps 1 and 2 in one click — sitting in the middle of step 1 it
     read as a third way to edit the text. */
  const libraryShortcut = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">
        Used this person before? Picking them fills in both steps below.
      </p>
      {libraryEntryPoint}
    </div>
  );

  /* Two ways to get a photo, named as two ways and numbered as one step.
     The operator's question, asked in those words, was "do I need to
     upload? or take from library? or what is generate?" — three controls
     sat at the same level with nothing saying they were alternatives, and
     the library one is not even part of this step (it fills BOTH steps at
     once, which is why it now sits above them as a shortcut). */
  const photoStep = (
    <div className="flex flex-col gap-4 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center gap-x-2">
        <p className="text-sm font-medium text-foreground">2. Add a photo of them</p>
        <InfoHint>
          Every scene is generated from this photo, so the same person appears in all of them. Pick
          either way below — the description stays, and it is the part the compiler reads.
        </InfoHint>
        <span className="text-xs text-muted-foreground">pick one</span>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-foreground">Make one from your description</p>
        {generateFromDescription}
      </div>

      <div className="flex items-center gap-3" role="separator" aria-orientation="horizontal">
        <span className="h-px flex-1 bg-border" aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          or
        </span>
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>

      {uploadOption}
    </div>
  );

  const descriptionColumn = (
    <div className="flex flex-col gap-3">
      <CharacterDescriptionField
        initialValue={project.character_desc ?? ""}
        locked={fieldsLocked}
        projectId={id}
        improveCostUsd={improveDescriptionCostUsd}
      />
      {generateFromDescription}
    </div>
  );

  /* The staleness flag is drawn ON THE PORTRAIT — dimmed image, warning
     outline, the words on the card, and the regenerate button in the same
     card. It used to be a banner inside the description block saying "the
     portrait below was generated…", which pointed in the wrong direction
     once the two sat side by side and put the warning in a different block
     from the only control that answers it.
     The app never regenerates on its own: this costs money, and the design
     is explicit that the app says the photo is stale and the operator
     decides whether to spend. */
  const portraitCard = characterImageUrl ? (
    <CharacterPortraitCard
      imageUrl={characterImageUrl}
      stale={portraitStale}
      admin={admin}
      fieldsLocked={fieldsLocked}
      regenerateDisabled={locked || !project.character_desc}
      costLabel={regenerateCostLabel}
      libraryCharacterName={sourceCharacter?.name ?? null}
      removeDescription={
        project.character_desc
          ? `If it was generated from the description beside it, regenerating it costs ${regenerateCostLabel} again.`
          : "You'll need to upload or describe a character again before compiling."
      }
      removeAction={removeCharacterRef.bind(null, id)}
      regenerateAction={regenerateCharacter.bind(null, id)}
    />
  ) : (
    // Keeps the text column in place when there is no portrait yet, so the
    // description does not jump across the screen the moment one is
    // generated.
    <div aria-hidden className="hidden sm:block" />
  );

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      {/* One heading and one line of meta, and the meta states SCOPE — the
          thing an operator has to know before writing anything here is that
          this person appears in every scene, not a restatement of the
          controls below. The "UGC Pipeline" eyebrow said nothing this
          screen needed, and the project title is already in the rail
          (components/project-rail.tsx), which is on screen at the same
          time. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-2xl font-medium text-foreground">Character</h1>
        <p className="text-sm text-muted-foreground">used in every scene</p>
      </div>

      {imagesAreMocked ? (
        <MockModeBanner>
          MODE=development — the character photo shown or generated on this page is a
          placeholder image, not a real fal generation.
        </MockModeBanner>
      ) : null}

      <SetupLockBanner projectId={id} locked={locked} hasCommittedScenes={hasCommittedScenes} />

      <CharacterSetupForm
        action={saveCharacter.bind(null, id)}
        fallbackErrorMessage="Failed to save character."
        redirectOnSuccessTo={`/projects/${id}/product`}
        nextStepLabel="Product"
      >
        <Card id="setup-character" className="scroll-mt-6">
          {/* No CardTitle repeating "Character" under the h1 that already
              says it — the design's panel head is one heading and one line
              of meta, both of which are now the page header above. The
              header survives only for the required-a-character message,
              which is a real state and not a title. */}
          <CardContent className="flex flex-col gap-6">
            {/* A real STATE, not standing guidance, so it stays on the page
                instead of moving into the info hint with the explanations:
                it means this step is not done yet and the compile will
                refuse. assertHasCharacter is the same guard the compile
                itself runs, so what is said here cannot drift from what
                actually blocks. */}
            {characterMessage ? (
              <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                {characterMessage}
              </p>
            ) : null}
            {fieldsLocked ? null : libraryShortcut}
            {hasCharacter ? (
              <>
                {sourceCharacter ? (
                  <p className="text-sm text-muted-foreground">
                    Picked from your library as{" "}
                    <span className="font-medium text-foreground">{sourceCharacter.name}</span>. The
                    photo and description here are this project&apos;s own copy — editing them
                    doesn&apos;t change the library entry.
                  </p>
                ) : null}

                {/* Portrait and description side by side, which is the
                    design's first note on this screen and the reason it
                    gives: the compiler follows the TEXT, never the picture,
                    so the two have to be visible together or a disagreement
                    between them is invisible until it has rendered into
                    every scene. Stacked in one narrow column — which is what
                    this was — you scroll past the face before you read the
                    words describing it.
                    A fixed portrait column and a fluid text column, because
                    the text is the part that needs the room: it is the only
                    thing the compiler reads. Single column below sm, where
                    there is no width to divide. */}
                {/* The two-column grid only when there IS a portrait to
                    put in the left column. A description with the photo
                    removed used to keep the grid and fill that column with
                    an empty spacer, so the field sat marooned in the right
                    half of the card with a hole beside it. */}
                {characterImageUrl ? (
                  <>
                    <div className="flex flex-col gap-6 sm:grid sm:grid-cols-[minmax(0,11rem)_1fr] sm:items-start">
                      {portraitCard}
                      {descriptionColumn}
                    </div>
                    {uploadOption}
                  </>
                ) : (
                  <>
                    {descriptionField}
                    {photoStep}
                  </>
                )}
              </>
            ) : (
              // The description FIRST, not last. It is the text the compiler
              // reads and the only required part of this screen; it used to
              // sit below the library pick and the uploader, behind two "or"
              // dividers, which reads as the third-choice fallback for
              // someone who has neither a saved character nor a photo. The
              // library pick is now beside Improve inside this block, where
              // the design puts it, and the uploader is the alternative
              // below.
              <>
                {/* Two steps, in order, instead of two halves separated by
                    "or". The old divider read as a choice between
                    DESCRIBING and UPLOADING, which is not the choice: the
                    description is required either way (an undescribed photo
                    leaves the compiler inventing its own mismatched person).
                    The only real either/or is HOW the photo arrives, and it
                    belongs inside the photo step, not across the whole
                    card. */}
                {descriptionField}
                {photoStep}
              </>
            )}
          </CardContent>
        </Card>

        <CharacterLibraryDialog
          open={libraryOpen}
          closeHref={`/projects/${id}/character`}
          count={libraryTotalCount}
        >
          {libraryPanel}
        </CharacterLibraryDialog>

        <SaveButton locked={locked} readOnly={!isOwner} busyEntryId={RAIL_ENTRY_CHARACTER} />
      </CharacterSetupForm>
    </div>
  );
}
