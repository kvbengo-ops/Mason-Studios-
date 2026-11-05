#!/usr/bin/env node
//
// Measure what a kie model actually charges, by billing yourself once.
//
// WHY THIS EXISTS
//
// web/lib/models.ts refuses to carry a price nobody has paid. Seedance 2.5's
// $0.315/s and Kling 3.0 Pro's 1.2x billing multiplier are both marked
// "measured" in that file, and every other number in it that came from a
// vendor's marketing page belongs to a descriptor that is disabled. The six
// kie models added alongside this script are disabled for exactly that
// reason: their shape is known, their price is not.
//
// kie publishes no price in its API and none in the model docs. recordInfo
// returns costTime (milliseconds), never cost. The only instrument is the
// credit balance, so the measurement is: read it, render once, read it
// again, divide.
//
// THIS SPENDS REAL MONEY. That is not a side effect, it is the method. The
// script therefore refuses to run without --yes-this-spends, prints what it
// is about to do, and stops on anything it does not understand rather than
// pressing on and billing twice.
//
// USAGE
//
//   node scripts/kie/measure-price.mjs \
//     --model kling/v3-turbo-image-to-video \
//     --duration 15 --resolution 720p --yes-this-spends
//
// Reads KIE_API_KEY from worker/.env.
//
// MEASURE AT THE LONGEST DURATION, NOT THE SHORTEST.
//
// The balance endpoint returns whole credits. A render costing 12.4 credits
// reads as 12 or 13, so the rounding error is fixed while the bill is not:
// at 3 seconds that is ±4% on the per-second rate, at 15 seconds it is
// ±0.8%. The cheap-looking probe is the inaccurate one, and its error is
// multiplied into every quote the app computes from the result.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

/** 200 credits to the dollar — web/lib/kie-balance.ts's CREDIT_USD, verified on two billed image calls. */
const CREDITS_PER_USD = 200;

/**
 * kie's own example image, from its published docs.
 *
 * Deliberately not one of our storage objects: a signed URL expires, and a
 * measurement that fails because its input went stale looks exactly like a
 * model that rejected the request. This URL is kie's to keep alive.
 */
const REFERENCE_IMAGE =
  "https://static.aiquickdraw.com/tools/example/1781770668096_2bmSjv45.png";

// Which audio tier this run measures. Seedance prices silent and sound-on
// renders differently and kie defaults to sound-ON, so a measurement that
// does not say which one it took is not a measurement of either.
const AUDIO = process.env.AUDIO === "1";

const PROMPT =
  "A person stands still in a bright room, looking at the camera. Static shot, natural light.";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

function apiKey() {
  const env = readFileSync(join(REPO, "worker", ".env"), "utf8");
  const line = env
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("KIE_API_KEY="));
  if (!line) throw new Error("No KIE_API_KEY in worker/.env");
  return line.slice("KIE_API_KEY=".length).trim();
}

