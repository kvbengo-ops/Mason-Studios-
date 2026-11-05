// The Image Generator's recovery flow (0095_image_attempt_recovery.sql).
//
// What is under test is the part an operator only meets on a bad day: they left
// the page while an image was drawing, and came back. The money rules are what
// make it worth pinning — every branch here either avoids a second real charge
// or refuses to hide one.
//
// The database, the vendor, storage and the guard are all mocked, exactly as
// actions/compile.test.ts does: what these tests are about is the ORDER of the
// decisions and what each one returns, not PostgREST's own behaviour.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/actions/guard";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { checkImageTask, generateImage } from "@/lib/kie";
import {
  attachRunAsset,
  isRunInFlight,
  reserveImageAttempt,
  settleRunSuccess,
  sweepStaleImageReservations,
} from "@/lib/runs";
import { resolveImageAttemptCeilings } from "@/lib/spend";
import { signedUrl } from "@/lib/storage";
import { BILLING_UNKNOWN_PREFIX } from "@/lib/image-attempt";

vi.mock("@/actions/guard", () => ({
  requireUser: vi.fn(),
  requireProject: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/kie", () => ({
  generateImage: vi.fn(),
  checkImageTask: vi.fn(),
  modelForImageArgs: vi.fn((args: { model?: string }) => args.model ?? "google/nano-banana"),
  // A real class, declared INSIDE the factory. The action narrows on
  // `instanceof ImageGenerationError` and a plain object would silently take
  // the wrong branch — but a class declared at the top of this file cannot be
  // referenced here at all: vi.mock is hoisted above every declaration, so the
  // binding is still in its temporal dead zone when this runs.
  ImageGenerationError: class ImageGenerationError extends Error {},
  KieTaskPendingError: class KieTaskPendingError extends Error {},
}));

vi.mock("@/lib/runs", () => ({
  attachKieTaskId: vi.fn(async () => undefined),
  attachRunAsset: vi.fn(async () => "linked"),
  holdRunBillingUnknown: vi.fn(async () => undefined),
  isRunInFlight: vi.fn(async () => false),
  releaseRun: vi.fn(async () => undefined),
  reserveImageAttempt: vi.fn(),
  settleRunSuccess: vi.fn(async () => undefined),
  sweepStaleImageReservations: vi.fn(async () => 0),
  recordRun: vi.fn(async () => undefined),
}));

vi.mock("@/lib/spend", () => ({
  assertWithinSpendCaps: vi.fn(async () => undefined),
  assertKieBalanceCoversEstimate: vi.fn(() => undefined),
  resolveImageAttemptCeilings: vi.fn(),
}));

vi.mock("@/lib/kie-balance", () => ({
  getKieAccountBalanceUsd: vi.fn(async () => 100),
}));

vi.mock("@/lib/claude", () => ({
  compileImageSequence: vi.fn(),
  CLAUDE_VENDOR: "anthropic",
}));

vi.mock("@/lib/storage", () => ({
  signedUrl: vi.fn(async (key: string) => `https://signed.test/${key}?token=fresh`),
  uploadFromUrl: vi.fn(async () => ({ storageKey: "users/user-1/generated_image/new.png" })),
  removeStorageObjects: vi.fn(async () => undefined),
}));

