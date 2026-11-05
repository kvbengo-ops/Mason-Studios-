# demo/

Sample ad scripts for `make compile SCRIPT=demo/<file>.txt`.

These exist so the pipeline can be exercised without waiting on a client script.
They are **not** a substitute for one: these prove the machine runs, a real script
proves the output is good enough to sell. Both are needed, in that order.

```bash
make compile SCRIPT=demo/cold-brew.txt     # ~$0.07 of Anthropic tokens, no video
```

The three scripts are deliberately different, because the compiler's most expensive
decision is `is_talking_head` — lip-synced audio costs $0.14/s against $0.04/s for
silent footage, roughly 60% of the bill. A demo set that is all one shape would not
test that at all.

| File | Shape | What it should stress |
|---|---|---|
| `cold-brew.txt` | Short punchy product spot | Few scenes, mostly B-roll — the cheap path |
| `founder-story.txt` | Direct-to-camera testimonial | Mostly talking head — the expensive path, and character consistency across every scene |
| `city-morning.txt` | Voiceover over visuals, no on-camera speaker | All silent, one character appearing throughout |

## What to look at in the output

Not whether it ran. Whether:

- The character sentence is specific enough to regenerate the *same* person 30 times.
  Vague ("a young woman") produces a different face every scene.
- `is_talking_head` is set only where someone is genuinely speaking on camera. Every
  false positive costs 3.5x more per second than it should.
- Scene durations sum to something a human would actually watch.
- The video prompts describe a shot, not a summary of the line.
