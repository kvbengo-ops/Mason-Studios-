"use client";

// "New clip" — the entry to /ugc.
//
// A form rather than a <Link>, because it writes: /ugc needs a project id in
// its path, and this is what creates the project it then opens. A GET that
// inserts a row would fire on a link prefetch and leave empty projects behind
// every time someone hovered the button.

import type { JSX } from "react";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { createClipProject } from "@/actions/ugc";

export function NewClipButton(): JSX.Element {
  return (
    <ActionForm action={createClipProject} fallbackErrorMessage="Could not start a clip project.">
      {/* createClipProject redirects, so its promise never resolves on the
          happy path. ActionForm's unstable_rethrow is what keeps that from
          surfacing as an error toast. */}
      {/* "New video project" rather than the bare "New project": image
          generation is a sidebar console (/image-generator), not a project, so
          the noun says which of the two surfaces this button feeds. The
          COMPONENT keeps its name, which describes what it writes — a clip
          project — and clip and scripted are both video. */}
      <SubmitButton pendingLabel="Starting">New video project</SubmitButton>
    </ActionForm>
  );
}
