"use client";

// This component itself has no hooks, event handlers, or browser APIs — it
// is a pure function of props and would otherwise be a good Server
// Component candidate. It stays "use client" anyway: its only call site,
// components/scene-table.tsx, is itself a Client Component that imports
// this file directly and renders <CostBadge /> inline (not passed down as
// a server-rendered child) — confirmed empirically by removing this
// directive, rebuilding, and finding CostBadge's own strings still present
// in scene-table's client chunk regardless. A component imported straight
// into a Client Component's module graph is bundled for the client either
// way; the directive here is documentation of that fact, not something
// dropping it would fix. See docs/architecture.md's composition notes (or
// the Next.js docs on "keeping server-only code out of the client
// environment") for the general pattern: Server Components have to be
// passed down as children/props from an actual Server Component parent to
// be excluded from the client bundle, not imported by a Client Component.
//
// Live render-cost estimate for Gate 1 (docs/architecture.md § "Cost
// model"). Must react the instant a row is toggled or resized — that
// visible reaction is the entire point of the brief-review gate.

import type { JSX } from "react";
import { estimateCost, type EstimatableBrief } from "@/lib/estimate";
import type { RenderSettings } from "@/lib/models";
import { formatUsd } from "@/lib/format-usd";
import { Card, CardContent } from "@/components/ui/card";

export interface CostBadgeScene {
  script_line: string | null;
  video_prompt: string | null;
  is_talking_head: boolean;
  duration_s: number;
}

function toBrief(scenes: readonly CostBadgeScene[]): EstimatableBrief {
  return {
    character: "",
    scenes: scenes.map((scene) => ({
      script_line: scene.script_line ?? "",
      video_prompt: scene.video_prompt ?? "",
      is_talking_head: scene.is_talking_head,
      duration_s: scene.duration_s,
    })),
  };
}

export function CostBadge({
  scenes,
  audioEnabled,
  renderSettings,
}: {
  scenes: readonly CostBadgeScene[];
  /** Server-computed AUDIO_ENABLED flag — see lib/models.ts isAudioEnabled(). */
  audioEnabled: boolean;
  /**
   * The project's persisted render settings. Required, not defaulted: the
   * silent rate is per-resolution, so a badge that assumed 1080p would show
   * a quarter of the real price for a project set to 2160p — and this badge
   * is the number the operator carries in their head all the way to the
   * render button.
   */
  renderSettings: RenderSettings;
}): JSX.Element {
  const { totalUsd, talkingHeadCount, silentCount, seconds, resolution } = estimateCost(
    toBrief(scenes),
    audioEnabled,
    renderSettings,
  );

  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-4">
        <span className="text-3xl font-semibold tabular-nums text-foreground">
          {formatUsd(totalUsd)}
        </span>
        <span className="text-sm text-muted-foreground">
          {audioEnabled
            ? `${talkingHeadCount} talking-head + ${silentCount} silent · ${seconds}s total`
            : `Audio off — all ${talkingHeadCount + silentCount} scenes render silent · ${seconds}s total`}
          {` · ${resolution}`}
        </span>
      </CardContent>
    </Card>
  );
}
