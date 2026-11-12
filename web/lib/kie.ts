// Image generation only (see docs/architecture.md § "Responsibility split").
//
// The web app generates *images* — character reference frames, product
// reference frames, and per-scene reference frames used for the "Review
// Frames" gate. It never generates video: video rendering is submitted to
// kie.ai exclusively by the Go worker's dispatch loop
// (worker/internal/kie), which is also the only thing that ever writes
// `scenes.status = 'rendering'`. If you find yourself wanting to call a
// video model from this file, that call belongs in the worker instead.
//
// kie.ai is the only image-generation vendor. fal.ai was decommissioned
// outright — this file used to be the kie-specific half of a two-vendor
// switch (lib/fal.ts held the default fal path and an IMAGE_VENDOR=kie env
// var routed here); both the switch and the fal path are gone, and this is
// now the whole of image generation. generateImage/modelForImageArgs carry
// the names the fal path used to own — there is no second vendor left to
// distinguish "via kie" from — and ImageGenerationError/imagePromptWithGuards/
// NO_ON_SCREEN_TEXT/GenerateImageArgs/GenerateImageResult, all genuinely
// vendor-neutral, moved here from lib/fal.ts rather than being deleted with
// it: every action file's `instanceof ImageGenerationError` check, and the
// "never put words on screen" guard every image prompt carries, are
// unrelated to which vendor answers the call.
//
// MODE=development short-circuits the real call with a placeholder image
// URL after a short delay, the same switch that keeps lib/claude.ts and the
// worker's video generation testable without spending real money — see
// lib/mode.ts's header for why this used to be three independent flags and
// no longer is.
//
// Contract verified against kie.ai's LIVE API on 2026-08-28 (not a guess,
// unlike worker/internal/kie/client.go's header, which is still
// unverified — this file's shape is confirmed, that one's is not):
//   POST https://api.kie.ai/api/v1/jobs/createTask
//        Header: Authorization: Bearer <KIE_API_KEY>
//        Body:   {"model": "...", "input": {...}, "callBackUrl": "..."}
//   GET  https://api.kie.ai/api/v1/jobs/recordInfo?taskId=<id>
// The envelope is {code, msg, data} and HTTP is 200 EVEN ON FAILURE — code
// carries the real status (422 unsupported model, 500 validation, 429 rate
// limit), so every response is checked on `code`, never on HTTP status.
// data.state goes waiting -> success (queuing/generating/fail also exist
// per the Go client, but only waiting/success have ever been observed).
// data.resultJson is a JSON-ENCODED STRING, not a nested object, holding
// {"resultUrls": [...]}.
//
// Both image models were verified with real paid calls: google/nano-banana
// (text-to-image, 4 credits = $0.02, 22s) and google/nano-banana-edit
// (reference-conditioned, 4 credits = $0.02, 70s). Both returned 768x1344
// PNG.

import { isDev } from "./mode";
import { mockDelayMs } from "./mock-flags";
import type { ImageAspectRatio } from "./image-aspect-ratios";
import type { ImageResolutionId } from "./image-resolutions";
import { kieImageInput } from "./kie/image-input";
import { KIE_POLL_BUDGET_MS } from "./kie/poll-budget";
import { SEEDREAM_PRO_ID } from "./seedream";
import { generateBytePlusSeedreamImage } from "./byteplus-image";

// Two endpoints, not one. The base model is text-to-image; passing image_urls
// to it is silently ignored. Reference-conditioned generation — which is how a
// character stays the same person across thirty clips — must go to /edit.
/**
 * Appended to EVERY image prompt.
 *
 * On 2026-08-31 a scene's reference frame came back with
 * "I've given up coffee... twice." burned into the picture. The prompt never
 * quoted the line — it said "as she recalls giving up coffee twice" — and the
 * image model wrote it on screen anyway.
 *
 * That is expensive rather than ugly: the clip is rendered FROM the frame, so
 * a paid render inherits the text, warps it under motion, and lands it on top
 * of the real burned-in captions the assemble step adds. The operator caught
 * it by eye and typed this sentence in by hand.
 *
 * The compiler template has carried a "Never put words on screen" rule for
 * video_prompt since v3 (see applyPronunciationGuide's comment in
 * lib/claude.ts). Nothing said it at IMAGE time, which is the layer that
 * actually draws.
 *
 * Appended here rather than written into the prompt column: it is a property
 * of how we generate, not of what the operator wrote, and a scene's saved
 * prompt should stay the words they can read and edit.
 */
