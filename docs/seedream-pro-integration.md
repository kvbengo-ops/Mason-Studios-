# Seedream 5.0 Pro image generation

The image generator offers Seedream 5.0 Pro for prompt-only images at a
measured 7 credits ($0.035) per image. The adapter fixes `quality: basic`
(1K), PNG output, and the eight documented aspect ratios.

References and sequences remain unavailable: the measured image-to-image
call took 105.2 seconds, exceeding the application's 100-second polling
budget. The server refuses these combinations before reserving or paying
for an attempt. Enable references only after background completion is
implemented; do not raise the blocking request timeout.

## Billed receipts — 2026-09-08

Both calls used the same red ceramic mug prompt at 9:16, basic/1K, PNG.
The second call used the first output as its reference. Prices came from
Kie's per-task `creditsConsumed`, at $0.005 per credit.

| Endpoint | Task ID | Billed credits | USD | Wall-clock time |
| --- | --- | --- | --- | --- |
| `seedream/5-pro-text-to-image` | `7392348b188665cf90ec7bacb42d1e05` | 7 | 0.035 | 91.9s |
| `seedream/5-pro-image-to-image` | `0a32dc68def234243b4c37c1cbc8b682` | 7 | 0.035 | 105.2s |

Results (temporary vendor URLs):

- Prompt-only: https://tempfile.aiquickdraw.com/p/7392348b188665cf90ec7bacb42d1e05_1_1788835710_2650.png
- Reference-conditioned: https://tempfile.aiquickdraw.com/p/0a32dc68def234243b4c37c1cbc8b682_1_1788835838_4360.png

Total measurement spend: 14 credits ($0.07). These direct measurement calls
bypass the app and are not recorded as user attempts in `runs`.
One measurement per endpoint establishes these receipts, not a latency
guarantee. Prompt-only generation has little margin under the timeout.
Skin-texture improvement has not been visually verified; the sample was a mug.

### What these receipts do not cover

**The price is measured. The aspect ratios are not.** Both calls above ran at
9:16, so what $0.035 is a receipt for is one ratio on each endpoint. The other
seven in `SEEDREAM_PRO_ASPECT_RATIOS` are transcribed from the vendor pages
linked below and have never been sent to Kie from anywhere, so "accepted" is
an assumption about them rather than an observation.

The same gap is wider on the Nano Banana models, which this PR touches without
measuring: `IMAGE_ASPECT_RATIOS` offers ten values, and until this change the
only one that could reach Kie was the hardcoded `9:16`. Nine of those ten are
therefore unexercised.

Whether an unsupported ratio is refused cheaply or billed is also unknown. The
adapter refuses a ratio outside the model's list before reserving, so a wrong
entry in either list surfaces as a 422 rather than a silent charge, but that
reasoning is about our own guard and not about Kie's behaviour.

Closing this costs one paid call at a non-9:16 ratio per model. Until someone
spends it, read every ratio but 9:16 as documented, not confirmed.

## Repeat a measurement

Supply `KIE_API_KEY` securely in the measurement shell. These commands make
real paid calls, independently of the application's MODE. From `web/`:

```powershell
bun scripts/measure-image-model.ts seedream/5-pro-text-to-image
# Set REF_IMAGE_URL to the generated image URL printed above.
bun scripts/measure-image-model.ts seedream/5-pro-image-to-image
```

Sources:

- https://docs.kie.ai/market/seedream/5-pro-text-to-image
- https://docs.kie.ai/market/seedream/5-pro-image-to-image
- https://kie.ai/seedream-5-0-pro
