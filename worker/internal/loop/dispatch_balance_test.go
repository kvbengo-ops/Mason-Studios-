package loop

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"ugc-pipeline/worker/internal/config"
)

// The whole value of the gate is WHERE it sits: ahead of ClaimQueuedScenes,
// not inside the per-scene submit loop. Claiming is what
// flips a scene to 'rendering', and the worker may not flip it back to
// 'queued' (AGENTS.md's ownership contract), so a scene claimed while the
// account is empty can only ever end 'failed'. A gate placed one line lower
// would still log "paused" and still return nil — and still shred ten scenes
// a tick.
//
// fakeStore embeds a nil Store, so any method it does not override panics on
// call. It does not override ClaimQueuedScenes. That makes this test a real
// positional assertion rather than a behavioural one: if the check is ever
// moved below that call, this panics instead of passing.
func TestDispatchGatedNeverReachesTheStore(t *testing.T) {
	gate := &BalanceGate{}
	gate.Trip(time.Now())

	deps := Deps{
		Store:   &fakeStore{},
		Config:  &config.Config{RenderConcurrency: 10},
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		Balance: gate,
	}

	if err := Dispatch(context.Background(), deps); err != nil {
		t.Fatalf("gated Dispatch returned error %v, want nil", err)
	}
}

// The mirror of the above, and the reason it is not vacuous: with the gate
// open, Dispatch DOES reach the store on the very next call. Without this,
// a Dispatch that returned early unconditionally — or a Blocked() stuck at
// true — would satisfy the test above perfectly.
func TestDispatchUngatedDoesReachTheStore(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Error("ungated Dispatch never called ClaimQueuedScenes — the gate is blocking when it should not")
		}
	}()

	deps := Deps{
		Store:   &fakeStore{},
		Config:  &config.Config{RenderConcurrency: 10},
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		Balance: &BalanceGate{},
	}

	_ = Dispatch(context.Background(), deps)
}

// An expired pause must let work resume on its own. The failure this guards
// against is a gate that latches: nothing in the worker can clear it by hand
// (no balance endpoint, no admin scope), so a gate that never reopened would
// need a redeploy to start rendering again after a top-up.
func TestDispatchResumesOnceThePauseExpires(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Error("Dispatch stayed paused past the cooldown — the gate latched")
		}
	}()

	gate := &BalanceGate{}
	gate.Trip(time.Now().Add(-balanceCooldownInitial - time.Minute))

	deps := Deps{
		Store:   &fakeStore{},
		Config:  &config.Config{RenderConcurrency: 10},
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		Balance: gate,
	}

	_ = Dispatch(context.Background(), deps)
}
