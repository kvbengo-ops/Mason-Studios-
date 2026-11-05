// Find out what a kie image model actually IS and actually COSTS, before any
// of it reaches the app.
//
//   cd web
//   KIE_API_KEY=... bun scripts/measure-image-model.ts google/nano-banana-pro google/nano-banana-2
//
// WHY THIS EXISTS. AGENTS.md: "Every price is a receipt or it is refused —
// adding a model does not make it usable, measuring it does." A price taken
// off kie's published page goes straight into the reservation, the spend cap
// and /spend, so a guess there is a wrong number in three places at once. This
// prints the receipt: kie's own creditsConsumed for one real call.
//
// A WRONG MODEL ID IS FREE. kie answers an unknown model with code=422 at
// createTask, before any work is queued and before anything is billed. So this
// doubles as a cheap way to discover the right id — try the candidates, note
// which ones are rejected, and only the accepted ones cost anything.
//
// Deliberately talks to kie's HTTP API directly rather than going through
// lib/kie.ts. That module picks its own model (modelForImageArgs) and takes no
// override, and teaching production code a test-only parameter to satisfy a
// measurement script is the wrong trade. The request/response shape here is
// copied from lib/kie.ts's verified header; if kie ever changes it, that file
// is the source of truth and this follows it.

import { SEEDREAM_PRO_EDIT_ID } from "../lib/kie/seedream-image";
import { kieImageInput } from "../lib/kie/image-input";

const BASE_URL = "https://api.kie.ai";
// kie's published rate, and the same constant lib/kie.ts prices against.
const CREDIT_USD = 0.005;
const ASPECT_RATIO = "9:16";
const POLL_BUDGET_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

const models = process.argv.slice(2).filter(Boolean);
if (models.length === 0) {
  console.error("usage: bun scripts/measure-image-model.ts <model-id> [<model-id> ...]");
  process.exit(1);
}
const key = process.env.KIE_API_KEY;
if (!key) {
  console.error("KIE_API_KEY is not set. Pass it inline; do not put it in .env.local.");
  process.exit(1);
}

const PROMPT =
  "A plain red ceramic mug centred on a white studio background, soft even lighting. " +
  "No text, captions, subtitles, watermarks or written words anywhere in the frame.";

type Envelope<T> = { code: number; msg?: string; data?: T };

async function createTask(model: string): Promise<string> {
  const referenceUrl = process.env.REF_IMAGE_URL;
  if (model === SEEDREAM_PRO_EDIT_ID && !referenceUrl) {
    throw new Error(
      "Set REF_IMAGE_URL to the text-to-image receipt's output before measuring edits.",
    );
  }
  // REF_IMAGE_URL is what selects the reference path, for every model — it has
  // to be, now that nano-banana-2 serves both paths from one id and the model
  // id alone no longer says which one is being measured.
  //
  // Through the app's own builder, so the receipt prices the request the app
  // actually sends. A measurement that posted image_urls where the model wants
  // image_input would come back priced, plausible, and about a call in which
  // the reference was ignored.
  const input = kieImageInput(model, PROMPT, ASPECT_RATIO, referenceUrl ? [referenceUrl] : []);
  const res = await fetch(`${BASE_URL}/api/v1/jobs/createTask`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
  if (!res.ok)
    throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")) || res.statusText}`);
  // HTTP is 200 even on failure — `code` carries the real status.
  const env = (await res.json()) as Envelope<{ taskId?: string }>;
  if (env.code !== 200) throw new Error(`rejected: code=${env.code} msg=${env.msg || "(none)"}`);
  if (!env.data?.taskId) throw new Error("accepted but returned no taskId");
  return env.data.taskId;
}

async function poll(taskId: string) {
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${BASE_URL}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      {
        headers: { Authorization: `Bearer ${key}` },
      },
    );
    const env = (await res.json()) as Envelope<{
      state?: string;
      resultJson?: string;
      creditsConsumed?: number;
      failMsg?: string;
    }>;
    const state = env.data?.state;
    if (state === "success") return env.data!;
    if (state === "fail")
      throw new Error(`generation failed: ${env.data?.failMsg || env.msg || "(no message)"}`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `no result within ${POLL_BUDGET_MS / 1000}s (task ${taskId} may still be billed)`,
  );
}

for (const model of models) {
  process.stdout.write(`\n${model}\n`);
  const started = Date.now();
  let taskId: string;
  try {
    taskId = await createTask(model);
  } catch (error) {
    // The free outcome: refused before any work was queued.
    console.log(`  UNUSABLE  ${error instanceof Error ? error.message : String(error)}`);
    console.log("  (nothing billed — a rejected createTask never queues work)");
    continue;
  }
  console.log(`  task      ${taskId}`);

  try {
    const data = await poll(taskId);
    const elapsedS = ((Date.now() - started) / 1000).toFixed(1);
    const credits = data.creditsConsumed;
    // resultJson is a JSON-ENCODED STRING, not a nested object.
    let url = "(none)";
    try {
      url =
        (JSON.parse(data.resultJson ?? "{}") as { resultUrls?: string[] }).resultUrls?.[0] ??
        "(none)";
    } catch {
      /* leave as (none) — the price is what this script is for */
    }
    console.log(`  elapsed   ${elapsedS}s`);
    console.log(
      credits === undefined
        ? "  COST      kie reported no creditsConsumed — NOT measurable, do not offer this model"
        : `  COST      ${credits} credits = $${(credits * CREDIT_USD).toFixed(4)}`,
    );
    console.log(`  image     ${url}`);
  } catch (error) {
    console.log(`  FAILED    ${error instanceof Error ? error.message : String(error)}`);
    console.log(`  ⚠ submitted as ${taskId} — this one MAY have been billed`);
  }
}

// tsc treats a script with no import/export as a non-module, where top-level
// await is an error.
export {};
