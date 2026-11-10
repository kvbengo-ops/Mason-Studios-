"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type JSX,
  type ReactNode,
} from "react";
import { Plus, Settings } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { StatusIcon } from "@/components/status-icon";
import { RailTitleEdit } from "@/components/rail-title-edit";
import { PendingButton } from "@/components/pending-button";
import { addScene } from "@/actions/brief";
import { elapsedLabel } from "@/lib/render-elapsed";
import type { RailModel, RailEntry, RailGroup } from "@/lib/project-rail-types";
import type { SceneStatus } from "@/types/db";
import { useVisibleInterval } from "@/lib/use-visible-interval";

/**
 * Map RailEntry status to SceneStatus for StatusIcon rendering.
 * "locked" is handled separately (not passed to StatusIcon).
 */
function mapRailStatusToSceneStatus(status: Exclude<RailEntry["status"], "locked">): SceneStatus {
  switch (status) {
    case "done":
      return "done";
    case "queued":
      return "queued";
    case "running":
      return "rendering";
    case "idle":
      return "draft";
    case "failed":
      return "failed";
    default:
      const _: never = status;
      return _;
  }
}

/**
 * How often the rail re-asks the server what is going on, while anything in
 * it is running.
 *
 * The design's argument for the rail is that it is the one thing visible from
 * every screen, so "if you go to Character and come back, that is where you
 * see whether it finished." That is only true if it moves on its own. It
 * didn't: the model is built in a Server Component, and a Next layout is
 * PRESERVED across sibling-segment navigation — Character -> Product ->
 * Character re-renders the pages and not the layout, so a rail built with a
 * scene mid-render kept saying "rendering" until a hard reload, however much
 * the operator navigated around trying to find out.
 *
 * Ten seconds, and only while something is actually running — the interval is
 * torn down the moment the refreshed model comes back with nothing in flight,
 * so an idle project polls nothing at all. Same figure and same
 * teardown-on-terminal rule as scene-workbench.tsx's own in-flight refresh,
 * which is deliberately the cheaper, page-local half of this: that one keeps
 * the scene you are looking at fresh, this one keeps the rail fresh from
 * wherever you have wandered off to.
 */
// 15s, not 10: the worker's dispatch/reconcile loops tick every 30s, so a
// faster full-page refresh shows nothing new. Hidden tabs don't poll at all.
const RAIL_REFRESH_MS = 15_000;

// ---------------------------------------------------------------------------
// Runtime busy reporting
// ---------------------------------------------------------------------------

/**
 * The busy set travels through a STORE the rail subscribes to, and never
 * through the context value. That is not a preference — it is the only shape
 * of this that works, and the previous one shipped broken.
 *
 * This provider wraps the rail AND the page (see the layout). A screen
 * reports its work from inside a pending React transition — that is what both
 * a `<form action={...}>` submit and a `useTransition` are. Carrying `busy`
 * in the context value means delivering it requires RE-RENDERING THIS
 * PROVIDER, and the provider's subtree contains the very form that is still
 * pending, so React defers that render until the transition settles: the
 * moment the call returns. The row would light up one frame after the work it
 * was reporting was already over.
 *
 * That is a lie in the direction that costs money — an operator waiting on a
 * $1.89 render reads a still rail as "nothing is running" and clicks again —
 * and it is exactly what was on screen: the rail sat still through a
 * thirty-second compile and through both paid image calls.
 *
 * A store update reaches the rail directly, without the provider rendering at
 * all, so nothing about it is inside the transition. Found the honest way: a
 * test that drives a real form submit instead of mounting the reporter by
 * hand. Reverting to `useState` in the provider fails those two tests and
 * nothing else, which is how it is known to be load-bearing rather than
 * ceremony.
 */
interface RailBusyStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ReadonlySet<string>;
  setBusy: (entryId: string, busy: boolean) => void;
}

const RailBusyContext = createContext<RailBusyStore | null>(null);

