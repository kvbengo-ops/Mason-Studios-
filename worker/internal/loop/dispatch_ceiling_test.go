package loop

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"ugc-pipeline/worker/internal/config"
	"ugc-pipeline/worker/internal/store"
)

// claimRecorder is deliberately NOT an override on fakeStore: two tests in
// dispatch_balance_test.go depend on fakeStore panicking the moment Dispatch
// touches the store at all, which is how they assert the balance gate sits
// ahead of the claim. Teaching the shared fake to answer ClaimQueuedScenes
// would silently defeat both.
type claimRecorder struct {
	Store
	ceilings     []int
	byteplusCaps []int
}

func (c *claimRecorder) ClaimQueuedScenes(ctx context.Context, ceiling, byteplusCap int) ([]store.Scene, error) {
	c.ceilings = append(c.ceilings, ceiling)
	c.byteplusCaps = append(c.byteplusCaps, byteplusCap)
	return nil, nil
}

// C4: Dispatch no longer subtracts anything before claiming. It hands
// ClaimQueuedScenes the configured ceiling and lets the claim's own
// statement work out the free slots, which is what makes the limit hold
// across worker instances instead of only within one.
//
// This is the half of C4 a fake can see: if anyone reintroduces a
// count-then-subtract in Go, the number arriving here stops being
// RenderConcurrency and this fails.
func TestDispatchPassesTheCeilingNotTheSlots(t *testing.T) {
	rec := &claimRecorder{}
	deps := Deps{
		Store:   rec,
		Config:  &config.Config{RenderConcurrency: 7},
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		Balance: &BalanceGate{},
	}

	if err := Dispatch(context.Background(), deps); err != nil {
		t.Fatalf("Dispatch returned error %v, want nil", err)
	}

	if len(rec.ceilings) != 1 {
		t.Fatalf("ClaimQueuedScenes called %d times, want 1", len(rec.ceilings))
	}
	if rec.ceilings[0] != 7 {
		t.Errorf("ClaimQueuedScenes(ceiling = %d), want 7 (RenderConcurrency)", rec.ceilings[0])
	}
}

// The BytePlus cap has to reach the claim: it is what keeps an over-cap
// BytePlus scene queued instead of claimed and then failed by the router.
func TestDispatchHandsTheBytePlusCapToTheClaim(t *testing.T) {
	rec := &claimRecorder{}
	deps := Deps{
		Store:            rec,
		Config:           &config.Config{RenderConcurrency: 7},
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		Balance:          &BalanceGate{},
		BytePlusClaimCap: 3,
	}

	if err := Dispatch(context.Background(), deps); err != nil {
		t.Fatalf("Dispatch returned error %v, want nil", err)
	}
	if len(rec.byteplusCaps) != 1 || rec.byteplusCaps[0] != 3 {
		t.Errorf("ClaimQueuedScenes byteplusCap = %v, want [3]", rec.byteplusCaps)
	}
}
