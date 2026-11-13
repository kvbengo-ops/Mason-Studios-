package media

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// requireFFmpeg skips the test when ffmpeg/ffprobe aren't on PATH, rather
// than failing — this package has no mock mode (see the package doc: it
// wraps the real binary), and CI/dev environments without the Alpine image
// this worker actually ships in shouldn't hard-fail a `go test ./...` run.
func requireFFmpeg(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe not on PATH")
	}
}

// synthClip writes a short lavfi-generated video to path, with a real sine
// audio track when withAudio is true and no audio stream at all when it is
// false — the two source shapes a real fal render can actually produce
// (generate_audio=true vs the current hardcoded-false default).
func synthClip(t *testing.T, path string, durationS int, withAudio bool) {
	t.Helper()
	args := []string{"-y", "-f", "lavfi", "-i",
		"testsrc=size=320x240:duration=" + strconv.Itoa(durationS) + ":rate=24"}
	if withAudio {
		args = append(args, "-f", "lavfi", "-i", "sine=frequency=440:duration="+strconv.Itoa(durationS),
			"-c:a", "aac")
	} else {
		args = append(args, "-an")
	}
	args = append(args, "-c:v", "libx264", path)

	cmd := exec.Command("ffmpeg", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("synthesize test clip: %v: %s", err, stderr.String())
	}
}

// probeAudioFormat returns "sample_rate,channels" for path's first audio
// stream, or "" if it has none — the same shape assertAudioTrack checks,
// used here to assert on Normalize's actual output independent of the
// package's own (equally-testable) assertion logic.
func probeAudioFormat(t *testing.T, path string) string {
	t.Helper()
	cmd := exec.Command("ffprobe", "-v", "error", "-select_streams", "a:0",
		"-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", path)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	_ = cmd.Run() // a clip with no audio stream exits non-zero with empty stdout; that's a valid result here.
	return strings.TrimSpace(stdout.String())
}

// probeDurationSeconds returns ffprobe's container (or, for a:0, stream)
// duration in seconds for path.
func probeDurationSeconds(t *testing.T, path string, streamArgs ...string) float64 {
	t.Helper()
	args := append([]string{"-v", "error"}, streamArgs...)
	args = append(args, "-show_entries", "format=duration", "-of", "csv=p=0", path)
	cmd := exec.Command("ffprobe", args...)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		t.Fatalf("ffprobe duration %s: %v", path, err)
	}
	d, err := strconv.ParseFloat(strings.TrimSpace(stdout.String()), 64)
	if err != nil {
		t.Fatalf("parse duration %q: %v", stdout.String(), err)
	}
	return d
}

func TestNormalize_SynthesizesSilentAudioTrack(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "src.mp4")
	out := filepath.Join(dir, "out.mp4")
	synthClip(t, src, 2, false)

	r := NewRunner(1)
	if err := r.Normalize(context.Background(), src, out, "9:16", CRFFor("")); err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}

	// This is the bug: before pinning an audio track onto every normalized
	// clip, a silent source's Normalize output carried no audio stream at
	// all, so this would read "".
	if got, want := probeAudioFormat(t, out), audioSampleRateHz+","+audioChannels; got != want {
		t.Errorf("normalized silent clip audio format = %q, want %q", got, want)
	}
}

func TestNormalize_PreservesRealAudioTrack(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "src.mp4")
	out := filepath.Join(dir, "out.mp4")
	synthClip(t, src, 2, true)

	r := NewRunner(1)
	if err := r.Normalize(context.Background(), src, out, "9:16", CRFFor("")); err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}

	if got, want := probeAudioFormat(t, out), audioSampleRateHz+","+audioChannels; got != want {
		t.Errorf("normalized clip with real audio, format = %q, want %q", got, want)
	}
}

