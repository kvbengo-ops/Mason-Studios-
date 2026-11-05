/**
 * "Iterate" in the video viewer refills the prompt bar with an earlier take:
 * its prompt, its References box, and the model and length it used. The viewer
 * and the bar share no parent on /create, so this is a window event — the
 * video twin of lib/image-reuse.ts.
 */
export const VIDEO_ITERATE_EVENT = "video-iterate";

export interface VideoIterateDetail {
  prompt: string;
  /** The scene's saved References box, in order. Empty for Kling scenes. */
  referenceTags: string[];
  modelId: string | null;
  resolution: string | null;
  durationS: number | null;
}

export function requestVideoIterate(detail: VideoIterateDetail): void {
  window.dispatchEvent(new CustomEvent<VideoIterateDetail>(VIDEO_ITERATE_EVENT, { detail }));
}
