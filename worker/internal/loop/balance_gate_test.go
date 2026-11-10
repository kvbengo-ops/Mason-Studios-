package loop

import (
	"errors"
	"testing"
	"time"
)

var gateEpoch = time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)

func TestBalanceGateNilNeverBlocks(t *testing.T) {
	// Every Deps literal that predates this gate leaves the field nil, and
	// none of them should suddenly stop dispatching. Calling methods on a
	// nil *BalanceGate has to be safe, not merely unused.
	var g *BalanceGate
	if blocked, _ := g.Blocked(gateEpoch); blocked {
		t.Error("a nil gate blocked dispatch")
	}
	if d := g.Trip(gateEpoch); d != 0 {
		t.Errorf("nil Trip returned %v, want 0", d)
	}
	g.Clear()
}

func TestBalanceGateOpenUntilTripped(t *testing.T) {
	g := &BalanceGate{}
	if blocked, _ := g.Blocked(gateEpoch); blocked {
		t.Error("a fresh gate blocked dispatch before any failure")
	}
}

func TestBalanceGateBlocksForTheInitialCooldownThenReopens(t *testing.T) {
	g := &BalanceGate{}
	if d := g.Trip(gateEpoch); d != balanceCooldownInitial {
		t.Errorf("first trip paused %v, want %v", d, balanceCooldownInitial)
	}

	blocked, until := g.Blocked(gateEpoch.Add(time.Minute))
	if !blocked {
		t.Fatal("gate did not block one minute into a 15 minute pause")
	}
	if want := gateEpoch.Add(balanceCooldownInitial); !until.Equal(want) {
		t.Errorf("retry_after = %v, want %v", until, want)
	}

	// Exactly at the deadline the gate is open again, not one tick later:
	// `!now.Before(until)` rather than `now.After(until)`. A dispatch tick
	// landing precisely on the boundary should probe, not wait another 30s.
	if blocked, _ := g.Blocked(gateEpoch.Add(balanceCooldownInitial)); blocked {
		t.Error("gate still blocked at the exact expiry instant")
	}
}

// The batch that trips the gate has RENDER_CONCURRENCY scenes in flight
// concurrently, so ten insufficient-balance errors arrive within
// milliseconds of each other. Treating each as its own incident would jump
// the backoff straight from 15 minutes to the 60 minute cap on the very
// first outage, turning a two-minute top-up into an hour of idle queue.
func TestBalanceGateConcurrentTripsCountAsOneIncident(t *testing.T) {
	g := &BalanceGate{}
	for i := 0; i < 10; i++ {
		g.Trip(gateEpoch.Add(time.Duration(i) * time.Millisecond))
	}

	_, until := g.Blocked(gateEpoch)
	want := gateEpoch.Add(balanceCooldownInitial)
	// Within the millisecond spread of the simulated batch — the assertion
	// is "one window, not ten stacked", not an exact instant.
	if until.Sub(want) > time.Second || want.Sub(until) > time.Second {
		t.Errorf("ten concurrent trips produced a window ending %v, want ~%v", until, want)
	}
}

// A genuinely separate incident — one that arrives after the previous window
// already expired — is what doubles the pause. This is the unattended
// overnight case the backoff exists for: without it, a drained account burns
// ten scenes every 15 minutes all night.
func TestBalanceGateBacksOffAcrossSeparateIncidents(t *testing.T) {
	g := &BalanceGate{}
	now := gateEpoch

	if d := g.Trip(now); d != balanceCooldownInitial {
		t.Fatalf("trip 1 = %v, want %v", d, balanceCooldownInitial)
	}
	now = now.Add(balanceCooldownInitial).Add(time.Second)
	if d := g.Trip(now); d != 2*balanceCooldownInitial {
		t.Fatalf("trip 2 = %v, want %v", d, 2*balanceCooldownInitial)
	}
	now = now.Add(2 * balanceCooldownInitial).Add(time.Second)
	if d := g.Trip(now); d != balanceCooldownMax {
		t.Fatalf("trip 3 = %v, want the %v cap", d, balanceCooldownMax)
	}
	// And it stays capped rather than growing without bound — an account
	// left empty for a week must still probe hourly, not once a day.
	now = now.Add(balanceCooldownMax).Add(time.Second)
	if d := g.Trip(now); d != balanceCooldownMax {
		t.Fatalf("trip 4 = %v, want to stay at the %v cap", d, balanceCooldownMax)
	}
}

// Clear resets the accumulated backoff, not just the current window. Without
// that reset the gate ratchets over the process lifetime: an account that
// runs dry once a month would, months later, meet a two-minute outage with
// an hour-long pause. Asserting the NEXT trip's duration is what catches
// that — an assertion that only checked "not blocked after Clear" passes
// against a Clear that forgets to zero the backoff.
func TestBalanceGateClearResetsTheBackoffNotJustTheWindow(t *testing.T) {
	g := &BalanceGate{}
	now := gateEpoch
	g.Trip(now)
	now = now.Add(balanceCooldownInitial).Add(time.Second)
	g.Trip(now)
	now = now.Add(2 * balanceCooldownInitial).Add(time.Second)
	g.Trip(now)

	g.Clear()
	if blocked, _ := g.Blocked(now); blocked {
		t.Fatal("gate still blocked after Clear")
	}
	if d := g.Trip(now); d != balanceCooldownInitial {
		t.Errorf("first trip after Clear = %v, want back to %v", d, balanceCooldownInitial)
	}
}

func TestBalanceGateAdmit(t *testing.T) {
	var nilGate *BalanceGate
	if err := nilGate.Admit(); err != nil {
		t.Errorf("nil gate Admit() = %v, want nil", err)
	}
	g := &BalanceGate{}
	if err := g.Admit(); err != nil {
		t.Errorf("open gate Admit() = %v, want nil", err)
	}
	g.Trip(time.Now())
	if err := g.Admit(); !errors.Is(err, ErrBalancePaused) {
		t.Errorf("closed gate Admit() = %v, want ErrBalancePaused", err)
	}
}
