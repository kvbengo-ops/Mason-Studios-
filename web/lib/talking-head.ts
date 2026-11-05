// Pulled out of actions/brief.ts (a "use server" file, where every export
// must be an async Server Action) so this pure write-back rule stays a
// plain, synchronous, unit-testable function — same reasoning as
// lib/recompile-guard.ts and lib/enqueue-guard.ts.

/**
 * Overrides a freshly-(re)compiled scene's `is_talking_head` with the
 * operator's existing choice for that scene, discarding whatever the model
 * returned for that field. Used by applyScenePrompt and splitScene
 * (actions/brief.ts) after every compileScene() call.
 *
 * `is_talking_head` is not just a label on the brief: web/lib/
 * reference-selection.ts reads it to choose which reference image is sent
 * to the vendor (talking-head scenes get the character reference; every
 * other scene gets the character+product composite), and the Go worker's
 * PickModel reads it to choose which model renders the clip — a
 * talking-head scene routes to the native-audio lip-sync model at roughly
 * 3x the cost of a silent one (see 0019_seed_template_v5.sql §4). A
 * recompile that lets the model silently re-derive this field therefore
 * changes both what the ad shows and what it costs, without the operator
 * asking for either — under MOCK_CLAUDE=1 in particular, every compile
 * returns the same fixture (`is_talking_head: true`), so an unguarded Apply
 * or Split forces every scene it touches to A-roll.
 *
 * This is deliberately a write-back-level override, not a hint threaded
 * into compileScene's prompt. The v5 template (0019_seed_template_v5.sql
 * §4 "Set is_talking_head") has no "the operator already decided this,
 * don't re-derive it" input — it (re)derives is_talking_head fresh from the
 * script line and direction on every call, including for a brand-new
 * scene created by a split. Even if a hint were added to the prompt, the
 * model would still be free to disregard it; only overriding the field
 * after the fact guarantees an explicit operator choice can never be
 * silently reversed by a compile.
 */
export function preserveTalkingHead<T extends { is_talking_head: boolean }>(
  original: { is_talking_head: boolean },
  generated: T,
): T {
  return { ...generated, is_talking_head: original.is_talking_head };
}
