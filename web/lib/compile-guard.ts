// Pure checks for the Compile step (docs/architecture.md § "User flow" step
// 3). Pulled out of actions/compile.ts (a "use server" file, where every
// export must be an async Server Action) so these stay plain, synchronous,
// unit-testable functions, mirroring lib/recompile-guard.ts.

/**
 * Throws unless the project has established a character to condition
 * scenes on — a typed description (`character_desc`), on its own or paired
 * with an uploaded/generated reference photo (a `character_ref` asset).
 *
 * A reference photo with NO description is refused, not accepted — this is
 * not the same rule character/page.tsx used to offer ("upload OR describe,
 * either is sufficient"). The bug that rule allowed: actions/compile.ts
 * only forwards `characterDesc` to lib/claude.ts's compileBrief when it's
 * set, and compileBrief omits the character section entirely when it's
 * falsy — so with no description, Claude INVENTS its own canonical
 * `character` string from the script alone, and that invented person gets
 * baked into every scene's `video_prompt` (0019_seed_template_v5.sql §2-3).
 * Frame generation, meanwhile, conditions on the actual uploaded photo
 * (actions/frames.ts). The prompt and the reference image end up
 * describing two different people at the same fal call, and the ad comes
 * back as the wrong person. A typed description is the only thing that
 * stops Claude from having to invent one, so it is now mandatory whenever
 * a photo exists — description-only compiles are unaffected, since there
 * is no photo for an invented description to contradict.
 *
 * Names both fixes rather than just one in each message, since the
 * operator may have already tried the other.
 */
export function assertHasCharacter(hasCharacterDesc: boolean, hasCharacterRefAsset: boolean): void {
  if (!hasCharacterDesc && !hasCharacterRefAsset) {
    throw new Error(
      "Project has no character to compile against — add a character description or upload a " +
        "reference photo on the Character step before compiling.",
    );
  }
  if (hasCharacterRefAsset && !hasCharacterDesc) {
    throw new Error(
      "This project has a character reference photo but no character description. Without a " +
        "description, the compiler invents its own — a different person than the one in the " +
        "photo — and every scene ends up conditioned on two different people at once. Add a " +
        "character description on the Character step before compiling.",
    );
  }
}
