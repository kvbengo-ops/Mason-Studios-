// Gate 2 — reference frame review (docs/architecture.md § "User flow" step
// 6: "REVIEW FRAMES — operator regenerates bad ones — GATE — $0.02 each").
// Resolves every scene's reference frame to a signed URL server-side, then
// hands the grid to the client for fast per-scene editing/regeneration.

import type { JSX } from "react";
import { estimatedRefFrameCostUsd } from "@/lib/models";
import Link from "next/link";
import { requireProjectReadable } from "@/actions/guard";
import { approveFrames } from "@/actions/frames";
import { createClient } from "@/lib/supabase/server";
import { signedUrl, getImageUrl } from "@/lib/storage";
import { FrameGrid, type FrameGridScene } from "@/components/frame-grid";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { MockModeBanner } from "@/components/mock-mode-banner";
import { isEditable } from "@/lib/editable-guard";
import { isDev } from "@/lib/mode";

export default async function FramesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  const { project, isOwner } = await requireProjectReadable(id);

  const supabase = await createClient();
  const { data: scenes, error } = await supabase
    .from("scenes")
    .select("id, idx, video_prompt, is_talking_head, status, ref_frame_asset_id")
    .eq("project_id", id)
    .order("idx", { ascending: true });

  if (error) {
    throw new Error(`Failed to load scenes for project ${id}: ${error.message}`);
  }

  const assetIds = (scenes ?? [])
    .map((scene) => scene.ref_frame_asset_id)
    .filter((assetId): assetId is string => assetId !== null);

  const { data: assets, error: assetsError } =
    assetIds.length > 0
      ? await supabase.from("assets").select("id, storage_key").in("id", assetIds)
      : { data: [], error: null };

  if (assetsError) {
    throw new Error(
      `Failed to load reference frame assets for project ${id}: ${assetsError.message}`,
    );
  }

  const storageKeyByAssetId = new Map((assets ?? []).map((asset) => [asset.id, asset.storage_key]));

  const frameScenes: FrameGridScene[] = await Promise.all(
    (scenes ?? []).map(async (scene) => {
      const storageKey = scene.ref_frame_asset_id
        ? storageKeyByAssetId.get(scene.ref_frame_asset_id)
        : undefined;
      // Two signed URLs per frame, not one: `imageUrl` is the 1280px "medium"
      // copy the grid paints, and `originalImageUrl` is the untouched source the
      // grid links out to, so an operator judges a generation on its real bytes
      // before rejecting it. This is a GATE screen (see this file's header).
      //
      // width:640 — the grid (components/frame-grid.tsx) is grid-cols-1
      // sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 inside app-layout's
      // max-w-6xl shell, and the WIDEST box turns out to be the
      // single-column mobile layout (~303px CSS-wide on a 375px viewport),
      // not the 4-up desktop one (~240px once the container maxes out) —
      // adding columns on a wider screen shrinks each card faster than the
      // container grows. 640 covers that 303px box at just over DPR2
      // (606px needed); DPR3 phones (909px) would cost roughly 50% more
      // bytes for a difference that's hard to see on a card this size.
      const [imageUrl, originalImageUrl] = storageKey
        ? await Promise.all([
            getImageUrl(storageKey, "medium"),
            signedUrl(storageKey),
          ])
        : [null, null];

      return {
        id: scene.id,
        idx: scene.idx,
        video_prompt: scene.video_prompt,
        is_talking_head: scene.is_talking_head,
        status: scene.status,
        imageUrl,
        originalImageUrl,
      };
    }),
  );

  const allFramed = frameScenes.length > 0 && frameScenes.every((scene) => scene.imageUrl !== null);

  // Same rule as the Brief gate's Approve button: a locked step must not
  // keep offering its forward action. FrameGrid already greys each row once
  // its scene leaves draft/frame_ready, and leaving "Continue to render"
  // live under it invites the operator back into a gate that has already
  // been passed and paid for.
  const framesLocked = frameScenes.some((scene) => !isEditable(scene.status));

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-medium text-foreground">{project.title}</h1>
        <p className="text-sm text-muted-foreground">Review frames</p>
      </div>

      {isDev() ? (
        <MockModeBanner>
          MODE=development — every reference frame below is a placeholder image, not a real fal
          generation. Regenerating a frame will still return the same placeholder.
        </MockModeBanner>
      ) : null}

      {frameScenes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No scenes yet — go back to Review Brief to compile scenes first.
        </p>
      ) : (
        <FrameGrid
          refFrameCostUsd={estimatedRefFrameCostUsd()}
          projectId={id}
          initialScenes={frameScenes}
          readOnly={!isOwner}
        />
      )}

      {isOwner && allFramed && !framesLocked && (
        <div className="flex justify-end">
          <ActionForm
            action={approveFrames.bind(null, id)}
            fallbackErrorMessage="Failed to continue to render."
          >
            <SubmitButton size="lg" pendingLabel="Continuing…">
              Continue to render →
            </SubmitButton>
          </ActionForm>
        </div>
      )}

      {framesLocked ? (
        <p className="text-right text-sm text-muted-foreground">
          {/* An actual link, not just text naming the step: step-rail.tsx
              now marks Render reachable whenever any scene has left
              draft/frame_ready (see its deriveReachedSteps-backed doc
              comment), but this locked screen has no forward action of its
              own once framesLocked is true, and used to leave the operator
              with no in-app way there at all — the audit for this
              regression called that out by name. */}
          Rendering has started — these frames are locked. Follow the render on the{" "}
          <Link
            href={`/projects/${id}/render`}
            className="font-medium text-accent-foreground underline-offset-4 hover:underline"
          >
            Render step
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