// TestConcat_MixedAudioSources_AudioCoversFullDuration reproduces the exact
// bug this fix closes: a project mixing a clip with real audio and a clip
// with none, concatenated the old way, ends up with an audio track that
// stops after the first (audio-bearing) clip while the video keeps playing
// — the container's own duration disagrees with its audio stream's
// duration, and Concat exits 0 regardless. After the fix, both clips gain a
// matching audio track in Normalize, so the concatenated audio stream
// covers the full container duration.
func TestConcat_MixedAudioSources_AudioCoversFullDuration(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()

	srcWithAudio := filepath.Join(dir, "src_audio.mp4")
	srcSilent := filepath.Join(dir, "src_silent.mp4")
	synthClip(t, srcWithAudio, 3, true)
	synthClip(t, srcSilent, 3, false)

	r := NewRunner(1)
	normA := filepath.Join(dir, "norm_a.mp4")
	normB := filepath.Join(dir, "norm_b.mp4")
	ctx := context.Background()
	if err := r.Normalize(ctx, srcWithAudio, normA, "9:16", CRFFor("")); err != nil {
		t.Fatalf("Normalize(with audio) error = %v", err)
	}
	if err := r.Normalize(ctx, srcSilent, normB, "9:16", CRFFor("")); err != nil {
		t.Fatalf("Normalize(silent) error = %v", err)
	}

	final := filepath.Join(dir, "final.mp4")
	if err := r.Concat(ctx, []string{normA, normB}, final); err != nil {
		t.Fatalf("Concat() error = %v", err)
	}

	containerDuration := probeDurationSeconds(t, final)
	audioDuration := probeDurationSeconds(t, final, "-select_streams", "a:0")

	// Real-world encode jitter means these won't match to the millisecond;
	// the bug this guards produces a gap of roughly half the total runtime
	// (the whole second clip goes mute), so a generous 1s tolerance still
	// catches it while not flaking on ordinary encoder rounding.
	if diff := containerDuration - audioDuration; diff > 1.0 || diff < -1.0 {
		t.Errorf("container duration = %.3fs, audio stream duration = %.3fs — audio does not cover the full clip (the mixed-audio assembler bug)", containerDuration, audioDuration)
	}
}

// synthColorBarsClip writes a synthetic 1280x720 clip banded red (left
// quarter) | green (middle half) | blue (right quarter) — Kling's own
// receipt shape: both the sound and silent std/720p renders came back
// landscape, 1280x720, regardless of the 9:16 aspect_ratio requested (see
// Normalize's own doc comment). Used to tell a stretch from a centre-crop:
// scaling this straight to 1080x1920 without cropping puts a point near the
// output's left edge over the source's own red band; scaling to COVER
// 1080x1920 and cropping the centre moves that same point well inside the
// green band instead.
func synthColorBarsClip(t *testing.T, path string, durationS int) {
	t.Helper()
	d := strconv.Itoa(durationS)
	cmd := exec.Command("ffmpeg", "-y",
		"-f", "lavfi", "-i", "color=red:size=320x720:duration="+d+":rate=24",
		"-f", "lavfi", "-i", "color=green:size=640x720:duration="+d+":rate=24",
		"-f", "lavfi", "-i", "color=blue:size=320x720:duration="+d+":rate=24",
		"-filter_complex", "[0:v][1:v][2:v]hstack=inputs=3[v]",
		"-map", "[v]", "-an", "-c:v", "libx264", path,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("synthesize color-bars test clip: %v: %s", err, stderr.String())
	}
}

// probeVideoDimensions returns path's first video stream's width and height.
func probeVideoDimensions(t *testing.T, path string) (width, height int) {
	t.Helper()
	cmd := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", path)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		t.Fatalf("ffprobe dimensions %s: %v", path, err)
	}
	parts := strings.Split(strings.TrimSpace(stdout.String()), "x")
	if len(parts) != 2 {
		t.Fatalf("ffprobe dimensions %s: unexpected output %q", path, stdout.String())
	}
	w, err := strconv.Atoi(parts[0])
	if err != nil {
		t.Fatalf("parse width %q: %v", parts[0], err)
	}
	h, err := strconv.Atoi(parts[1])
	if err != nil {
		t.Fatalf("parse height %q: %v", parts[1], err)
	}
	return w, h
}

