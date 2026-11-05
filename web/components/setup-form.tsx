"use client";

// One empty <form>, plus the pending/dirty tracking every Setup page needs,
// factored out from character-setup-form.tsx's original CharacterSetupForm
// so Character/Product/Script (and Settings' Direction+Captions section)
// don't each carry their own near-identical copy of it.
//
// WHY an empty <form> at all, rather than a normal wrapping one: every one
// of these pages interleaves its fields with OTHER real <form>s — upload,
// remove, regenerate, composite — physically between and even inside the
// same field groups. A <form> cannot nest inside another <form> (invalid
// HTML, and browsers mis-parse it), so a single wrapping <form> around a
// whole page is not an option. The fix, unchanged from the original: one
// real, empty `<form id={formId}>` with no children of its own, and every
// field elsewhere on the page points at it via the HTML `form="…"`
// attribute instead of DOM nesting — `new FormData(form)` collects any
// element whose `form` attribute names it, regardless of where in the
// document that element actually lives.
//
// createSetupForm(formId) is called ONCE per page, at module scope, so each
// page gets its OWN id and its OWN Context — see this feature's task for why
// that has to stay one-per-page rather than one shared instance: with four
// distinct routes there is no longer a single "the setup form" to share, and
// a shared instance would let a field rendered on one page submit through
// another page's id by accident.
//
// The one cost of skipping DOM nesting: React's useFormStatus (what
// PendingFieldset/SubmitButton normally read) only sees descendants of the
// <form> element, and these fields deliberately aren't descendants of it.
// So pending/dirty state is tracked by hand here, in a Context, instead.
//
// The nav-away guards (beforeunload + Link-click intercept) are copied
// verbatim from the original CharacterSetupForm — see git history / the
// character-setup-form.tsx file this was extracted from for the five live-
// testing defects `dirty` exists to fix.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from "react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/action-result";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import { useRailEntryBusy } from "@/components/project-rail";

/**
 * The entry id a page passes when it has no paid generation of its own (the
 * Script step). A constant, never an inline literal: useRailEntryBusy reads
 * a store keyed by this string, and a value that changes identity per render
 * would be a new key every time.
 */
const NO_BUSY_ENTRY = "__setup-form-no-busy-entry__";

export interface SetupFormState {
  pending: boolean;
  dirty: boolean;
  markDirty: () => void;
}

/**
 * `pending` travels through a STORE, never through the context value.
 *
 * Same defect, same cure as project-rail.tsx's RailBusyStore — read its
 * comment for the long version. `handleAction` runs INSIDE the transition
 * React opens for `<form action={…}>`, so `setPending(true)` is a
 * transition update. Delivering it through the context value means
 * re-rendering this provider, and the provider's subtree contains the very
 * form that is still pending, so React defers that render until the
 * transition settles — which is the moment the save finishes. The spinner
 * would appear one frame after the work it was reporting was already over,
 * which on screen is indistinguishable from no spinner at all.
 *
 * That is exactly what shipped: Save went dead-static on click, on both
 * Character and Product, and was reported as "may loading dapat ito".
 *
 * A store update reaches the button directly without the provider
 * rendering, so nothing about it is inside the transition. `dirty` stays in
 * ordinary state on purpose — it is set from a field's onChange, which is
 * not in a transition, and it must re-render the fields anyway.
 */
interface PendingStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => boolean;
  set: (pending: boolean) => void;
}

function createPendingStore(): PendingStore {
  let pending = false;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => pending,
    set(next) {
      if (pending === next) return;
      pending = next;
      for (const listener of listeners) listener();
    },
  };
}

/**
 * Stable identities for a field mounted with no provider (a test, a story).
 * useSyncExternalStore re-subscribes whenever `subscribe` changes identity,
 * so neither of these may be built inline.
 */
/**
 * How long an autosaving form waits after the last change.
 *
 * Long enough that typing a sentence is one write rather than forty, short
 * enough that clicking a radio and immediately navigating away still saves.
 * Guard #1 and #2 below also protect that case: a leave with `dirty` still
 * set is what they exist to catch.
 */
const AUTOSAVE_DEBOUNCE_MS = 700;

/**
 * The server snapshot for useSyncExternalStore below.
 *
 * No matching no-op `subscribe` here, unlike project-rail.tsx's version of
 * this pattern: that one tolerates a field mounted with no provider (a test,
 * a story), while this bundle throws in that case a few lines down — a field
 * pointing at #formId with no <SetupForm> around it is a wiring mistake, not
 * a state to render. So the real store's subscribe is always available.
 */
const notPending = (): boolean => false;