/**
 * Stable identities for the no-provider case (a component rendered in
 * isolation — a test, a story). useSyncExternalStore re-subscribes whenever
 * `subscribe` changes identity and throws if `getSnapshot` returns a new
 * object every call, so neither may be built inline.
 */
const EMPTY_BUSY: ReadonlySet<string> = new Set<string>();
const noopSubscribe = (): (() => void) => () => {};
const emptySnapshot = (): ReadonlySet<string> => EMPTY_BUSY;

/**
 * Lets a screen report its own in-flight work to the rail.
 *
 * The design's rule is that every API call owns a rail entry and that entry
 * spins while the call runs. Half of those calls already satisfy it for free:
 * a scene render moves `scenes.status` to queued/rendering, and the assemble
 * loop's window is derivable too (lib/project-rail.ts's `assembling`), so any
 * server render can see them.
 *
 * The other half — Rewrite my words, describe-from-photo, regen portrait,
 * compile into scenes — are awaited inline inside their own server action and
 * write nothing anyone can observe while they run. By the time the rail is
 * rebuilt, the call it should have been spinning for has already returned.
 * There is no database state to derive from, and inventing an
 * `in_flight` column to fake one would be a second, lying copy of a fact the
 * client already knows for certain.
 *
 * So the client that fired the call says so directly. This provider wraps the
 * rail AND the page in app/(app)/projects/[id]/layout.tsx, which is what lets
 * the two talk; screens call useRailBusyWhile below.
 */
