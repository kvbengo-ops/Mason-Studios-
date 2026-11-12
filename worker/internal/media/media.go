// Package media wraps ffmpeg for the two operations the worker needs:
// per-clip normalization and final concatenation. See
// docs/architecture.md § "ffmpeg — not a bottleneck if designed correctly"
// for why the split matters — normalizing each ~8s clip as it arrives
// (~5-10s of CPU) costs zero additional wall-clock because the next clip is
// still ~3 minutes away, which turns the final concat into a `-c copy`
// stream copy (~2s) instead of a 10-20 minute re-encode of the whole video.
package media

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const (
	// ffmpegTimeout bounds one ffmpeg process. Generous enough for caption
	// burn-in of a full assembled video on Render's single CPU, while still
	// stopping one wedged process from holding a semaphore slot — and
	// blocking shutdown — forever. The process context inherits only the
	// process lifetime, so without this there is no deadline at all.
	ffmpegTimeout = 30 * time.Minute
	// ffprobeTimeout bounds one ffprobe. It only reads container/stream
	// metadata; a probe that cannot finish this fast is wedged, not slow.
	ffprobeTimeout = 30 * time.Second
)

// Runner executes ffmpeg, bounding how many processes run concurrently.
// The cap matters on the webhook path specifically: five simultaneous fal
// callbacks must not be able to saturate the CPU and starve the HTTP
// handler goroutine that's supposed to be responding 200 quickly.
type Runner struct {
	sem chan struct{}
}

// NewRunner builds a Runner allowing at most concurrency simultaneous
// ffmpeg processes. concurrency <= 0 is treated as 1 (never zero — a
// zero-capacity semaphore would deadlock forever, not run serially).
func NewRunner(concurrency int) *Runner {
	if concurrency <= 0 {
		concurrency = 1
	}
	return &Runner{sem: make(chan struct{}, concurrency)}
}

// audioSampleRateHz, audioChannels and audioBitrate are the exact audio
// format every normalized clip must carry, whether its source had a real
// audio track or not. Concat below is `-c copy` — a bitstream copy, not a
// re-encode — which requires every input's streams to already match
// exactly; it has no way to reconcile a 48kHz stereo AAC track against a
// 44.1kHz mono one, and ffmpeg does not error on the mismatch, it just
// produces a broken or partial-duration output (see Normalize's synthesized
// track below, and Concat's doc comment, for the failure this closes).
// Values match what a real fal render with generate_audio=true actually
// returns, so the common case — every clip already has real audio — never
// needs resampling, only the newly-possible silent-clip case does.
const (
	audioSampleRateHz = "48000"
	audioChannels     = "2"
	audioBitrate      = "128k"
)

// FrameSize is the normalized width x height for an aspect ratio.
func FrameSize(aspectRatio string) (w, h int) {
	switch aspectRatio {
	case "16:9":
		return 1920, 1080
	case "1:1":
		return 1080, 1080
	default:
		return 1080, 1920
	}
}