export const NO_ON_SCREEN_TEXT =
  "No text, captions, subtitles, watermarks or written words anywhere in the frame.";

/** The prompt actually sent to an image model. */
export function imagePromptWithGuards(prompt: string): string {
  const trimmed = prompt.trim();
  // Idempotent: an operator who typed the sentence themselves (as one did,
  // before this existed) must not get it twice.
  if (trimmed.includes(NO_ON_SCREEN_TEXT)) return trimmed;
  return `${trimmed} ${NO_ON_SCREEN_TEXT}`;
}

// Same two-endpoint split the file header describes: the base model is
// text-to-image only, so a call that carries reference images must go to
// the edit model or they're silently dropped.
const TEXT_TO_IMAGE_MODEL = "google/nano-banana";
const EDIT_MODEL = "google/nano-banana-edit";

/**
 * Which model a call with these args would hit — exported so every caller
 * that needs to record a `runs.model` value (recordRun, lib/runs.ts) uses
 * the exact same rule generateImage itself uses to pick a model, including
 * on the failure path, where generateImage throws before it ever gets to
 * return which model it tried. One rule, read from both sides of the call,
 * instead of a second "does this have refs" check copied into every action
 * file that generates an image.
 */
export function modelForImageArgs(args: GenerateImageArgs): string {
  // An explicit choice wins, and is returned on the failure path too, so
  // runs.model names what was actually attempted rather than the default.
  if (args.model) return args.model;
  const hasRefs = args.refImageUrls !== undefined && args.refImageUrls.length > 0;
  return hasRefs ? EDIT_MODEL : TEXT_TO_IMAGE_MODEL;
}

// Every frame produced here becomes the init frame of a 9:16 vertical clip.
// A square reference frame gets cropped or letterboxed by the video model, so
// the aspect has to be right at generation time or the money is wasted twice.
const ASPECT_RATIO = "9:16";

const MOCK_IMAGE_URL = "https://placehold.co/1080x1920/png";

export interface GenerateImageArgs {
  prompt: string;
  /** The image generator may choose a ratio; video reference callers stay vertical. */
  aspectRatio?: ImageAspectRatio;
  /** Pixel tier for the models that document one; absent is 1K. */
  resolution?: ImageResolutionId;
  refImageUrls?: string[];
  /** Persist the task id before polling; a rejected callback stops polling. */
  onTaskCreated?: (taskId: string) => Promise<void>;
  /**
   * Overrides the nano-banana pair below with an explicit kie model id.
   *
   * For the Image Generator's model picker (lib/models.ts's IMAGE_MODELS),
   * whose prices are MEASURED per model. Every other caller omits it and keeps
   * the automatic text-to-image/edit choice exactly as before.
   *
   * The caller owns the consequences: a model with no reference-conditioned
   * variant will SILENTLY DROP image_urls (see this file's header), so whoever
   * sets this must refuse the combination rather than send it.
   */
  model?: string;
  /**
   * How long THIS call may block, overriding the module budget.
   *
   * 0 means "do not wait at all": submit, hand the task id to onTaskCreated, and
   * throw KieTaskPendingError immediately. That is the background path for a
   * model measured slower than the budget (lib/models.ts's blocksInline) — the
   * attempt panel finishes it by task id rather than a request sitting on a
   * server worker for 100s to discover what was already measured.
   */
  pollBudgetMs?: number;
  /** Seedream 5.0 Pro only: how long the BytePlus call may run (default 90s). */
  byteplusTimeoutMs?: number;
}

export interface GenerateImageResult {
  url: string;
  /**
   * Which vendor actually served this call. Always "kie" now — kie.ai is
   * the only image-generation vendor — but kept on the result rather than
   * inlined at every call site, the same reasoning lib/models.ts's
   * VideoModelDescriptor still keeps a `vendor`-shaped field name for even
   * with one vendor: a caller writing `runs.vendor` reads what actually
   * ran off the result, not a literal it typed itself.
   */
  vendor: "kie" | "byteplus";
  /**
   * The actual amount this call is known to have cost, in USD — non-null
   * whenever kie's response carries a billing figure (recordInfo's
   * creditsConsumed, a real vendor-reported charge, honoured over any
   * estimate) and null only when it doesn't. Mirrors the worker's own
   * kie.Result cost contract: a vendor-reported charge beats an estimate
   * whenever one exists, and null means "unknown," never a silent zero.
   */
  costUsd: number | null;
}

