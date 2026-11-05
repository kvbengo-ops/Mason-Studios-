import type { JSX } from "react";
import { requireProjectReadable } from "@/actions/guard";
import { createClient } from "@/lib/supabase/server";
import { signedUrl } from "@/lib/storage";
import {
  uploadProductRef,
  removeProductRef,
  setPrimaryProductRef,
  regenerateComposite,
  removeComposite,
} from "@/actions/character";
import { saveProduct } from "@/actions/setup";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { RailBusyWhileSubmitting } from "@/components/project-rail";
import { InfoHint } from "@/components/info-hint";
import { RAIL_ENTRY_PRODUCT } from "@/lib/project-rail";
import { UploadButton } from "@/components/upload-button";
import { RemoveReferenceButton } from "@/components/remove-reference-button";
import { CharacterThumbnail } from "@/components/character-thumbnail";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ProductSetupForm,
  ProductNameField,
  ProductAppearanceField,
  SaveButton,
} from "@/components/product-setup-form";
import { SetupLockBanner } from "@/components/setup-lock-banner";
import { isEditable } from "@/lib/editable-guard";
import { isDev } from "@/lib/mode";
import { MockModeBanner } from "@/components/mock-mode-banner";
import { estimatedRefFrameCostUsd, parseCompilerModel, applySceneCostUsd } from "@/lib/models";
import { isDescriptionStale } from "@/lib/description-staleness";
import { RenderTimer } from "@/lib/perf-log";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

// Spec §3.2's Product step: product photos (a grid, one marked primary),
// product name, product appearance text, and the generated "character with
// product" combined shot. Split out of the single Character Setup page —
// see actions/setup.ts's header for why the write split the same way.