// Normalize re-encodes inPath into outPath at a fixed resolution/framerate
// so every clip in a project is bit-for-bit compatible for a later stream
// copy concat: scale to 1080x1920 @ 24fps, H.264 + AAC.
//
// FILL, THEN CENTRE-CROP — not stretch. kie's Kling ignores the
// aspect_ratio field outright and copies its first input picture's own
// shape instead (both the sound and silent std/720p receipts came back
// landscape, 1280x720, against a 9:16 request — see lib/kie/rates.ts's
// KLING_STD_MEASURED/KLING_STD_SILENT_MEASURED notes on the web side). A
// plain `scale=1080:1920` stretched that landscape frame to fill a 9:16
// canvas, squashing every subject in it. `force_original_aspect_ratio=
// increase` scales the source up until it fully covers 1080x1920 on both
// axes, then `crop=1080:1920` takes the centre 1080x1920 out of that —
// filling the frame at the source's own proportions and losing the edges
// instead of the shape. Operator decision, 2026-09-10: crop, not letterbox
// — a cropped subject reads as a normal vertical clip; a letterboxed one
// reads as broken. A clip that already arrives 9:16 is unaffected beyond
// sub-pixel rounding, since "cover" and "fit" agree once the aspect ratios
// already match.
//
// Every normalized clip is given an audio track, synthesized if the source
// doesn't have one. Before this, a clip rendered with generate_audio=false
// (or from before AUDIO_ENABLED existed) came out of Normalize with no
// audio stream at all, while a clip rendered with audio came out with one —
// and Concat's `-c copy` doesn't require every input to agree on that, it
// just silently produces whichever of two broken shapes ffmpeg's concat
// demuxer happens to fall into: dropping audio from the whole final, or
// stretching one clip's track across the entire runtime while the rest play
// mute. Both exit 0, so `assemble` recorded the broken file as a success —
// reproduced locally with these exact ffmpeg args against a real
// audio/silent clip pair before this fix, and against the same pair after
// it, to confirm the difference. A probe where every scene has audio never
// hits this; the moment anyone re-renders one scene of an older silent
// project, or renders a project with AUDIO_ENABLED flipped mid-project, it
// does.
//
// probeHasAudio decides which ffmpeg invocation to use: a real audio track
// is simply re-encoded to the pinned format (audioSampleRateHz/
// audioChannels/audioBitrate); a missing one is filled in from `anullsrc`
// (ffmpeg's built-in silence generator, via the lavfi virtual device),
// capped to the video's own length with `-shortest` so the infinite
// synthetic source doesn't extend the clip. assertAudioTrack then re-probes
// the file Normalize just wrote and fails loudly if it doesn't carry
// exactly the pinned format — belt-and-suspenders against a future flag
// regression here reproducing the exact "exits 0, output is silently wrong"
// failure this whole fix exists to close.
//
// -movflags +faststart moves the moov atom (the index of every frame's
// byte offset) to the front of the file. Without it, ffmpeg appends moov
// after mdat by default, so a browser can't learn duration/dimensions —
// or seek at all — without first reading to the end of the file. Every
// <video> in the web app sets preload="metadata" specifically to avoid
// pulling whole videos on page load (web/components/clip-grid.tsx,
// web/app/(app)/projects/[id]/deliver/page.tsx); on the 3G/4G connections
// these are watched over, a moov-at-the-end file defeats that entirely.
// Confirmed against a real asset already in the bucket: a 12.3MB final.mp4
// produced before this change has moov as the LAST atom, so 100% of the
// file must be read to reach it — see the verification notes accompanying
// this change.
//
// CRFFor maps a scene's render_settings quality (editor's pick in /ugc) to x264's
// CRF. Lower is a higher bitrate and a bigger file; unset or unknown keeps the
// long-standing 20, so the API and older scenes encode exactly as before.
func CRFFor(quality string) int {
	switch quality {
	case "high":
		return 17
	case "max":
		return 14
	default:
		return 20
	}
}

// aspectRatio picks the frame (FrameSize): 1080x1920 for 9:16 and anything
// unrecognised, 1920x1080 for 16:9, 1080x1080 for 1:1. crf is x264's quality
// (lower = higher bitrate); callers take it from CRFFor.
func (r *Runner) Normalize(ctx context.Context, inPath, outPath, aspectRatio string, crf int) error {
	hasAudio, err := r.probeHasAudio(ctx, inPath)
	if err != nil {
		return fmt.Errorf("media: normalize %s: probe audio: %w", inPath, err)
	}

	w, h := FrameSize(aspectRatio)
	args := []string{"-y", "-i", inPath}
	if !hasAudio {
		// Second input: an infinite silent audio stream at the pinned
		// format. `-shortest` below trims it to inPath's video length so
		// the output isn't extended past the real clip.
		args = append(args, "-f", "lavfi", "-i",
			fmt.Sprintf("anullsrc=channel_layout=stereo:sample_rate=%s", audioSampleRateHz))
	}
	args = append(args,
		"-vf", fmt.Sprintf("scale=%[1]d:%[2]d:force_original_aspect_ratio=increase,crop=%[1]d:%[2]d,fps=24", w, h),
		// superfast, not veryfast: about half the CPU per clip on the one-CPU
		// worker, for a file about 60% bigger at the same crf.
		"-c:v", "libx264", "-preset", "superfast", "-crf", strconv.Itoa(crf),
		"-c:a", "aac", "-ar", audioSampleRateHz, "-ac", audioChannels, "-b:a", audioBitrate,
	)
	if !hasAudio {
		args = append(args, "-shortest")
	}
	args = append(args, "-movflags", "+faststart", outPath)

	if err := r.run(ctx, args); err != nil {
		return fmt.Errorf("media: normalize %s: %w", inPath, err)
	}
	if err := r.assertAudioTrack(ctx, outPath); err != nil {
		return fmt.Errorf("media: normalize %s: %w", inPath, err)
	}
	return nil
}

