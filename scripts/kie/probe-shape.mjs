#!/usr/bin/env node
//
// Answer every open question about the Seedance request shape in ONE render,
// by making the output file the instrument.
//
// WHY THIS EXISTS
//
// Six things about worker/internal/kie/models.go's seedanceInput are
// unverified, and each one looked like it needed its own paid experiment:
//
//   1. Is the image field called reference_image_urls or image_urls?
//   2. Is `duration` honoured when sent as a STRING ("4") not a number?
//   3. Is `resolution` honoured when spelled "480P" not kie's enum "480p"?
//   4. Does generate_audio actually produce sound?
//   5. What does an audio-ON render cost? (Rates has no Seedance Sound tier.)
//   6. Did the reference image reach the model at all?
//
// They do not need six renders. Five of the six are answerable MECHANICALLY
// from the returned mp4 — ffprobe reads its duration, its height and whether
// it carries an audio stream — and the sixth is the credit balance either
// side, which measure-price.mjs already knows how to read.
//
// So: one render, then read the file. The trick is only that nobody was
// reading the file. measure-price.mjs ends by TELLING THE OPERATOR to "check
// the clip before trusting this rate", which is an instruction to a human
// where a probe would do.
//
// THE COLOUR TRICK, for question 6
//
// "Did the reference arrive" normally needs eyes. It does not have to. Point
// --reference at an image with one overwhelming colour, and ffmpeg's own
// 1x1 downscale gives the clip's average pixel. A magenta reference that
// produces a magenta-dominant clip reached the model; a grey one did not.
// This is a SIGNAL, not a proof — a model may restyle or crop — so it is
// reported with its confidence rather than as a verdict.
//
// THIS SPENDS REAL MONEY, exactly like measure-price.mjs, and refuses to run
// without --yes-this-spends for the same reason.
//
// USAGE
//
//   node scripts/kie/probe-shape.mjs \
//     --duration 4 --resolution 480P --audio 0 \
//     --reference https://example.com/magenta-person.jpg \
//     --yes-this-spends
//
// Run it TWICE to fill the missing Sound table: once --audio 0, once
// --audio 1. The difference between the two credit deltas is the audio
// surcharge, which is the number Rates["seedance-2.5"] has no row for.
//
// Reads KIE_API_KEY from worker/.env.local, same as measure-price.mjs.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

/** 200 credits to the dollar — mirrors CREDITS_PER_USD everywhere else. */
const CREDITS_PER_USD = 200;

const MODEL = "bytedance/seedance-2-5";

/**
 * Deliberately says nothing about colour, clothing or setting.
 *
 * The colour test below only means something if the PROMPT did not ask for
 * the colour the reference happens to be — otherwise a magenta clip proves
 * the model read the prompt, not the picture.
 */
