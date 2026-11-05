// How long a blocking image generation may poll kie, as its own module so
// lib/models.ts can read it without importing lib/kie.ts.
//
// That import direction matters: lib/models.ts is imported by "use client"
// components (render-gate, scene-table, ...), so anything it pulls in ships to
// the browser. lib/kie.ts is the vendor client — it has no business in a client
// bundle, and this repo has already shipped an SDK to the browser once
// (see lib/claude.ts's server-only guard). A number has no such problem.
//
// 100s is the deployed ceiling and is NOT arbitrary: Render's edge and the
// proxies in front of a server action cut a blocked request somewhere in the
// 30-100s range, and whoever fires first writes the error the operator reads.
// See lib/kie.ts's own poll-budget block for the full reasoning.
//
// Raising it is NOT the answer to a slow model. A generation measured at 149s
// exceeds this budget, and pushing the number past the platform's own cut just
// swaps a named, task-id-carrying handoff for a generic gateway timeout that
// carries nothing. The budget expiring is a handoff (lib/kie.ts's
// KieTaskPendingError), so a slow task is finished by reconciliation rather
// than by waiting longer.
//
// KIE_POLL_BUDGET_MS raises it, and only means anything HOST-RUN, where there
// is no edge in front of `next dev` and this constant is the only thing ending
// the poll. Setting it on a deployed service buys nothing — the platform still
// cuts the request, and the operator gets a generic gateway timeout instead of
// a named error carrying the task id. Deployed services leave it unset.
export const KIE_POLL_BUDGET_MS = Number(process.env.KIE_POLL_BUDGET_MS) || 100_000;
