// What's left here after MOCK_CLAUDE/MOCK_FAL_IMAGE/MOCK_FAL_VIDEO were
// collapsed into the single MODE switch (lib/mode.ts — read its header for
// why three independent per-vendor flags were the shape of a real money
// bug). Whether a vendor call is mocked is now `isDev()`'s question, not
// this file's. What remains here are two things orthogonal to that
// question: how long a mock pretends to take, and how to tell — after the
// fact, from data — that a specific render actually was mocked.

/**
 * How long a mock should pretend to take, in milliseconds.
 *
 * The mocks used to return after a hardcoded 500ms, duplicated in lib/fal.ts
 * and lib/kie.ts. That is enough to prove a spinner appears and far too
 * short to test what happens AROUND a slow call — navigating away mid-flight,
 * coming back to a control that is still running, a rail row that has to
 * keep talking after its screen is gone. Every one of those bugs was found
 * by an operator sitting through a real ten-second vendor call, which is a
 * poor way to find them and a worse way to check the fix.
 *
 * MOCK_DELAY_MS makes that wait settable: `MOCK_DELAY_MS=30000` gives thirty
 * seconds to click around in. Only ever read from inside a mock branch, so
 * it cannot slow a real vendor call no matter what it is set to.
 *
 * Capped at two minutes. An extra zero in a .env is otherwise a request that
 * appears to hang forever, and the point of this is to make waiting
 * observable, not indefinite. A junk or negative value falls back to the
 * default rather than to zero — a mock that returns instantly is the one
 * shape guaranteed to hide the bugs this exists to surface.
 */
const DEFAULT_MOCK_DELAY_MS = 500;
const MAX_MOCK_DELAY_MS = 120_000;

export function mockDelayMs(): number {
  const raw = process.env.MOCK_DELAY_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MOCK_DELAY_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MOCK_DELAY_MS;
  return Math.min(parsed, MAX_MOCK_DELAY_MS);
}

/**
 * Whether this project has hard evidence that a video render was mocked —
 * the closest the web app can honestly get to "did a dev-mode worker render
 * this."
 *
 * The worker's own MODE lives in the worker's environment, a different
 * process from this one. The two services deliberately share nothing but
 * Postgres (render.yaml's own header comment), so the web app cannot read
 * it live, and this file does not attempt to guess at it or add an HTTP
 * call to find out. What it CAN prove is retrospective: the worker's mock
 * fal.Client stamps every mock submission's request id
 * "mock-<nanos>-<rand>" (worker/internal/fal/client.go's mockSubmit) into
 * scenes.kie_task_id, and that column is never overwritten back to empty
 * once set. A "mock-" prefixed id on any scene in this project is hard
 * proof that scene's clip was never sent to fal for real money — it is NOT
 * a claim about the worker's current MODE, which could have changed since
 * that scene was submitted. Callers must phrase the banner this way (past
 * tense, about specific scenes) rather than as "mock mode is on."
 *
 * scenes.dev is a stronger, forward-looking version of this same fact (it
 * says which mode WROTE the row, not which mode rendered it, and it exists
 * on every scene, not only ones that got as far as kie_task_id) — see
 * lib/mode.ts. This function stays because it answers a different
 * question, about clips already rendered before scenes.dev existed.
 */
export function hasMockVideoEvidence(
  scenes: readonly { kie_task_id: string | null }[],
): boolean {
  return scenes.some((scene) => scene.kie_task_id?.startsWith("mock-") ?? false);
}
