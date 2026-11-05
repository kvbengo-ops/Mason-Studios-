"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { ChangeEvent, FormEvent, JSX, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// 500ms: long enough that a normal typing cadence (multiple keystrokes
// within a word) collapses into a single navigation, short enough that
// pausing after a word feels immediate rather than sluggish. No config knob
// for it — one number, used once, isn't worth threading through props.
const DEBOUNCE_MS = 500;

export interface LiveSearchProps {
  /** Current `q` from the URL, i.e. what the server actually searched for. */
  q: string;
  placeholder: string;
  ariaLabel: string;
  /** No-JS fallback target — the same path the old plain GET form posted to. */
  action: string;
  /** Non-default sort/size, carried as hidden fields so the no-JS submit path preserves them exactly like the typed path does. */
  hiddenFields?: Record<string, string>;
  /** href for the "Clear" link, or null to hide it (nothing to clear). */
  clearHref: string | null;
  /** Optional controls rendered beside the search field. Used by /projects
   * to keep its owner filter and search in one compact toolbar. */
  leadingControls?: ReactNode;
  /** The results region (table + pagination, or the "no matches" empty state) — dimmed while a search navigation is in flight. */
  children: ReactNode;
}

/**
 * Type-to-search for /projects and /users. No API route, no Server Action:
 * the RSC payload these pages already render IS the search result — this
 * component only decides *when* to ask for a new one. `router.replace` (not
 * `push`, so typing doesn't fill the back button with a history entry per
 * debounce firing) inside `startTransition` re-requests the current page's
 * RSC payload with a new `?q=`; the server re-runs the exact same
 * `ilike`/RLS/sort/`.range()` query this page already had, just with a
 * different `q`. A REST handler or Server Action here would be a second copy
 * of that query with its own chance to drift from this one.
 *
 * Input focus/cursor survive every re-render because this component's own
 * identity never changes across a debounced navigation — only ITS `children`
 * prop (the Server Component subtree below it) gets swapped for a new one
 * once the transition resolves. The `<input>` is owned by this component's
 * `value`/`onChange` state, not by a `defaultValue` re-read from a prop on
 * every render, so React never has a reason to touch that DOM node; it just
 * updates surrounding text. (The old plain-GET-form version used
 * `defaultValue={q}` safely for the same reason a fully uncontrolled input
 * always is — but a controlled one needs the same discipline restated here,
 * since a naive `value={q}` bound straight to the search param WOULD fight
 * every keystroke, snapping back to the last-committed value on each
 * re-render.)
 */
// A function prop cannot cross the Server -> Client boundary: React throws
// at render, which surfaces as a 500 with the message redacted (#441). So
// this composes the URL itself from serializable props. `hiddenFields`
// already carries exactly the params to preserve (sort/dir/size, each
// omitted when it is the default), and `page` is always dropped because a
// new query makes any page but the first meaningless — the same contract
// the sort headers and the size control already follow.
function buildSearchHref(
  action: string,
  hiddenFields: Record<string, string> | undefined,
  q: string,
): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  for (const [key, value] of Object.entries(hiddenFields ?? {})) {
    params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${action}?${qs}` : action;
}

export function LiveSearch({
  q,
  placeholder,
  ariaLabel,
  action,
  hiddenFields,
  clearHref,
  leadingControls,
  children,
}: LiveSearchProps): JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const hrefFor = (next: string): string => buildSearchHref(action, hiddenFields, next);
  const [value, setValue] = useState(q);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // What this component itself last pushed into the URL. Lets the effect
  // below tell "the `q` prop changed because we changed it" (a no-op — the
  // input already shows this value) apart from "the `q` prop changed some
  // other way" (browser back/forward, a bookmarked/shared link landing on
  // an already-mounted instance) — the one case the input's own state
  // still needs to adopt.
  const lastPushedRef = useRef(q);

  useEffect(() => {
    if (q !== lastPushedRef.current) {
      lastPushedRef.current = q;
      setValue(q);
    }
  }, [q]);

  useEffect(() => {
    return (): void => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  function navigate(nextValue: string): void {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    lastPushedRef.current = nextValue;
    startTransition((): void => {
      router.replace(hrefFor(nextValue), { scroll: false });
    });
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const nextValue = event.target.value;
    setValue(nextValue);
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => navigate(nextValue), DEBOUNCE_MS);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    // With JS available, skip the full-page GET this <form> would otherwise
    // issue and take the same debounced path immediately instead — hitting
    // Enter or clicking Search shouldn't feel slower than just waiting
    // 500ms. Without JS this handler never runs and the native GET submit
    // (method="get", action below) is exactly the old behavior.
    event.preventDefault();
    navigate(value);
  }

  const searchForm = (
    <form
      action={action}
      method="get"
      onSubmit={handleSubmit}
      className={cn("flex flex-wrap items-center gap-2", leadingControls && "min-w-0 flex-1")}
    >
      <Input
        type="search"
        name="q"
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={cn("max-w-sm text-base md:text-sm", leadingControls && "max-w-none flex-1")}
      />
      {hiddenFields
        ? Object.entries(hiddenFields).map(([name, fieldValue]) => (
            <input key={name} type="hidden" name={name} value={fieldValue} />
          ))
        : null}
      {/* Inside <noscript>, because with JS on this button is not just
            redundant — it is misleading. Typing already searches after
            DEBOUNCE_MS, so a visible Search button teaches "type, then
            click", and every search then feels like it waited for a click
            it never needed. The whole point of the debounce is that there
            is nothing to press.

            It stays for the no-JS path, where it is the ONLY way to search
            (see this component's header: typing does nothing without JS,
            and dropping search entirely for those visitors was rejected).
            <noscript> is what expresses "only when scripting is off"
            without a client-side flag, which would flash the button on
            first paint and hide it a tick later. */}
      <noscript>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </noscript>
      {clearHref ? (
        <Button asChild variant="ghost">
          <Link href={clearHref}>Clear</Link>
        </Button>
      ) : null}
    </form>
  );

  return (
    <>
      {leadingControls ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 sm:flex-row sm:items-center">
          {leadingControls}
          <div aria-hidden="true" className="hidden h-6 w-px bg-border sm:block" />
          {searchForm}
        </div>
      ) : (
        searchForm
      )}
      {/* Dimmed, not replaced, while a debounced/Enter/Search navigation is
          in flight: the previous result set stays fully laid out and
          readable (no spinner swapped in, no layout jump), just softened
          enough that "this is stale" reads at a glance. `isPending` (from
          `useTransition` above) IS the loading flag — no parallel bit of
          state to keep in sync with it. `motion-reduce:transition-none`
          respects a `prefers-reduced-motion` visitor by making the dim
          state change instantly instead of fading. */}
      <div
        aria-busy={isPending}
        className={cn(
          "transition-opacity duration-150 motion-reduce:transition-none",
          isPending && "opacity-60",
        )}
      >
        {children}
      </div>
    </>
  );
}
