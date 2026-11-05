import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ImageGenerationError,
  KieTaskPendingError,
  NO_ON_SCREEN_TEXT,
  generateImage,
  imagePromptWithGuards,
  __setKieFetchForTests,
  __setKiePollTimingForTests,
  __resetKieTestSeams,
} from "./kie";

// kie.ai's envelope is {code, msg, data} and HTTP is 200 EVEN ON FAILURE —
// code carries the real status. jsonResponse below always returns
// HTTP 200 (unless overridden), matching that: a test that wants to prove
// the `code` check fires must never rely on a non-2xx HTTP status to do it.
function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubEnv("KIE_API_KEY", "test-kie-key");
  // MODE=production: every test in this file (except the MODE=development
  // block below, which stubs its own value) exercises the real fetch path
  // via the injected fetchImpl, never lib/mode.ts's isDev() mock
  // short-circuit — which is otherwise the default MODE resolves to.
  vi.stubEnv("MODE", "production");
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetKieTestSeams();
});

describe("generateImage — success path", () => {
  it("returns the first resultUrl and the vendor-reported cost (creditsConsumed * $0.005)", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/createTask")) {
        return jsonResponse({ code: 200, msg: "success", data: { taskId: "task-1" } });
      }
      // resultJson is a JSON-ENCODED STRING on the real API, not a nested
      // object — encoded here with JSON.stringify the same way, so this
      // test fails if generateImageViaKie stops JSON.parsing it.
      return jsonResponse({
        code: 200,
        msg: "success",
        data: {
          taskId: "task-1",
          state: "success",
          resultJson: JSON.stringify({ resultUrls: ["https://kie.example/out.png"] }),
          creditsConsumed: 4,
        },
      });
    });
    __setKieFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateImage({ prompt: "a dog on a skateboard" });

    expect(result.url).toBe("https://kie.example/out.png");
    expect(result.vendor).toBe("kie");
    expect(result.costUsd).toBeCloseTo(0.02); // 4 credits * $0.005
  });
});

describe("generateImage — HTTP-200-with-error-code envelope", () => {
  // This is exactly the shape of bug this task's brief calls out: kie
  // returns HTTP 200 with `code` carrying the real failure, and a later
  // "no taskId" branch can accidentally make a broken `code` check look
  // like it's still working. data.taskId is deliberately populated here —
  // if createTask's `code !== 200` check were deleted, createTask would
  // happily return this taskId as though the submission succeeded.
  //
  // recordInfo is deliberately stubbed to a CLEAN success for that taskId
  // (not another error) — so if createTask's own check is what's deleted,
  // the whole call succeeds silently with no thrown error at all, and the
  // assertions below fail outright instead of coincidentally passing via
  // recordInfo's own (separate) code check. That coincidence is exactly
  // what happened on the first draft of this test, and exactly the trap
  // this task's brief warns about: a fixture must reach the line it claims
  // to protect, not a different line that happens to produce a similar
  // message.
  it("treats an HTTP-200 envelope with a non-200 code as a failure, even though data still carries a taskId", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/createTask")) {
        return jsonResponse({
          code: 422,
          msg: "Unsupported model",
          data: { taskId: "should-never-be-used" },
        });
      }
      return jsonResponse({
        code: 200,
        msg: "success",
        data: {
          taskId: "should-never-be-used",
          state: "success",
          resultJson: JSON.stringify({ resultUrls: ["https://kie.example/should-not-appear.png"] }),
          creditsConsumed: 4,
        },
      });
    });
    __setKieFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(generateImage({ prompt: "x" })).rejects.toThrow(ImageGenerationError);
    await expect(generateImage({ prompt: "x" })).rejects.toThrow(/code=422/);
    await expect(generateImage({ prompt: "x" })).rejects.toThrow(/Unsupported model/);
  });
});

