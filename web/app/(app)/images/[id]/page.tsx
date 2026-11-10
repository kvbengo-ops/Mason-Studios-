import type { JSX } from "react";
import { z } from "zod";
import { requireProjectReadable } from "@/actions/guard";
import { generateProjectImage, getProjectImageDetails } from "@/actions/image-generator";
import { ImageGeneratorForm } from "@/components/image-generator-form";
import { ImageGeneratorHistory } from "@/components/image-generator-history";
import type { ImageHistoryCursor, ImageHistoryPage } from "@/components/image-generator-history";
import { MockModeBanner } from "@/components/mock-mode-banner";
import { UgcTitle } from "@/components/ugc-title";
import { IMAGE_MODELS } from "@/lib/models";
import { isDev } from "@/lib/mode";
import { signedUrl } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";
import { loadElementTags } from "@/lib/element-library";

const HISTORY_PAGE_SIZE = 20;
const assetIdSchema = z.string().uuid();
const historyCursorSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    assetId: assetIdSchema,
  })
  .nullable();

// Read-only actions stay with this page: both initial rendering and later
// requests admit a non-owning admin through the same readable guard.
async function loadImageHistory(
  projectId: string,
  cursor: ImageHistoryCursor | null,
): Promise<ImageHistoryPage> {
  "use server";
  await requireProjectReadable(projectId);

  // .or() accepts raw PostgREST syntax. Validate both values before using
  // them in the filter, and retain timestamp microseconds instead of passing
  // through Date.toISOString(), which would truncate the pagination boundary.
  const parsedCursor = historyCursorSchema.safeParse(cursor);
  if (!parsedCursor.success) throw new Error("Invalid image history cursor.");

  const supabase = await createClient();
  let query = supabase
    .from("assets")
    .select("id, created_at, storage_key")
    .eq("project_id", projectId)
    .eq("kind", "generated_image")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    // One lookahead row tells us whether Load More has anything to fetch.
    // Only the first 20 are signed and returned to the UI.
    .limit(HISTORY_PAGE_SIZE + 1);

  if (parsedCursor.data) {
    const { createdAt, assetId } = parsedCursor.data;
    query = query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${assetId})`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load image history: ${error.message}`);

  const rows = data ?? [];
  const pageRows = rows.slice(0, HISTORY_PAGE_SIZE);
  const lastRow = pageRows.at(-1);
  const images = await Promise.all(
    pageRows.map(async (asset) => ({
      assetId: asset.id,
      createdAt: asset.created_at,
      // THE ORIGINAL, no transform. Supabase's resize does not keep a picture's
      // shape — "cover" crops (a landscape portrait-cropped to a face) and
      // "contain" pads with white — and the wall's whole job is to show each
      // picture's real shape, which it reads off the loaded image itself.
      url: await signedUrl(asset.storage_key),
    })),
  );

  return {
    images,
    nextCursor:
      rows.length > HISTORY_PAGE_SIZE && lastRow
        ? { createdAt: lastRow.created_at, assetId: lastRow.id }
        : null,
  };
}

async function getImageDownloadUrl(projectId: string, assetId: string): Promise<string> {
  "use server";
  await requireProjectReadable(projectId);

  const parsedId = assetIdSchema.safeParse(assetId);
  if (!parsedId.success) throw new Error("Invalid generated image.");

  const supabase = await createClient();
  const { data: asset, error } = await supabase
    .from("assets")
    .select("storage_key")
    .eq("project_id", projectId)
    .eq("kind", "generated_image")
    .eq("id", parsedId.data)
    .maybeSingle();

  if (error) throw new Error(`Failed to load generated image: ${error.message}`);
  if (!asset) throw new Error("This generated image is no longer available.");

  // Sign on click, without the thumbnail transform. The preview URL may be
  // old; the download must request original bytes with attachment disposition.
  return signedUrl(asset.storage_key, undefined, true);
}

export default async function ImageGeneratorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  const { project, isOwner } = await requireProjectReadable(id);
  const history = await loadImageHistory(id, null);

  // The PROJECT OWNER's @tag library, not the viewer's — see loadElementTags.
  // This is what makes tagging possible at all: the picker inside the prompt
  // box uploads into this same library (registerElement), so a reference
  // created here is immediately taggable here.
  const supabase = await createClient();
  // PICTURES ONLY. Read off assets.kind, never the element's category label —
  // a reference saved before 0081 is filed as "character" and is still a
  // picture, while "audio" is the only value that reliably means a sound file.
  //
  // Filtered here rather than only in the picker so the @ MENU cannot offer one
  // either: a voice clip that autocompletes in the prompt but is dropped
  // server-side is worse than one that was never offered — it looks like it
  // worked. The server drops audio refs regardless; this is what stops the
  // operator being invited to add one.
  const elements = (await loadElementTags(supabase, project.user_id)).filter(
    (element) => element.assetKind !== "audio",
  );
  // A refreshed first page replaces the loaded tail when a new image arrives.
  // Include all first-page IDs so tied timestamps cannot hide an insertion.
  const historyKey = JSON.stringify([
    id,
    history.images.map((image) => image.assetId),
    history.nextCursor,
  ]);

  const disabledReason = !isOwner
    ? "Only the project owner can generate images. You are viewing this project in read-only mode."
    : project.status === "delivered"
      ? "This project has been delivered. Reopen it before generating images."
      : null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        {/* Reused from /ugc despite the name: it is a generic project-title
            editor — projectId, title, readOnly — and calls saveTitle, which
            goes through updateProject and is not /ugc-specific. Renaming the
            component would touch the clip console for a cosmetic gain, so the
            odd name stays and this comment explains it.

            readOnly mirrors what the server would do anyway: saveTitle guards
            with the strict requireProject and refuses a non-owning admin, so
            this stops the page offering a control that could only fail. */}
        <UgcTitle projectId={id} title={project.title} readOnly={!isOwner} />
        <p className="text-sm text-muted-foreground">Image generator</p>
        <p className="text-sm text-muted-foreground">
          Describe the image you want to create. Output is 9:16 only.
        </p>
      </div>

      {isDev() ? (
        <MockModeBanner>
          Development mode — Generate returns a placeholder image. No vendor charge.
        </MockModeBanner>
      ) : null}

      <ImageGeneratorForm
        key={id}
        action={generateProjectImage.bind(null, id)}
        // .bind, never awaited here — this page uses the READABLE guard and
        // both actions use the strict one. See lib/guard-seam.test.ts.
        models={IMAGE_MODELS}
        disabledReason={disabledReason}
        projectId={id}
        elements={elements}
      />

      <ImageGeneratorHistory
        key={historyKey}
        initialPage={history}
        loadMoreAction={loadImageHistory.bind(null, id)}
        downloadAction={getImageDownloadUrl.bind(null, id)}
        detailsAction={getProjectImageDetails.bind(null, id)}
        elements={elements}
      />
    </div>
  );
}
