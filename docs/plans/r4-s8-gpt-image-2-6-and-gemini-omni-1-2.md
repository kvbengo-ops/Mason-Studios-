# R4 + S8: GPT Image 2.6 and Gemini Omni 1.2 (research and proposal, no code)

Read-only research, 2026-11-09. Nothing was submitted to kie. This lives in its own file so it
does not conflict with Codex's R1–R3 edits to `dev-updates-2026-11-09.md`; copy it into that
file's "Research findings" when the two branches merge.

## R4: what exists on kie

**ChatGPT Image 2.6: exists, in three variants.** Source: [llms.txt index](https://docs.kie.ai/llms.txt),
[Economy T2I](https://docs.kie.ai/market/gpt/gpt-image-2-6-economy-text-to-image.md),
[Flare T2I](https://docs.kie.ai/market/gpt/gpt-image-2-6-flare-text-to-image.md),
[Sunburst T2I](https://docs.kie.ai/market/gpt/gpt-image-2-6-sunburst-text-to-image.md),
[pricing page](https://kie.ai/gpt-image-2-6).

| Variant | Text-to-image id | Image-to-image id | Notes |
|---|---|---|---|
| Flare | `gpt-image-2-6/flare-text-to-image` | `gpt-image-2-6/flare-image-to-image` | faster, more sizes |
| Sunburst | `gpt-image-2-6/sunburst-text-to-image` | `gpt-image-2-6/sunburst-image-to-image` | more detail, tighter edit consistency |
| Economy | `gpt-image-2-6/economy-text-to-image` | `gpt-image-2-6/economy-image-to-image` | "cost-efficient", **1K only**, ratios `auto 1:1 16:9 9:16 3:2 2:3 21:9 4:3` |

**Is it cheaper than 2.5? Unknown.** 2.5 is a flat per-image price (6 credits = $0.03 at 1K).
2.6 is priced **per token**, not per image: text input $4.50/M, image input $7.20/M, image
output $27.00/M ("10% below official"; per-variant rates are not split out on the page). The
per-image cost depends on tokens used, so no per-image figure can be stated from the docs. It
needs a receipt.

**Gemini 1.2 Omni: exists as "Gemini Omni 1.2 Flash".** Source:
[docs page](https://docs.kie.ai/market/google/gemini-omni-flash-1-2.md).
- id `google/gemini-omni-flash-1-2` (the current app model, "Gemini Omni Video", is a different
  page and id; the index also lists `google/gemini-omni-flash-1-1`).
- `prompt` max **20,000** characters; `duration` 3–15 s (3–10 s with first and last frame);
  `aspect_ratio` `16:9 | 9:16 | auto`; up to 6 reference images (7-slot quota, a video costs 2).
- Price: the docs page and `kie.ai/gemini-omni` publish none in text. Needs the pricing card
  read in a browser, or a receipt.

## S8: proposal (nothing added)

1. **GPT Image 2.6 Economy** is the only 2.6 variant worth a trial: it is the cheap one and 1K
   only matches what the picker offers. Ratios it supports include 9:16, 1:1 and 16:9, so it
   fits the three-ratio rule from S1.
   - Receipt plan: one text-to-image call and one image-to-image call at 9:16, 1K, with
     `web/scripts/measure-image-model.ts`, because the price is token-based and varies by prompt. Do 3 prompts of different
     length and record the spread; offer it only if the worst case is below 2.5 Flare's $0.03.
   - Then add `gpt-image-2.6-economy` to `IMAGE_MODELS` (ids above, `input_urls` shape to be
     confirmed on the Economy image-to-image page first) and to `spend_category_totals`'s
     render list in a migration.
2. **Flare / Sunburst 2.6**: skip until Economy is measured; same token pricing, no known gain.
3. **Gemini Omni 1.2 Flash**: needs a published price and a receipt before it can be offered
   (`offerable()` rule). Cost to add: a `KieModel` descriptor, a rate entry, worker input
   builder for the 1.2 body (it differs from "Gemini Omni Video"), and the migration for
   `spend_category_totals`. Not a drop-in swap for the current Gemini id.

Open question for the owner: should Gemini Omni 1.2 replace the current Gemini entry, or sit
beside it?