describe("generateImage — poll budget", () => {
  it("expires with an error naming the task id when the task never reaches a terminal state", async () => {
    __setKiePollTimingForTests(20, 5); // 20ms budget, 5ms between polls — real values would take minutes.

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/createTask")) {
        return jsonResponse({ code: 200, msg: "success", data: { taskId: "stuck-task" } });
      }
      // Always "generating" — never success or fail, so only the budget
      // itself can end the poll loop.
      return jsonResponse({
        code: 200,
        msg: "success",
        data: { taskId: "stuck-task", state: "generating" },
      });
    });
    __setKieFetchForTests(fetchMock as unknown as typeof fetch);

    await expect(generateImage({ prompt: "x" })).rejects.toThrow(ImageGenerationError);
    await expect(generateImage({ prompt: "x" })).rejects.toThrow(/stuck-task/);
    await expect(generateImage({ prompt: "x" })).rejects.toThrow(/did not finish within/);
  });

  // The money check. A budget expiry is "we stopped waiting", not "it failed" —
  // kie keeps drawing and keeps billing — and the CALLERS tell the two apart by
  // type: actions/image-generator.ts leaves the reservation unsettled (so the
  // attempt panel can still finish it) only for KieTaskPendingError, and
  // lib/runs.ts's failedRunFields holds the estimate and keeps the task id only
  // for KieTaskPendingError. Throw a plain ImageGenerationError here again and
  // both silently revert to settling a live task and reporting a paid
  // generation as free.
  it("times out as a KieTaskPendingError carrying the task id, not a plain failure", async () => {
    __setKiePollTimingForTests(20, 5);

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/createTask")) {
        return jsonResponse({ code: 200, msg: "success", data: { taskId: "slow-task" } });
      }
      return jsonResponse({
        code: 200,
        msg: "success",
        data: { taskId: "slow-task", state: "generating" },
      });
    });
    __setKieFetchForTests(fetchMock as unknown as typeof fetch);

    const err = await generateImage({ prompt: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KieTaskPendingError);
    // Still an ImageGenerationError, so every existing `instanceof` check in the
    // action files keeps working unchanged.
    expect(err).toBeInstanceOf(ImageGenerationError);
    expect((err as KieTaskPendingError).taskId).toBe("slow-task");
    expect((err as KieTaskPendingError).vendorState).toBe("generating");
  });

  // The other half: a vendor-reported failure must NOT become pending, or a
  // dead task would hold budget and be polled forever.
  it("does not report a vendor failure as pending", async () => {
    __setKiePollTimingForTests(5_000, 5);

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/createTask")) {
        return jsonResponse({ code: 200, msg: "success", data: { taskId: "dead-task" } });
      }
      return jsonResponse({
        code: 200,
        msg: "success",
        data: { taskId: "dead-task", state: "fail", failMsg: "nope" },
      });
    });
    __setKieFetchForTests(fetchMock as unknown as typeof fetch);

    const err = await generateImage({ prompt: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageGenerationError);
    expect(err).not.toBeInstanceOf(KieTaskPendingError);
  });

  it("does NOT time out when the task succeeds before the budget expires", async () => {
    __setKiePollTimingForTests(5_000, 5);
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/createTask")) {
        return jsonResponse({ code: 200, msg: "success", data: { taskId: "task-2" } });
      }
      calls += 1;
      if (calls < 2) {
        return jsonResponse({
          code: 200,
          msg: "success",
          data: { taskId: "task-2", state: "waiting" },
        });
      }
      return jsonResponse({
        code: 200,
        msg: "success",
        data: {
          taskId: "task-2",
          state: "success",
          resultJson: JSON.stringify({ resultUrls: ["https://kie.example/out2.png"] }),
          creditsConsumed: 4,
        },
      });
    });
    __setKieFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateImage({ prompt: "x" });
    expect(result.url).toBe("https://kie.example/out2.png");
  });
});

// MODE=development (lib/mode.ts's default) short-circuits generateImage
// before it ever calls fetch — no vendor call is made. This is the fixture
// every action-file test relies on.
describe("generateImage — MODE=development", () => {
  it("returns a placeholder without calling fetch, and never bills anything", async () => {
    vi.stubEnv("MODE", "development");
    const fetchMock = vi.fn();
    __setKieFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateImage({ prompt: "a dog" });

    expect(result.vendor).toBe("kie");
    expect(result.costUsd).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Moved from lib/fal.test.ts when fal.ts was decommissioned — these guards
// are vendor-neutral and now live in lib/kie.ts, the sole implementation.
describe("imagePromptWithGuards", () => {
  it("appends the no-on-screen-text rule", () => {
    // A scene's reference frame came back with the spoken line burned into
    // the picture on 2026-08-31. The clip is rendered FROM the frame, so a
    // paid render inherits the text and warps it under motion.
    expect(imagePromptWithGuards("A woman in a kitchen")).toBe(
      `A woman in a kitchen ${NO_ON_SCREEN_TEXT}`,
    );
  });

  it("does not append it twice", () => {
    // The operator typed this sentence in by hand before the guard existed,
    // and that prompt is still saved on the scene.
    const already = `A woman in a kitchen. ${NO_ON_SCREEN_TEXT}`;
    expect(imagePromptWithGuards(already)).toBe(already);
  });

  it("trims first, so a trailing newline does not become a double space", () => {
    expect(imagePromptWithGuards("  A woman  \n")).toBe(`A woman ${NO_ON_SCREEN_TEXT}`);
  });
});
