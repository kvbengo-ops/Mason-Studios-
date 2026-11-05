// Pure builder for the Deliver-step manifest (docs/architecture.md §
// "User flow" step 9: "Deliver clips + manifest, or assembled mp4"). Kept
// separate from actions/deliver.ts — a "use server" file where every export
// must be an async Server Action — so the ordering/shape logic stays a
// plain, synchronous, unit-testable function, mirroring lib/enqueue-guard.ts
// and lib/recompile-guard.ts.
//
// This is deliberately NOT an assembly step. It describes the clips an
// editor already has (or is about to download) and the order they go in —
// it does not touch ffmpeg, and it never will from this file.

export interface ManifestSceneInput {
  idx: number;
  script_line: string | null;
  video_prompt: string | null;
  is_talking_head: boolean;
  duration_s: number;
  filename: string;
  signed_url: string;
}

export interface ManifestScene {
  // A human reads this file — it is what carries the pronunciation guide and
  // the shot list over to CapCut — so it leads with the number that human
  // sees everywhere else: `scene_number` is 1-based and always agrees with
  // `filename` (scene 4 is scene-04.mp4) and with every screen in the app,
  // all of which render `scene.idx + 1`. `idx` is kept alongside it as the
  // raw 0-based `scenes.idx` column, because sort order and any future
  // machine consumer should key on the database's own value rather than a
  // presentation number. Do not "tidy" these into one field: they answer
  // different questions, and the mismatch between them is exactly what made
  // "re-render scene 4" hand someone scene-03.mp4.
  scene_number: number;
  idx: number;
  script_line: string | null;
  video_prompt: string | null;
  is_talking_head: boolean;
  duration_s: number;
  filename: string;
  signed_url: string;
}

export interface Manifest {
  project_title: string;
  character_description: string | null;
  scenes: ManifestScene[];
}

export interface BuildManifestArgs {
  projectTitle: string;
  characterDescription: string | null;
  scenes: readonly ManifestSceneInput[];
}

/**
 * Deterministic download filename for a scene's clip, shared between
 * actions/deliver.ts (manifest entries), the deliver page (per-clip download
 * links) and the archive route (via lib/archive.ts's buildClipEntries) so
 * none of the three ever drift apart. `storageKey` is expected to be shaped
 * `projects/{id}/{kind}/{uuid}.{ext}` (see lib/storage.ts).
 *
 * `idx` is the scene's raw (0-based) `scenes.idx` column, same as every
 * other call site in this codebase — filenameForClip is what converts it to
 * the 1-based number a human sees, the same convention lib/brief-guard.ts
 * documents and components/scene-table.tsx, frame-grid.tsx and
 * render-progress.tsx each apply inline as `scene.idx + 1`. Doing the +1
 * here, once, rather than requiring every caller to remember it, is what
 * keeps "scene 4" on screen matching `scene-04.mp4` on disk — before this,
 * the file for the operator's "scene 4" was `scene-03.mp4`, a mismatch an
 * editor could easily hand off into CapCut without noticing.
 */
export function filenameForClip(idx: number, storageKey: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(storageKey);
  const ext = match?.[1] ?? "mp4";
  return `scene-${String(idx + 1).padStart(2, "0")}.${ext}`;
}

/**
 * Builds the JSON-serialisable manifest an editor imports alongside the
 * downloaded clips so they know the intended order and what each shot is.
 * Sorts by `idx` defensively — the manifest's whole job is to record
 * ordering, so this must not trust callers to have already sorted.
 */
export function buildManifest(args: BuildManifestArgs): Manifest {
  const { projectTitle, characterDescription, scenes } = args;

  const ordered = [...scenes].sort((a, b) => a.idx - b.idx);

  return {
    project_title: projectTitle,
    character_description: characterDescription,
    scenes: ordered.map((scene) => ({
      scene_number: scene.idx + 1,
      idx: scene.idx,
      script_line: scene.script_line,
      video_prompt: scene.video_prompt,
      is_talking_head: scene.is_talking_head,
      duration_s: scene.duration_s,
      filename: scene.filename,
      signed_url: scene.signed_url,
    })),
  };
}
