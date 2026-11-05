// The version rail — every attempt at ONE scene, newest at the top.
//
// Two axes, and they mean different things. The strip along the bottom is
// WHICH CLIP; this rail is WHICH ATTEMPT at that clip. A scene renders, comes
// back wrong, is rendered again — v1, v2, v3 — and only one is current.
//
// CLICKING A VERSION MAKES IT CURRENT. This file used to argue the opposite
// at length — selected was a navigation, current was a separate button, and
// conflating them was "how a good take gets lost" — and that split was
// deliberately given up: see the comment on the tile itself for the trade.
//
// Current is still what the scene IS: the version its clip resolves to. It is
// drawn as a solid left edge; a version arrived at through `?v=` is ringed.
// A tile can be both.
//
// It exists because retries are the normal case on this route rather than the
// exception, and every one of them was billed. A UI showing only the latest
// would quietly hide what the earlier attempts cost.
//
// CURRENT HAD TO BE MADE THE LOUDER OF THE TWO MARKS. The ring above is a
// bright, primary-coloured signal for "what you are looking at"; current was
// a thin edge plus a small grey word for "what the scene actually is" — an
// operator scanning the rail read the loud ring as the one that counts and
// reached for it first. The fix is not a second ring (two loud marks beside
// each other is not clearer, just louder): current now also carries a solid
// Badge pill, a different visual FORM from a ring so the two stay tellable
// apart, and every non-current tile dims slightly so current wins on
// brightness too. See the tile's own comments for the dim amount and why.

import type { JSX } from "react";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { FormPendingOverlay } from "@/components/form-pending-overlay";
import { Badge } from "@/components/ui/badge";
import { deleteClipVersion, setActiveVersion } from "@/actions/ugc";
import { UgcTileMenu } from "@/components/ugc-tile-menu";
import { cn } from "@/lib/utils";
import type { SceneVersionView } from "@/lib/scene-versions";

/**
 * SceneVersionView plus the two fields the rail's own download link needs.
 * Kept local to this component rather than added to SceneVersionView
 * itself: that type is shared with the scripted pipeline's scene page
 * (app/(app)/projects/[id]/scenes/[sceneId]/page.tsx), which has no
 * per-version download control of its own and no reason to carry a
 * signed-URL pair it would never use.
 */
export interface UgcVersion extends SceneVersionView {
  /** Signed URL for THIS version's own clip, or null when it never produced one (clipAssetId null). */
  downloadUrl: string | null;
  /** Deterministic filename (lib/manifest.ts's filenameForClip) — null exactly when downloadUrl is null. */
  filename: string | null;
  /** Signed URL for this attempt's poster frame, or null when it has none. */
  posterUrl: string | null;
}