/**
 * Thrown by `generateImage` on a failed call, with `.message` already
 * carrying the best available operator-facing reason. Its own type, not a
 * bare `Error`, so every call site (actions/character.ts, actions/frames.ts)
 * can `catch` and return it as an `ActionResult` without a fragile
 * string/regex check to tell "the vendor rejected this prompt" apart from
 * "the database is down" — see lib/action-result.ts for why that
 * distinction is the whole point. Named for the era when fal was the only
 * vendor and never renamed since — every `instanceof ImageGenerationError`
 * check across this codebase still works unchanged regardless of which
 * vendor actually ran.
 */
export class ImageGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

/**
 * The poll budget ran out while kie still reported the task as PENDING.
 *
 * NOT a failure, and that distinction is the whole point of the type. kie keeps
 * drawing — and keeps billing — after this process stops waiting: a measured
 * generation took 149s against a 100s budget, so the budget expiring is the
 * NORMAL outcome for a slow model, not evidence anything went wrong.
 *
 * A subclass, so every existing `instanceof ImageGenerationError` check across
 * the action files keeps working unchanged. What it adds is the task id, because
 * the two things a caller must do here are the opposite of what a real failure
 * calls for: HOLD the money rather than release it, and hand the id to
 * `checkImageTask` later rather than resubmit and pay for the picture twice.
 */
export class KieTaskPendingError extends ImageGenerationError {
  constructor(
    readonly taskId: string,
    readonly vendorState: string | null,
    message: string,
  ) {
    super(message);
    this.name = "KieTaskPendingError";
  }
}

// --- Poll budget --------------------------------------------------------
//
// This file must poll recordInfo itself — kie has no blocking "wait for the
// vendor to finish" call — and the poll happens inside a Next.js server
// action the browser is waiting on.
//
// Observed: the text-to-image call took 22s, the edit call 70s
// (google/nano-banana-edit, 2026-08-28) — and a later one measured on kie's own
// dashboard took 149s. The budget does NOT cover that, deliberately (below),
// which is why expiring it has to be a handoff rather than a failure.
//
// 100s, not the 240s that one sample would justify on headroom alone,
// because this budget is in a RACE it must win. Render's edge and the
// ordinary Node-fronting proxies in front of a server action cut a blocked
// request somewhere in the 30-100s range. Whoever fires first writes the
// error the operator actually reads. Lose that race and they get a generic
// gateway timeout: no task id, no way to know the task may still be
// running and may still be billed — and this file's carefully named error
// is written to a socket nobody is holding.
//
// So the number is chosen to beat the platform, not to flatter the model.
//
// What it is NOT is a deadline for the task. Expiring the budget stops this
// request from blocking; it does not stop kie, which keeps drawing and keeps
// billing. So the expiry throws KieTaskPendingError (above) — a handoff
// carrying the task id, not a failure — and the attempt stays reconcilable
// through checkImageTask. Treating it as a failure is what previously settled
// a live reservation and lost a picture the account had already paid for; with
// a 149s generation against a 100s budget that was the ordinary outcome, not an
// edge case.
//
// ponytail: the poll still blocks up to 100s. kie supports callBackUrl, and a
// webhook would drop the blocking wait entirely — worth it if slow models
// become the norm, but it needs a public endpoint, a shared secret, and a
// per-caller "where does this image go" record that only the Image Generator
// keeps today.
//
// KIE_POLL_BUDGET_MS raises it host-run only; the value lives in
// lib/kie/poll-budget.ts so lib/models.ts can read it without importing this
// vendor client into a client bundle.
const POLL_BUDGET_MS = KIE_POLL_BUDGET_MS;
const POLL_INTERVAL_MS = 3_000;

// Test seams — mirrors lib/kie-balance.ts's own fetchImpl pattern.
// pollBudgetMs/pollIntervalMs are separately overridable so a test can
// exercise "the budget actually expires" in milliseconds instead of really
// waiting 100s, without having to fake the whole module's timers.
let fetchImpl: typeof fetch = fetch;
let pollBudgetMs = POLL_BUDGET_MS;
let pollIntervalMs = POLL_INTERVAL_MS;

