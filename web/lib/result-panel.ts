/**
 * What the /ugc result panel shows, decided in one place.
 *
 * This exists because the ordering of these branches was a bug, twice over,
 * and the page it lives on is a server component with no test around it. The
 * panel used to ask the SCENE whether it was working before asking the shown
 * VERSION whether it had a clip — so while v2 rendered, v1's finished clip
 * showed a spinner, and reverting to a good take landed the operator on a page
 * saying "Rendering" about something that had rendered minutes earlier.
 *
 * The rule is one sentence: a version that HAS a clip can always be played.
 * The spinner belongs only to a version still waiting on the worker.
 */

export type ResultPanelState =
  /** No scene picked, or a scene with no attempts yet. */
  | { kind: "empty" }
  /** This version is the one the worker currently holds. */
  | { kind: "working"; queued: boolean }
  /** This version has a clip. `renderInFlight` says a NEWER one is rendering. */
  | { kind: "clip"; renderInFlight: boolean; queued: boolean }
  /** This version finished without producing one. */
  | { kind: "failed" };

export function resultPanelState(input: {
  hasClip: boolean;
  hasVersion: boolean;
  status: string | null;
}): ResultPanelState {
  const queued = input.status === "queued";
  const working = queued || input.status === "rendering";

  // The clip wins over the status. This is the whole fix.
  if (input.hasClip) return { kind: "clip", renderInFlight: working, queued };
  if (working) return { kind: "working", queued };
  if (input.hasVersion) return { kind: "failed" };
  return { kind: "empty" };
}

/**
 * Which version the worker is holding, if any.
 *
 * `scenes.status` is scene-level — it says a render is in flight but not which
 * attempt it belongs to. The rail needs the version, or it labels the one being
 * rendered "no clip", which is the sentence it uses for an attempt that failed
 * and came back empty. Those are opposite facts wearing the same words.
 *
 * The in-flight attempt is the NEWEST version with no clip. If the newest one
 * already has a clip, the row and the status disagree — a callback that landed
 * between the two reads — and the honest answer is null rather than a guess
 * that would pin "rendering" on a finished take.
 */
export function workingVersionId(
  versions: readonly { id: string; n: number; clipAssetId: string | null }[],
  status: string | null,
): string | null {
  if (status !== "queued" && status !== "rendering") return null;

  let newest: { id: string; n: number; clipAssetId: string | null } | undefined;
  for (const version of versions) {
    if (!newest || version.n > newest.n) newest = version;
  }
  return newest && newest.clipAssetId === null ? newest.id : null;
}
