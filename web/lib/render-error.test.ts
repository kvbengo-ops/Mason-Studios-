// Credential-redaction tests for sanitizeRenderError, plus coverage for
// classifyRenderError and latestErrorsByScene. sanitizeRenderError is the
// security-critical export here (see its doc comment): worker errors wrap
// whatever fal or our own signing code echoed back, which in the signing
// path can include a signed Supabase URL carrying a live access token in the
// query string. Every redaction assertion below checks BOTH directions: the
// secret substring is gone, AND useful diagnostic text survives — asserting
// only "output !== input" would pass a function that mangled the string
// while leaving the token in, and asserting only "token absent" would pass a
// function that nuked the whole string to "[redacted]".
import { describe, expect, it } from "vitest";
import {
  classifyRenderError,
  latestErrorsByScene,
  sanitizeRenderError,
  type RunErrorRow,
} from "./render-error";

// A real-shaped Supabase storage signed URL and its token, split apart so
// tests can assert the token substring specifically is absent (not just
// that some redaction happened somewhere in the string).
const SIGNED_URL_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1cmwiOiJtZWRpYS9wcm9qZWN0cy9hYmMvY2xpcC94Lm1wNCIsImlhdCI6MTcwMDAwMDAwMH0.k3x9pQ7z2vN8mLtR5wY1cB6dF4gH0jK2sT9uV3xW8yZ";
const SIGNED_URL = `https://xyzcompany.supabase.co/storage/v1/object/sign/media/projects/550e8400-e29b-41d4-a716-446655440000/clip/x.mp4?token=${SIGNED_URL_TOKEN}`;

// Deliberately NOT dot-separated (unlike SIGNED_URL_TOKEN's JWT shape) so
// tests using it exercise ONLY the third, generic "long opaque run" pass —
// a JWT-shaped fixture here would still get caught by the second (dotted)
// pass even with the third pass deleted, making the test vacuous against
// that mutation.
const BARE_TOKEN = "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4cD5eF6gH7iJ8kL9mN0oP1qR2sT3uV4wX5yZ";

describe("sanitizeRenderError", () => {
  it("redacts a signed Supabase URL wrapped in a Go error, and keeps the diagnostic text", () => {
    const raw = `sign reference frame url: submit to fal: ${SIGNED_URL}: 403 Forbidden`;
    const out = sanitizeRenderError(raw);

    expect(out).not.toContain(SIGNED_URL_TOKEN);
    expect(out).not.toContain("token=");
    // Useful diagnostic text must survive redaction, not just the fact that
    // *something* got redacted.
    expect(out).toContain("sign reference frame url");
    expect(out).toContain("submit to fal");
    expect(out).toContain("403 Forbidden");
  });

  it("redacts a bare token-shaped run with no URL present (e.g. echoed Authorization header)", () => {
    const raw = `submit to fal: got response Authorization: Bearer ${BARE_TOKEN}`;
    const out = sanitizeRenderError(raw);

    expect(out).not.toContain(BARE_TOKEN);
    expect(out).toContain("submit to fal");
    expect(out).toContain("Authorization: Bearer");
  });

  it("redacts a URL truncated before its scheme, leaving a bare token-shaped tail", () => {
    // Simulates fal's own error text getting cut off before "https://".
    const raw = `sign reference frame url: unexpected EOF while reading ...supabase.co/storage/v1/object/sign/media/x.mp4?token=${BARE_TOKEN}`;
    const out = sanitizeRenderError(raw);

    expect(out).not.toContain(BARE_TOKEN);
    expect(out).toContain("sign reference frame url");
    expect(out).toContain("unexpected EOF while reading");
  });

  it("redacts multiple URLs/tokens in one string, not just the first", () => {
    const secondToken =
      "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4cD5eF6gH7iJ8kL9mN0oP1qR2sT3uV4wX5yZ";
    const secondUrl = `https://xyzcompany.supabase.co/storage/v1/object/sign/media/projects/other/clip/y.mp4?token=${secondToken}`;
    const raw = `sign reference frame url: retry 1: ${SIGNED_URL} retry 2: ${secondUrl}: giving up after 3 attempts`;
    const out = sanitizeRenderError(raw);

    expect(out).not.toContain(SIGNED_URL_TOKEN);
    expect(out).not.toContain(secondToken);
    // If only the first URL's query string were stripped (e.g. a
    // non-global regex), the second URL's "token=" prefix would survive
    // even though its token value got mopped up by a later pass — still a
    // leak of which bucket/object the token unlocks.
    expect(out).not.toContain("token=");
    expect(out).toContain("retry 1");
    expect(out).toContain("retry 2");
    expect(out).toContain("giving up after 3 attempts");
  });

  it("handles empty and falsy input", () => {
    expect(sanitizeRenderError("")).toBe("");
  });

  it("leaves ordinary short diagnostic text alone", () => {
    const raw = "insufficient_balance: the fal account is out of credit";
    expect(sanitizeRenderError(raw)).toBe(raw);
  });

  // Covers the dot-separated JWT pass specifically, which the other cases do
  // NOT reach: deleting that pass leaves every other test here green, because
  // the generic {24,} rule catches whatever segment happens to be long enough
  // on its own and the rest survive. The probe from that pass's own comment,
  // run against the real function: with the pass, "token [redacted]"; without
  // it, "token [redacted].eyJ1cmwiOiJhIn0.sig9".
  //
  // The surviving middle segment is the JWT payload — base64 of the claims,
  // which for a Supabase storage token carries the object path. So the
  // assertions below are per-segment: a whole-string "changed?" check, or one
  // that only looks for the header, passes while the payload leaks.
  it("redacts every segment of a dot-separated JWT, not just the long ones", () => {
    const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const payload = "eyJ1cmwiOiJhIn0";
    const signature = "sig9";
    const out = sanitizeRenderError(
      `sign reference frame url: token ${header}.${payload}.${signature}`,
    );

    expect(out).not.toContain(header);
    expect(out).not.toContain(payload);
    expect(out).not.toContain(`${payload}.${signature}`);
    // The diagnostic half still has to survive, or over-redaction would
    // satisfy every assertion above while destroying the message.
    expect(out).toContain("sign reference frame url");
  });
});

