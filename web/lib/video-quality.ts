/**
 * The editor's per-clip re-encode quality on /ugc, stored as `quality` in the scene's
 * render_settings_override. The worker maps it to x264 CRF (worker/internal/media
 * CRFFor: standard 20, high 17, max 14). No vendor sees it and no price changes; it
 * only trades file size for bitrate in our own re-encode.
 */
export const VIDEO_QUALITIES = ["standard", "high", "max"] as const;
export type VideoQuality = (typeof VIDEO_QUALITIES)[number];

export const DEFAULT_VIDEO_QUALITY: VideoQuality = "high";

export const VIDEO_QUALITY_LABELS: Readonly<Record<VideoQuality, { label: string; hint: string }>> =
  {
    standard: { label: "Standard", hint: "Smallest file" },
    high: { label: "High", hint: "Higher bitrate" },
    max: { label: "Max", hint: "Highest bitrate, largest file" },
  };

/** The value if it is a known quality, else null. */
export function videoQualityFor(value: unknown): VideoQuality | null {
  return (VIDEO_QUALITIES as readonly unknown[]).includes(value) ? (value as VideoQuality) : null;
}
