// Shared return shape for every Server Action that can fail in a way the
// operator is meant to read and act on.
//
// React redacts errors *thrown* from a Server Action once the app is built
// for production: the client sees only "Minified React error #441; visit
// https://react.dev/errors/441…", which decodes to "The specific message is
// omitted in production builds to avoid leaking sensitive details." That
// applies indiscriminately — it does not distinguish a carefully-worded
// guard ("Rendering has already started on this project — render settings
// are locked") from a raw Postgres error, so a thrown guard message is a
// message the operator will never read outside local dev. The only way to
// get a message to the client in production is to return it as data instead
// of throwing it.
//
// So: validation/guard failures the operator can act on (wrong scene status,
// over budget, locked settings) must be returned as an ActionResult. Genuine
// failures nobody anticipated (a Postgres error, a null we never expected)
// should stay thrown — those are correctly redacted, since there's nothing
// an operator can do with "the database returned an error" beyond reporting
// a bug, and error #441 is more informative to us in a server log than a
// leaked implementation detail would be to them.
//
// `redirect()` is a deliberate exception: it works by throwing an error
// tagged with a NEXT_REDIRECT digest, which is Next's own control-flow
// mechanism, not a failure. Every call site that awaits one of these actions
// still needs `unstable_rethrow` for that reason — see action-form.tsx and
// render-confirm-dialog.tsx.
export type ActionResult =
  | {
      error: string;
      /**
       * Always absent, and the mirror of ActionNotice.error below. The two
       * optional-never fields are what let a caller read `.error` or
       * `.notice` on a union of both without narrowing first — otherwise
       * adding notices would have meant a type assertion at every site that
       * already reads one of them.
       */
      notice?: undefined;
    }
  | undefined;

/**
 * An action that SUCCEEDED but has something the operator needs to know.
 *
 * Returned for the same reason an error is — React redacts anything thrown
 * from a Server Action in production, so data is the only channel to the
 * client — but it is not a failure and must never read as one. The work
 * happened; this says something about what it did.
 *
 * The case it exists for: a prompt naming a reference that no longer exists.
 * The clip renders and bills either way (see actions/ugc.ts's
 * resolveElementTags — "an unsubstituted tag is a worse clip, not a lost
 * one"), and that trade is deliberate and older than this type. What was
 * missing was anyone being TOLD. The tag loses its '@' in the worker and
 * arrives as an ordinary word, so the render looks completely normal and is
 * simply missing the face or the voice that was asked for.
 *
 * Refusing the render instead would be the wrong fix: it fights a rule this
 * codebase states in three places, and it would block a render the cap has
 * already been charged for.
 */
export type ActionNotice = {
  notice: string;
  /**
   * Always absent, declared so every existing `result?.error` narrows
   * against this shape too. Without it a union of the two types makes
   * `.error` unreadable at ~40 call sites that have nothing to do with
   * notices, and the type would have bought a warning at the cost of
   * touching every action in the app.
   */
  error?: undefined;
};

/**
 * Runs a synchronous guard (one of the `assert*` functions in
 * lib/enqueue-guard.ts, lib/recompile-guard.ts, lib/spend.ts, …) and turns a
 * thrown Error into a returned ActionResult instead of letting it propagate.
 * The guards themselves stay throwing, plain, unit-testable functions —
 * this is the one place their throw gets converted, right at the Server
 * Action boundary where the redaction problem above actually bites.
 */
export function guardResult(fn: () => void): ActionResult {
  try {
    fn();
    return undefined;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "This action was refused." };
  }
}