describe("classifyRenderError", () => {
  it("maps insufficient balance markers, retryable once funded", () => {
    const info = classifyRenderError("dispatch: insufficient account balance for this call");
    expect(info.category).toBe("insufficient_balance");
    // Retryable: the failure is fixed from outside (someone funds the
    // account), and enqueue's pre-flight re-checks the balance on the click
    // itself, so nothing is spent if it's still empty.
    expect(info.retryable).toBe(true);
  });

  it("maps 429 to rate_limited (retryable)", () => {
    const info = classifyRenderError("submit to fal: client error: status 429: too many requests");
    expect(info.category).toBe("rate_limited");
    expect(info.retryable).toBe(true);
  });

  it("maps 408 to rate_limited (retryable)", () => {
    const info = classifyRenderError("submit to fal: client error: status 408: timeout");
    expect(info.category).toBe("rate_limited");
    expect(info.retryable).toBe(true);
  });

  it("maps content policy markers to retryable", () => {
    const info = classifyRenderError("fal reported content_policy_violation for reference image");
    expect(info.category).toBe("content_policy");
    expect(info.retryable).toBe(true);
  });

  it("maps a generic 4xx to rejected (not retryable)", () => {
    const info = classifyRenderError("submit to fal: client error: status 422: bad prompt");
    expect(info.category).toBe("rejected");
    expect(info.retryable).toBe(false);
  });

  it("maps BytePlus's real-person refusal to rejected, with its own advice", () => {
    // The worker's exact wrap (dispatch.go -> router.go -> client.go readable()).
    const info = classifyRenderError(
      "submit render: byteplus: submit bytedance/seedance-2-5: byteplus: BytePlus refused a reference that may show a real person (InputImageSensitiveContentDetected.PrivacyInformation). Use a different reference, or make the face with Seedream 5.0 Pro in the Image Generator. Nothing was charged. (HTTP 400)",
    );
    expect(info.category).toBe("rejected");
    expect(info.retryable).toBe(false);
    expect(info.message).toContain("real person");
    expect(info.message).not.toContain("[redacted]");
    // Seedance 2.5 on Kie is retired and BytePlus never falls back to it: never suggest it.
    expect(info.message).not.toMatch(/kie/i);
  });

  it("maps a generic retryable marker (timeout)", () => {
    const info = classifyRenderError("reconcile: timeout waiting for fal");
    expect(info.category).toBe("retryable");
    expect(info.retryable).toBe(true);
  });

  it("falls back to unknown with SANITIZED text for an unrecognized cause containing a credential", () => {
    const raw = `weird unrecognized worker failure: ${SIGNED_URL}`;
    const info = classifyRenderError(raw);

    expect(info.category).toBe("unknown");
    expect(info.retryable).toBe(true);
    // This is the seam where a credential would escape if the fallback ever
    // returned raw text instead of sanitizeRenderError's output.
    expect(info.message).not.toContain(SIGNED_URL_TOKEN);
    expect(info.message).toContain("weird unrecognized worker failure");
  });

  it("handles null and undefined as unknown, non-crashing", () => {
    expect(classifyRenderError(null).category).toBe("unknown");
    expect(classifyRenderError(undefined).category).toBe("unknown");
    expect(classifyRenderError(undefined).message).toBe("Unknown failure reason — retry may help.");
  });
});