// Concat stream-copies inPaths (already-normalized, identical format) into
// a single outPath. Cheap by design — see the package doc — but only if
// every input already went through Normalize; concatenating mismatched
// clips with -c copy produces a broken or garbled output. Normalize's
// synthesized-silence branch and its assertAudioTrack check are what make
// "every input already went through Normalize" actually sufficient here —
// before that, two Normalize outputs could legally differ on whether they
// carried an audio stream at all, which is exactly the mismatch this
// function has no way to detect or reconcile: `-c copy` copies bitstreams,
// it does not inspect or align them across inputs.
//
// -movflags +faststart applies here too, for the same reason as Normalize's
// doc comment: this is the path that produces the 'final' asset the
// Deliver page's assembled-video player loads. +faststart is a metadata
// rewrite (a second pass moving moov, not a re-encode), so it's compatible
// with -c copy and doesn't reintroduce the CPU cost stream-copy exists to
// avoid.
func (r *Runner) Concat(ctx context.Context, inPaths []string, outPath string) error {
	if len(inPaths) == 0 {
		return fmt.Errorf("media: concat: no input paths")
	}

	listFile, err := writeConcatList(inPaths)
	if err != nil {
		return fmt.Errorf("media: concat: %w", err)
	}
	defer os.Remove(listFile)

	args := []string{
		"-y",
		"-f", "concat", "-safe", "0",
		"-i", listFile,
		"-c", "copy",
		"-movflags", "+faststart",
		outPath,
	}
	if err := r.run(ctx, args); err != nil {
		return fmt.Errorf("media: concat %d clips: %w", len(inPaths), err)
	}
	return nil
}

// posterSeekSeconds is how far into the source to seek before grabbing the
// poster frame. Not "0" deliberately: the first frame of an encoded clip is
// frequently black (encoder init / the fal render's own lead-in), so
// frame 0 makes a worse placeholder than no placeholder at all. 1s is safe
// against every scene length the schema allows — scenes.duration_s is
// constrained to {6, 8, ..., 20} (0010_scene_duration_allowed_set.sql), so
// every clip and every assembled final is at least 6s long.
const posterSeekSeconds = "1"

// posterScale matches the aspect ratio Normalize already fixed every clip
// to (1080x1920) at exactly 1/3 size, so there's no letterboxing or
// distortion to account for — just a clean downscale. 360x640 landed at
// ~15KB against a real 1080x1920 ad frame at posterQuality below, well
// inside the "tens of KB" a poster needs to stay cheap on 3G/4G.
// Written as iw/3:ih/3 so a 16:9 or 1:1 clip gets its own shape at the same
// 1/3 size (640x360, 360x360) — 360x640 for the 9:16 clips described above.
const posterScale = "scale=iw/3:ih/3"

// posterQuality is ffmpeg's mjpeg -q:v value: 2 (best/largest) to 31
// (worst/smallest). 5 is toward the high-quality end of that range but
// still measured at ~15KB — see posterScale's comment for the measurement
// this was picked against.
const posterQuality = "5"

// ExtractPoster grabs a single downscaled JPEG frame from inPath at
// posterSeekSeconds in and writes it to outPath. Used for both a scene's
// clip (internal/ingest, after Normalize) and a project's assembled final
// (internal/loop/assemble, after Concat) — every <video> in the web app
// renders blank/black until its metadata resolves, and this is the one
// affordance against that on a slow connection. Deliberately mjpeg, not
// libwebp: mjpeg is one of ffmpeg's built-in encoders with no external
// library dependency, so it needs no verification against exactly how the
// worker's Alpine image was built (Dockerfile just does `apk add ffmpeg`),
// where libwebp support is a compile-time flag this repo has never checked.
//
// Callers MUST treat a returned error as non-fatal: a missing poster must
// never fail or block a render or an assembly. See internal/ingest's and
// internal/loop/assemble's callers for the log-and-continue handling.
func (r *Runner) ExtractPoster(ctx context.Context, inPath, outPath string) error {
	args := []string{
		"-y",
		"-ss", posterSeekSeconds,
		"-i", inPath,
		"-frames:v", "1",
		"-vf", posterScale,
		"-q:v", posterQuality,
		outPath,
	}
	// A seek past the end of the file produces no frame and ffmpeg exits
	// non-zero, which is what every mocked render did: the mock clip is
	// about a second long and posterSeekSeconds is 1, so the seek landed on
	// or past the last frame. Real renders are 6s and up so this never fired
	// in production — but "extract poster failed" on every local clip is
	// noise that trains an operator to ignore the log. Retried from the
	// first frame, which is a worse poster than one second in and a better
	// one than none.
	if err := r.run(ctx, args); err != nil {
		fallback := append([]string(nil), args...)
		for i, a := range fallback {
			if a == posterSeekSeconds && i > 0 && fallback[i-1] == "-ss" {
				fallback[i] = "0"
				break
			}
		}
		if fallbackErr := r.run(ctx, fallback); fallbackErr != nil {
			return fmt.Errorf("media: extract poster %s: %w", inPath, err)
		}
		return nil
	}
	return nil
}

