// The shape of the project rail — the vertical navigation that replaces the
// horizontal StepRail (components/step-rail.tsx) inside
// app/(app)/projects/[id]/layout.tsx.
//
// This file is DATA SHAPE ONLY, on purpose. Two separate pieces of work meet
// here and neither may reach past it:
//
//   - components/project-rail.tsx renders a RailModel and knows nothing about
//     how one is built. It fetches nothing, derives nothing, and imports no
//     server code.
//   - lib/project-rail.ts builds a RailModel from a project, its scenes and
//
// Keeping the contract in a third file that neither owns is what lets the
// component and the derivation be written independently without either
// guessing at the other's assumptions. Change this file and both sides break
// loudly at the type level, which is the intended failure mode.

/**
 * Why the rail groups at all: the old StepRail was five equal steps because
 * the pipeline was a walk. It isn't — a scene gets revisited 3-8 times before
 * it is accepted, so the rail's job is to show state, not sequence.
 *
 * - "setup"  — project-wide inputs, touched once (character, product, script,
 *              render settings).
 * - "scenes" — the actual unit of work, one entry per scene.
 * - "cut"    — the assembled delivery.
 */
export type RailGroupId = "setup" | "scenes" | "cut";

/**
 * Mirrors the states components/status-icon.tsx already draws, so the
 * rail reuses that component rather than inventing a second vocabulary for
 * the same idea. "locked" is the one state StatusIcon has no glyph for —
 * see RailEntry.lockedReason for why it is a rail concept rather than a
 * scene concept.
 */
export type RailEntryStatus = "done" | "queued" | "running" | "idle" | "failed" | "locked";

export interface RailEntry {
  /** Stable id, unique within the whole model. Used as the React key. */
  id: string;
  label: string;
  status: RailEntryStatus;
  /**
   * Route to navigate to. `null` when the entry is not reachable — a locked
   * entry renders as text, never as a link, so there is no route to guard
   * against on the page itself.
   */
  href: string | null;
  /**
   * Right-aligned trailing text: "2/2", "done", "bumagsak". Kept as a
   * pre-formatted string rather than a number so the derivation owns the
   * wording and the component never has to know what is being counted.
   *
   * Superseded at render time by a live m:ss readout whenever `elapsedSince`
   * is set and the clock has started — see that field.
   */
  count?: string;
  /**
   * ISO timestamp the row's work started at, when there is a real one to
   * measure from (`scenes.submitted_at`). The component turns it into a
   * ticking "2:10" in the `count` slot.
   *
   * Not formatted here, unlike every other string on this interface: a
   * pre-rendered elapsed string is wrong one second after the server sent it,
   * and this model is built in a Server Component. The derivation owns WHICH
   * rows have a clock; only the component can own what time it is.
   */
  elapsedSince?: string | null;
  /**
   * The one reason a locked row exists, and it REPLACES the label — one row,
   * one sentence.
   *
   * It used to render underneath the label instead, which made every locked
   * group two lines tall and said the same sentence twice when two groups
   * shared one gate. The group heading directly above already names the row
   * ("SCENES" / "CUT"), so the label was the redundant half, not the reason.
   *
   * Optional, therefore, rather than required-when-locked: the group that
   * OWNS the gate carries the sentence, and a second group locked by the same
   * gate keeps its own name and stays quiet rather than echoing it. Whatever
   * is shown must fit one line at this rail's width (13rem) — a reason that
   * has to wrap is a reason to shorten the sentence, not to add a line.
   */
  lockedReason?: string;
  /** True for the entry matching the current route. Purely presentational. */
  active?: boolean;
  /**
   * True while an action belonging to this entry is in flight — the rail's
   * one job beyond navigation (see RailModel's doc comment). Set by the
   * derivation for work that is visible in the database (the assemble loop
   * stitching the final), and at runtime by useRailBusyWhile
   * (components/project-rail.tsx) for the awaited server actions that never
   * touch a row a server render could see.
   */
  busy?: boolean;
  /**
   * Glyph to draw INSTEAD of the status shape while this row is the current
   * one. The status word stays the accessible name either way, so this costs
   * nothing to a screen reader; it is the visual reinforcement of "this is
   * the screen you are standing on" the design asks for on Render settings.
   */
  icon?: "settings";
}

export interface RailGroup {
  id: RailGroupId;
  label: string;
  entries: readonly RailEntry[];
  /**
   * Optional group-level progress, e.g. "3/4" on Setup — shown inline beside
   * the group label, in warning weight, so an operator can see how far off
   * they are without opening the group.
   *
   * Set only while the group is INCOMPLETE. "4/4" is not progress, it is
   * furniture: a permanent counter in the chrome that never changes stops
   * being read, and it was the only thing marking Setup as unfinished. Omit
   * it and a bare "SETUP" heading is itself the signal that there is nothing
   * left to do there.
   */
  count?: string;
  /**
   * Where an "Add scene" row at the end of this group would insert, or
   * omitted when the viewer may not add one (not the owner).
   *
   * The affordance lives in the rail and not only on the brief page because
   * the rail is the one thing visible from every route — the design's whole
   * argument for it. Adding a scene from the frames screen should not mean
   * navigating away from the frames screen first.
   */
  addScene?: { projectId: string; afterIdx: number };
  /**
   * True when every entry in the group is locked. The component dims the
   * whole group but still renders it — hiding it would make the shape of the
   * work invisible while the operator is filling in setup, which is exactly
   * when they most need to see it.
   */
  dimmed?: boolean;
}

export interface RailModel {
  /** The project this rail belongs to — the rail renames it in place (components/rail-title-edit.tsx). */
  projectId: string;
  projectTitle: string;
  /** True for a non-owning admin: the title renders as a plain heading, with no rename control. */
  readOnly: boolean;
  /** e.g. "2 scenes · 12s · $4.17" */
  projectSubtitle: string;
  groups: readonly RailGroup[];
  /** Href for the "← Studio" escape hatch at the top of the rail. */
  backHref: string;
}
