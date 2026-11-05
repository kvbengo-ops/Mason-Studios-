"use client";

// One pending flag for a server action, WITHOUT useTransition.
//
// WHY THIS EXISTS
//
// A pending transition blocks navigation. Next's <Link> starts its own
// transition to render the next route, and React will not run it while
// another transition is still awaiting a server action. On 2026-08-31 that
// meant clicking scene 4 in the rail during a $0.02 frame regeneration did
// nothing at all until the regeneration finished — reported as "nag try ako
// mag press sa 4th scene pero ayaw mag navigate". The link was never
// disabled; the navigation was queued behind the transition.
//
// scene-workbench.tsx was fixed by hand, and then the same shape turned up
// in seven other components: an awaited server action wrapped in
// startTransition purely to get a pending flag out of it. Every one of them
// sits on a route that renders the rail, and the slowest of them — a
// character image regeneration, a vision call against a product photo —
// hold it for seconds.
//
// None of these needed a transition in the first place. A transition is for
// keeping the OLD UI interactive while new UI renders; these are network
// calls whose result arrives as a server revalidation. Plain state gives the
// same spinner, paints more reliably (a transition's pending flag does not
// paint when delivery requires re-rendering a provider above the caller —
// the bug that shipped three times), and leaves the router free.
//
// `run` is stable, and always clears `pending` — including when the action
// throws, which is what a bare try/catch around a hand-rolled setState
// usually forgets and what leaves a spinner turning forever.
//
// WHEN NOT TO USE THIS
//
// Two kinds of caller genuinely need the transition and must keep it:
//
//   useOptimistic. The optimistic value lives only for as long as the
//   transition that set it — that is the whole contract. frame-grid.tsx,
//   scene-settings-panel.tsx and render-settings-form.tsx all dispatch an
//   optimistic update and then await the server inside the SAME transition,
//   which looks like the pattern this hook replaces and is not: split the
//   two and the overlay reverts the instant the dispatch settles, before
//   the server has answered. Their navigation cost is real and inherent.
//
//   <form action={...}>. A form action is a transition by construction, and
//   SubmitButton reads it through useFormStatus. script-setup-form.tsx's
//   compile is the long one, and it navigates on success anyway.
//
//   A deliberate navigation INSIDE the transition. use-character-button.tsx
//   calls router.replace within its own, so the spinner keeps turning until
//   the destination is actually ready rather than going idle over a page
//   that has already changed underneath it. There, holding the router is
//   the feature.
//
// So the sweep this hook came from ends where those three begin. A component
// that awaits a server action for its own pending flag, and nothing else,
// is the one this is for.
//
// ERRORS ARE THE CALLER'S. A rejection clears `pending` and then propagates,
// which for a fire-and-forget call means an unhandled rejection. That is
// deliberate: this hook cannot know whether a failure deserves a toast, a
// retry, or an inline message, and a shared helper that quietly swallowed
// every error would turn a broken action into a spinner that simply stops.
// Every caller therefore try/catches inside its own action — which all of
// them already did, since that is where the toast text lives.

import { useCallback, useRef, useState } from "react";

export interface AsyncAction {
  /** True from the moment `run` is called until its promise settles. */
  pending: boolean;
  /**
   * Runs `action`, holding `pending` for its duration.
   *
   * Re-entrant calls are IGNORED while one is in flight rather than queued:
   * every caller here spends money, and a second click during the first
   * call is a double-charge, not a second intention. Callers that also
   * disable their button get this as a second line of defence — the
   * disabled attribute does not survive a keyboard repeat or a fast
   * double-click landing before the re-render.
   */
  run: (action: () => Promise<void>) => void;
}

export function useAsyncAction(): AsyncAction {
  const [pending, setPending] = useState(false);
  // A ref as well as the state: `pending` inside `run`'s closure is the
  // value from the render that created it, so a second click in the same
  // tick would read false and start a second call.
  const inFlight = useRef(false);

  const run = useCallback((action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    void (async (): Promise<void> => {
      try {
        await action();
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    })();
  }, []);

  return { pending, run };
}
