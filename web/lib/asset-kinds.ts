// Which assets.kind values are a PICTURE.
//
// This lived in lib/bin-thumbnails.ts until 0093_video_reference_elements.sql,
// where its own comment promised something that stopped being true: "used only
// to pick a scene's thumbnail — a wider or narrower list here changes what a
// card shows, never what an asset IS." Three callers read it now, and only one
// of them is cosmetic:
//
//   1. pickSceneThumbnailSource       — what a /bin card shows. Cosmetic.
//   2. firstTaggedImageElementId      — which @tagged element becomes a clip's
//                                       conditioning frame. A render decision.
//   3. attachSceneReferences          — which @tagged element earns a
//                                       scene_references row, and so which
//                                       signed URL the worker posts to kie.
//                                       A MONEY decision.
//
// So widening this set to make some card render a nicer picture would also,
// silently, let that kind be handed to Seedance as a still frame and billed as
// a reference. It sits in its own module now precisely so that adding a member
// is a deliberate act read against all three, rather than a one-line edit in a
// file whose name says "thumbnails".
//
// Note what is ABSENT and why: 'clip' and 'final' are video, 'audio' is audio,
// and 'video_ref' (0093) is an operator-uploaded .mp4 — none is a still, and
// the last one is the reason this list had to become an allowlist at all. The
// two call sites in actions/ugc.ts previously asked `kind !== "audio"`, which
// read as an allowlist only while audio was the sole alternative.

import type { AssetKind } from "@/types/db";

export const IMAGE_ASSET_KINDS = new Set<AssetKind>([
  "character_ref",
  "product_ref",
  "composite_ref",
  "ref_frame",
  "poster",
  "generated_image",
]);