describe("latestErrorsByScene", () => {
  it("picks the newest row per scene when rows arrive out of order", () => {
    const rows: RunErrorRow[] = [
      { scene_id: "scene-1", error: "timeout waiting for fal", created_at: "2026-01-01T00:00:00Z" },
      {
        scene_id: "scene-1",
        error: "client error: status 429: too many requests",
        created_at: "2026-01-03T00:00:00Z",
      },
      {
        scene_id: "scene-2",
        error: "insufficient account balance",
        created_at: "2026-01-02T00:00:00Z",
      },
      {
        scene_id: "scene-1",
        error: "client error: status 422: bad prompt",
        created_at: "2026-01-02T00:00:00Z",
      },
    ];

    const result = latestErrorsByScene(rows);

    // scene-1's newest row (2026-01-03, 429) must win over the earlier
    // 422 and timeout rows, even though it isn't first in the input array.
    expect(result.get("scene-1")?.category).toBe("rate_limited");
    expect(result.get("scene-2")?.category).toBe("insufficient_balance");
    expect(result.size).toBe(2);
  });

  it("skips rows with no scene_id or no error", () => {
    const rows: RunErrorRow[] = [
      { scene_id: null, error: "timeout", created_at: "2026-01-01T00:00:00Z" },
      { scene_id: "scene-3", error: null, created_at: "2026-01-01T00:00:00Z" },
    ];
    expect(latestErrorsByScene(rows).size).toBe(0);
  });
});

// Both halves of this shipped wrong, and production runs the configuration
// that exposes them: KIE_ENABLED=1 with IMAGE_VENDOR=kie, so kie is the
// account that actually runs dry.
describe("classifyRenderError, out of credit on kie", () => {
  // kie's real refusal, measured against a drained account. The word order is
  // the whole problem: "credits insufficient", not "insufficient credit", so
  // none of the pre-existing markers matched and this fell through to the
  // unclassified branch — a raw vendor string shown to an editor, with no
  // "retrying will not help" and no instruction.
  const KIE_402 =
    "kie: submit bytedance/seedance-2.5/reference-to-video: vendor reported code=402 " +
    'msg="Credits insufficient : Your current balance isn\'t enough for this request"';

  it("recognises kie's own wording as an out-of-credit refusal, retryable once funded", () => {
    const info = classifyRenderError(KIE_402);
    expect(info.category).toBe("insufficient_balance");
    expect(info.retryable).toBe(true);
  });

  it("names the kie account, not fal", () => {
    // The message said "The fal account" unconditionally, which sent an admin
    // to top up a balance that was never empty while the one that refused
    // stayed at zero.
    const info = classifyRenderError(KIE_402);
    expect(info.message).toContain("kie.ai account");
    expect(info.message).not.toContain("fal account");
  });

  it("still names fal when fal is the one refusing", () => {
    const info = classifyRenderError("fal: insufficient balance on this account");
    expect(info.category).toBe("insufficient_balance");
    expect(info.message).toContain("fal account");
  });

  it("names neither when the text names neither", () => {
    // A bare 402 from somewhere new. Saying nothing beats guessing a vendor.
    const info = classifyRenderError("Payment required");
    expect(info.category).toBe("insufficient_balance");
    expect(info.message).not.toContain("fal account");
    expect(info.message).not.toContain("kie.ai account");
  });
});

// The seam, pinned. lib/kie.ts writes these strings; render-error.ts reads
// them; nothing connected the two, which is exactly how the word-order
// mismatch survived — each half was individually reasonable. If either side
// is reworded, this fails instead of quietly degrading an editor's error
// message back into a raw vendor dump.
describe("what lib/kie.ts actually throws, classified", () => {
  // Verbatim shapes from lib/kie.ts's two `code !== 200` throws, with kie's
  // measured 402 envelope substituted in.
  const CREATE_TASK = (msg: string): string =>
    `kie createTask rejected the request: code=402 msg=${msg}`;
  const RECORD_INFO = (msg: string): string =>
    `kie recordInfo rejected task abc123: code=402 msg=${msg}`;

  const KIE_MSG = "Credits insufficient : Your current balance isn't enough for this request";

  it.each([
    ["createTask", CREATE_TASK(KIE_MSG)],
    ["recordInfo", RECORD_INFO(KIE_MSG)],
  ])("%s: reads as out of credit, names kie, and offers a retry once funded", (_label, raw) => {
    const info = classifyRenderError(raw);
    expect(info.category).toBe("insufficient_balance");
    expect(info.retryable).toBe(true);
    expect(info.message).toContain("kie.ai account");
    expect(info.message).toContain("retry once it is funded");
  });

  // Even if kie reworded the msg entirely, the envelope code is in the text
  // this side writes, so the category survives the wording changing under us.
  it("still classifies on the envelope code alone when the wording changes", () => {
    const info = classifyRenderError(CREATE_TASK("some future wording nobody has seen"));
    expect(info.category).toBe("insufficient_balance");
  });
});