// Development mode: skips the vendor balance read, which is not what any of
// these tests are about. It does NOT mock the vendor call away — @/lib/kie is
// already mocked above, so a test asserting generateImage was never called is
// still asserting something real.
vi.mock("@/lib/mode", () => ({ isDev: () => true }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

interface FakeBuilder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  not: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: (
    onFulfilled: (r: FakeResult) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => Promise<unknown>;
}

/**
 * Every filter returns the builder; the terminals resolve. `then` is what lets
 * a chain ending in `.limit()` be awaited directly, which is how the attempts
 * query is written.
 */
function fakeBuilder(result: FakeResult = { data: null, error: null }): FakeBuilder {
  const builder: FakeBuilder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    not: vi.fn(() => builder),
    in: vi.fn(() => builder),
    or: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

function fakeClient(tables: Record<string, FakeBuilder>): { from: ReturnType<typeof vi.fn> } {
  return {
    from: vi.fn((table: string) => {
      const builder = tables[table];
      if (!builder) throw new Error(`Test did not stub table "${table}"`);
      return builder;
    }),
  };
}

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    idempotency_key: "key-1",
    created_at: "2026-09-08T03:00:00.000Z",
    model: "google/nano-banana",
    error: null,
    settled_at: null,
    kie_task_id: null,
    asset_id: null,
    ...overrides,
  };
}

const ASSET_ROW = {
  id: ASSET_ID,
  created_at: "2026-09-08T03:01:00.000Z",
  storage_key: "users/user-1/generated_image/done.png",
};

beforeEach(() => {
  vi.mocked(requireUser).mockResolvedValue({
    user: { id: "user-1" },
    profile: { role: "editor" },
  } as never);
  vi.mocked(resolveImageAttemptCeilings).mockResolvedValue({
    globalDailyCapUsd: 100,
    weeklyCapUsd: 10,
    dailyCapUsd: 5,
    dailyCapEnabled: false,
  } as never);
});

afterEach(() => {
  // clear, not reset: the implementations declared in the vi.mock factories
  // above (signedUrl's fresh-token stub, uploadFromUrl's storage key) are the
  // fixture, and resetAllMocks would strip them after the first test and leave
  // every later one asserting against undefined.
  vi.clearAllMocks();
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

// ---------------------------------------------------------------------------
describe("loadPersonalImageAttempts", () => {
  it("returns an attempt that is still generating, so the page can say so", async () => {
    // The whole point of the flow: the operator left, and the server still
    // knows a submitted attempt has not come back.
    const runs = fakeBuilder({ data: [runRow({ kie_task_id: "task-1" })], error: null });
    vi.mocked(createClient).mockResolvedValue(fakeClient({ runs }) as never);

    const { loadPersonalImageAttempts } = await import("./image-generator");
    const attempts = await loadPersonalImageAttempts();

    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("generating");
    expect(attempts[0]!.idempotencyKey).toBe("key-1");
    expect(attempts[0]!.image).toBeNull();
  });

  it("scopes the read to the caller's own project-less attempts", async () => {
    // Never another account's work, and never a project-backed attempt reached
    // by a leaked id — the two filters that make this surface personal.
    const runs = fakeBuilder({ data: [], error: null });
    vi.mocked(createClient).mockResolvedValue(fakeClient({ runs }) as never);

    const { loadPersonalImageAttempts } = await import("./image-generator");
    await loadPersonalImageAttempts();

    expect(runs.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(runs.is).toHaveBeenCalledWith("project_id", null);
    // And only the Image Generator's own rows, not every run this account has.
    expect(runs.not).toHaveBeenCalledWith("idempotency_key", "is", null);
  });

  it("mints a fresh signed URL for a completed attempt rather than storing one", async () => {
    // Requirement: no expiring URL is durable state. The row carries an asset
    // id; the link is made at read time, every time.
    const runs = fakeBuilder({
      data: [
        runRow({ settled_at: "2026-09-08T03:01:00Z", kie_task_id: "task-1", asset_id: ASSET_ID }),
      ],
      error: null,
    });
    const assets = fakeBuilder({ data: ASSET_ROW, error: null });
    vi.mocked(createClient).mockResolvedValue(fakeClient({ runs, assets }) as never);

    const { loadPersonalImageAttempts } = await import("./image-generator");
    const attempts = await loadPersonalImageAttempts();

    expect(attempts[0]!.status).toBe("completed");
    expect(signedUrl).toHaveBeenCalledWith(ASSET_ROW.storage_key, undefined, expect.anything());
    expect(attempts[0]!.image?.url).toContain("token=fresh");
  });

  it("shows a failed attempt's reason", async () => {
    const runs = fakeBuilder({
      data: [
        runRow({
          settled_at: "2026-09-08T03:01:00Z",
          error: "kie createTask rejected the request: code=422",
        }),
      ],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(fakeClient({ runs }) as never);

    const { loadPersonalImageAttempts } = await import("./image-generator");
    const attempts = await loadPersonalImageAttempts();

    expect(attempts[0]!.status).toBe("failed");
    expect(attempts[0]!.reason).toBe("kie createTask rejected the request: code=422");
  });

  it("strips the billing-unknown marker but keeps the task id for a human to check", async () => {
    // The task id is shown for exactly this state, because this is the one
    // where somebody has to look it up before deciding to pay again.
    const runs = fakeBuilder({
      data: [
        runRow({
          settled_at: "2026-09-08T03:01:00Z",
          kie_task_id: "task-9",
          error: `${BILLING_UNKNOWN_PREFIX}kie task task-9 failed: quota exceeded`,
        }),
      ],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(fakeClient({ runs }) as never);

    const { loadPersonalImageAttempts } = await import("./image-generator");
    const attempts = await loadPersonalImageAttempts();

    expect(attempts[0]!.status).toBe("billing_unknown");
    expect(attempts[0]!.reason).toBe("kie task task-9 failed: quota exceeded");
    expect(attempts[0]!.kieTaskId).toBe("task-9");
  });
});

// ---------------------------------------------------------------------------
describe("generatePersonalImage with a key that has been used before", () => {
  const submission = form({
    prompt: "a red ceramic mug on white",
    idempotencyKey: "key-1",
    imageModel: "nano-banana",
    aspectRatio: "9:16",
  });

  beforeEach(() => {
    vi.mocked(reserveImageAttempt).mockResolvedValue({
      outcome: "duplicate",
      runId: RUN_ID,
    } as never);
  });

  it("returns the image the first attempt already produced, without generating again", async () => {
    // THE DOUBLE-CHARGE TEST. An operator who navigates away and comes back
    // presses Generate on the restored draft with the same key. Before 0088 the
    // schema could not identify the picture, so this could only refuse; now it
    // hands the picture back and no vendor call is made.
    const runs = fakeBuilder({ data: { asset_id: ASSET_ID }, error: null });
    const assets = fakeBuilder({ data: ASSET_ROW, error: null });
    vi.mocked(createAdminClient).mockReturnValue(fakeClient({ runs, assets }) as never);

    const { generatePersonalImage } = await import("./image-generator");
    const result = await generatePersonalImage(submission);

    expect(result.error).toBeUndefined();
    expect(result.image?.assetId).toBe(ASSET_ID);
    expect(result.image?.url).toContain("token=fresh");
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("hands back the running attempt, key kept, while the first attempt is still running", async () => {
    // The key must survive: a fresh one on the next press would start a second
    // paid attempt beside the one already drawing. The personal generator hands
    // the running attempt back so the form waits on it instead of refusing.
    const runs = fakeBuilder({ data: { asset_id: null }, error: null });
    vi.mocked(createAdminClient).mockReturnValue(fakeClient({ runs }) as never);
    vi.mocked(isRunInFlight).mockResolvedValue(true);

    const { generatePersonalImage } = await import("./image-generator");
    const result = await generatePersonalImage(submission);

    expect(result.image).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.pendingRunId).toBe(RUN_ID);
    expect(result.keyExhausted).toBeUndefined();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("exhausts the key when the earlier attempt settled without an image", async () => {
    // Otherwise a failed generation would be refused as its own duplicate for
    // ever, and the operator could never retry that prompt.
    const runs = fakeBuilder({ data: { asset_id: null }, error: null });
    vi.mocked(createAdminClient).mockReturnValue(fakeClient({ runs }) as never);
    vi.mocked(isRunInFlight).mockResolvedValue(false);

    const { generatePersonalImage } = await import("./image-generator");
    const result = await generatePersonalImage(submission);

    expect(result.keyExhausted).toBe(true);
    expect(generateImage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("reconcilePersonalImageAttempt", () => {
  it("leaves a still-drawing attempt alone", async () => {
    const runs = fakeBuilder({ data: runRow({ kie_task_id: "task-1" }), error: null });
    vi.mocked(createClient).mockResolvedValue(fakeClient({ runs }) as never);
    vi.mocked(checkImageTask).mockResolvedValue({ state: "pending", vendorState: "generating" });

    const { reconcilePersonalImageAttempt } = await import("./image-generator");
    const attempt = await reconcilePersonalImageAttempt(RUN_ID);

    expect(attempt.status).toBe("generating");
  });

  it("does not ask kie about an attempt that already has an image", async () => {
    // A terminal row cannot change, and a poll per tick against the vendor for
    // an answer that is already known is a cost with no upside.
    const runs = fakeBuilder({
      data: runRow({
        settled_at: "2026-09-08T03:01:00Z",
        kie_task_id: "task-1",
        asset_id: ASSET_ID,
      }),
      error: null,
    });
    const assets = fakeBuilder({ data: ASSET_ROW, error: null });
    vi.mocked(createClient).mockResolvedValue(fakeClient({ runs, assets }) as never);

    const { reconcilePersonalImageAttempt } = await import("./image-generator");
    const attempt = await reconcilePersonalImageAttempt(RUN_ID);

    expect(attempt.status).toBe("completed");
    expect(checkImageTask).not.toHaveBeenCalled();
  });

  it("recovers a settled billing-unknown image without another submission", async () => {
    const row = runRow({
      settled_at: "2026-09-08T03:01:00Z",
      kie_task_id: "completed-task",
      error: `${BILLING_UNKNOWN_PREFIX}poll timed out`,
    });
    const runs = fakeBuilder({ data: row, error: null });
    const assets = fakeBuilder({ data: ASSET_ROW, error: null });
    vi.mocked(createClient).mockResolvedValue(fakeClient({ runs, assets }) as never);
    vi.mocked(createAdminClient).mockReturnValue(fakeClient({ runs, assets }) as never);
    vi.mocked(checkImageTask).mockResolvedValue({
      state: "success",
      url: "https://kie.test/image.png",
      costUsd: 0.02,
    });
    vi.mocked(attachRunAsset).mockImplementationOnce(async () => {
      runs.maybeSingle.mockResolvedValue({
        data: { ...row, asset_id: ASSET_ID, error: null },
        error: null,
      });
      return "linked";
    });

    const { reconcilePersonalImageAttempt } = await import("./image-generator");
    const result = await reconcilePersonalImageAttempt(RUN_ID);
    expect(checkImageTask).toHaveBeenCalledWith("completed-task");
    expect(settleRunSuccess).toHaveBeenCalledWith(RUN_ID, 0.02);
    expect(result.image?.assetId).toBe(ASSET_ID);
    expect(generateImage).not.toHaveBeenCalled();
    expect(reserveImageAttempt).not.toHaveBeenCalled();
  });

  it("keeps checking an old billing-unknown task that is still generating", async () => {
    const runs = fakeBuilder({
      data: runRow({
        settled_at: "2026-09-08T03:01:00Z",
        kie_task_id: "slow-task",
        error: `${BILLING_UNKNOWN_PREFIX}poll timed out`,
      }),
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(fakeClient({ runs }) as never);
    vi.mocked(checkImageTask).mockResolvedValue({ state: "pending", vendorState: "generating" });
    const { reconcilePersonalImageAttempt } = await import("./image-generator");
    expect((await reconcilePersonalImageAttempt(RUN_ID)).status).toBe("generating");
    expect(settleRunSuccess).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("hands a reserved-but-never-submitted attempt to the existing sweep", async () => {
    // No task id means nothing to reconcile against. "Abandoned" has exactly
    // one definition in this codebase and it lives in the sweep.
    const runs = fakeBuilder({ data: runRow(), error: null });
    vi.mocked(createClient).mockResolvedValue(fakeClient({ runs }) as never);

    const { reconcilePersonalImageAttempt } = await import("./image-generator");
    await reconcilePersonalImageAttempt(RUN_ID);

    expect(sweepStaleImageReservations).toHaveBeenCalledWith({ projectId: null, userId: "user-1" });
    expect(checkImageTask).not.toHaveBeenCalled();
  });

  it("refuses a run id that is not this account's", async () => {
    // The id arrives from the browser. The owner filter is what makes a guessed
    // one useless, and a miss must not read as "nothing to do".
    const runs = fakeBuilder({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue(fakeClient({ runs }) as never);

    const { reconcilePersonalImageAttempt } = await import("./image-generator");
    await expect(reconcilePersonalImageAttempt(RUN_ID)).rejects.toThrow("no longer available");
  });

  it("rejects a run id that is not a uuid before touching the database", async () => {
    const { reconcilePersonalImageAttempt } = await import("./image-generator");
    await expect(reconcilePersonalImageAttempt("not-a-uuid")).rejects.toThrow(
      "Invalid image attempt",
    );
    expect(createClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("generatePersonalImage hands a new attempt off instead of waiting on kie", () => {
  it("submits with a zero poll budget and returns the run id, key kept", async () => {
    // Waiting on kie inside the action held the page's one Server Action slot
    // for up to 100s, so Save to Elements queued behind it. The form now waits
    // by reconciling this run id; nothing here may block on the draw.
    vi.mocked(reserveImageAttempt).mockResolvedValue({ outcome: "reserved", runId: RUN_ID });
    // `runs` only for the prompt write (0116) the image viewer reads back.
    const runs = fakeBuilder();
    vi.mocked(createAdminClient).mockReturnValue(fakeClient({ runs }) as never);
    const { KieTaskPendingError } = await import("@/lib/kie");
    vi.mocked(generateImage).mockImplementation(async (args) => {
      await args.onTaskCreated?.("task-1");
      throw new KieTaskPendingError("task-1", "generating", "still drawing");
    });

    const { generatePersonalImage } = await import("./image-generator");
    const result = await generatePersonalImage(
      form({
        prompt: "a mug",
        idempotencyKey: "key-2",
        imageModel: "nano-banana",
        aspectRatio: "9:16",
      }),
    );

    expect(vi.mocked(generateImage).mock.calls[0]?.[0].pollBudgetMs).toBe(0);
    expect(result).toEqual({ pendingRunId: RUN_ID });
    expect(runs.update).toHaveBeenCalledWith({ prompt: "a mug" });
    expect(runs.eq).toHaveBeenCalledWith("id", RUN_ID);
  });
});