export function RailBusyProvider({ children }: { children: ReactNode }): JSX.Element {
  // One store per provider, not a module-level singleton: two rails on one
  // page (only tests do this today) must not report into each other.
  const stateRef = useRef<{ busy: ReadonlySet<string>; listeners: Set<() => void> } | null>(null);
  stateRef.current ??= { busy: EMPTY_BUSY, listeners: new Set() };

  const value = useMemo<RailBusyStore>(() => {
    const state = stateRef.current!;
    return {
      subscribe: (listener) => {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
      getSnapshot: () => state.busy,
      setBusy: (entryId, isBusy) => {
        // Same-value writes are dropped before anything is notified, so a
        // screen re-reporting an unchanged flag every render can't loop the
        // subscribers.
        if (state.busy.has(entryId) === isBusy) return;
        const next = new Set(state.busy);
        if (isBusy) {
          next.add(entryId);
        } else {
          next.delete(entryId);
        }
        state.busy = next;
        for (const listener of state.listeners) listener();
      },
    };
  }, []);

  return <RailBusyContext.Provider value={value}>{children}</RailBusyContext.Provider>;
}

/**
 * Spin `entryId`'s rail row for as long as `active` is true.
 *
 * One line at each call site — `useRailBusyWhile(RAIL_ENTRY_SCRIPT, isPending)`
 * beside the `isPending` a screen already computes for its own button, using
 * the ids lib/project-rail.ts exports. The two signals are deliberately not
 * the same one: the BUTTON's spinner says "this is the thing you pressed" and
 * stops a second click and a second charge; the RAIL's says "something is
 * still running", including once you have walked away from the screen that
 * started it.
 *
 * A no-op outside the provider, so a component rendered in isolation (a test,
 * a story) neither crashes nor has to fake a rail.
 */
/**
 * The read side of the same store. Separate from the context object so a
 * busy change re-renders the rail WITHOUT the provider re-rendering the whole
 * page under it — and, more importantly, so the update is not deferred behind
 * whatever transition the reporter is sitting inside (see RailBusyStore).
 */
/**
 * Whether a rail entry currently has work in flight, readable by anyone —
 * not just the rail.
 *
 * The busy set outlives the screen that set it (useRailBusySetter), which is
 * the point; but a control that reads only its OWN component state does not
 * know that. Navigate away from a scene mid-regeneration and back, and the
 * workbench remounts with a fresh `regenerating = false`: the button reads
 * as ready, and the next click pays a second time for a call already
 * running. The store is the only thing that survived the round trip, so a
 * paid control has to ask it rather than itself.
 */
export function useRailEntryBusy(entryId: string): boolean {
  return useRailBusySnapshot().has(entryId);
}

/**
 * The whole busy set, for a caller that needs to ask about many entries in
 * one render — frame-grid.tsx maps over every scene, and a hook cannot be
 * called inside that map.
 */
export function useRailBusyIds(): ReadonlySet<string> {
  return useRailBusySnapshot();
}

function useRailBusySnapshot(): ReadonlySet<string> {
  const store = useContext(RailBusyContext);
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
}

export function useRailBusyWhile(entryId: string, active: boolean): void {
  const setBusy = useContext(RailBusyContext)?.setBusy;

  useEffect(() => {
    if (!setBusy) return;
    setBusy(entryId, active);
    // Clears on unmount too, not only when `active` goes false — a screen
    // navigated away from mid-call would otherwise leave its row spinning for
    // the rest of the session, which is the exact failure this whole signal
    // exists to prevent.
    return () => setBusy(entryId, false);
  }, [entryId, active, setBusy]);
}

/**
 * The busy setter itself, for a call that must stay visible AFTER the screen
 * that started it goes away.
 *
 * useRailBusyWhile above ties the signal to the caller's mounted lifetime,
 * which was the right shape while a pending transition made it impossible
 * to navigate mid-call. Now that the paid actions no longer hold the router
 * (components/use-async-action.ts), navigating away is exactly what an
 * operator does with a ten-second frame regeneration — and the row went
 * quiet the moment they did, so the one signal that was supposed to survive
 * the navigation was the one thing that did not.
 *
 * The store lives above the routes, so the value survives. What has to
 * change is who clears it: the ACTION, in its own finally, rather than a
 * component unmounting. The returned function is stable and safe to call
 * after unmount — it writes to the store, not to component state.
 *
 * Use this only for calls worth following across a navigation. Anything
 * that settles in a few hundred milliseconds should keep useRailBusyWhile,
 * whose unmount cleanup is a genuine safety net against a stranded row.
 */
export function useRailBusySetter(): (entryId: string, busy: boolean) => void {
  const setBusy = useContext(RailBusyContext)?.setBusy;
  return useCallback(
    (entryId: string, busy: boolean) => {
      setBusy?.(entryId, busy);
    },
    [setBusy],
  );
}

/**
 * The hook as a component, for the one place a hook cannot go: inside a
 * `.map()` over rows, where each row needs its own entry lit.
 *
 * frame-grid.tsx generates up to N frames in one batch and each card knows
 * only its own pending flag, so the alternative was extracting every card
 * into its own component purely to have somewhere to put a hook call. This
 * renders nothing and exists only for its effect.
 */
export function RailBusyWhile({ entryId, active }: { entryId: string; active: boolean }): null {
  useRailBusyWhile(entryId, active);
  return null;
}

/**
 * The same signal for a plain <form action={...}> — mount it anywhere inside
 * the form and that form's row spins while the action is in flight.
 *
 * A Server Component page cannot call useRailBusyWhile itself, and the
 * ActionForm/SubmitButton pair it renders keeps its pending state inside
 * React's own form status rather than a useTransition the page can see. This
 * is the one-line bridge: a client child of the <form>, reading the same
 * useFormStatus SubmitButton reads, reporting it to the rail.
 *
 * Renders nothing. Its whole output is the row spinning.
 */
export function RailBusyWhileSubmitting({ entryId }: { entryId: string }): null {
  const { pending } = useFormStatus();
  useRailBusyWhile(entryId, pending);
  return null;
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

/**
 * The id of the one entry to mark current, or null.
 *
 * An entry with an explicit `active` wins outright. Otherwise the first
 * (in practice, only) entry whose href matches the current pathname wins.
 *
 * The four Setup rows used to all point at one shared /character route —
 * that single page really did hold the character, the product, the script
 * AND the render settings — so `.find()`'s first-match behaviour used to be
 * load-bearing: marking every match lit the whole Setup group at once and
 * said nothing about where the operator was. Now that Character/Product/
 * Script/Settings are four distinct routes (lib/project-rail.ts's
 * buildRailModel), no two entries can ever share an href any more, so
 * `.find()` never actually has more than one candidate to choose between —
 * this is kept as a plain "first (only) match" rather than rewritten to
 * something that asserts uniqueness, since a genuine second collision
 * (a future route reused across two rail rows) should degrade the same safe
 * way this already does, not throw.
 */
function currentEntryId(model: RailModel, pathname: string | null): string | null {
  const entries = model.groups.flatMap((group) => group.entries);
  const explicit = entries.find((entry) => entry.active === true);
  if (explicit) return explicit.id;
  const matched = entries.find((entry) => entry.href !== null && entry.href === pathname);
  return matched ? matched.id : null;
}

/**
 * A ticking clock, or null until the browser has one.
 *
 * Null on the server and on the first client render, deliberately: the model
 * is server-rendered, and any elapsed string computed during render would
 * differ between the two passes and hydrate mismatched. Every row falls back
 * to its static `count` until this returns a number, which is the first tick
 * after mount. Same shape as scene-workbench.tsx's own elapsed hook.
 */
function useNowMs(active: boolean): number | null {
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    // Both writes happen in callbacks rather than in the effect body — a
    // synchronous setState here is a cascading render on every mount of every
    // project page — and the zero-delay timeout gets the first reading on
    // screen without waiting out the interval's first whole second. Same
    // shape, and the same reason, as scene-workbench.tsx's useElapsedLabel.
    const firstTick = setTimeout(() => setNowMs(Date.now()), 0);
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return (): void => {
      clearTimeout(firstTick);
      clearInterval(timer);
    };
  }, [active]);

  // Gated on `active` rather than cleared on teardown, for the same reason: a
  // stale reading left from a render that HAD a clock must not survive into
  // one that doesn't, and clearing it in the effect would be the synchronous
  // setState this just avoided.
  return active ? nowMs : null;
}