// probePixelRGB extracts frame 0 of path as raw rgb24 and returns the pixel
// at (x, y), given the frame's own width (for the row-stride offset).
func probePixelRGB(t *testing.T, path string, x, y, width int) (r, g, b byte) {
	t.Helper()
	cmd := exec.Command("ffmpeg", "-y", "-i", path, "-vframes", "1",
		"-f", "rawvideo", "-pix_fmt", "rgb24", "-")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("extract raw frame %s: %v: %s", path, err, stderr.String())
	}
	data := stdout.Bytes()
	offset := (y*width + x) * 3
	if offset+3 > len(data) {
		t.Fatalf("pixel (%d,%d) out of range: frame has %d bytes at width %d", x, y, len(data), width)
	}
	return data[offset], data[offset+1], data[offset+2]
}

// TestNormalize_FillsAndCropsRatherThanStretching pins the 2026-09-10
// operator decision (see Normalize's own doc comment): a clip that arrives
// in the wrong aspect ratio — which is exactly what Kling delivers, since it
// copies its first input picture's shape and ignores aspect_ratio outright —
// is filled and centre-cropped to 1080x1920, not stretched.
//
// The synthetic source is Kling's own receipt shape, 1280x720, banded
// red|green|blue in quarter/half/quarter vertical bands. A plain
// `scale=1080:1920` maps output x=20 (near the left edge) back onto the
// source's own left edge — the red band. The fill-then-crop filter scales
// the source up until it covers 1080x1920 on both axes (driven by the
// height: 1920/720 = 2.667x) and then crops the centre 1080 out of the
// resulting ~3413px width — a window that falls entirely inside the middle
// (green) band. So: stretched, x=20 is red; filled-and-cropped, it's green.
func TestNormalize_FillsAndCropsRatherThanStretching(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "src.mp4")
	out := filepath.Join(dir, "out.mp4")
	synthColorBarsClip(t, src, 1)

	r := NewRunner(1)
	if err := r.Normalize(context.Background(), src, out, "9:16", CRFFor("")); err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}

	width, height := probeVideoDimensions(t, out)
	if width != 1080 || height != 1920 {
		t.Fatalf("normalized dimensions = %dx%d, want 1080x1920", width, height)
	}

	red, green, blue := probePixelRGB(t, out, 20, 960, width)
	// A stretch would land here on the source's red band (high R, low G);
	// fill-and-crop lands well inside the green band instead.
	if !(green > red && green > blue) {
		t.Errorf("pixel (20,960) = rgb(%d,%d,%d), want green-dominant (a stretch would show red here instead)", red, green, blue)
	}
}

// A clip that already arrives 9:16 must be unaffected beyond sub-pixel
// rounding: "cover" and "fit" agree once the source and target aspect
// ratios already match, so this pins that the new fill-then-crop filter
// still produces the same 1080x1920 output for the common (already-vertical)
// case.
func TestNormalize_AlreadyVertical_StillProduces1080x1920(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "src.mp4")
	out := filepath.Join(dir, "out.mp4")

	cmd := exec.Command("ffmpeg", "-y", "-f", "lavfi", "-i",
		"testsrc=size=480x854:duration=1:rate=24", "-an", "-c:v", "libx264", src)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("synthesize 9:16 test clip: %v: %s", err, stderr.String())
	}

	r := NewRunner(1)
	if err := r.Normalize(context.Background(), src, out, "9:16", CRFFor("")); err != nil {
		t.Fatalf("Normalize() error = %v", err)
	}

	width, height := probeVideoDimensions(t, out)
	if width != 1080 || height != 1920 {
		t.Errorf("normalized dimensions = %dx%d, want 1080x1920", width, height)
	}
}

func TestNewRunner_ZeroConcurrencyTreatedAsOne(t *testing.T) {
	r := NewRunner(0)
	if cap(r.sem) != 1 {
		t.Errorf("NewRunner(0) semaphore capacity = %d, want 1", cap(r.sem))
	}
}

func TestHasAudioTrack(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()
	withAudio := filepath.Join(dir, "with_audio.mp4")
	silent := filepath.Join(dir, "silent.mp4")
	synthClip(t, withAudio, 1, true)
	synthClip(t, silent, 1, false)

	r := NewRunner(1)
	ctx := context.Background()

	got, err := r.HasAudioTrack(ctx, withAudio)
	if err != nil {
		t.Fatalf("HasAudioTrack(with audio) error = %v", err)
	}
	if !got {
		t.Error("HasAudioTrack(with audio) = false, want true")
	}

	got, err = r.HasAudioTrack(ctx, silent)
	if err != nil {
		t.Fatalf("HasAudioTrack(silent) error = %v", err)
	}
	if got {
		t.Error("HasAudioTrack(silent) = true, want false")
	}
}

