package loop

import (
	"errors"
	"sync"
	"time"
)

// BalanceGate stops the dispatch loop from feeding scenes into a fal account
// that cannot pay for them.
//
// Without it, a drained account is not a pause, it is a shredder. Dispatch
// runs every 30 seconds and claims up to RENDER_CONCURRENCY (10) scenes per
// tick; every one of those submissions returns the same insufficient-balance
// error, and every one ends in MarkFailed. That is 1,200 scenes an hour
// converted to 'failed' — none of which were ever actually attempted, all of
// which an operator has to find and retry by hand, each leaving a runs row
// that makes the failure ledger unreadable for the period it covers.
//
// Two constraints shape the design, and both are worth stating because they
// rule out the fixes that look obvious first:
//
//  1. **The worker owns rendering/done/failed, not draft/frame_ready.** It may
//     return a claimed, never-submitted scene to 'queued'
//     (Store.ReleaseUnsubmittedClaim), and does: a scene refused for credit,
//     or stopped by Admit while the gate is closed, goes back in the queue
//     unbilled rather than failing.
//  2. **The worker cannot read the account balance.** That endpoint needs
//     fal's admin scope and the worker only ever holds FAL_KEY (API scope),
//     which gets a 403 — deliberately, since admin scope is full account
//     takeover. So there is no way to check ahead; the worker finds out it
//     is broke by being told no.
//
// Together those mean the first batch after the money runs out is
// unavoidably lost. This gate is about every batch after it.
//
// Backoff rather than a flat cooldown because the case that matters is the
// unattended one. A fixed 15 minutes still burns ten scenes four times an
// hour, which overnight is a few hundred; stepping up to an hour costs at
// most ten scenes per probe once it settles. The probe is deliberate — the
// gate never latches permanently, so funding the account is all it takes to
// resume, with no restart and nothing to clear by hand.
type BalanceGate struct {
	mu sync.Mutex
	// until is when dispatch may next attempt a batch. Zero means open.
	until time.Time
	// backoff is the delay the NEXT trip will apply, doubling from
	// balanceCooldownInitial up to balanceCooldownMax.
	backoff time.Duration
}

const (
	// balanceCooldownInitial is the first pause after an insufficient-balance
	// error. Long enough that someone who is watching can top the account up
	// and see rendering resume without wondering whether it is stuck; short
	// enough that a transient billing blip does not idle the queue for an
	// hour.
	balanceCooldownInitial = 15 * time.Minute
	// balanceCooldownMax bounds the doubling. An hour between probes costs at
	// most ten wasted scenes per hour while the account stays empty, and
	// still recovers within an hour of being funded — which is well inside
	// the window where anyone would notice renders had stopped.
	balanceCooldownMax = 60 * time.Minute
)

// Blocked reports whether dispatch should skip this tick, and until when.
//
// Nil-safe: a zero-value Deps (every existing test constructs one) has no
// gate, and a nil gate never blocks. That keeps this an addition to
// dispatch's behaviour rather than a new precondition every caller has to
// satisfy.
func (g *BalanceGate) Blocked(now time.Time) (bool, time.Time) {
	if g == nil {
		return false, time.Time{}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.until.IsZero() || !now.Before(g.until) {
		return false, time.Time{}
	}
	return true, g.until
}

// Trip records an insufficient-balance error and closes the gate.
//
// Returns the delay applied, so the caller can say how long it is pausing
// for in the same log line that reports why — a log that says only "paused"
// sends someone to read this file to find out for how long.
//
// Repeated trips within one closed window still double the backoff. That is
// deliberate: the batch that tripped the gate had ten scenes in flight
// concurrently, so ten errors arrive at once, and treating each as evidence
// of a longer outage would jump straight to the maximum on the first
// incident. Guarded below by only extending `until` when the new deadline is
// later, so the ten concurrent trips settle on one window rather than ten
// stacked ones.
func (g *BalanceGate) Trip(now time.Time) time.Duration {
	if g == nil {
		return 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.backoff == 0 {
		g.backoff = balanceCooldownInitial
	} else if now.After(g.until) || g.until.IsZero() {
		// Only a trip that arrives after the previous window has already
		// expired counts as a fresh incident worth backing off further. The
		// nine siblings of the batch that opened this window are not nine
		// incidents.
		g.backoff *= 2
		if g.backoff > balanceCooldownMax {
			g.backoff = balanceCooldownMax
		}
	}

	deadline := now.Add(g.backoff)
	if deadline.After(g.until) {
		g.until = deadline
	}
	return g.backoff
}

// ErrBalancePaused is what Admit returns while the gate is closed: kie said it
// is out of credit, so nothing more is sent until the pause ends. Dispatch
// requeues the scene without counting it against maxCapacityRequeues; a pause
// can last an hour, far longer than that bound.
var ErrBalancePaused = errors.New("kie submissions are paused: the account was out of credit")

// Admit is kie.Client.Admit's check: nil while the gate is open, otherwise
// ErrBalancePaused. Nil-safe like Blocked.
func (g *BalanceGate) Admit() error {
	if blocked, _ := g.Blocked(time.Now()); blocked {
		return ErrBalancePaused
	}
	return nil
}

// Clear reopens the gate and forgets the accumulated backoff, called when a
// submission succeeds. Without this the backoff would ratchet up over the
// lifetime of the process: an account that runs dry once a month would, by
// the third month, be pausing for an hour on the first error of an incident
// that a top-up resolved in two minutes.
func (g *BalanceGate) Clear() {
	if g == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.until = time.Time{}
	g.backoff = 0
}