/**
 * The row's trailing text: a live "2:10" while it has a clock to read, its
 * own state word otherwise.
 *
 * The clock replaces the word rather than joining it — the rail is 13rem wide
 * and "rendering 2:10" does not fit — and the word is what survives when
 * there is nothing to measure (a queued scene the worker has not claimed yet
 * has no submitted_at), so no row ever loses its trailing text to a dash.
 */
function trailingText(entry: RailEntry, nowMs: number | null): string | undefined {
  if (entry.elapsedSince && nowMs !== null) {
    const startedMs = Date.parse(entry.elapsedSince);
    if (!Number.isNaN(startedMs)) {
      return elapsedLabel(Math.max(0, nowMs - startedMs));
    }
  }
  return entry.count;
}

/**
 * The "+ Add scene" row that closes the Scenes group.
 *
 * A PendingButton (components/pending-button.tsx), not a bare button, for the
 * reason that file gives: a control whose click costs something must be
 * genuinely disabled while it is in flight, not merely look busy. Adding a
 * scene costs no money by itself, but a double-click here inserts two blank
 * scenes into the cut, which is a worse mess to unpick than a re-click that
 * does nothing.
 *
 * router.refresh() afterwards, on top of addScene's own revalidatePath: that
 * call revalidates the BRIEF page's path, and the whole point of this row is
 * that it can be pressed from the frames screen, the character screen, or
 * anywhere else the rail is visible — none of which the brief's path
 * invalidates.
 */
function AddSceneRow({ target }: { target: NonNullable<RailGroup["addScene"]> }): JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleAdd(): void {
    startTransition(async () => {
      try {
        const result = await addScene(target.projectId, target.afterIdx);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to add scene.");
      }
    });
  }

  return (
    <PendingButton
      type="button"
      variant="ghost"
      pending={pending}
      onClick={handleAdd}
      className="h-auto w-full justify-start gap-2.5 rounded-md px-2 py-1.5 text-sm font-normal text-muted-foreground hover:text-foreground"
    >
      {pending ? null : <Plus aria-hidden="true" className="size-4 shrink-0" />}
      Add scene
    </PendingButton>
  );
}