export interface SetupFormBundle {
  /** The id every field on this page's `form="…"` attribute must name. */
  formId: string;
  SetupForm: (props: {
    action: (formData: FormData) => Promise<ActionResult | void>;
    fallbackErrorMessage: string;
    /**
     * Where to go once the save succeeds — the next step in the Setup
     * sequence (Character → Product → Script). Optional: a page that is
     * the end of its own sequence, or that an operator edits in place,
     * passes nothing and stays put.
     */
    redirectOnSuccessTo?: string;
    /** Name of that next step, for the link Save leaves behind — e.g. "Product". */
    nextStepLabel?: string;
    /**
     * Save on change instead of on a button.
     *
     * For a form of pre-render SETTINGS — shooting mode, direction,
     * captions — where nothing is spent and every field is a preference.
     * A Save button there asks the operator to confirm a choice they have
     * already made, and the price of forgetting it is silent: the fields
     * show one thing and the next render uses another.
     *
     * Deliberately NOT the default. A form that spends money, or one whose
     * fields must be judged together before they mean anything, wants the
     * button.
     */
    autoSave?: boolean;
    children: ReactNode;
  }) => JSX.Element;
  useSetupFormState: () => SetupFormState;
  UnsavedChangesNotice: () => JSX.Element | null;
  /**
   * The one Save control for this page. Unlike the original
   * CharacterSetupForm's SaveButton, there is no "title still saves while
   * locked" exception here: none of the three split pages carry a title
   * field any more (see character-setup-form.tsx's TitleField doc comment,
   * now on settings/page.tsx), so a locked page has nothing left that can
   * ever legally save — Save is disabled outright, not merely narrowed.
   */
  SaveButton: (props: {
    locked: boolean;
    readOnly?: boolean;
    /** Rail entry this page's paid generations report under — Save shuts while one runs. */
    busyEntryId?: string;
  }) => JSX.Element | null;
}

/**
 * Builds one independent `{ formId, SetupForm, useSetupFormState,
 * UnsavedChangesNotice, SaveButton }` bundle, all bound to `formId`. Call
 * once per page, at module scope — see this file's header for why one
 * instance per page, not a shared singleton.
 */
