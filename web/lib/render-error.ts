// Turns a raw `runs.error` string (worker/internal/loop/dispatch.go,
// reconcile.go — every failure path in the Go worker writes one) into
// something safe and useful to show an editor on the render/watch screen.
// See components/render-progress.tsx and actions/enqueue.ts's
// getSceneStatuses for the two places this gets called: server-side, so a
// raw vendor string never crosses the wire in the first place.

/**
 * Strips a raw worker error down to something safe to display.
 *
 * Worker errors are wrapped Go errors — `"submit to kie: %w"`,
 * `"sign reference frame url: %w"` (worker/internal/loop/dispatch.go) — so
 * the wrapped text is whatever the vendor (or our own signing code) echoed back
 * verbatim. In the signing path specifically, that can include the signed
 * `start_image_url` this app handed to the vendor: a Supabase signed URL, which
 * carries its access token in the query string. Showing that string
 * unfiltered on screen is not cosmetic — it leaks a working credential into
 * screenshots, support threads, and anywhere the page gets pasted or
 * shared. Anyone holding that URL can fetch the underlying storage object
 * until it expires, no login required.
 *
 * Two passes, both conservative on purpose (over-redacting a diagnostic
 * string is a much smaller problem than under-redacting a credential):
 *   1. Anything URL-shaped (`scheme://...` up to the next whitespace/quote)
 *      is removed outright, token and all.
 *   2. Anything still token-shaped afterward — a long, contiguous run of
 *      base64url/hex-ish characters — is redacted too, in case a token
 *      shows up outside a full URL (e.g. an echoed `Authorization: Bearer
 *      …` header, or a URL the vendor's own error text truncated before the
 *      scheme).
 *
 * This is the fallback text for a cause classifyRenderError doesn't
 * recognize — prefer its mapped human message wherever the cause IS
 * recognized; this function's job is only to make the leftover raw text
 * safe, not to make it friendly.
 */
export function sanitizeRenderError(raw: string): string {
  if (!raw) return "";

  let out = raw.replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, "[link removed]");

  // Dot-separated tokens first, and separately, because \b treats a dot as
  // a word boundary: the generic rule below sees a JWT as three independent
  // runs and only redacts the segments long enough on their own. A probe
  // against `token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1cmwiOiJhIn0.sig9`
  // left the payload and the signature intact — and a JWT's payload is
  // base64 of its claims, which for a Supabase storage token carries the
  // object path. Match the whole three-segment shape and take it out in one
  // piece.
  out = out.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, "[redacted]");

  // Belt-and-suspenders: redact any remaining long opaque run of
  // token/signature-shaped characters (JWTs, hex digests, base64url
  // signatures, API keys). 24 is high enough that ordinary identifiers in
  // worker error text (e.g. "insufficient_balance", 21 chars) survive,
  // while real tokens — which run to dozens or hundreds of characters —
  // still get caught.
  out = out.replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]");

  return out.trim();
}

export type RenderErrorCategory =
  | "insufficient_balance"
  | "rate_limited"
  | "content_policy"
  | "rejected"
  | "still_running"
  | "retryable"
  | "unknown";

export interface RenderErrorInfo {
  category: RenderErrorCategory;
  /** Whether an editor clicking Retry could plausibly get a different outcome. */
  retryable: boolean;
  /** Always safe to render as-is — either a mapped human message or sanitizeRenderError's output. */
  message: string;
}

// Matched case-insensitively against the raw (pre-sanitization) error text
// — these are all plain technical phrases, not URLs or tokens, so matching
// before sanitizing doesn't risk seeing a redacted placeholder instead of
// the real marker. Mirrors worker/internal/kie/client.go's own
// insufficientBalancePhrases list and dispatch.go's translated wrap
// ("the account is out of credit …").
const INSUFFICIENT_BALANCE_MARKERS = [
  "insufficient account balance",
  "insufficient balance",
  "insufficient credit",
  "insufficient funds",
  "insufficient_balance",
  "out of credit",
  "payment required",
  // kie.ai's own wording, measured against a drained account:
  // `{"code":402,"msg":"Credits insufficient : Your current balance isn't ..."}`.
  // Note the word order — "credits insufficient", not "insufficient credit" —
  // which is why none of the markers above matched it and a drained kie
  // account produced a raw, unclassified error instead of the one message
  // that tells an operator what to actually do.
  "credits insufficient",
  "code=402",
];

