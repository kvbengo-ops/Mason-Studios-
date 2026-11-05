# Does Kling's native audio actually lip-sync?

The one open question with real money attached, and the cheapest one left to answer.

## Why it is still open

Kling 3.0 Pro was verified working against fal, but that check used a **grey mock
placeholder** as the reference image. There was audio, and no face. Lip-sync — the
mouth matching the words — is the entire thing the premium buys.

**Partly closed 2026-08-24.** A Kling render against a real face and a real dialogue line
was watched manually and the lip-sync read as clean, and a second Kling render on the same
frame was made while verifying its billing rate. What is still missing is the CONTROLLED
part: nobody has put an LTX clip and a Kling clip of the same scene side by side. "Kling's
lip-sync looks good" and "Kling's lip-sync is worth 2.8x LTX" are different claims, and
only the second one decides anything. The protocol below is for the second.

## What it costs to be wrong

| model | rate | billed seconds | effective | a 32s ad | ads/day at the $33 cap |
|---|---|---|---|---|---|
| LTX 2.3 fast | $0.06/s | 1.0x (measured) | $0.06/s | $1.92 | ~17 |
| Kling 3.0 Pro | $0.14/s | **1.2x (measured)** | **$0.168/s** | $5.38 | ~6 |

**Corrected 2026-08-24, then corrected again the same day.** This table said $0.04/s and
$1.28 for LTX until fal's billing API was read for the first time and reported
`unit_price=0.06`. Both sides are now measured against real bills — see
`docs/architecture.md` § "What fal actually bills".

The second correction is the interesting one. Kling's **rate is right**: $0.14/s, exactly
what this table always claimed. But a 6-second Kling request that delivered a 6.04s clip
was billed for **7.2 seconds**. LTX, same day and same account, asked for 46 seconds and
was billed 46. So Kling's real cost is $0.168 per delivered second, and this document
would have been wrong even if nobody had ever touched the rate.

Net: the gap moves 3.5x → 2.3x on the rate correction alone, then back to **2.8x** once
Kling's billed quantity is counted. Against the $1,000/month fal budget that is ~520 ads
versus ~186.

One caveat that has to travel with the 1.2x: it is a single sample, and 7.2/6 cannot
distinguish a multiplier from a flat +1.2s floor. One 10s Kling render (~$1.68) settles
it — 12s billed means multiplier, 11.2s means additive.

Answering it costs about **$1.82** ($0.48 on LTX + $1.34 on Kling).

## The test

The point is a controlled comparison. Two clips that differ in the model and in
nothing else — not the prompt, not the reference image, not the script line. A
sloppy A/B here proves nothing and costs the same as a clean one.

`scenes.render_settings_override` (0045, applied 2026-08-22) is the instrument: it
overrides one scene's model while every other setting keeps inheriting the project's.

1. **A real face.** A project whose character reference is an actual generated or
   uploaded person. Not the placeholder — using it again reproduces the exact gap
   this test exists to close.
2. **One talking-head scene.** Mark it `is_talking_head`. That flag does two things
   (`web/lib/talking-head.ts`): it sends the character reference rather than the
   character+product composite, and it is what `PickModel` reads. Give it a line with
   hard consonants — b, p, m closures are where unconvincing lip-sync shows first —
   and include the brand name, since pronunciation is the other thing worth watching.
3. **Render it on the project default (LTX).** Keep the clip. ~8s ≈ $0.48.
4. **Retry the same scene with a Kling override.** Same scene, so same prompt, same
   reference, same script line. ~8s ≈ $1.34 (8 x $0.14 x the 1.2 billed-seconds
   multiplier — see "What it costs to be wrong").
5. **Put them side by side.**

`AUDIO_ENABLED` must be on for both (render.yaml). Overrides are sticky by design —
nothing clears one, not even a successful render — so the scene keeps whichever model
it last rendered with. That is deliberate: it is the record of what the scene was
actually billed at.

## What to look for

- **Do the mouth closures land on the consonants?** Not "is there mouth movement" —
  movement is easy and meaningless. Whether it tracks the words is the question.
- **Does the brand name survive?** Captions take their text from `scenes.script_line`
  rather than ASR precisely because Whisper rendered "CANOCO" for *Kinoko*. Worth
  checking whether the mouth agrees with the audio on the one word that cannot be wrong.
- **Does the face hold?** Character consistency held across three scenes on LTX. If
  Kling drifts, that partly offsets whatever the lip-sync buys.

## Either answer is worth having

- **It works** → Kling is genuinely worth 2.8x for talking-head scenes, and it stays a
  deliberate per-project choice. LTX remains the default, so nothing routes there by
  accident (that mistake was already caught once: `pickModel` checked
  `isTalkingHead && audioEnabled && Kling.Enabled` *ahead of* the project's own
  selection, which would have put every A-roll scene for every editor on Kling).
- **It does not** → the question closes for good. LTX everywhere, the premium is never
  paid, and it stops being an open decision carried into every planning conversation.

The expensive outcome is neither of those. It is leaving it unanswered while twenty
editors start making ads, so a 2.8x model gets chosen by feel.
