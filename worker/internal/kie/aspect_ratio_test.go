package kie

import "testing"

func pickFor(t *testing.T, isTalkingHead bool, raw string) Model {
	t.Helper()
	settings, err := ParseRenderSettings([]byte(raw))
	if err != nil {
		t.Fatalf("%s: ParseRenderSettings: %v", raw, err)
	}
	m, err := PickModel(isTalkingHead, true, settings)
	if err != nil {
		t.Fatalf("%s: PickModel: %v", raw, err)
	}
	return m
}

// The operator's ratio reaches the wire for models that take one, and a
// model with a fixed ratio ignores it rather than sending something kie
// never documented for it.
func TestAspectRatio_ReachesTheRequestOnlyWhereAllowed(t *testing.T) {
	cases := []struct {
		settings string
		want     string
	}{
		{`{"model":"seedance-2.5","aspect_ratio":"16:9"}`, "16:9"},
		{`{"model":"wan-3.0","aspect_ratio":"1:1"}`, "1:1"},
		{`{"model":"seedance-2.5"}`, "9:16"},
		{`{"model":"seedance-2.5","aspect_ratio":"21:9"}`, "9:16"},
		{`{"model":"gemini-omni-video","aspect_ratio":"16:9"}`, "9:16"},
		{`{"model":"hailuo-2.3-pro","aspect_ratio":"16:9"}`, ""},
	}
	for _, c := range cases {
		if got := pickFor(t, false, c.settings).AspectRatio; got != c.want {
			t.Errorf("%s: AspectRatio = %q, want %q", c.settings, got, c.want)
		}
	}

	for _, id := range []string{"kling-3.0-pro", "kling-4.0"} {
		d, _ := DescriptorByID(id)
		m := pickFor(t, true, `{"model":"`+id+`","aspect_ratio":"16:9"}`)
		if got := d.BuildInput(SubmitRequest{Prompt: "p", AspectRatio: m.AspectRatio})["aspect_ratio"]; got != "16:9" {
			t.Errorf("%s: aspect_ratio = %v, want 16:9", id, got)
		}
		if got := d.BuildInput(SubmitRequest{Prompt: "p"})["aspect_ratio"]; got != "9:16" {
			t.Errorf("%s with no ratio: aspect_ratio = %v, want 9:16", id, got)
		}
	}
}