// 429 Too Many Requests and 408 Request Timeout, matching
// worker/internal/kie/client.go's doOnce: both mean the request was never
// actually billed (the vendor either refused to start it or it never completed),
// unlike an ordinary 4xx rejection of the input — so unlike REJECTED_MARKERS
// below, these ARE retryable. 408 is grouped in here rather than with
// RETRYABLE_MARKERS because the worker's wrapped text is just "client error:
// status 408: <body>" — it carries no "timeout" word for that generic marker
// to catch — and because the reasoning for retrying it is identical to
// 429's, not because the two failures mean the same thing.
//
// With ~20 editors submitting in parallel, 429 in particular is the
// *expected* failure at scale, not evidence of a bad prompt — see this
// file's module doc / the change that added this category.
const RATE_LIMITED_MARKERS = [/\bclient error: status 429\b/i, /\bclient error: status 408\b/i];

// the content-policy safety checker, observed live on fal: a run against the
// same reference photo, same project, four minutes apart, went
// OK/OK/FAIL/FAIL/FAIL/OK — three rejections of an input that had already
// rendered clean twice and rendered clean again on the fourth retry with
// nothing changed. So unlike an ordinary 4xx (REJECTED_MARKERS below),
// this specific rejection is a probabilistic verdict from a safety checker,
// not a verdict on the input — and every one of those failures billed $0.
// That makes it worth splitting out and marking retryable ahead of the
// generic 4xx check, which would otherwise swallow it.
const CONTENT_POLICY_MARKERS = [/content_policy_violation/i, /flagged by a content checker/i];

// A 4xx from fal (worker/internal/fal/client.go's doJSON doc comment) means
// fal refused the request itself, not a network hiccup — except the two
// statuses RATE_LIMITED_MARKERS claims above and content-policy rejections
// (CONTENT_POLICY_MARKERS above, checked first), which is why those checks
// run before this one. For everything else that's the closest real signal
// this codebase has for "retrying with the same input won't help."
const REJECTED_MARKERS = [/\bclient error: status 4\d\d\b/i];

// lib/kie.ts's KieTaskPendingError — the poll budget expired while the vendor
// was STILL DRAWING. Matched here, in the one place that turns a raw error
// string into advice, rather than at each of the three call sites that catch it:
// they all hand this text to classifyRenderError already.
//
// Checked BEFORE RETRYABLE_MARKERS, whose /\btimeout\b/ would otherwise claim it
// and print "retrying may work" — the single worst thing to tell an operator
// here. The task is alive and will still bill, so a retry does not replace the
// charge, it adds a second one.
const STILL_RUNNING_MARKERS = [/\bdid not finish within \d+s\b/i];