export function __setKieFetchForTests(impl: typeof fetch): void {
  fetchImpl = impl;
}

export function __setKiePollTimingForTests(budgetMs: number, intervalMs: number): void {
  pollBudgetMs = budgetMs;
  pollIntervalMs = intervalMs;
}

export function __resetKieTestSeams(): void {
  fetchImpl = fetch;
  pollBudgetMs = POLL_BUDGET_MS;
  pollIntervalMs = POLL_INTERVAL_MS;
}

const BASE_URL = "https://api.kie.ai";

// 1 credit = $0.005, kie.ai's published rate, confirmed against the
// creditsConsumed value real paid calls returned (4 credits = $0.02 on both
// verified models above). Mirrors worker/internal/kie/client.go's own
// creditUSD constant.
const CREDIT_USD = 0.005;

interface KieEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

interface CreateTaskData {
  taskId: string;
}

interface RecordInfoData {
  taskId: string;
  state: string;
  resultJson: string;
  failMsg?: string;
  creditsConsumed?: number;
}

interface KieResultJson {
  resultUrls: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiKey(): string {
  const key = process.env.KIE_API_KEY;
  if (!key) {
    throw new ImageGenerationError("KIE_API_KEY is not set — cannot generate an image.");
  }
  return key;
}

/** POSTs createTask and returns kie's task id, or throws ImageGenerationError naming the real reason. */
async function createTask(model: string, input: Record<string, unknown>): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`${BASE_URL}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input }),
    });
  } catch (err) {
    throw new ImageGenerationError(
      `kie createTask request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // HTTP is 200 even for a vendor-side error — code carries the real
  // status. An actual non-2xx here means the request never reached kie's
  // own job logic at all (e.g. a network edge, not `code`), so it is still
  // worth surfacing distinctly.
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ImageGenerationError(
      `kie createTask HTTP ${response.status}: ${body || response.statusText}`,
    );
  }

  const envelope = (await response.json()) as KieEnvelope<Partial<CreateTaskData>>;
  if (envelope.code !== 200) {
    throw new ImageGenerationError(
      `kie createTask rejected the request: code=${envelope.code} msg=${envelope.msg || "(no message)"}`,
    );
  }
  const taskId = envelope.data?.taskId;
  if (!taskId) {
    throw new ImageGenerationError("kie createTask succeeded but returned no taskId.");
  }
  return taskId;
}

async function recordInfo(taskId: string): Promise<KieEnvelope<Partial<RecordInfoData>>> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${BASE_URL}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey()}` }, cache: "no-store" },
    );
  } catch (err) {
    throw new ImageGenerationError(
      `kie recordInfo request failed for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ImageGenerationError(
      `kie recordInfo HTTP ${response.status} for task ${taskId}: ${body || response.statusText}`,
    );
  }

  return (await response.json()) as KieEnvelope<Partial<RecordInfoData>>;
}

/**
 * One read of a task's current state, with no waiting.
 *
 * Split out of the poll loop below so the RECOVERY path can ask the same
 * question in a request short enough to survive any proxy: an operator who
 * navigated away mid-generation comes back, and one call each says whether the
 * task finished, failed, or is still drawing. Both callers parse kie's reply
 * exactly once, here — a second copy of "resultJson is a JSON-ENCODED STRING"
 * and "state fail carries failMsg" is how the two would drift.
 *
 * `pending` covers waiting / queuing / generating AND anything unrecognised,
 * mirroring the Go client's statusFromState default: an unknown state is still
 * working, never a silent failure.
 */
export type KieTaskCheck =
  | { state: "success"; url: string; costUsd: number | null }
  | { state: "failed"; message: string }
  // Carries kie's own state string so the timeout message can still name what
  // the vendor last said, which is the first thing anyone looking a stuck task
  // up on kie's dashboard wants to know.
  | { state: "pending"; vendorState: string | null };