// run executes ffmpeg with args, bounded by the semaphore, and folds
// stderr into the returned error — a bare "exit status 1" tells nobody
// anything useful at 2am.
func (r *Runner) run(ctx context.Context, args []string) error {
	select {
	case r.sem <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-r.sem }()

	cmdCtx, cancel := context.WithTimeout(ctx, ffmpegTimeout)
	defer cancel()

	cmd := exec.CommandContext(cmdCtx, "ffmpeg", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// probeHasAudio reports whether inPath carries at least one audio stream,
// via ffprobe rather than ffmpeg — this is a read, not a transcode, and
// runs outside r.sem: it is fast enough (metadata only, no decode) that
// bounding it alongside actual ffmpeg transcodes would just make Normalize
// wait on a semaphore slot for work that was never going to use meaningful
// CPU. Determines which of Normalize's two ffmpeg invocations to build.
func (r *Runner) probeHasAudio(ctx context.Context, inPath string) (bool, error) {
	probeCtx, cancel := context.WithTimeout(ctx, ffprobeTimeout)
	defer cancel()

	cmd := exec.CommandContext(probeCtx, "ffprobe",
		"-v", "error",
		"-select_streams", "a",
		"-show_entries", "stream=codec_type",
		"-of", "csv=p=0",
		inPath,
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return false, fmt.Errorf("ffprobe %s: %w: %s", inPath, err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(stdout.String()) != "", nil
}

// assertAudioTrack fails loudly if path's first audio stream does not carry
// exactly the pinned sample rate and channel count Normalize just asked
// ffmpeg to produce (audioSampleRateHz/audioChannels). This is what turns a
// silent ffmpeg misconfiguration here — a dropped -ar/-ac flag, an
// -shortest that didn't apply, a future edit that reorders args badly
// enough to drop the audio map — into a failed scene instead of a clip that
// Concat later corrupts without either step ever returning a non-nil error.
func (r *Runner) assertAudioTrack(ctx context.Context, path string) error {
	probeCtx, cancel := context.WithTimeout(ctx, ffprobeTimeout)
	defer cancel()

	cmd := exec.CommandContext(probeCtx, "ffprobe",
		"-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "stream=sample_rate,channels",
		"-of", "csv=p=0",
		path,
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffprobe %s: %w: %s", path, err, strings.TrimSpace(stderr.String()))
	}
	got := strings.TrimSpace(stdout.String())
	want := audioSampleRateHz + "," + audioChannels
	if got == "" {
		return fmt.Errorf("normalized output %s has no audio stream at all, want %s", path, want)
	}
	if got != want {
		return fmt.Errorf("normalized output %s has audio format (sample_rate,channels) = %q, want %q — Concat's -c copy requires every clip to match exactly", path, got, want)
	}
	return nil
}

// ---------------------------------------------------------------------------
// captions
// ---------------------------------------------------------------------------

// HasAudioTrack reports whether inPath carries a real audio stream — an
// exported wrapper around probeHasAudio for internal/loop/assemble's
// caption gate (decision 7 in the task this implements: "gate on ...
// whether the clip carries a real audio track — media.go already has
// probeHasAudio"). Note its limitation there: by the time assemble
// downloads a clip, it has already been through Normalize, which
// synthesizes a silent track onto every clip that didn't have one — so this
// alone cannot distinguish "real speech" from "normalize's own silence
// filler." It is combined with is_talking_head and AUDIO_ENABLED at the
// call site specifically because neither of those alone is sufficient
// either; together they're the closest approximation to "this scene should
// have dialogue" available without re-probing the pre-Normalize source
// (which assemble never downloads — only the already-normalized clip is in
// Storage). See assembleProject's caption gate for the full reasoning.
func (r *Runner) HasAudioTrack(ctx context.Context, path string) (bool, error) {
	return r.probeHasAudio(ctx, path)
}

// ProbeDuration returns inPath's container duration in seconds, via
// ffprobe. Used by the caption pipeline to accumulate each scene's offset
// into the final concatenated video (internal/loop/assemble) — probed
// directly off the downloaded clip rather than trusted from
// assets.duration_s, since the DB value is fal's self-reported duration at
// render time and the actual file is the ground truth for how long ffmpeg
// will actually play it.
func (r *Runner) ProbeDuration(ctx context.Context, path string) (float64, error) {
	probeCtx, cancel := context.WithTimeout(ctx, ffprobeTimeout)
	defer cancel()

	cmd := exec.CommandContext(probeCtx, "ffprobe",
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "csv=p=0",
		path,
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return 0, fmt.Errorf("ffprobe duration %s: %w: %s", path, err, strings.TrimSpace(stderr.String()))
	}
	d, err := strconv.ParseFloat(strings.TrimSpace(stdout.String()), 64)
	if err != nil {
		return 0, fmt.Errorf("ffprobe duration %s: parse %q: %w", path, stdout.String(), err)
	}
	return d, nil
}

// ExtractAudio pulls inPath's audio into a mono 16kHz PCM WAV at outPath —
// the shape fal-ai/whisper expects, matching the proof of concept's
// transcribe.js exactly (`-vn -ac 1 -ar 16000 -acodec pcm_s16le`). Bounded
// by r.sem like every other transcode here: it's cheap, but still real
// ffmpeg work competing for the same CPU budget as Normalize/Concat.
func (r *Runner) ExtractAudio(ctx context.Context, inPath, outPath string) error {
	args := []string{
		"-y", "-i", inPath,
		"-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le",
		outPath,
	}
	if err := r.run(ctx, args); err != nil {
		return fmt.Errorf("media: extract audio %s: %w", inPath, err)
	}
	return nil
}

// BurnCaptions renders assPath's subtitle track onto inPath via ffmpeg's
// `ass` filter (libass) and writes outPath. fontsDir points libass at the
// bundled caption font (internal/captions.FontBytes, extracted to a temp
// directory by the caller) — the `ass` filter's own fontsdir option, not
// fontconfig: libass matches font family names against files in this
// directory directly, so it works regardless of whether the OS's
// fontconfig cache knows about the font at all. Audio is stream-copied
// (`-c:a copy`) since burning captions never touches the audio track; video
// must be re-encoded because libass draws into the decoded frames.
//
// Requires ffmpeg built with --enable-libass — verified present in this
// worker's actual Alpine image (`apk add ffmpeg` on alpine:3.20 pulls a
// build configured with --enable-libass and --enable-libfontconfig; checked
// by running the image and grepping `ffmpeg -version`'s configuration line,
// not assumed from a local machine's ffmpeg) rather than a silent fallback
// that would produce a caption-free final reporting success.
func (r *Runner) BurnCaptions(ctx context.Context, inPath, assPath, fontsDir, outPath string) error {
	filterArg := fmt.Sprintf("ass=filename=%s:fontsdir=%s", escapeFilterValue(assPath), escapeFilterValue(fontsDir))
	args := []string{
		"-y", "-i", inPath,
		"-vf", filterArg,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
		"-c:a", "copy",
		"-movflags", "+faststart",
		outPath,
	}
	if err := r.run(ctx, args); err != nil {
		return fmt.Errorf("media: burn captions %s: %w", inPath, err)
	}
	return nil
}

// escapeFilterValue backslash-escapes the characters ffmpeg's filtergraph
// parser treats specially (: separates a filter's key=value options, ,
// separates filters, ' and \ are the escape mechanism itself, [ ] ; name
// pads/links) — needed because BurnCaptions passes real filesystem paths
// (temp directories, possibly containing any of these on some platform)
// as filter option values, not as separately shell-quoted arguments; ffmpeg
// parses -vf's value as one filtergraph string regardless of how
// exec.Command delivered it.
func escapeFilterValue(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '\\', ':', '\'', ',', '[', ']', ';':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// writeConcatList writes ffmpeg's concat-demuxer list file (one
// `file '<path>'` line per input) to a temp file and returns its path. The
// caller owns cleanup.
func writeConcatList(inPaths []string) (string, error) {
	f, err := os.CreateTemp("", "ugc-concat-*.txt")
	if err != nil {
		return "", fmt.Errorf("create concat list: %w", err)
	}
	defer f.Close()

	var b strings.Builder
	for _, p := range inPaths {
		// ffmpeg's concat demuxer treats each line as a mini config file;
		// single quotes delimit the path and must themselves be escaped as
		// '\'' (close quote, literal quote, reopen quote).
		escaped := strings.ReplaceAll(p, "'", `'\''`)
		fmt.Fprintf(&b, "file '%s'\n", escaped)
	}

	if _, err := f.WriteString(b.String()); err != nil {
		os.Remove(f.Name())
		return "", fmt.Errorf("write concat list: %w", err)
	}
	return f.Name(), nil
}