// Every one of these strings/patterns comes from an actual worker call
// site (worker/internal/loop/dispatch.go, reconcile.go,
// worker/internal/kie/client.go) — not invented. All describe a failure
// that is plausibly transient: a network/5xx blip, our own bookkeeping
// write failing, a wedged or lost request, or a step reconcile's giveUp
// backstop gave up on after retrying it repeatedly.
// THE VENDOR NAME IS DELIBERATELY NOT IN THESE PATTERNS.
//
// Two of them used to carry it, and both stopped matching the day fal was
// replaced: the worker writes "kie reported the render failed" and "claimed
// but never submitted to kie", while these read "fal". Neither matched, so the
// two most common reconcile outcomes fell through to the `unknown` branch at
// the bottom of classifyRenderError — which is also retryable: true, so the
// ADVICE stayed correct. What the operator lost was the explanation: instead
// of "this looks like a transient failure (network, timeout, or a dropped
// connection)" they got the raw Go error echoed back.
//
// Nothing failed. A regex that stops matching produces a vaguer answer, not an
// error, and the fal removal swept the code and the docs without reaching a
// string literal inside a pattern. So the vendor is out of the patterns
// entirely: the phrases below are the worker's own, minus the one word that
// changes when the vendor does. render-error-drift.test.ts reads those phrases
// straight out of reconcile.go and fails if any of them stops being
// recognised.
const RETRYABLE_MARKERS = [
  /\btimeout\b/i, // reconcile.go pastTimeout
  /\bserver error: status 5\d\d\b/i, // kie/client.go doOnce, 5xx
  /giving up after \d+ attempts/i, // kie/client.go doJSON, network/5xx exhausted
  /kept failing/i, // reconcile.go giveUpReason's reasonPrefixes
  /claimed but never submitted/i, // reconcile.go: worker crashed between claim and submit
  /reported the render failed/i, // reconcile.go: vendor-side failure, no detail of why
  /no reference frame/i, // dispatch.go: RefFrameURL lookup failed
  /sign reference frame url/i, // dispatch.go: signing failure
  /could not be saved/i, // dispatch.go: local record of an accepted job failed to persist
];

/**
 * Classifies a raw `runs.error` string into whether retrying is worth an
 * editor's money, and produces the message shown next to the Retry button.
 *
 * Order matters: insufficient balance is checked first since dispatch.go's
 * translated message ("the fal account is out of credit…") also contains
 * the word "credit", which could otherwise coincide with future rejected-
 * marker text. Rate-limit/timeout (429/408) is checked next, before the
 * general 4xx-rejected check, because REJECTED_MARKERS' pattern
 * (`client error: status 4\d\d`) would otherwise swallow both — a 429/408
 * was never billed and is retryable, unlike an ordinary rejection.
 * Content-policy rejections (CONTENT_POLICY_MARKERS) are checked next, also
 * before the general 4xx-rejected check and for the same reason: they're a
 * 4xx too, but a probabilistic one worth retrying, not a verdict on the
 * input. Falls through to "unknown" — sanitized raw text, not a guessed
 * category — rather than assuming a match exists; see this file's marker
 * lists for exactly which real worker strings are recognized today.
 */
/**
 * Which vendor's account an insufficient-balance message is about, read off
 * the error text itself.
 *
 * The text is the only evidence available here — classifyRenderError is a
 * pure function over a stored `runs.error` string, called long after the
 * request that produced it, so there is no request context left to consult.
 * Both clients embed their own name (worker/internal/kie/client.go writes
 * "kie: submit ...", lib/fal.ts and the Go fal client write "fal"), which is
 * what makes this readable rather than a guess.
 *
 * Falls back to a vendor-neutral phrase rather than picking one. Naming the
 * wrong account is worse than naming none: it sends an admin to top up a
 * balance that was never the problem.
 */
function vendorFromErrorText(lower: string): string {
  if (lower.includes("kie")) return "The kie.ai account";
  if (lower.includes("fal")) return "The fal account";
  return "The video vendor's account";
}

