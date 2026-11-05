import { describe, expect, it } from "vitest";
import { categorizeRun } from "./spend-categories";

// Pinning tests against the ACTUAL vendor/model strings this codebase
// writes to `runs` (see worker/internal/kie/models.go's Model.KieModelID and
// web/lib/kie/models.ts's KIE_MODELS) — not synthetic examples. If a future
// model rename or addition changes one of these strings without updating
// categorizeRun (and its SQL mirror, 0037_spend_category_totals.sql), this
// is the test that catches the drift instead of a real render silently
// miscounting as cheap iteration or vice versa.
describe("categorizeRun", () => {
  it("categorizes every real video model's wire id as 'render'", () => {
    expect(categorizeRun("kie", "bytedance/seedance-2-5")).toBe("render");
    expect(categorizeRun("kie", "kling-3.0/video")).toBe("render");
    expect(categorizeRun("kie", "hailuo/2-3-image-to-video-pro")).toBe("render");
  });

  it("categorizes every real Claude compile as 'iterate'", () => {
    // actions/compile.ts / actions/brief.ts record vendor: "anthropic" for
    // every full-script compile, per-scene compile, and Apply/Split call —
    // the model id varies (whichever Claude model is configured), but the
    // vendor alone already settles this bucket.
    expect(categorizeRun("anthropic", "claude-sonnet-5")).toBe("iterate");
    expect(categorizeRun("anthropic", "claude-haiku-4.5")).toBe("iterate");
  });

  it("categorizes every real kie reference-frame image model as 'iterate'", () => {
    // web/lib/kie.ts's modelForImageArgs — the only two models a reference
    // frame / character / composite generation ever writes. Both are vendor
    // "kie", same as a video render, so the model string alone is what
    // keeps these out of 'render' — see this file's own header.
    expect(categorizeRun("kie", "google/nano-banana")).toBe("iterate");
    expect(categorizeRun("kie", "google/nano-banana-edit")).toBe("iterate");
  });

  it("is a total function: every (vendor, model) pair lands in exactly one bucket, never neither", () => {
    // Not a tautological identity — a CASE with no ELSE (or a JS switch
    // with no default) can silently produce a third state (null/undefined)
    // that drops a row from both buckets. categorizeRun's return type is
    // "iterate" | "render" with no third value, so this is enforced at the
    // type level too; this test pins the runtime behavior for an input the
    // Set lookup has never seen before.
    const category = categorizeRun("kie", "some/future-model");
    expect(["iterate", "render"]).toContain(category);
  });

  it("an unrecognized kie model (not in KIE_MODELS) falls to 'iterate', not 'render'", () => {
    // The safer default: undercounting a stray/unknown kie call as cheap
    // iteration is a much smaller error than overcounting it as an
    // expensive render — and it matches the exact-match Set design (see
    // this file's own header) rather than a broad "vendor === 'kie'" guess.
    expect(categorizeRun("kie", "some/future-model")).toBe("iterate");
  });
});
