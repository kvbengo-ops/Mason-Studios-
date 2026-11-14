package byteplus

import (
	"math"
	"testing"

	"ugc-pipeline/worker/internal/kie"
)

// Seedance 2.5 Flash goes to BytePlus under its own model id and is billed at
// its own token price; standard 2.5 keeps the configured model and price.
func TestSeedance25FlashModelAndPrice(t *testing.T) {
	c := NewClient("k", "", nil)
	if got := c.modelFor(kie.BytePlusSeedance25FlashID); got != ModelSeedance25Flash {
		t.Errorf("flash model = %q, want %q", got, ModelSeedance25Flash)
	}
	if got := c.modelFor(kie.BytePlusSeedance25ID); got != ModelSeedance25 {
		t.Errorf("2.5 model = %q, want %q", got, ModelSeedance25)
	}
	if !kie.IsBytePlusModel(kie.BytePlusSeedance25FlashID) {
		t.Error("flash is not routed to BytePlus")
	}

	tokens := 1e6
	cost := func(model string, withVideo bool) float64 {
		tk := task{Model: model, Resolution: "480p"}
		tk.Usage = &struct {
			CompletionTokens *float64 `json:"completion_tokens"`
		}{CompletionTokens: &tokens}
		return *costUSD(tk, withVideo)
	}
	for _, tc := range []struct {
		model     string
		withVideo bool
		want      float64
	}{
		{ModelSeedance25Flash, false, 7.0},
		{ModelSeedance25Flash, true, 4.3},
		{ModelSeedance25, false, 10.70},
		{ModelSeedance25, true, 6.40},
	} {
		if got := cost(tc.model, tc.withVideo); math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("cost(%s, video=%v) = %v, want %v", tc.model, tc.withVideo, got, tc.want)
		}
	}
}