async function credits(key) {
  const res = await fetch("https://api.kie.ai/api/v1/chat/credit", {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await res.json();
  if (body.code !== 200) throw new Error(`credit read failed: ${JSON.stringify(body)}`);
  return body.data;
}

/**
 * Each model spells its own input. There is no shared shape to generalise
 * over — Seedance takes `resolution`, Kling takes `mode`, Hailuo takes
 * `image_url` singular where the others take `image_urls` plural — which is
 * the same reason worker/internal/kie/models.go keeps a buildInput per model
 * rather than one builder with branches.
 */
function buildInput(model, durationS, resolution) {
	if (model === "gemini-omni-video") {
		if (![4, 6, 8, 10].includes(durationS)) {
			throw new Error("Gemini Omni Video accepts 4, 6, 8, or 10 seconds.");
		}
		if (!["720p", "1080p", "4k"].includes(resolution)) {
			throw new Error("Gemini Omni Video accepts 720p, 1080p, or 4k.");
		}
		return {
			prompt: PROMPT,
			image_urls: [REFERENCE_IMAGE],
			duration: String(durationS),
			aspect_ratio: "9:16",
			resolution,
		};
	}
  if (model.startsWith("kling-3.0/")) {
    return {
      prompt: PROMPT,
      image_urls: [REFERENCE_IMAGE],
      mode: resolution === "720p" ? "std" : "pro",
      // From AUDIO, like Seedance's generate_audio below. This was hardcoded
      // true, so the script could not take Kling's silent receipt at all.
      sound: AUDIO,
      multi_shots: false,
      aspect_ratio: "9:16",
      duration: durationS,
    };
  }
  if (model.startsWith("kling/v3-turbo")) {
    return {
      prompt: PROMPT,
      image_urls: [REFERENCE_IMAGE],
      duration: durationS,
      resolution,
    };
  }
  if (model.startsWith("hailuo/")) {
    return {
      prompt: PROMPT,
      image_url: REFERENCE_IMAGE,
      duration: String(durationS),
      resolution,
    };
  }
  // Same shape as worker/internal/kie/models.go's wanInput — kie bills unknown
  // fields without complaint, so a measurement must send what a render sends.
  if (model.startsWith("wan/")) {
    return {
      prompt: PROMPT,
      reference_image_urls: [REFERENCE_IMAGE],
      resolution,
      duration: durationS,
      aspect_ratio: "9:16",
      audio: AUDIO,
    };
  }
  // Same shape as kling4RefInput. Before the keyframe branch, which would
  // otherwise match it. No sound input: kie always renders sound here.
  if (model === "kling-4.0/reference-to-video") {
    return {
      prompt: `@image_1 ${PROMPT}`,
      image_urls: [REFERENCE_IMAGE],
      resolution,
      duration: durationS,
      aspect_ratio: "9:16",
    };
  }
  // Same shape as kling4Input; keyframe-to-video has no sound input.
  if (model.startsWith("kling-4.0/")) {
    return {
      prompt: PROMPT,
      first_frame_url: REFERENCE_IMAGE,
      resolution,
      duration: durationS,
      aspect_ratio: "9:16",
    };
  }
  if (model.startsWith("bytedance/seedance")) {
    return {
      prompt: PROMPT,
      image_urls: [REFERENCE_IMAGE],
      resolution,
      duration: durationS,
      aspect_ratio: "9:16",
      // EXPLICIT, because kie's default is `true`.
      //
      // This field was omitted entirely until now, and the omission is not
      // neutral: docs.kie.ai/market/bytedance/seedance-2-5 documents
      // generate_audio with "Default value: true" and the note "Enabling
      // audio will increase the generation cost." So every Seedance
      // measurement taken with this script was almost certainly billed at
      // the WITH-AUDIO rate — including the 63 credits/second figure filed
      // as Rates["seedance-2.5"].Silent["720P"] with provenance "receipt",
      // which is the one measured number the whole Seedance table rests on.
      //
      // Set from AUDIO so a run says which tier it measured instead of
      // inheriting a vendor default nobody wrote down. To populate the
      // missing Sound table, run it again with AUDIO=1.
      generate_audio: AUDIO,
    };
  }
  throw new Error(`No input shape known for ${model}. Add one to buildInput before measuring.`);
}

async function main() {
  const model = arg("model");
  const durationS = Number(arg("duration"));
  const resolution = arg("resolution");
  const confirmed = process.argv.includes("--yes-this-spends");

  if (!model || !durationS || !resolution) {
    console.error(
      "usage: --model <kie id> --duration <seconds> --resolution <720p|1080p|768P> --yes-this-spends",
    );
    process.exit(2);
  }

  const key = apiKey();
  const before = await credits(key);

  console.log(`model      ${model}`);
  console.log(`duration   ${durationS}s at ${resolution}`);
  console.log(`balance    ${before} credits ($${(before / CREDITS_PER_USD).toFixed(2)})`);

  if (!confirmed) {
    console.log("\nDry run. This would submit ONE PAID render. Re-run with --yes-this-spends.");
    return;
  }

  const create = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: buildInput(model, durationS, resolution) }),
  });
  const created = await create.json();
  if (created.code !== 200 || !created.data?.taskId) {
    // Refuses rather than retrying. A rejected submit is free; a retry loop
    // around a request that is actually succeeding is how you pay twice.
    console.error(`submit refused: ${created.code} ${created.msg}`);
    process.exit(1);
  }
  const taskId = created.data.taskId;
  console.log(`task       ${taskId}`);

  // Loop until a TERMINAL state, not while state === "waiting". kie's
  // recordInfo reports "generating" while a render is running, and the first
  // version of this loop exited the moment it saw anything that was not
  // "waiting" — one poll in, five seconds after submitting, on a render that
  // takes minutes. It then printed "timed out", which sent the reader
  // looking for a hung job rather than a wrong condition.
  let state = "waiting";
  for (let i = 0; i < 360 && state !== "success" && state !== "fail"; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(
      `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    const body = await res.json();
    state = body.data?.state ?? "waiting";
    process.stdout.write(`\rstate      ${state} (${(i + 1) * 5}s)   `);
    if (state === "fail") {
      console.log(`\nfailed: ${body.data?.failCode} ${body.data?.failMsg}`);
      console.log("A failed render is not billed — nothing was measured.");
      process.exit(1);
    }
  }
  console.log();

  if (state !== "success") {
    console.log("Timed out waiting. Check the balance by hand before re-running:");
    console.log(`  taskId ${taskId}`);
    process.exit(1);
  }

  const after = await credits(key);
  const spentCredits = before - after;
  const spentUsd = spentCredits / CREDITS_PER_USD;

  console.log(`\nspent      ${spentCredits} credits  ($${spentUsd.toFixed(4)})`);
  console.log(`per second $${(spentUsd / durationS).toFixed(4)}`);
  console.log(
    `\nRounding: the balance is whole credits, so this rate carries ±$${(
      0.5 /
      CREDITS_PER_USD /
      durationS
    ).toFixed(4)}/s. Measure at a longer duration to shrink it.`,
  );
  console.log(
    `\nPaste into web/lib/models.ts AND worker/internal/fal/models.go — both, or the\n` +
      `drift guard fails and, worse, the two sides quote different prices:\n` +
      `  pricePerSecondUsd: { "${resolution}": ${(spentUsd / durationS).toFixed(4)} }`,
  );
  console.log(
    `\nNOT the billed-seconds multiplier. If the clip comes back longer than\n` +
      `${durationS}s, kie billed for the delivered length, not the requested one —\n` +
      `that is what billedSecondsMultiplier records. Check the clip before trusting this rate.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