export function classifyRenderError(raw: string | null | undefined): RenderErrorInfo {
  const text = raw ?? "";
  const lower = text.toLowerCase();

  if (INSUFFICIENT_BALANCE_MARKERS.some((marker) => lower.includes(marker))) {
    return {
      category: "insufficient_balance",
      // Retryable, despite the message. An empty account is the one failure
      // here that is FIXED FROM OUTSIDE — someone funds it, or the render is
      // switched to a mocked/other vendor — and marking it permanent left a
      // scene with no way back at all: Retry hidden, and the only escape
      // was deleting the scene. It was observed in exactly that state after
      // the account was topped up.
      //
      // Safe to offer because nothing is spent on the click: enqueue's
      // pre-flight (assertWithinSpendCaps) re-reads the vendor's balance NOW
      // and refuses with its own message if it is still short. The stale
      // classification below is a description of what happened, not a
      // prediction of what will.
      retryable: true,
      // Names the account that is actually empty. This said "The fal
      // account" unconditionally, which under IMAGE_VENDOR=kie and
      // KIE_ENABLED=1 — production today — pointed an admin at the wrong
      // vendor's billing page while the one that refused stayed empty.
      // Neither name appearing is possible (a bare "payment required" from
      // somewhere new), so the fallback says nothing it cannot support.
      message: `${vendorFromErrorText(lower)} is out of credit. An admin needs to add funds before this scene can render — retry once it is funded.`,
    };
  }

  if (RATE_LIMITED_MARKERS.some((pattern) => pattern.test(text))) {
    return {
      category: "rate_limited",
      retryable: true,
      message:
        "The vendor is busy right now and didn't accept this request — nothing was charged, and nothing about your input needs to change. Retrying should work; we can't say exactly when.",
    };
  }

  if (CONTENT_POLICY_MARKERS.some((pattern) => pattern.test(text))) {
    return {
      category: "content_policy",
      retryable: true,
      message:
        "The vendor's safety checker flagged this attempt. It's inconsistent about the same input — the same photo has passed before and can pass again. Retrying often works, though we can't promise it will this time.",
    };
  }

  // BytePlus's own refusal codes (worker/internal/byteplus/client.go readable()): a verdict on
  // the input, unbilled. Its wrap says "(HTTP 400)", which REJECTED_MARKERS below never matched.
  if (/SensitiveContentDetected/i.test(text)) {
    return {
      category: "rejected",
      retryable: false,
      message: /PrivacyInformation/i.test(text)
        ? "BytePlus refused a reference that may show a real person. Use a different reference, or make the face with Seedream 5.0 Pro in the Image Generator — its faces are accepted. Nothing was charged."
        : "BytePlus blocked this as sensitive content. Change the prompt or references. Nothing was charged.",
    };
  }

  if (REJECTED_MARKERS.some((pattern) => pattern.test(text))) {
    return {
      category: "rejected",
      retryable: false,
      message:
        "The vendor rejected this request outright (invalid prompt, reference image, or settings). Retrying the same input will fail the same way — it needs a change first.",
    };
  }

  if (STILL_RUNNING_MARKERS.some((pattern) => pattern.test(text))) {
    return {
      category: "still_running",
      // Not retryable, and this is the one category where that word means
      // "pressing again costs money for nothing" rather than "it cannot
      // succeed". The vendor is still working on the request that already
      // exists.
      retryable: false,
      message:
        "This is taking longer than we wait for. The vendor is still generating it and will still charge for it — pressing the button again starts a second paid generation rather than replacing this one. Give it a couple of minutes and reload.",
    };
  }

  if (RETRYABLE_MARKERS.some((pattern) => pattern.test(text))) {
    return {
      category: "retryable",
      retryable: true,
      message:
        "This looks like a transient failure (network, timeout, or a dropped connection). Retrying may work.",
    };
  }

  const sanitized = sanitizeRenderError(text);
  return {
    category: "unknown",
    retryable: true,
    message: sanitized || "Unknown failure reason — retry may help.",
  };
}

/** Minimal shape this file needs from a `runs` row — matches the columns actions/enqueue.ts and the render page select. */
export interface RunErrorRow {
  scene_id: string | null;
  error: string | null;
  created_at: string;
}

/**
 * Reduces a project's `runs` rows down to the newest classified error per
 * `scene_id` — the TypeScript half of "one query, not N+1" (see
 * actions/enqueue.ts's getSceneStatuses and the render page's server
 * query, both of which fetch every error row for a project in one shot and
 * call this instead of querying per scene).
 *
 * Sorts defensively by created_at descending rather than trusting the
 * caller's query order, so this stays correct even if a future call site
 * fetches unordered rows — the "several run rows for one scene" case this
 * exists for only works if the reduction, not the query, is the source of
 * truth for "newest."
 */
export function latestErrorsByScene(rows: readonly RunErrorRow[]): Map<string, RenderErrorInfo> {
  const sorted = [...rows].sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  );
  const result = new Map<string, RenderErrorInfo>();
  for (const row of sorted) {
    if (!row.scene_id || !row.error || result.has(row.scene_id)) continue;
    result.set(row.scene_id, classifyRenderError(row.error));
  }
  return result;
}