export async function checkImageTask(taskId: string): Promise<KieTaskCheck> {
  const envelope = await recordInfo(taskId);
  if (envelope.code !== 200) {
    throw new ImageGenerationError(
      `kie recordInfo rejected task ${taskId}: code=${envelope.code} msg=${envelope.msg || "(no message)"}`,
    );
  }

  const state = envelope.data?.state;
  if (state === "success") {
    const raw = envelope.data?.resultJson;
    let parsed: KieResultJson | null = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw) as KieResultJson;
      } catch {
        parsed = null;
      }
    }
    const url = parsed?.resultUrls?.[0];
    if (!url) {
      throw new ImageGenerationError(
        `kie task ${taskId} reported success but resultJson had no usable resultUrls.`,
      );
    }
    const credits = envelope.data?.creditsConsumed;
    return {
      state: "success",
      url,
      costUsd: typeof credits === "number" ? credits * CREDIT_USD : null,
    };
  }

  if (state === "fail") {
    return {
      state: "failed",
      message: envelope.data?.failMsg || "vendor reported no reason",
    };
  }

  return { state: "pending", vendorState: state ?? null };
}

/**
 * Polls recordInfo until the task reaches a terminal state or POLL_BUDGET_MS
 * elapses. A timeout is NOT a failure and must not be recorded as one: the task
 * keeps running and keeps billing after this function stops waiting, so the
 * budget expiring throws KieTaskPendingError carrying the task id — the handle
 * a caller uses to finish the attempt later via checkImageTask instead of
 * resubmitting and paying twice.
 */
async function pollForResult(taskId: string, budgetMs?: number): Promise<GenerateImageResult> {
  const deadline = Date.now() + (budgetMs ?? pollBudgetMs);

  for (;;) {
    const check = await checkImageTask(taskId);
    if (check.state === "success") {
      return { url: check.url, vendor: "kie", costUsd: check.costUsd };
    }

    if (check.state === "failed") {
      throw new ImageGenerationError(`kie task ${taskId} failed: ${check.message}`);
    }

    // Still working. Keep polling until the budget is spent.
    if (Date.now() >= deadline) {
      // KieTaskPendingError, not a bare ImageGenerationError: the task is alive
      // and the id is the handle to finish it later. Callers settle a real
      // failure and must NOT settle this one — see actions/image-generator.ts's
      // catch and lib/runs.ts's failedRunFields for the two shapes that take.
      throw new KieTaskPendingError(
        taskId,
        check.vendorState,
        `kie task ${taskId} did not finish within ${Math.round((budgetMs ?? pollBudgetMs) / 1000)}s ` +
          `(last state=${check.vendorState ?? "unknown"}). It is still running and may still ` +
          `be billed — it is reconciled by task id, so do not resubmit.`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Generates a single reference image via kie.ai. Used for character refs,
 * product refs, and per-scene reference frames — never for video (see file
 * header).
 */
export async function generateImage(args: GenerateImageArgs): Promise<GenerateImageResult> {
  const { refImageUrls } = args;
  const prompt = imagePromptWithGuards(args.prompt);

  if (isDev()) {
    await sleep(mockDelayMs());
    if (args.aspectRatio && args.aspectRatio !== ASPECT_RATIO) {
      const [width, height] = args.aspectRatio.split(":").map(Number);
      return {
        url: `https://placehold.co/${width! * 120}x${height! * 120}/png`,
        vendor: "kie",
        costUsd: null,
      };
    }
    return { url: MOCK_IMAGE_URL, vendor: "kie", costUsd: null };
  }

  const model = modelForImageArgs(args);

  // Seedream runs on BytePlus only, with or without references, so its faces pass
  // Seedance 2.5 there (lib/byteplus-image.ts). Synchronous: no task id, so
  // onTaskCreated is never called.
  if (model === SEEDREAM_PRO_ID) {
    try {
      const image = await generateBytePlusSeedreamImage({
        prompt,
        aspectRatio: args.aspectRatio ?? ASPECT_RATIO,
        resolution: args.resolution ?? "1K",
        refImageUrls: refImageUrls ?? [],
        timeoutMs: args.byteplusTimeoutMs,
      });
      return { url: image.url, vendor: "byteplus", costUsd: image.costUsd };
    } catch (error) {
      throw new ImageGenerationError(error instanceof Error ? error.message : String(error));
    }
  }

  // Which field carries the references is per-model — see kie/image-input.ts.
  const input = kieImageInput(
    model,
    prompt,
    args.aspectRatio ?? ASPECT_RATIO,
    refImageUrls ?? [],
    args.resolution,
  );

  const taskId = await createTask(model, input);
  await args.onTaskCreated?.(taskId);
  // onTaskCreated FIRST, always, and that ordering is what makes a 0 budget
  // safe: the id is durable before anything can give up on the task.
  return pollForResult(taskId, args.pollBudgetMs);
}
