// Pure checks for the Review Brief gate (docs/architecture.md § "User flow"
// step 4). Pulled out of actions/brief.ts (a "use server" file, where every
// export must be an async Server Action) so this stays a plain, synchronous,
// unit-testable function, mirroring lib/enqueue-guard.ts.

/**
 * Throws unless every scene has both a script line and a video prompt.
 * approveBrief already refuses an empty scene *list* and any scene past
 * draft/frame_ready, but neither of those catches a scene that exists,
 * is editable, and is simply blank — split/addScene can leave one behind,
 * and Apply can be skipped entirely. An empty prompt survives the brief
 * gate silently and only fails later, at the render gate
 * (actions/frames.ts's generateSceneFrame throws on it) — after the
 * operator has already passed Review Frames believing the brief was sound.
 * Scene numbers are 1-based (`idx + 1`) to match what the Scene table
 * shows the operator, not the zero-based array position.
 */
export function assertScenesComplete(
  scenes: readonly { idx: number; script_line: string | null; video_prompt: string | null }[],
): void {
  const incomplete = scenes.filter(
    (scene) => !scene.script_line?.trim() || !scene.video_prompt?.trim(),
  );
  if (incomplete.length > 0) {
    const numbers = incomplete
      .map((scene) => scene.idx + 1)
      .sort((a, b) => a - b)
      .join(", ");
    throw new Error(
      `${incomplete.length} of ${scenes.length} scene(s) are missing a script line or video ` +
        `prompt (scene${incomplete.length > 1 ? "s" : ""} ${numbers}) — fill in both before ` +
        "approving the brief.",
    );
  }
}
