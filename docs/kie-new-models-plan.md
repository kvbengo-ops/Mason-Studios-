# Plan: New kie image and video models

As of 2026-10-25.

## Goal and scope

Add six kie models to the pipeline: three to the Image Generator and three to the
`/ugc` video picker. All six exist on kie today, and each becomes usable only after
one paid test render records its real price.

- **Image Generator:** Nano Banana 2.1, ChatGPT (GPT Image) 2.5 Flare, ChatGPT (GPT Image) 2.5 Sunburst
- **Video Generator:** Seedance 2.0 Mini, Wan 3.0, Kling 4.0

**Done means:** each model shows in its picker, renders through kie in both mock and
real mode, counts toward spend caps and `/spend`, and CI is green on the fork's `main`.

**Out of scope:** Wan 3.0 Video Prime, kie's older GPT Image 1.5 and 2, and any picker
redesign. The pickers already list every model that has a price.

## Model facts from kie's docs

Three models fit existing code almost unchanged. The other three each need one small
new input builder.

| Model | kie model ID | Key inputs and limits | Fits existing code? |
| --- | --- | --- | --- |
| [Nano Banana 2.1](https://docs.kie.ai/market/google/nanobanana-2-1.md) | `nano-banana-2-1` (one ID for text and edit) | Images in `image_input`, max 10. Resolution 1K/2K/4K. 15 aspect ratios | Yes, same shape as Nano Banana 2 |
| [GPT Image 2.5 Flare](https://docs.kie.ai/market/gpt/gpt-image-2-5-flare-text-to-image.md) | `gpt-image-2-5-flare-text-to-image`, `gpt-image-2-5-flare-image-to-image` | Images in `input_urls`. Resolution 1K/2K/4K. No quality field | New builder in `image-input.ts` |
| [GPT Image 2.5 Sunburst](https://docs.kie.ai/market/gpt/gpt-image-2-5-sunburst-image-to-image.md) | `gpt-image-2-5-sunburst-text-to-image`, `gpt-image-2-5-sunburst-image-to-image` | Images in `input_urls`, max 16. Same ratios and resolutions as Flare | Same builder as Flare |
| [Seedance 2.0 Mini](https://docs.kie.ai/market/bytedance/seedance-2-mini.md) | `bytedance/seedance-2-mini` | Max 9 reference images, 3 videos, 3 audio. 480p/720p. 4–15s. `generate_audio` | Yes, reuses `seedanceInput` |
| [Wan 3.0](https://docs.kie.ai/market/wan/3-0-video.md) | `wan/3-0-video` | Max 10 images, 5 videos, 5 audio. `480P`/`720P`/`1080P` (uppercase). 2–30s. Sound is `audio`, not `generate_audio` | New `wanInput` builder |
| [Kling 4.0 Keyframe](https://docs.kie.ai/market/kling/v4-keyframe-to-video.md) | `kling-4.0/keyframe-to-video` | `first_frame_url`, up to 8 `keyframe_urls`, `last_frame_url`. 720p/1080p. 3–30s. No sound field | New builder |
| [Kling 4.0 Reference](https://docs.kie.ai/market/kling/v4-reference-to-video.md) | `kling-4.0/reference-to-video` | `@image_N` tags, max 10 images, 5 videos, 7 elements. 720p/1080p. 3–30s. Always generates sound | New builder, if chosen |

Kling 4.0 is two separate kie endpoints, not one model with modes like Kling 3.0.
Which to offer is an open decision below.

## The pricing gate

New models appear greyed out until one paid test render records their price. The
repo's `offerable()` check (`web/lib/kie/offerable.ts`) refuses to sell any model
priced from kie's website, and kie's docs give no prices at all.

How a model becomes usable:

1. Code is added. The model shows in its picker, disabled, with a reason.
2. One real render runs through `scripts/kie/measure-price.mjs` with `--yes-this-spends`,
   reading the kie credit balance before and after.
3. The measured credits per second (video) or per image go into the rate table,
   marked as a receipt.
4. The model becomes selectable. No other code change is needed.

Video tests run at the longest duration (15s) with `AUDIO=1`, because the balance
rounds to whole credits and every render sends audio on.

| Test | Rough cost | Basis |
| --- | --- | --- |
| Each image model path (5 paths) | ~$0.015–$0.025 each | Credits in kie's doc examples (3–5 credits), not rates |
| Wan 3.0, 15s at 480P | ~$0.60 | kie's example: 40 credits for 5s |
| Seedance 2.0 Mini, 15s at 480p | Unknown | No figure in kie's docs |
| Kling 4.0, 15s at 720p | Unknown, possibly several dollars | kie's example shows 425 credits, length not stated |

At 200 credits per dollar, those examples work out to the figures above. Treat them
as estimates until a receipt exists.

## Implementation steps

Six steps, in order. Steps 1–4 ship as code with every new model greyed out. Step 5
is the only one that spends money.

1. **Image models (web only)**
    - Add Nano Banana 2.1, Flare and Sunburst to `IMAGE_MODELS` in `web/lib/models.ts`,
      with `costUsd: null` until measured.
    - Add a GPT Image 2.5 builder to `web/lib/kie/image-input.ts`: images go in
      `input_urls`, and text and edit use separate IDs.
    - Give each model only the aspect ratios kie accepts (`web/lib/image-aspect-ratios.ts`).
2. **Video models, web side**
    - Add Seedance 2.0 Mini, Wan 3.0 and Kling 4.0 to `web/lib/kie/models.ts`,
      `web/lib/kie/rates.ts` and the video table in `web/lib/models.ts`.
    - Add their kie IDs to `web/lib/spend-categories.ts` so spend counts as video.
    - Cap Seedance Mini at 9 reference images (the References box allows 10).
    - Extend the Kling-only rules (`klingTagRefusal`, `KLING_FRAME_EXTS`, the
      720p → "480p" label in `ugc-tier-label.ts`) to Kling 4.0 if Keyframe mode is chosen.
3. **Video models, worker side**
    - Add matching rate entries and descriptors in `worker/internal/kie/models.go`.
    - Seedance Mini reuses `seedanceInput`. Add `wanInput` (uppercase resolution,
      `audio` flag) and a Kling 4.0 builder.
    - Confirm development-mode mocks cover all three before any real render.
4. **Database migration**
    - New migration adding the four kie video IDs to `spend_category_totals`'s render
      list. `spend-category-sql.test.ts` refuses a model missing from it.
    - Bump `EXPECTED_DB_VERSION` in `web/lib/version.ts` to match.
5. **Paid price tests**
    - One `measure-price.mjs` run per video model at 15s with `AUDIO=1`, and one per
      image path.
    - Write each receipt (credits, task ID, date) into `rates.ts` and `models.go`, or
      `IMAGE_MODELS` for images.
    - Record each image model's measured wait time. Anything over the 100s request
      budget must use the background path, as Seedream 5.0 Pro already does.
6. **Push and verify**
    - Push to the fork's `main`, then read the CI result.
    - Apply the migration to the database the app uses before the deploy.

**To check during step 3:** how `@tags` in a prompt reach Seedance today, and whether
Wan needs them rewritten to its `Image1`/`Video1` naming.

## Decisions needed

Four answers are needed before coding starts.

- [ ] **Kling 4.0 mode.** Keyframe (start and end frames, same experience as Kling 3.0
  today, smallest change), Reference (`@tags`, always has sound), or both.
- [ ] **Paid tests.** Approve the spend in the pricing table, and choose the kie key:
  the production key in `worker/.env`, or your own. Or ship greyed out now and test later.
- [ ] **Wan 3.0 or Wan 3.0 Video Prime.** kie lists both. The plan assumes plain Wan 3.0.
- [ ] **Migration number clash.** Your untracked `0114_task_admin_read.sql` shares a
  number with upstream's `0114_image_bin_and_notifications.sql`. Renumber it, or drop
  it, before the new migration takes the next free number.

## Risks and verification

The biggest risk is paying for a render kie quietly misreads. kie accepts unknown input
fields, returns success, and bills anyway.

| Risk | Guard | How it is checked |
| --- | --- | --- |
| A wrong field name is ignored but billed | Build inputs only from kie's doc pages, never by trial submissions | Worker payload tests compare each builder's output with the documented fields |
| A model is sold before it is priced | Price stays empty until a receipt exists | `offerable()` keeps it greyed out; `rates-drift.test.ts` keeps web and worker rates in sync |
| Spend for a new model is missing from caps or `/spend` | Migration adds its kie IDs to the render list | `spend-category-sql.test.ts` fails for any missing model; read one row back after applying |
| A slow image model times out and bills with no image | Record measured wait time with the receipt | Over 100s uses the background path, as Seedream 5.0 Pro does |
| Health check reports schema drift after deploy | Apply the migration before the deploy and bump `EXPECTED_DB_VERSION` | `/api/health` shows no `schemaDrift` |
| A local test spends real money | Keep `MODE=development` until step 5 | Mocked renders only; check `scenes.dev = true` on test rows |

CI runs lint, typecheck, tests and the build on every push. A change counts as done
only when CI on the fork's `main` is green.

## Sources

kie doc pages read on 2026-10-25:

- [kie docs index](https://docs.kie.ai/llms.txt)
- [Nano Banana 2.1](https://docs.kie.ai/market/google/nanobanana-2-1.md)
- [GPT Image 2.5 Flare, text to image](https://docs.kie.ai/market/gpt/gpt-image-2-5-flare-text-to-image.md)
- [GPT Image 2.5 Sunburst, image to image](https://docs.kie.ai/market/gpt/gpt-image-2-5-sunburst-image-to-image.md)
- [Seedance 2.0 Mini](https://docs.kie.ai/market/bytedance/seedance-2-mini.md)
- [Wan 3.0](https://docs.kie.ai/market/wan/3-0-video.md)
- [Kling 4.0 Keyframe to Video](https://docs.kie.ai/market/kling/v4-keyframe-to-video.md)
- [Kling 4.0 Reference to Video](https://docs.kie.ai/market/kling/v4-reference-to-video.md)