export function createSetupForm(formId: string): SetupFormBundle {
  interface ContextValue {
    pendingStore: PendingStore;
    dirty: boolean;
    markDirty: () => void;
    redirectOnSuccessTo?: string;
    nextStepLabel?: string;
    autoSave: boolean;
    savedAt: number | null;
  }
  const Context = createContext<ContextValue | null>(null);

  function useSetupFormState(): SetupFormState {
    const ctx = useContext(Context);
    if (!ctx) {
      throw new Error(`Fields for #${formId} must render inside its own <SetupForm>.`);
    }
    // Subscribed, not read off the context value — see PendingStore above.
    const pending = useSyncExternalStore(
      ctx.pendingStore.subscribe,
      ctx.pendingStore.getSnapshot,
      notPending,
    );
    return { pending, dirty: ctx.dirty, markDirty: ctx.markDirty };
  }

  function UnsavedChangesNotice(): JSX.Element | null {
    const { dirty } = useSetupFormState();
    if (!dirty) return null;
    return (
      <p className="text-sm font-medium text-foreground" role="status">
        Unsaved changes — nothing below has taken effect yet. Click &ldquo;Save&rdquo; to apply
        them.
      </p>
    );
  }

  function SetupForm({
    action,
    fallbackErrorMessage,
    redirectOnSuccessTo,
    nextStepLabel,
    autoSave = false,
    children,
  }: {
    action: (formData: FormData) => Promise<ActionResult | void>;
    fallbackErrorMessage: string;
    redirectOnSuccessTo?: string;
    nextStepLabel?: string;
    autoSave?: boolean;
    children: ReactNode;
  }): JSX.Element {
    const router = useRouter();
    const pendingStore = useMemo(createPendingStore, []);
    const [dirty, setDirty] = useState(false);
    const [savedAt, setSavedAt] = useState<number | null>(null);
    const markDirty = useCallback(() => setDirty(true), []);

    // Autosave. Debounced, because these fields include free text and a
    // round trip per keystroke would be both wasteful and jumpy, and driven
    // through the form's own requestSubmit rather than by calling `action`
    // directly — requestSubmit collects every field pointing at this id
    // (see this file's header on the empty-<form> pattern), which is the
    // only way to send the whole set rather than the one field that changed.
    useEffect(() => {
      if (!autoSave || !dirty) return;
      const timer = setTimeout(() => {
        const form = document.getElementById(formId);
        if (form instanceof HTMLFormElement) form.requestSubmit();
      }, AUTOSAVE_DEBOUNCE_MS);
      return (): void => clearTimeout(timer);
    }, [autoSave, dirty]);

    // Read by the click guard, which is registered once and must not close
    // over the first render's value of a prop that can change.
    const autoSaveRef = useRef(autoSave);
    autoSaveRef.current = autoSave;

    const dirtyRef = useRef(dirty);
    useEffect(() => {
      dirtyRef.current = dirty;
    }, [dirty]);

    // Guard #1: a real page leave — tab close, refresh, typed URL, a plain
    // (non-Link) <a>.
    useEffect(() => {
      function handleBeforeUnload(e: BeforeUnloadEvent): void {
        if (!dirtyRef.current) return;
        // Autosaving forms still warn HERE, unlike guard #2 below: a tab
        // close cannot be outrun by a request, so the pending change would
        // genuinely be lost. The prompt is only wrong when the navigation
        // is one this app controls.
        e.preventDefault();
        e.returnValue = "";
      }
      window.addEventListener("beforeunload", handleBeforeUnload);
      return (): void => window.removeEventListener("beforeunload", handleBeforeUnload);
    }, []);

    // Guard #2: Next's own client-side <Link> navigation, which does not
    // fire beforeunload at all. A capture-phase listener runs before Link's
    // own bubble-phase click handler, so preventDefault() here reliably
    // stops the soft navigation before Link ever sees an un-prevented
    // event. Not covered: Back/Forward — see the original CharacterSetupForm
    // this was extracted from for why that's structurally unreachable.
    useEffect(() => {
      function handleClick(e: MouseEvent): void {
        if (!dirtyRef.current) return;
        if (e.defaultPrevented || e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

        const anchor = (e.target as HTMLElement).closest("a");
        if (!anchor) return;
        if (anchor.target && anchor.target !== "_self") return;
        if (anchor.hasAttribute("download")) return;

        const href = anchor.getAttribute("href");
        if (!href || href.startsWith("#")) return;

        let url: URL;
        try {
          url = new URL(href, window.location.href);
        } catch {
          return;
        }
        if (url.origin !== window.location.origin) return;

        // An autosaving form has nothing to ask about. `dirty` here means
        // "the debounce has not fired yet", not "you decided not to save" —
        // so the honest move is to fire it now and let the navigation go,
        // rather than to interrogate the operator about a save they never
        // opted out of. Without this, clicking a rail row within 700ms of
        // touching a radio button produced a confirm dialog for a change
        // that was already on its way.
        if (autoSaveRef.current) {
          const form = document.getElementById(formId);
          if (form instanceof HTMLFormElement) form.requestSubmit();
          dirtyRef.current = false;
          return;
        }

        if (!window.confirm("You have unsaved changes on this page. Leave without saving?")) {
          e.preventDefault();
          e.stopPropagation();
        } else {
          // Confirmed: clear the ref (not React state — no re-render needed,
          // the page is about to be replaced) so guard #1 doesn't show a
          // second, native prompt for the plain-<a> links this listener also
          // catches.
          dirtyRef.current = false;
        }
      }
      document.addEventListener("click", handleClick, true);
      return (): void => document.removeEventListener("click", handleClick, true);
    }, []);

    async function handleAction(formData: FormData): Promise<void> {
      pendingStore.set(true);
      // Only a save that actually navigates keeps the spinner on. A FAILED
      // save on a redirecting page must still release it, or the button
      // spins forever on a page that is going nowhere.
      let navigating = false;
      try {
        const result = await action(formData);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        // Clear `dirty` BEFORE navigating. Guard #2 only intercepts anchor
        // clicks, so it cannot stop this push, but guard #1's beforeunload
        // would still fire on a hard reload mid-navigation — and the page
        // is genuinely saved by now, so there is nothing left to warn about.
        setDirty(false);
        setSavedAt(Date.now());
        if (redirectOnSuccessTo) {
          // The Setup steps are a sequence an operator walks once, and Save
          // was the end of the road: it saved, said nothing, and left them
          // on the page they had just finished to work out where to go next.
          // Landing on the next step is the answer to "what now", and it
          // doubles as the success signal this button never had.
          //
          // Deliberately NOT pendingStore.set(false) on this path — the
          // button stays spinning until the new route paints, because the
          // save is done but the operator's wait is not.
          navigating = true;
          router.push(redirectOnSuccessTo);
          return;
        }
      } catch (err) {
        unstable_rethrow(err);
        toast.error(err instanceof Error ? err.message : fallbackErrorMessage);
      } finally {
        if (!navigating) pendingStore.set(false);
      }
    }

    return (
      <Context.Provider
        value={{
          pendingStore,
          dirty,
          markDirty,
          redirectOnSuccessTo,
          nextStepLabel,
          autoSave,
          savedAt,
        }}
      >
        <form id={formId} action={handleAction} />
        {children}
      </Context.Provider>
    );
  }

  function SaveButton({
    locked,
    readOnly = false,
    busyEntryId,
  }: {
    locked: boolean;
    readOnly?: boolean;
    /**
     * The rail entry this page's paid generations report under
     * (RAIL_ENTRY_CHARACTER, RAIL_ENTRY_PRODUCT). Given it, Save shuts while
     * one of them is running.
     *
     * Those generations are separate <ActionForm>s on the Server Component
     * page, so this form's own `pending` never sees them — which is how the
     * Product step ended up offering a live Save underneath a card reading
     * "Generating…". The description could be edited and saved while an
     * image was being built from the OLD text, and nothing recorded which
     * version the image came from.
     *
     * They already WRITE the signal (RailBusyWhileSubmitting). Nothing was
     * reading it. Optional so a page with no paid generation on it — the
     * script step — is unchanged.
     */
    busyEntryId?: string;
  }): JSX.Element | null {
    const { pending, dirty } = useSetupFormState();
    const ctx = useContext(Context);
    const generating = useRailEntryBusy(busyEntryId ?? NO_BUSY_ENTRY);
    if (readOnly) return null;

    // An autosaving form has no button to render — only a word about what
    // just happened. Deliberately a status line and not a silent one: a
    // field that saves itself with no acknowledgement is indistinguishable
    // from a field that did nothing, which is the complaint the old "Nothing
    // to save" line was trying and failing to answer.
    if (ctx?.autoSave) {
      if (locked) {
        return (
          <p className="text-sm text-muted-foreground">
            This project has been delivered, so this step is locked. Reopen it from the Deliver page
            to make changes.
          </p>
        );
      }
      return (
        <p className="text-xs text-muted-foreground" role="status">
          {pending
            ? "Saving…"
            : dirty
              ? "Unsaved changes"
              : ctx.savedAt !== null
                ? "Saved."
                : "Changes save themselves."}
        </p>
      );
    }

    // With Save now carrying the operator to the next step, a page with
    // nothing to save has no way forward at all — Save is the road, and on
    // a step they have already finished it is greyed out. That is precisely
    // the page someone lands on when they come back to check their work.
    // So when there is nothing to save, the forward move is offered as its
    // own control instead of hidden behind a disabled one.
    const showNextStep = !locked && !dirty && Boolean(ctx?.redirectOnSuccessTo);
    return (
      <div className="flex flex-col gap-2">
        {locked ? (
          <p className="text-sm text-muted-foreground">
            This project has been delivered, so this step is locked. Reopen it from the Deliver page
            to make changes.
          </p>
        ) : null}
        <UnsavedChangesNotice />
        {/* Says WHY the button is inert. Regenerating an image, uploading a
            photo and picking a library character are all their own actions
            that save themselves — none of them makes this form dirty, so an
            operator who has just done one comes back to a greyed-out Save
            with nothing explaining it and reads it as broken. Asked in those
            words: "nag regenerate ako, tapos un save disable pa din?" */}
        {!locked && !dirty && !generating ? (
          <p className="text-xs text-muted-foreground">
            Nothing to save — the fields above match what is stored. Buttons like Regenerate and
            Upload save themselves as soon as they finish.
          </p>
        ) : null}
        {/* The third reason Save can be inert, and the only one that is
            temporary. Said out loud for the same reason the other two are:
            the complaint that produced the sentence above was about a greyed
            button with nothing explaining it. */}
        {!locked && generating ? (
          <p className="text-xs text-muted-foreground">
            An image is generating from what is currently stored. Save comes back when it finishes —
            saving now would leave the picture and the words describing it out of step.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <PendingButton
            type="submit"
            form={formId}
            pending={pending}
            disabled={!dirty || locked || generating}
          >
            Save
          </PendingButton>
          {showNextStep && ctx?.redirectOnSuccessTo ? (
            // Secondary, never primary: Save is still the button that
            // matters on a page with unsaved work, and this one appears
            // only when there is none. A plain Link, so it costs nothing
            // and the dirty-guard has nothing to intercept.
            <Button asChild variant="outline">
              <Link href={ctx.redirectOnSuccessTo}>
                Continue to {ctx.nextStepLabel ?? "the next step"}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return { formId, SetupForm, useSetupFormState, UnsavedChangesNotice, SaveButton };
}