export function UgcVersionRail({
  sceneId,
  sceneIdx,
  versions,
  activeVersionId,
  selectedVersionId,
  workingVersionId = null,
  workingIsQueued = false,
  readOnly = false,
}: {
  /**
   * True for an admin viewing someone else's project. Both writes this rail
   * can make — setActiveVersion and deleteClipVersion — go through
   * requireProject and refuse a non-owner in the server, so this only stops
   * the page offering controls that would fail.
   */
  readOnly?: boolean;
  /** Null when nothing is selected — the column is composing a new scene. */
  sceneId: string | null;
  sceneIdx: number | null;
  versions: readonly UgcVersion[];
  /** scenes.active_version_id — the attempt currently standing as the clip. */
  activeVersionId: string | null;
  /** From `?v=`. What the operator is looking at, which may not be current. */
  selectedVersionId: string | null;
  /**
   * The attempt the worker is holding right now, or null.
   *
   * Without this the rail called a render in flight "no clip" — the same
   * sentence it uses for an attempt that failed and produced nothing. An
   * operator watching v2 render read that its render had come back empty.
   * Absence of a clip is not evidence of failure while the clip is still
   * being made.
   */
  workingVersionId?: string | null;
  /** Whether that attempt is queued rather than already rendering. */
  workingIsQueued?: boolean;
}): JSX.Element {
  // Newest first: the attempt just paid for should not need a scroll.
  const ordered = [...versions].sort((a, b) => b.n - a.n);

  return (
    <aside className="flex min-h-0 w-full shrink-0 flex-col self-stretch rounded-lg border bg-card xl:w-56">
      <h2 className="rounded-t-[7px] border-b bg-muted/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-foreground">
        {sceneIdx === null ? "Versions" : `Scene ${sceneIdx} · versions`}
      </h2>

      {ordered.length === 0 || sceneId === null ? (
        <p className="p-2.5 text-xs text-muted-foreground">
          Each render of a scene adds a version here.
        </p>
      ) : (
        // Scrolls in its own box. The page body scrolls in neither direction.
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
          {ordered.map((version) => {
            const current = version.id === activeVersionId;
            const selected = version.id === selectedVersionId;
            return (
              <div
                key={version.id}
                className={cn(
                  "relative flex flex-col gap-0.5 rounded-md border p-1.5",
                  current && "border-l-[3px] border-l-foreground bg-muted",
                  // Every OTHER tile dims a little, so current wins on
                  // brightness without a second ring. 80%, not the ~95%
                  // first asked for: at a 112px-tall thumbnail a 5% dim
                  // reads as nothing, especially on a dark ground, and it
                  // has to stay well clear of Button's own
                  // disabled:opacity-50 — that number is exactly what this
                  // tile's own disabled:opacity-100 fix (below) exists to
                  // keep OFF current, so reusing anything near it for "not
                  // current" would relitigate the same mistake this file
                  // already reversed. 80% is visibly a step down without
                  // reading as "unavailable".
                  !current && "opacity-80",
                  selected && "ring-2 ring-primary",
                )}
              >
                {/* CLICKING A VERSION MAKES IT CURRENT.
                    Asked for directly, and it replaces a deliberate split
                    this file used to argue for at length: selecting was a
                    navigation (?v=), promoting was a separate "Make current"
                    button, and the header called conflating them "how a good
                    take gets lost".

                    What that bought was the ability to inspect an old take
                    without promoting it. What it cost was two controls and a
                    second click on the one thing an operator comes to this
                    rail to do. The trade is real and it went the other way:
                    every click is now a write, so comparing v3 then v2 then
                    v1 leaves v1 current. That is one click to undo, and the
                    rail shows which is current at all times.

                    setActiveVersion still refuses a version from another
                    scene, and still spends nothing — it repoints a row at a
                    clip already paid for. */}
                <ActionForm
                  action={setActiveVersion}
                  fallbackErrorMessage="Could not change the current version."
                >
                  <input type="hidden" name="sceneId" value={sceneId} />
                  <input type="hidden" name="versionId" value={version.id} />
                  {/* SubmitButton no longer WRAPS the poster — it sits on
                      top of it. SubmitButton's own pending state (see its
                      header) replaces `children` wholesale with a spinner and
                      a short label, which is correct for an ordinary button
                      and wrong for this one: the poster below is what an
                      operator is on this rail to compare, and swapping it for
                      a spinner mid-click is the exact bug ("Setting" where
                      the picture had been) this component was rebuilt to fix.
                      SubmitButton itself is not touched — Compile/Recompile/
                      Save all depend on the swap being correct for THEM.
                      Instead the button becomes an invisible, full-tile hit
                      target: its own visible content is reduced to a sr-only
                      accessible name (both idle and pending — [&_svg]:hidden
                      mutes its built-in spinner so FormPendingOverlay, below,
                      is the only one that paints), and the poster/label the
                      operator actually looks at render as an always-present
                      sibling underneath, in this same relatively-positioned
                      tile, untouched by whatever SubmitButton is doing. */}
                  {/* disabled:opacity-100 — the dimming was backwards.
                      Button's base carries `disabled:opacity-50`, and this
                      tile is disabled whenever it is CURRENT. So the version
                      the operator is actually using rendered as the faded one
                      in the rail, which reads as "unavailable" — the opposite
                      of what is true about it. A read-only viewer got the same
                      treatment on every tile, on the screen whose only purpose
                      for them is looking at those posters. Kept even though
                      this button now carries no visible content of its own:
                      cheap insurance against the same mistake creeping back in
                      if this ever regains one.

                      The disabled attribute STAYS: pressing "make current" on
                      the version that is already current must not fire a
                      write, and pointer-events-none still comes with it. */}
                  <SubmitButton
                    pendingLabel={
                      <span className="sr-only">{`Setting v${version.n} current`}</span>
                    }
                    variant="ghost"
                    // h-auto IS LOad-BEARING, and it went missing once.
                    //
                    // Button's default size carries `h-9` (ui/button.tsx), and
                    // CSS ignores `bottom` when `top`, `height` and `bottom` are
                    // all set — so `absolute inset-0` with an inherited height
                    // does NOT stretch. The hit target became a 36px strip
                    // pinned to the top of a ~180px tile, which is where the
                    // chevron menu already sits, and pressing a version's poster
                    // did nothing at all. Shipped that way for one deploy.
                    className="absolute inset-0 h-auto p-0 hover:bg-transparent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-100 [&_svg]:hidden"
                    disabled={current || readOnly}
                  >
                    <span className="sr-only">{`Make v${version.n} current`}</span>
                  </SubmitButton>
                  {/* Says the press landed, on the tile that was pressed —
                      see form-pending-overlay.tsx for the fuller argument.
                      Rendered after SubmitButton so it paints on top of it:
                      both are position: absolute, and CSS stacks positioned
                      siblings in tree order when neither sets a z-index. */}
                  <FormPendingOverlay label={`Setting v${version.n} current`} />
                </ActionForm>

                {/* The take itself, not a grey rectangle — and now rendered
                    unconditionally rather than as the button's children, so
                    a pending submit can never make it disappear. A rail of
                    blank placeholders makes an editor open each version to
                    find out what it is — which is the whole job this column
                    exists to save them. 9:16, the only aspect this product
                    delivers. pointer-events-none: the click target is the
                    invisible SubmitButton layered above, not this. */}
                <div className="pointer-events-none flex flex-col gap-0.5">
                  {/* A FIXED height, not the 9:16 aspect the clip is in.
                    At this rail's width a 9:16 poster is around 350px tall,
                    and with two buttons under it one version filled most of
                    the column — so comparing three takes meant scrolling
                    past two of them. 112px is enough to tell takes apart,
                    which is the only thing this thumbnail has to do; the
                    clip's real shape is on the canvas beside it. */}
                  {version.posterUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={version.posterUrl}
                      alt=""
                      className="mb-1 h-28 w-full rounded-sm border object-cover"
                    />
                  ) : (
                    <div className="mb-1 h-28 w-full rounded-sm bg-muted" />
                  )}
                  {/* One line, not three. durationS is null on any version
                    backfilled by 0058, which predates the snapshot columns.
                    Shown as "not recorded" rather than filled in from the
                    scene's CURRENT settings — substituting those is the
                    exact defect 0059 exists to prevent. */}
                  <span className="flex items-baseline gap-1.5 text-[11px]">
                    <span className="font-mono tabular-nums">v{version.n}</span>
                    {version.id === workingVersionId ? (
                      <span className="truncate text-[10px] text-muted-foreground">
                        {/* In flight beats everything else this line could
                          say. A version being rendered is neither superseded
                          nor empty — it is not finished, and that is the one
                          fact the operator is on this page to watch. */}
                        {workingIsQueued ? "queued" : "rendering"}
                      </span>
                    ) : current ? (
                      // A proper pill, not a small grey word — see the
                      // header note on why current had to get louder. Badge
                      // (ui/badge.tsx) is this codebase's existing status-pill
                      // primitive (project-status-badge.tsx and friends);
                      // `secondary` rather than `default` on purpose — default
                      // is the solid primary-gold fill this app already
                      // reserves for its one loud button per screen (see
                      // project-status-badge.tsx's header), and scattering
                      // that colour onto a rail of thumbnails would compete
                      // with it instead of just marking a fact.
                      <Badge
                        variant="secondary"
                        className="h-4 shrink-0 gap-0 px-1.5 py-0 text-[10px] font-semibold leading-none"
                      >
                        current
                      </Badge>
                    ) : (
                      <span className="truncate text-[10px] text-muted-foreground">
                        {version.clipAssetId ? "superseded" : "no clip"}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                      {version.durationS === null ? "not recorded" : `${version.durationS}s`}
                    </span>
                  </span>
                </div>

                {/* Download and Delete live in the menu, not under the
                    tile. The tile is a submit button now, so a second control
                    inside it would be a button in a button; and two stacked
                    full-width buttons per version were most of what made this
                    rail scroll. */}
                <UgcTileMenu
                  label={`v${version.n}`}
                  downloadUrl={version.downloadUrl}
                  filename={version.filename}
                  onDelete={readOnly ? undefined : deleteClipVersion}
                  deleteFields={readOnly ? undefined : { sceneId, versionId: version.id }}
                  deleteUnavailableReason={
                    current
                      ? "Current — pick another first"
                      : versions.length <= 1
                        ? "Only version"
                        : null
                  }
                  // Used to pass none, deliberately: the server guards above
                  // (current and last-version both refuse) made a confirm
                  // read as theatre for a call that mostly just succeeds.
                  // That reasoning stopped being the whole story once
                  // 0092_deleted_scene_versions.sql gave a deleted version
                  // somewhere to land — this now sends v{n} to the bin
                  // rather than destroying it outright, and an operator
                  // clicking Delete should know that, not just that the
                  // click "worked". /bin is where it can still be restored
                  // from, or purged for good.
                  confirmMessage={`Send v${version.n} to the bin? You can restore it from /bin, or delete it there permanently.`}
                />
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