func TestProbeDuration(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "src.mp4")
	synthClip(t, src, 3, false)

	r := NewRunner(1)
	d, err := r.ProbeDuration(context.Background(), src)
	if err != nil {
		t.Fatalf("ProbeDuration() error = %v", err)
	}
	if d < 2.5 || d > 3.5 {
		t.Errorf("ProbeDuration() = %v, want ~3", d)
	}
}

func TestExtractAudio(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "src.mp4")
	out := filepath.Join(dir, "out.wav")
	synthClip(t, src, 2, true)

	r := NewRunner(1)
	if err := r.ExtractAudio(context.Background(), src, out); err != nil {
		t.Fatalf("ExtractAudio() error = %v", err)
	}
	info, err := os.Stat(out)
	if err != nil {
		t.Fatalf("stat extracted audio: %v", err)
	}
	if info.Size() == 0 {
		t.Error("extracted audio file is empty")
	}
}

// TestBurnCaptions_ProducesPlayableVideoWithSubtitleFilterApplied confirms
// this worker's actual ffmpeg build can apply the ass/libass filter at
// all — if it silently fell back (missing --enable-libass), ffmpeg would
// either error on an unknown filter or (worse) succeed while ignoring
// subtitles; this only asserts the run succeeds and produces a valid video
// of the same rough duration, which is the failure mode decision 4 in the
// task this implements is about: the caption-free final that reports
// success. The visual content (are captions actually burned in) is
// verified separately by this task's real end-to-end sample, not by this
// unit test.
func TestBurnCaptions_ProducesPlayableVideoWithSubtitleFilterApplied(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "src.mp4")
	out := filepath.Join(dir, "out.mp4")
	synthClip(t, src, 2, true)

	assContent := `[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 240

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,Anton,24,&H00FFFFFF&,&H00FFFFFF&,&H00101010&,&H00000000&,-1,0,0,0,100,100,0,0,1,3,1,4,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 1,0:00:00.00,0:00:02.00,Word,,0,0,0,,{\an4\pos(160,120)}TEST
`
	assPath := filepath.Join(dir, "captions.ass")
	if err := os.WriteFile(assPath, []byte(assContent), 0o644); err != nil {
		t.Fatalf("write .ass: %v", err)
	}

	fontsDir := t.TempDir()

	r := NewRunner(1)
	if err := r.BurnCaptions(context.Background(), src, assPath, fontsDir, out); err != nil {
		t.Fatalf("BurnCaptions() error = %v — this worker's ffmpeg may lack --enable-libass", err)
	}

	got := probeDurationSeconds(t, out)
	if got < 1.0 || got > 3.0 {
		t.Errorf("captioned output duration = %v, want ~2", got)
	}
}

func TestEscapeFilterValue(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"/tmp/plain/path.ass", "/tmp/plain/path.ass"},
		{"/tmp/weird:path.ass", `/tmp/weird\:path.ass`},
		{"/tmp/a,b.ass", `/tmp/a\,b.ass`},
		{`/tmp/it's.ass`, `/tmp/it\'s.ass`},
	}
	for _, c := range cases {
		if got := escapeFilterValue(c.in); got != c.want {
			t.Errorf("escapeFilterValue(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// A clip over the upload limit is re-encoded at ever-higher CRF, in steps, and
// stops at the floor rather than looping forever.
func TestShrinkCRF(t *testing.T) {
	crf, steps := CRFFor("max"), 0
	for {
		next, ok := ShrinkCRF(crf)
		if !ok {
			break
		}
		if next <= crf {
			t.Fatalf("ShrinkCRF(%d) = %d, want a higher CRF (smaller file)", crf, next)
		}
		crf = next
		steps++
		if steps > 10 {
			t.Fatal("ShrinkCRF never reached its floor")
		}
	}
	if crf != maxShrinkCRF {
		t.Errorf("shrink floor = %d, want %d", crf, maxShrinkCRF)
	}
}
