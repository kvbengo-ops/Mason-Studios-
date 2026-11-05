import type { JSX } from "react";
import { isAdmin, requireUser } from "@/actions/guard";
import {
  generatePersonalImage,
  getPersonalImageDownloadUrl,
  getPersonalImageDetails,
  deletePersonalImage,
  loadPersonalImageHistory,
  loadPersonalImageAttempts,
  reconcilePersonalImageAttempt,
} from "@/actions/image-generator";
import { ImageGeneratorForm } from "@/components/image-generator-form";
import { ImageGeneratorHistory } from "@/components/image-generator-history";
import { ImageAttemptPanel } from "@/components/image-attempt-panel";
import { MockModeBanner } from "@/components/mock-mode-banner";
import { IMAGE_MODELS } from "@/lib/models";
import { isDev } from "@/lib/mode";
import { createClient } from "@/lib/supabase/server";
import { loadElementTags } from "@/lib/element-library";

// The Image Generator, owned by an ACCOUNT rather than a project
// (0085_personal_image_generator.sql).
//
// This route used to be a PICKER: generating an image needed a project,
// because cost was attributed through runs -> projects -> owner and an asset
// had nowhere else to live, so a sidebar link with no id to carry could only
// offer a list of image projects and a New button. The console itself lived at
// /images/<id>.
//
// 0085 gave `runs` and `assets` an owner column, so there is nothing left for
// the project to supply and the picker has become the console. What used to be
// two steps and a projects row per session is now a prompt box.
//
// WHAT THIS PAGE DELIBERATELY DOES NOT SHOW: images that belong to an existing
// image project. Those are still real, still charged, and still reachable —
// /images/<id> is unchanged, and /projects still links to it — but they are
// scoped to that project, and folding them into a personal list would claim an
// ownership the rows do not have (a non-owning admin can read a project's
// images; nobody but you reads your own). Two shapes, two lists, and nobody's
// history moved.
//
// ONE GUARD, NO SEAM. requireUser here and requireUser inside every action
// this page hands over — there is no permissive-door/strict-action pair to get
// wrong, which is the whole class of bug lib/guard-seam.test.ts sweeps
// /images/[id] for. The account-approval gate lives inside requireUser
// (canUseApp -> /pending), so it is enforced on the page AND independently on
// every submit.

/** The personal image generator: gallery, recovery panel and prompt bar. /image-generator and /create share it. */
export async function ImageGeneratorConsole(): Promise<JSX.Element> {
  const { user, profile } = await requireUser();
  const supabase = await createClient();
  // CONCURRENT, not one after another: each load runs its own requireUser
  // plus a query, and in sequence they added up to about a second per visit.
  // None reads another's result, and each still guards itself.
  const [history, attempts, elementTags] = await Promise.all([
    loadPersonalImageHistory(null),
    // WHAT HAPPENED TO THE LAST THING YOU ASKED FOR (0088). Read here, on the
    // server, so an operator who left mid-generation is told on arrival rather
    // than after the browser has re-asked. Own attempts only — the action
    // guards with requireUser and keys every filter on the id it returns.
    loadPersonalImageAttempts(),
    // The signed-in operator's own @tag library. Owner-only already
    // (elements.user_id, 0065_elements.sql), so this never needed a project to
    // scope it — the project console reads the same table keyed on the PROJECT
    // owner, which is the same account whenever the viewer can generate at all.
    loadElementTags(supabase, user.id),
  ]);
  // PICTURES ONLY. Read off assets.kind, never the element's category label —
  // a reference saved before 0081 is filed as "character" and is still a
  // picture, while "audio" is the only value that reliably means a sound file.
  const elements = elementTags.filter((element) => element.assetKind !== "audio");
  // A refreshed first page replaces the loaded tail when a new image arrives.
  // Include all first-page IDs so tied timestamps cannot hide an insertion.
  const historyKey = JSON.stringify([
    history.images.map((image) => image.assetId),
    history.nextCursor,
  ]);

  return (
    // THE GALLERY IS THE PAGE. A centred max-w column with a form card above a
    // list of thumbnails made the pictures the smallest thing on a screen that
    // exists to look at pictures. Now the wall of images fills the width and
    // the controls float over it: the prompt bar sticks to the bottom of
    // <main>'s scroll (components/image-generator-form.tsx), so generating
    // never means scrolling back up.
    <>
      {isDev() ? (
        <div className="px-4 pt-4">
          <MockModeBanner>
            Development mode — Generate returns a placeholder image. No vendor charge.
          </MockModeBanner>
        </div>
      ) : null}

      <ImageAttemptPanel initialAttempts={attempts} reconcileAction={reconcilePersonalImageAttempt}>
        <ImageGeneratorHistory
          key={historyKey}
          initialPage={history}
          loadMoreAction={loadPersonalImageHistory}
          downloadAction={getPersonalImageDownloadUrl}
          deleteAction={deletePersonalImage}
          detailsAction={getPersonalImageDetails}
          elements={elements}
        />

        <ImageGeneratorForm
          action={generatePersonalImage}
          models={IMAGE_MODELS}
          displayUnit={isAdmin(profile) ? "dual" : "credits"}
          // Nothing to lock. `delivered` is a state a PROJECT reaches, and there
          // is no project here; an account is never done generating.
          disabledReason={null}
          // Element actions accept either the owning project or the signed-in
          // account, so this picker also works on the projectless generator.
          projectId={null}
          elements={elements}
          waitAction={reconcilePersonalImageAttempt}
        />
      </ImageAttemptPanel>
    </>
  );
}