const PROMPT =
  "@image1 is a reference image. Use its subject's appearance and hold it identical for the " +
  "whole clip. The subject stands still and turns their head slowly to the left. Static camera.";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function apiKey() {
  const env = readFileSync(join(REPO, "worker", ".env.local"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("KIE_API_KEY="));
  if (!line) throw new Error("KIE_API_KEY not found in worker/.env.local");
  return line.slice("KIE_API_KEY=".length).trim();
}

async function credits(key) {
  const res = await fetch("https://api.kie.ai/api/v1/chat/credit", {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await res.json();
  if (typeof body?.data !== "number") {
    throw new Error(`credit balance came back unreadable: ${JSON.stringify(body)}`);
  }
  return body.data;
}

/**
 * THE SHAPE UNDER TEST — kept byte-identical to what the worker sends.
 *
 * Mirrors worker/internal/kie/models.go's seedanceInput, including the two
 * things this probe exists to question: `duration` as a string, and the
 * uppercase "480P". Do not "fix" them here — a probe that sends a different
 * body than production answers a question nobody asked.
 *
 * --shape documented sends kie's own published names and types instead, so
 * the two can be compared for the cost of one more render.
 */
function buildInput({ shape, durationS, resolution, audio, reference }) {
  if (shape === "documented") {
    return {
      prompt: PROMPT,
      reference_image_urls: [reference],
      duration: durationS, // number, per kie's schema
      resolution: resolution.toLowerCase(), // "480p", per kie's enum
      aspect_ratio: "9:16",
      generate_audio: audio,
    };
  }
  return {
    prompt: PROMPT,
    reference_image_urls: [reference],
    duration: String(durationS), // DurationSendAsString
    resolution, // "480P", as AllowedResolutions spells it
    aspect_ratio: "9:16",
    generate_audio: audio,
  };
}

/** ffprobe's answers, or nulls if the tool is missing. */
function probe(file) {
  const json = execFileSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(json);
  const video = (parsed.streams || []).find((s) => s.codec_type === "video");
  const audio = (parsed.streams || []).find((s) => s.codec_type === "audio");
  return {
    durationS: Number(parsed.format?.duration ?? 0),
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
  };
}

/**
 * The clip's average pixel, as [r,g,b].
 *
 * ffmpeg scaled to 1x1 IS the average — no sampling, no frame choice, no
 * judgement. Averaged again across the whole clip by taking the mean of the
 * per-frame 1x1 values.
 */
function averageColour(file) {
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (raw.length < 3) return null;
  let r = 0,
    g = 0,
    b = 0;
  const frames = Math.floor(raw.length / 3);
  for (let i = 0; i < frames; i++) {
    r += raw[i * 3];
    g += raw[i * 3 + 1];
    b += raw[i * 3 + 2];
  }
  return [Math.round(r / frames), Math.round(g / frames), Math.round(b / frames)];
}

function verdict(label, expected, observed, honoured) {
  const mark = honoured === null ? "?" : honoured ? "OK" : "NO";
  console.log(
    `  ${mark.padEnd(3)} ${label.padEnd(34)} sent ${String(expected).padEnd(14)} got ${observed}`,
  );
}

async function main() {
  const durationS = Number(arg("duration", "4"));
  const resolution = arg("resolution", "480P");
  const audio = arg("audio", "0") === "1";
  const shape = arg("shape", "worker");
  const reference = arg("reference");
  const confirmed = process.argv.includes("--yes-this-spends");

  if (!reference) {
    console.error(
      "usage: --reference <image url> [--duration 4] [--resolution 480P] [--audio 0|1]\n" +
        "       [--shape worker|documented] --yes-this-spends\n\n" +
        "Point --reference at an image with ONE dominant colour: the colour test below\n" +
        "is what answers whether the reference reached the model at all.",
    );
    process.exit(2);
  }

  const input = buildInput({ shape, durationS, resolution, audio, reference });

  console.log(`model      ${MODEL}`);
  console.log(`shape      ${shape}`);
  console.log(`input      ${JSON.stringify(input, null, 2).replace(/\n/g, "\n           ")}`);

  // THE DRY RUN TOUCHES NOTHING. It printed the balance first in the first
  // version of this file, which meant a dry run needed a live key and died
  // 401 against the mock key a local checkout actually carries — so the one
  // mode whose whole purpose is showing you the request body without
  // spending was the mode that could not run. Print the body, then stop.
  if (!confirmed) {
    console.log("\nDry run — nothing sent, no key needed. This would submit ONE PAID render.");
    console.log("Re-run with --yes-this-spends.");
    return;
  }

  const key = apiKey();
  const before = await credits(key);
  console.log(`balance    ${before} credits ($${(before / CREDITS_PER_USD).toFixed(2)})`);

  const create = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input }),
  });
  const created = await create.json();
  if (created.code !== 200 || !created.data?.taskId) {
    // A rejected submit is free. Refuse rather than retry — a retry loop
    // around a request that is actually succeeding is how you pay twice.
    console.error(`submit refused: ${created.code} ${created.msg}`);
    process.exit(1);
  }
  const taskId = created.data.taskId;
  console.log(`task       ${taskId}`);

  let state = "waiting";
  let body = null;
  for (let i = 0; i < 120 && state !== "success" && state !== "fail"; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(
      `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    body = await res.json();
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
    console.log(`Timed out. Check by hand before re-running: taskId ${taskId}`);
    process.exit(1);
  }

  const after = await credits(key);
  const spent = before - after;

  // kie's own figure, beside ours. They should agree; if they do not, the
  // balance is the authority — creditsConsumed is a field this repo has
  // never verified.
  const reported = body?.data?.creditsConsumed ?? null;

  const resultJson = JSON.parse(body?.data?.resultJson ?? "{}");
  const url = resultJson.resultUrls?.[0];
  if (!url) {
    console.error("no result url — cannot probe the clip. Raw:", body?.data?.resultJson);
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), "kie-probe-"));
  const file = join(dir, "out.mp4");
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  writeFileSync(file, bytes);

  const p = probe(file);
  const colour = averageColour(file);

  console.log(`\nclip       ${file}  (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`\nWHAT THE FILE SAYS`);
  verdict("duration honoured", `${durationS}s`, `${p.durationS.toFixed(2)}s`, Math.abs(p.durationS - durationS) < 0.6);
  verdict("resolution honoured", resolution, `${p.width}x${p.height}`, String(p.height).startsWith(resolution.replace(/[Pp]$/, "")));
  verdict("generate_audio honoured", String(audio), p.hasAudio ? `audio (${p.audioCodec})` : "silent", p.hasAudio === audio);
  verdict("reference colour reached", "see --reference", colour ? `rgb(${colour.join(",")})` : "unreadable", null);

  console.log(`\nWHAT IT COST`);
  console.log(`  balance delta   ${spent} credits  ($${(spent / CREDITS_PER_USD).toFixed(4)})`);
  console.log(`  kie reported    ${reported === null ? "(absent)" : reported + " credits"}`);
  console.log(`  per second      ${(spent / durationS).toFixed(2)} cr/s`);
  console.log(
    `\n  Paste into BOTH web/lib/kie/rates.ts and worker/internal/kie/models.go,\n` +
      `  under ${audio ? "Sound" : "Silent"}["${resolution}"], with provenance "receipt":\n` +
      `    creditsPerSecond: ${(spent / durationS).toFixed(2)}`,
  );
  console.log(
    `\n  Rounding: the balance is whole credits, so this rate carries ±${(0.5 / durationS).toFixed(2)} cr/s.\n` +
      `  Measure at a longer duration to shrink it — see measure-price.mjs's own note.`,
  );

  if (Math.abs(p.durationS - durationS) >= 0.6) {
    console.log(
      `\n  NOTE: the clip is ${p.durationS.toFixed(2)}s, not the ${durationS}s requested. The rate above\n` +
        `  divides by what was ASKED FOR. If kie billed the delivered length instead,\n` +
        `  divide by ${p.durationS.toFixed(2)} — check the two candidates against a second run.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
