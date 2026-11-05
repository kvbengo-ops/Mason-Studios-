"use client";

// An app-wide "something is uploading" line, reported into from wherever an
// upload actually happens: the /ugc reference picker's batch loop
// (ugc-reference-picker.tsx) and the /elements library's single-file drop
// (elements-library.tsx, via ReferenceDropzone + ActionForm). Rendered once,
// at the top of the viewport, by app/(app)/layout.tsx — so it is visible from
// either page and from every OTHER page too, which is the point: an operator
// who starts a batch on /ugc and clicks over to /elements should still see it
// moving.
//
// THE SAME MISTAKE AS RAILBUSYSTORE (project-rail.tsx), FOR THE SAME REASON.
// Read that file's doc comment above `RailBusyStore` before touching this —
// it is not a stylistic echo, it is the same bug: a batch upload is awaited
// inside an event handler (a plain async function, not a Server Action and
// not a form's own pending state) that keeps running after the dialog that
// started it has closed and unmounted. If progress lived in that component's
// `useState`, closing the dialog would either lose every update the still-
// running loop makes (React drops a state update dispatched against an
// unmounted fiber) or, worse, corrupt whatever remounted in its place. A
// store update reaches this file's <UploadProgressBar/> directly, with no
// component in between that could be unmounted out from under it, so the
// loop keeps reporting truthfully for exactly as long as it keeps running —
// which, since nothing here cancels it, is the whole batch.
//
// One provider-scoped store, not a module singleton, mirroring RailBusyStore
// again: two providers in one test tree (or, plausibly here, a project page
// nested under a route that also renders its own upload surface someday)
// must not report into each other.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from "react";
import { useFormStatus } from "react-dom";

/**
 * `done`/`total` are real counts, not an animation — same reasoning as the
 * `uploadProgress` state this replaced inside ugc-reference-picker.tsx: with
 * a Claude describe call on every picture, a batch is long enough that
 * "still working" is not enough to say, and a bar that fills on a timer
 * would be a lie that looks like information.
 *
 * ONE ACTIVE BATCH, GLOBALLY. Two surfaces feed this store (the /ugc picker
 * and the /elements library), and a single operator running both at once in
 * two tabs is a real but vanishingly rare edge case; the alternative — a
 * keyed map of concurrent batches — is real complexity for a case nobody has
 * hit yet. Last write wins, same as any other single-flight status line in
 * this app (e.g. the rail's busy set has the same "whoever wrote last"
 * shape for a given entryId).
 */
export interface UploadBatchProgress {
  done: number;
  total: number;
}

interface UploadProgressStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => UploadBatchProgress | null;
  setProgress: (progress: UploadBatchProgress | null) => void;
}

const UploadProgressContext = createContext<UploadProgressStore | null>(null);

/**
 * Stable identities for the no-provider case (a component rendered in
 * isolation — a test, a story) — see RailBusyStore's own comment on
 * `noopSubscribe`/`emptySnapshot` for why these may not be built inline:
 * useSyncExternalStore re-subscribes whenever `subscribe` changes identity
 * and throws if `getSnapshot` returns a new object on every call.
 */
const noopSubscribe = (): (() => void) => () => {};
const emptySnapshot = (): UploadBatchProgress | null => null;
const noopSetProgress = (): void => {};

export function UploadProgressProvider({ children }: { children: ReactNode }): JSX.Element {
  const stateRef = useRef<{
    progress: UploadBatchProgress | null;
    listeners: Set<() => void>;
  } | null>(null);
  stateRef.current ??= { progress: null, listeners: new Set() };

  const value = useMemo<UploadProgressStore>(() => {
    const state = stateRef.current!;
    return {
      subscribe: (listener) => {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
      getSnapshot: () => state.progress,
      setProgress: (progress) => {
        // Same-value writes dropped before anything is notified, so a loop
        // re-reporting an unchanged done/total (retryOne publishing the same
        // {done: index, total} it already holds) can't spin the subscribers.
        const prev = state.progress;
        const same =
          prev === progress ||
          (prev !== null &&
            progress !== null &&
            prev.done === progress.done &&
            prev.total === progress.total);
        if (same) return;
        state.progress = progress;
        for (const listener of state.listeners) listener();
      },
    };
  }, []);

  return (
    <UploadProgressContext.Provider value={value}>{children}</UploadProgressContext.Provider>
  );
}

/** The read side, for <UploadProgressBar/> and anything else that displays it. */
export function useUploadProgress(): UploadBatchProgress | null {
  const store = useContext(UploadProgressContext);
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
}

/**
 * The write side, for a loop that owns a whole batch (ugc-reference-picker's
 * saveElement/retryOne). Grabbed once via this hook and then called from
 * inside a plain async function — including after the component that called
 * the hook has unmounted, which is exactly the point: the returned function
 * closes over the store's own `setProgress`, not over anything belonging to
 * the calling component, so it is just as valid to call after that
 * component is gone as sonner's `toast()` is.
 */
export function useUploadProgressSetter(): (progress: UploadBatchProgress | null) => void {
  const store = useContext(UploadProgressContext);
  return store?.setProgress ?? noopSetProgress;
}

/**
 * The write side for a plain `<form action={...}>` submission — the
 * /elements library's upload, which is a single ActionForm around
 * registerElement rather than a hand-rolled loop. There is no batch object
 * to iterate here, only React's own pending flag, so the "batch" this
 * reports is always {done: 0, total: 1}: known to be running, with no
 * finer-grained progress a one-shot Server Action could ever supply.
 *
 * Render this as a child of the <form> — same placement rule as
 * RailBusyWhileSubmitting in project-rail.tsx, and for the same reason:
 * useFormStatus only answers for a client component that is itself inside
 * the form it is asking about.
 */
export function UploadProgressWhileSubmitting(): null {
  const { pending } = useFormStatus();
  const setProgress = useUploadProgressSetter();

  useEffect(() => {
    setProgress(pending ? { done: 0, total: 1 } : null);
    // Clears on unmount too, not only when `pending` goes false — mirrors
    // useRailBusyWhile's own cleanup, and for the same reason: a form that
    // unmounts mid-submit (this one does not today, but nothing enforces
    // that) must not leave the bar stuck at "uploading" for the rest of the
    // session.
    return () => setProgress(null);
  }, [pending, setProgress]);

  return null;
}