/**
 * Vertical navigation rail for project scenes and setup. Near-pure
 * presentation — takes a RailModel and renders it. Fetches nothing, derives
 * nothing about the project, imports no server code. All state derivation
 * belongs in lib/project-rail.ts.
 *
 * The two things it does own are the two the server cannot: what time it is
 * (the elapsed clock on a running row) and when to go back and ask
 * (RAIL_REFRESH_MS).
 *
 * The rail sits beside the sidebar, so it borrows spacing and muted-text
 * tokens rather than inventing new ones.
 *
 * A locked entry renders as plain text (no link), one line, whose text is its
 * lockedReason when it has one — see RailEntry.lockedReason.
 *
 * The current entry (entry.active === true) gets aria-current="page".
 *
 * Balances are pinned to the bottom edge, with warning colour when low: true,
 * and an em dash when value is null.
 */
export function ProjectRail({ model }: { model: RailModel }): JSX.Element {
  // Read the route here rather than expecting buildRailModel to stamp
  // `active`, for the same reason step-rail.tsx does: the layout that builds
  // the model is a Server Component and has no pathname to give. Leaving it
  // to the model meant nothing was ever marked current, so the rail could not
  // tell you where you were standing.
  //
  // RailEntry.active is still honoured when set, so a caller that genuinely
  // knows better (a test, or a future route whose URL doesn't match its
  // entry href) can override the match.
  const pathname = usePathname();
  const router = useRouter();
  const currentId = currentEntryId(model, pathname);
  const runtimeBusy = useRailBusySnapshot();

  const entries = model.groups.flatMap((group) => group.entries);

  // Only what the SERVER can see drives the refresh loop — a scene the worker
  // owns, or the assemble window. Runtime busy (useRailBusyWhile) is
  // deliberately excluded: those calls are awaited inline, so the page
  // re-renders by itself the moment they return, and polling on their behalf
  // would refetch the whole route under a screen that is already about to.
  // "queued" counts. Splitting it out of "running" for the glyph must not
  // quietly narrow the refresh: a queued scene is precisely the one waiting
  // for the worker to claim it, so it is the state the rail most needs to
  // poll through. Missing it here would have left the row sitting on
  // "queued" until something else happened to re-render the page.
  const anyRunning = entries.some(
    (entry) => entry.status === "running" || entry.status === "queued" || entry.busy === true,
  );
  const anyClock = entries.some((entry) => Boolean(entry.elapsedSince));
  const nowMs = useNowMs(anyClock);

  useVisibleInterval(() => router.refresh(), RAIL_REFRESH_MS, anyRunning);

  return (
    <nav
      aria-label="Project navigation"
      className="flex flex-col bg-sidebar text-sidebar-foreground md:flex-1"
    >
      {/* Scrollable content: back link, title, groups */}
      <div className="p-2">
        {/* Back link to Studio */}
        <Link
          href={model.backHref}
          className={cn(
            "block rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
          )}
        >
          ← Studio
        </Link>

        {/* Project title and subtitle */}
        <div className="px-2 pb-4 pt-2">
          {/* Renamed here, not on a settings page. The title is already on
              screen on every route; a second, editable copy of it in a panel
              below was a form competing with a label for one fact. */}
          <RailTitleEdit
            projectId={model.projectId}
            title={model.projectTitle}
            readOnly={model.readOnly}
          />
          <p className="text-xs text-muted-foreground">{model.projectSubtitle}</p>
        </div>

        {/* Groups of entries */}
        {model.groups.map((group) => (
          <div
            key={group.id}
            className={cn("mt-4 first:mt-0 space-y-0.5", group.dimmed && "opacity-60")}
          >
            {/* Group label, with the count sitting INLINE beside it rather
                than shoved to the far edge by justify-between. It is a
                warning about this group — "you are 1 of 4 through Setup" —
                not a column of figures, and at the rail's width a number
                pinned 8rem away from the word it modifies reads as belonging
                to neither. Warning colour and weight for the same reason:
                the model only sets it while the group is incomplete (see
                RailGroup.count), so whenever it is on screen at all it has
                something to say. */}
            <div className="mb-1 flex items-baseline gap-2 px-2">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                {group.label}
              </h3>
              {group.count && (
                <span className="text-xs font-semibold tabular-nums text-warning">
                  {group.count}
                </span>
              )}
            </div>

            {/* Group entries */}
            {group.entries.map((entry) => {
              // Two separate questions, deliberately not collapsed into one
              // condition: "is this locked" and "is there anywhere to go".
              //
              // They arrived here as `status === "locked" || !entry.href`,
              // which conflated them. RailEntry only defines lockedReason for
              // locked entries, so an unreachable-but-not-locked row rendered
              // `undefined` as its label and reported itself as draft
              // whatever it actually was — a failed scene with no route drew
              // as a blank draft row. No fixture combined those two facts, so
              // 26 passing tests said nothing about it.
              const isLocked = entry.status === "locked";
              const isBusy = entry.busy === true || runtimeBusy?.has(entry.id) === true;
              const isCurrent = entry.id === currentId;
              const trailing = trailingText(entry, nowMs);
              // The gear only while you are standing on the settings screen.
              // Everywhere else the row keeps its real status tick, which is
              // the thing a rail is scanned for; the swap is a "you are here"
              // reinforcement, and it costs the tick exactly where the tick
              // is least needed — on the page you are already looking at.
              const glyph = entry.icon === "settings" && isCurrent ? Settings : undefined;

              if (isLocked || !entry.href) {
                return (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-muted-foreground"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      {/* A locked row has no real status to draw — nothing has
                          been attempted on it — so it takes the quietest
                          glyph. Every other row keeps its own status even when
                          it has nowhere to link to. When busy, show the running
                          glyph regardless of status. */}
                      <StatusIcon
                        showLabel={false}
                        filled
                        icon={glyph}
                        status={
                          isBusy
                            ? "rendering"
                            : entry.status === "locked"
                              ? "draft"
                              : mapRailStatusToSceneStatus(entry.status)
                        }
                      />
                      {/* One row, one sentence. A locked row's reason REPLACES
                          its label — the group heading directly above already
                          said "Scenes", so repeating it under the reason made
                          every locked group two lines tall to carry one fact,
                          and made two groups gated by the same thing say it
                          twice. The reason is short enough to fit this width
                          on one line, which is a constraint on the sentence
                          (lib/project-rail.ts's SCRIPT_NOT_COMPILED_REASON),
                          not a reason for a second line. */}
                      <span className="truncate">{entry.lockedReason ?? entry.label}</span>
                    </div>
                    {trailing && (
                      <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                        {trailing}
                      </span>
                    )}
                  </div>
                );
              }

              // Reachable entries: render as link (non-locked, non-null href)
              return (
                <Link
                  key={entry.id}
                  href={entry.href}
                  // Explicit, not inherited: these routes are cookie-
                  // authenticated and therefore dynamic, so Next only
                  // prefetches them as far as the nearest loading boundary —
                  // which is exactly what projects/[id]/loading.tsx now is.
                  // Before that file existed this would have bought nothing.
                  prefetch
                  aria-current={isCurrent ? "page" : undefined}
                  className={cn(
                    "flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors",
                    isCurrent
                      ? "border border-border bg-card font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <StatusIcon
                      showLabel={false}
                      filled
                      icon={glyph}
                      status={
                        isBusy
                          ? "rendering"
                          : mapRailStatusToSceneStatus(
                              entry.status as Exclude<RailEntry["status"], "locked">,
                            )
                      }
                    />
                    <span className="truncate">{entry.label}</span>
                  </div>
                  {trailing && <span className="text-xs shrink-0 tabular-nums">{trailing}</span>}
                </Link>
              );
            })}

            {group.addScene ? <AddSceneRow target={group.addScene} /> : null}
          </div>
        ))}
      </div>
    </nav>
  );
}