export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;

  const timer = new RenderTimer("/projects/[id]/product");

  const { user, project, isOwner } = await timer.step(
    "require_project",
    requireProjectReadable(id),
  );
  const supabase = await createClient();

  const [
    { data: characterAsset },
    { data: productAssetsRaw },
    { data: compositeAsset },
    { data: sceneStatuses },
  ] = await Promise.all([
    timer.step(
      "character_asset_query",
      Promise.resolve(
        supabase
          .from("assets")
          .select("storage_key")
          .eq("project_id", id)
          .eq("kind", "character_ref")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    ),
    // Every product photo, not just the most recent one — a grid, with
    // position 0 (0023_asset_position.sql's partial unique index) always
    // the primary.
    timer.step(
      "product_assets_query",
      Promise.resolve(
        supabase
          .from("assets")
          .select("id, storage_key, position")
          .eq("project_id", id)
          .eq("kind", "product_ref")
          .order("position", { ascending: true }),
      ),
    ),
    timer.step(
      "composite_asset_query",
      Promise.resolve(
        supabase
          .from("assets")
          .select("storage_key, created_at")
          .eq("project_id", id)
          .eq("kind", "composite_ref")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    ),
    timer.step(
      "scene_statuses_query",
      Promise.resolve(supabase.from("scenes").select("status").eq("project_id", id)),
    ),
  ]);

  const locked = project.status === "delivered";
  const hasCommittedScenes = (sceneStatuses ?? []).some((scene) => !isEditable(scene.status));
  const fieldsLocked = locked || !isOwner;

  const improveDescriptionCostUsd = applySceneCostUsd(parseCompilerModel(project.render_settings));

  const compositeStale =
    isDescriptionStale(project.character_desc_edited_at, compositeAsset?.created_at ?? null) ||
    isDescriptionStale(project.product_appearance_edited_at, compositeAsset?.created_at ?? null);

  const productAssets = productAssetsRaw ?? [];

  const signOrNull = (key: string, width: number): Promise<string | null> =>
    signedUrl(key, undefined, { width, resize: "contain", quality: 80 }).catch(
      (reason: unknown) => {
        console.warn(`product page: could not sign ${key}`, reason);
        return null;
      },
    );

  const [compositeImageUrl, productImageUrls] = await Promise.all([
    timer.step(
      "composite_image_signing",
      compositeAsset ? signOrNull(compositeAsset.storage_key, 640) : Promise.resolve(null),
    ),
    timer.step(
      "product_image_signing",
      Promise.all(productAssets.map((asset) => signOrNull(asset.storage_key, 400))),
    ),
  ]);

  timer.finish({ userId: user.id });

  const imagesAreMocked = isDev();

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          UGC Pipeline
        </p>
        <p className="text-sm text-muted-foreground">{project.title}</p>
        <h1 className="text-2xl font-medium text-foreground">Product</h1>
        {/* The design pairs each screen's title with what it feeds, so the
            operator knows which scenes this work shows up in before doing
            it. */}
        <p className="text-sm text-muted-foreground">Appears in every product-shot scene</p>
        <p className="text-sm text-muted-foreground">
          Upload the product photo(s) and describe exactly what the compiler should render.
        </p>
      </div>

      {imagesAreMocked ? (
        <MockModeBanner>
          MODE=development — the product photo and combined shot shown or generated on this page
          are placeholder images, not real fal generations.
        </MockModeBanner>
      ) : null}

      <SetupLockBanner projectId={id} locked={locked} hasCommittedScenes={hasCommittedScenes} />

      <ProductSetupForm
        action={saveProduct.bind(null, id)}
        fallbackErrorMessage="Failed to save product."
        redirectOnSuccessTo={`/projects/${id}/script`}
        nextStepLabel="Script"
      >
        <Card id="setup-product" className="scroll-mt-6">
          {/* Not "(optional)". Technically true — the page saves without a
              photo — but it is the wrong thing to say at the top of a screen
              whose whole premise is that the photo and the text have to
              agree, and it invites skipping the one input that makes
              "Describe from photo" possible. The multi-angle explanation
              went with it: the grid's own "+ Another angle" cell is the
              place that offer belongs, and what the primary photo feeds is
              now said beside the combined shot that it feeds. */}
          <CardHeader>
            <CardTitle>Product reference</CardTitle>
            <CardDescription>
              Both halves are used, for different jobs. The words are what Claude writes every scene
              prompt from. The photo is what the combined shot below is built from — and that image
              is what product scenes are actually generated from. They have to agree.
            </CardDescription>
          </CardHeader>
          {/* Photos left, words right — the design's two-column workbench,
              and the same argument it makes on the Character screen: the
              compiler reads the APPEARANCE TEXT and never the photograph, so
              the two have to sit where one glance covers both. Stacked, with
              the photos below the text, an operator writes the description
              from memory of a picture they have scrolled past. That is the
              green-pouch incident's exact shape.
              The photo column is fixed and narrow, the text column fluid:
              the text is the part that has to be read closely, and it is the
              only half the compiler ever sees. */}
          <CardContent className="flex flex-col gap-4 sm:grid sm:grid-cols-[minmax(0,13rem)_1fr] sm:items-start sm:gap-6">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-foreground">2. Product photos</p>
                <InfoHint>
                  Only the PRIMARY photo is ever sent to the image model — it is what the combined
                  character-with-product shot is built from, and that shot is what product scenes
                  are generated from. Extra angles are stored for you to look at and to swap in as
                  primary later; nothing is generated from them. Optional either way: a project with
                  no photo still renders from the appearance text beside this.
                </InfoHint>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {productAssets.map((asset, index) => {
                  const isPrimary = asset.position === 0;
                  return (
                    <div key={asset.id} className="flex flex-col gap-2">
                      <div className="relative aspect-square w-full overflow-hidden rounded-md border border-border bg-muted">
                        <CharacterThumbnail
                          url={productImageUrls[index]}
                          alt={isPrimary ? "Primary product reference" : "Product reference"}
                          className="h-full w-full"
                        />
                        {isPrimary ? (
                          <span className="absolute left-2 top-2 rounded-full bg-foreground px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-background">
                            Primary
                          </span>
                        ) : null}
                        {fieldsLocked ? null : (
                          <RemoveReferenceButton
                            label="product reference photo"
                            description={
                              isPrimary
                                ? "This is the primary photo — it feeds the combined product shot and every product-shot scene. Another photo will take its place if any remain."
                                : "You can upload another angle any time."
                            }
                            action={removeProductRef.bind(null, id, asset.id)}
                            railEntryId={RAIL_ENTRY_PRODUCT}
                          />
                        )}
                      </div>
                      {!isPrimary && !fieldsLocked ? (
                        <ActionForm
                          action={setPrimaryProductRef.bind(null, id, asset.id)}
                          fallbackErrorMessage="Failed to set primary product photo."
                        >
                          <SubmitButton
                            variant="outline"
                            size="sm"
                            className="w-full"
                            pendingLabel="Setting…"
                          >
                            Make primary
                          </SubmitButton>
                        </ActionForm>
                      ) : null}
                    </div>
                  );
                })}
                {/* The upload is a cell OF the grid, not a labelled form
                    below it: adding an angle is the same kind of thing as
                    the photos beside it, and a dashed empty slot says so
                    without a heading. It also keeps the grid the whole story
                    of the photo column, so the description in the right-hand
                    column stays level with the pictures it is supposed to be
                    describing. */}
                {fieldsLocked ? null : (
                  <ActionForm
                    action={uploadProductRef.bind(null, id)}
                    fallbackErrorMessage="Failed to upload product reference."
                    className="flex"
                  >
                    <RailBusyWhileSubmitting entryId={RAIL_ENTRY_PRODUCT} />
                    <UploadButton
                      name="file"
                      variant="ghost"
                      className="h-auto w-full whitespace-normal rounded-md border border-dashed border-border p-2 text-xs font-normal text-muted-foreground aspect-square"
                      pendingLabel="Uploading…"
                    >
                      {productAssets.length > 0 ? "+ Another angle" : "+ Product photo"}
                    </UploadButton>
                  </ActionForm>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <ProductNameField initialValue={project.product_name ?? ""} locked={fieldsLocked} />

              <ProductAppearanceField
                initialValue={project.product_appearance ?? ""}
                locked={fieldsLocked}
                projectId={id}
                describeCostUsd={improveDescriptionCostUsd}
                hasProductPhoto={productAssets.length > 0}
              />
            </div>
          </CardContent>
        </Card>

        {/* Spec §3.2: "We'll generate one combined image of the character
            holding/showing the product — that's the only product shot we
            need." Needs a character reference from the Character page, so
            this card lives here (where the product photo is, the second
            input it needs) rather than there. */}
        <Card>
          <CardHeader>
            <CardTitle>Character with product</CardTitle>
            <CardDescription>
              Once this exists, EVERY scene is generated from it — talking-head scenes included, not
              only the ones showing the product.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {compositeStale ? (
              <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
                The character or product description changed since this combined image was generated
                — it may no longer match. Regenerate below to bring them back in sync.
              </p>
            ) : null}
            {/* Picture left, what it IS on the right — the design's shape for
                this section, and the reason it has words at all: a lone
                thumbnail under a title reads as a third reference photo to
                collect, when it is actually the OUTPUT of the two above it
                and the thing scenes attach to. */}
            <div className="flex flex-col gap-4 sm:grid sm:grid-cols-[minmax(0,13rem)_1fr] sm:items-start sm:gap-6">
              <div className="flex flex-col gap-3">
                {compositeImageUrl ? (
                  <div className="relative aspect-square w-full overflow-hidden rounded-md border border-border bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element -- signed URL, not a static import */}
                    <img
                      src={compositeImageUrl}
                      alt="Character with product composite"
                      className="h-full w-full object-contain"
                      loading="lazy"
                      decoding="async"
                    />
                    {fieldsLocked ? null : (
                      <RemoveReferenceButton
                        label="character-with-product composite"
                        description="You'll need to regenerate it from the character and product references again before compiling scenes that show the product."
                        action={removeComposite.bind(null, id)}
                        railEntryId={RAIL_ENTRY_PRODUCT}
                      />
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Not generated yet. Upload a product photo above and a character reference on the{" "}
                    <a
                      href={`/projects/${id}/character`}
                      className="font-medium text-foreground underline"
                    >
                      Character
                    </a>{" "}
                    page, then generate the combined shot.
                  </p>
                )}
                {fieldsLocked ? null : (
                  <ActionForm
                    action={regenerateComposite.bind(null, id)}
                    fallbackErrorMessage="Failed to generate the combined image."
                  >
                    {/* Same reason as the Character screen's generate form:
                        a paid, multi-second call the operator can walk away
                        from. The rail is the only thing still on screen
                        once they do. */}
                    <RailBusyWhileSubmitting entryId={RAIL_ENTRY_PRODUCT} />
                    <SubmitButton
                      variant="outline"
                      size="sm"
                      pendingLabel="Generating…"
                      disabled={!characterAsset || productAssets.length === 0}
                    >
                      Regenerate Combined (
                      {usdFormatter.format(estimatedRefFrameCostUsd())})
                    </SubmitButton>
                  </ActionForm>
                )}
              </div>

              <div className="flex flex-col gap-2 text-sm text-muted-foreground">
                <p>
                  One image of the right person holding the right product, built from the character
                  reference and the primary product photo. While it exists it is the ONLY reference
                  sent for any scene — instead of two separate images the model would have to
                  reconcile itself, and instead of a talking-head scene going out with the product
                  nowhere in frame.
                </p>
                {/* The design's standing line here reads "regenerated
                    whenever the character or the product changes", which
                    would be a lie in this app: nothing regenerates it. A
                    description edit only makes it STALE — isDescriptionStale
                    above compares edit times, this page raises the banner,
                    and the operator presses the button. Saying so keeps the
                    design's point (this is a derived image with a shelf
                    life) without promising an automatic rebuild that never
                    comes, which would be the expensive kind of wrong: a
                    scene compiled against a composite of last week's
                    product. */}
                <p className="text-xs">
                  It does not rebuild itself. When the character or product description changes,
                  this card marks the image out of date and you regenerate it here.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <SaveButton locked={locked} readOnly={!isOwner} busyEntryId={RAIL_ENTRY_PRODUCT} />
      </ProductSetupForm>
    </div>
  );
}
