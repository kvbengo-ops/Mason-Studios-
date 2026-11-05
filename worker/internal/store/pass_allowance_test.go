package store

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// pass_allowance (0087_pass_allowance.sql) against a real database.
//
// These exist because of a security review, and each one pins a claim that was
// FALSE in the first draft of that migration:
//
//   - the function was callable by `authenticated`, so an editor could reach it
//     through PostgREST without the dialog or the Server Action;
//   - it took the sender's spendable headroom as an argument and believed it,
//     so that caller could name their own balance;
//   - it took the expiry as an argument and wrote it, so a pass could be made
//     to outlive the weekly reset it is supposed to expire with.
//
// Unit tests cannot catch any of that. The first is a GRANT, the second is
// arithmetic the database now does itself, and the third is a boundary computed
// in SQL — all three live below the application, which is where the bug was.
//
// Gated on TEST_DATABASE_URL like every other test in this package. Note the
// hazard the Makefile's db-test-scratch target documents: without that variable
// these SKIP and the package still prints ok, so a green run here proves
// nothing unless the variable was set.

func passAllowanceStore(t *testing.T) (*Store, context.Context) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping database-backed test")
	}
	ctx := context.Background()
	s, err := New(ctx, dsn, false)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s, ctx
}

// seedEditor makes an active account at the given role, ready to be either end
// of a pass. Cleanup of its grants runs before seedUser's own profile delete,
// because allowance_grants references profiles twice (user_id and, since 0087,
// transfer_peer_id).
func seedEditor(ctx context.Context, t *testing.T, s *Store, role string) string {
	t.Helper()
	userID := seedUser(ctx, t, s)
	if _, err := s.pool.Exec(ctx, `UPDATE profiles SET role = $2 WHERE id = $1`, userID, role); err != nil {
		t.Fatalf("set role %q: %v", role, err)
	}
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(),
			`DELETE FROM allowance_grants WHERE user_id = $1 OR transfer_peer_id = $1 OR granted_by = $1`,
			userID,
		); err != nil {
			t.Errorf("cleanup grants for %s: %v", userID, err)
		}
	})
	return userID
}

// seedWeeklySpend books cost against an account inside the current Manila week,
// as a project-less run — the shape 0085 made count through
// coalesce(runs.user_id, projects.user_id). This is the sender's own spend, and
// the point of every test that calls it is that pass_allowance reads it for
// itself rather than being told what it is.
func seedWeeklySpend(ctx context.Context, t *testing.T, s *Store, userID string, costUsd float64) {
	t.Helper()
	if _, err := s.pool.Exec(ctx, `
INSERT INTO runs (user_id, vendor, model, cost_usd, created_at)
VALUES ($1, 'kie', 'google/nano-banana', $2, now())`, userID, costUsd); err != nil {
		t.Fatalf("seed weekly spend: %v", err)
	}
	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(), `DELETE FROM runs WHERE user_id = $1`, userID); err != nil {
			t.Errorf("cleanup runs for %s: %v", userID, err)
		}
	})
}

// callPass invokes the function as the SERVICE ROLE, which is the only role
// that may (0087 section 2b) and the one web/actions/transfer.ts uses.
func callPass(
	ctx context.Context, s *Store, from, to string, amount, baseCap, held float64, note *string,
) (time.Time, error) {
	var expiresAt time.Time
	err := s.pool.QueryRow(ctx, `
select pass_allowance(
  p_from_user_id        => $1,
  p_to_user_id          => $2,
  p_amount_usd          => $3,
  p_weekly_base_cap_usd => $4,
  p_held_usd            => $5,
  p_note                => $6
)`, from, to, amount, baseCap, held, note).Scan(&expiresAt)
	return expiresAt, err
}

// manilaWeekEnd is the boundary the function must derive: the next Monday 00:00
// Asia/Manila. Computed by the database rather than in Go so the assertion is
// against the same clock the function used, not against this test process's
// idea of "now" — but through an INDEPENDENT expression, so a wrong expression
// inside pass_allowance is not compared against a copy of itself.
func manilaWeekEnd(ctx context.Context, t *testing.T, s *Store) time.Time {
	t.Helper()
	var end time.Time
	if err := s.pool.QueryRow(ctx, `
select (date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')
       + interval '7 days'`).Scan(&end); err != nil {
		t.Fatalf("compute manila week end: %v", err)
	}
	return end
}

type grantRow struct {
	userID    string
	amountUsd float64
	expiresAt time.Time
	grantedBy string
	peerID    *string
}

func grantsFor(ctx context.Context, t *testing.T, s *Store, userIDs ...string) []grantRow {
	t.Helper()
	rows, err := s.pool.Query(ctx, `
select user_id, amount_usd, expires_at, granted_by, transfer_peer_id
from allowance_grants
where user_id = any($1)
order by amount_usd desc`, userIDs)
	if err != nil {
		t.Fatalf("read grants: %v", err)
	}
	defer rows.Close()

	var out []grantRow
	for rows.Next() {
		var g grantRow
		if err := rows.Scan(&g.userID, &g.amountUsd, &g.expiresAt, &g.grantedBy, &g.peerID); err != nil {
			t.Fatalf("scan grant: %v", err)
		}
		out = append(out, g)
	}
	return out
}

// TestPassAllowanceIsUnreachableByAuthenticated is the finding itself: an
// editor could call this straight through PostgREST. `authenticated` is the
// role PostgREST assumes for any signed-in browser session, so a permission
// error here is the whole difference between "the app checks your headroom" and
// "you may state your headroom".
//
// The failure this guards against is a silent one: 0007_grants.sql grants
// execute on every public function to `authenticated` BY DEFAULT, so deleting
// the revoke in 0087 does not break anything visible — it just quietly reopens
// the hole.
func TestPassAllowanceIsUnreachableByAuthenticated(t *testing.T) {
	s, ctx := passAllowanceStore(t)

	sender := seedEditor(ctx, t, s, "editor")
	recipient := seedEditor(ctx, t, s, "editor")

	runAsUser(ctx, t, s, sender, func(tx pgx.Tx) {
		var expiresAt time.Time
		err := tx.QueryRow(ctx, `
select pass_allowance($1::uuid, $2::uuid, $3::numeric, $4::numeric, $5::numeric, null)`,
			sender, recipient, 1.0, 1000000.0, 0.0).Scan(&expiresAt)
		if err == nil {
			t.Fatal("authenticated caller executed pass_allowance; it must be service-role only")
		}
		if !strings.Contains(strings.ToLower(err.Error()), "permission denied") {
			t.Fatalf("want a permission error for an authenticated caller, got: %v", err)
		}
	})

	if got := grantsFor(ctx, t, s, sender, recipient); len(got) != 0 {
		t.Fatalf("a refused call still wrote %d grant rows", len(got))
	}
}

// TestPassAllowanceOldSignatureIsGone pins the other half of the same fix. A
// changed argument list does not replace a function, it ADDS one: without the
// explicit drop in 0087, the five-argument version taking p_sender_headroom_usd
// and p_expires_at would still exist, still be callable by `authenticated`, and
// PostgREST would still route to it. The hole would be closed on paper and open
// in the database.
func TestPassAllowanceOldSignatureIsGone(t *testing.T) {
	s, ctx := passAllowanceStore(t)

	var n int
	if err := s.pool.QueryRow(ctx, `
select count(*)
from pg_proc p
join pg_namespace ns on ns.oid = p.pronamespace
where ns.nspname = 'public'
  and p.proname = 'pass_allowance'
  and pg_get_function_identity_arguments(p.oid) like '%p_sender_headroom_usd%'`).Scan(&n); err != nil {
		t.Fatalf("inspect signatures: %v", err)
	}
	if n != 0 {
		t.Fatalf("the headroom-taking signature still exists (%d overloads); the drop in 0087 is missing", n)
	}
}

// TestPassAllowanceUsesAuthoritativeSpend is the fake-headroom finding stated
// as arithmetic. The sender has a $10 base cap and has already spent $8, so $2
// is available. Nothing the caller can pass makes $5 affordable, because the
// $8 is read from `runs` inside the function rather than being subtracted by
// whoever called it.
func TestPassAllowanceUsesAuthoritativeSpend(t *testing.T) {
	s, ctx := passAllowanceStore(t)

	sender := seedEditor(ctx, t, s, "editor")
	recipient := seedEditor(ctx, t, s, "editor")
	seedWeeklySpend(ctx, t, s, sender, 8)

	if _, err := callPass(ctx, s, sender, recipient, 5, 10, 0, nil); err == nil {
		t.Fatal("passed $5 with $2 of real headroom; spend is not being read authoritatively")
	} else if !strings.Contains(err.Error(), "remaining allowance") {
		t.Fatalf("want a remaining-allowance refusal, got: %v", err)
	}

	// And the boundary is where it should be, not merely somewhere: $2 fits.
	if _, err := callPass(ctx, s, sender, recipient, 2, 10, 0, nil); err != nil {
		t.Fatalf("exactly the available $2 should pass, got: %v", err)
	}
}

// TestPassAllowanceCountsHeldAndGrants covers the two remaining terms of the
// same sum: work already queued but not yet billed (held, which only the
// application can price) and the sender's own active grants (which only the
// database can total).
func TestPassAllowanceCountsHeldAndGrants(t *testing.T) {
	s, ctx := passAllowanceStore(t)

	t.Run("held_reduces_what_can_be_passed", func(t *testing.T) {
		sender := seedEditor(ctx, t, s, "editor")
		recipient := seedEditor(ctx, t, s, "editor")

		// $10 cap, $9 of renders in flight: $1 left, so $5 must be refused.
		if _, err := callPass(ctx, s, sender, recipient, 5, 10, 9, nil); err == nil {
			t.Fatal("held renders were ignored; a sender can pass budget already committed")
		}
	})

	t.Run("a_grant_raises_it", func(t *testing.T) {
		sender := seedEditor(ctx, t, s, "editor")
		recipient := seedEditor(ctx, t, s, "editor")

		// $0 base cap — the production default for a new editor — plus a $6
		// grant. The grant is the entire headroom, and it must be counted or a
		// granted editor could pass nothing at all.
		if _, err := s.pool.Exec(ctx, `
INSERT INTO allowance_grants (user_id, amount_usd, expires_at, granted_by)
VALUES ($1, 6, now() + interval '3 days', $1)`, sender); err != nil {
			t.Fatalf("seed grant: %v", err)
		}

		if _, err := callPass(ctx, s, sender, recipient, 6, 0, 0, nil); err != nil {
			t.Fatalf("a $6 grant should be passable in full, got: %v", err)
		}
		if _, err := callPass(ctx, s, sender, recipient, 1, 0, 0, nil); err == nil {
			t.Fatal("passed more than the grant held; the -X row is not reducing the sum")
		}
	})
}

// TestPassAllowanceRejectsHeadroomInflatingArguments guards the two parameters
// that survived. They are server-computed and unreachable from a browser, but a
// wrong SIGN on either one manufactures allowance out of nothing — a negative
// held amount ADDS headroom — so the function validates rather than trusts.
func TestPassAllowanceRejectsHeadroomInflatingArguments(t *testing.T) {
	s, ctx := passAllowanceStore(t)

	sender := seedEditor(ctx, t, s, "editor")
	recipient := seedEditor(ctx, t, s, "editor")

	cases := []struct {
		name    string
		baseCap float64
		held    float64
	}{
		{"negative_held_would_add_headroom", 10, -100},
		{"negative_base_cap", -1, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := callPass(ctx, s, sender, recipient, 1, c.baseCap, c.held, nil); err == nil {
				t.Fatal("accepted a headroom-inflating argument")
			}
		})
	}

	t.Run("nan_amount", func(t *testing.T) {
		// NaN sorts ABOVE every numeric in Postgres, so `amount <= 0` is false
		// for it and a bare positivity check would let it through.
		var expiresAt time.Time
		err := s.pool.QueryRow(ctx, `
select pass_allowance($1::uuid, $2::uuid, 'NaN'::numeric, 10::numeric, 0::numeric, null)`,
			sender, recipient).Scan(&expiresAt)
		if err == nil {
			t.Fatal("accepted a NaN amount")
		}
	})

	if got := grantsFor(ctx, t, s, sender, recipient); len(got) != 0 {
		t.Fatalf("refused calls still wrote %d grant rows", len(got))
	}
}

// TestPassAllowanceDerivesManilaWeeklyExpiry is the second finding. The expiry
// is no longer an argument at all — there is nothing to supply — and both rows
// carry the next Manila Monday, which is when the weekly allowance they came
// out of resets. A pass that outlived that boundary would be a standing cap
// change one editor made for another with nobody deciding it.
func TestPassAllowanceDerivesManilaWeeklyExpiry(t *testing.T) {
	s, ctx := passAllowanceStore(t)

	sender := seedEditor(ctx, t, s, "editor")
	recipient := seedEditor(ctx, t, s, "editor")

	want := manilaWeekEnd(ctx, t, s)
	returned, err := callPass(ctx, s, sender, recipient, 3, 10, 0, nil)
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if !returned.Equal(want) {
		t.Fatalf("returned expiry %s, want the Manila week end %s", returned, want)
	}

	for _, g := range grantsFor(ctx, t, s, sender, recipient) {
		if !g.expiresAt.Equal(want) {
			t.Errorf("grant for %s expires %s, want %s", g.userID, g.expiresAt, want)
		}
	}

	// Monday 00:00 Manila is 16:00 Sunday UTC. Pinning the wall-clock time as
	// well as the instant catches a boundary that drifted to a day-start in the
	// wrong zone, which comparing two timestamps alone would not.
	if h, m := want.UTC().Hour(), want.UTC().Minute(); h != 16 || m != 0 {
		t.Errorf("Manila week end is %02d:%02d UTC, want 16:00 (Monday 00:00 +08)", h, m)
	}
	if wd := want.In(time.FixedZone("PHT", 8*3600)).Weekday(); wd != time.Monday {
		t.Errorf("Manila week end falls on %s, want Monday", wd)
	}
}

// TestPassAllowanceWritesTwoEqualAndOppositeRows is the zero-sum property the
// whole feature rests on: a pass MOVES allowance and can never mint it. Two
// rows, equal and opposite, same expiry, each naming the other party.
func TestPassAllowanceWritesTwoEqualAndOppositeRows(t *testing.T) {
	s, ctx := passAllowanceStore(t)

	sender := seedEditor(ctx, t, s, "editor")
	recipient := seedEditor(ctx, t, s, "trusted_editor")
	note := "for the mug shoot"

	if _, err := callPass(ctx, s, sender, recipient, 4, 10, 0, &note); err != nil {
		t.Fatalf("pass: %v", err)
	}

	got := grantsFor(ctx, t, s, sender, recipient)
	if len(got) != 2 {
		t.Fatalf("a pass wrote %d rows, want exactly 2", len(got))
	}

	credit, debit := got[0], got[1] // ordered by amount desc
	if credit.userID != recipient || credit.amountUsd != 4 {
		t.Errorf("credit row = (%s, %v), want (%s, 4)", credit.userID, credit.amountUsd, recipient)
	}
	if debit.userID != sender || debit.amountUsd != -4 {
		t.Errorf("debit row = (%s, %v), want (%s, -4)", debit.userID, debit.amountUsd, sender)
	}
	if credit.amountUsd+debit.amountUsd != 0 {
		t.Errorf("the pair sums to %v, want 0 — a pass must not change the team's total",
			credit.amountUsd+debit.amountUsd)
	}
	if !credit.expiresAt.Equal(debit.expiresAt) {
		t.Errorf("halves expire apart: %s vs %s", credit.expiresAt, debit.expiresAt)
	}
	// The sender is the actor on both halves — nobody approved this.
	if credit.grantedBy != sender || debit.grantedBy != sender {
		t.Errorf("granted_by = (%s, %s), want both %s", credit.grantedBy, debit.grantedBy, sender)
	}
	// Each row names the OTHER party, which is what lets either side render
	// "passed to / received from" from its own half alone.
	if credit.peerID == nil || *credit.peerID != sender {
		t.Errorf("credit peer = %v, want %s", credit.peerID, sender)
	}
	if debit.peerID == nil || *debit.peerID != recipient {
		t.Errorf("debit peer = %v, want %s", debit.peerID, recipient)
	}
}

// TestPassAllowanceConcurrentTransfersCannotExceedHeadroom is why the function
// takes an advisory lock at all, and why making it service-role-only was not
// enough on its own.
//
// Server-only stops a browser LYING about the headroom. It does nothing about
// two honest calls reading the same true headroom at the same moment: both see
// $6 available, both write +$6, and between them the recipients hold $12 the
// sender never had. That is not an overshoot of a ceiling — it is a pass
// MINTING allowance, which is the one failure the zero-sum design cannot
// survive.
//
// Both callers pass the sender's entire headroom simultaneously. Exactly one
// must win, and the loser must be refused for the amount, not deadlocked.
func TestPassAllowanceConcurrentTransfersCannotExceedHeadroom(t *testing.T) {
	s, ctx := passAllowanceStore(t)

	sender := seedEditor(ctx, t, s, "editor")
	first := seedEditor(ctx, t, s, "editor")
	second := seedEditor(ctx, t, s, "editor")

	const cap = 6.0

	var wg sync.WaitGroup
	errs := make([]error, 2)
	targets := []string{first, second}
	start := make(chan struct{})

	for i := range targets {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start // release both at once, so they actually contend
			_, errs[i] = callPass(ctx, s, sender, targets[i], cap, cap, 0, nil)
		}(i)
	}
	close(start)
	wg.Wait()

	won := 0
	for i, err := range errs {
		if err == nil {
			won++
			continue
		}
		if !strings.Contains(err.Error(), "remaining allowance") {
			t.Fatalf("caller %d failed for the wrong reason: %v", i, err)
		}
	}
	if won != 1 {
		t.Fatalf("%d of 2 concurrent full-headroom passes succeeded, want exactly 1", won)
	}

	// The ledger has to agree: one +6 to one recipient and one -6 to the
	// sender, and the sender's active grants must not have gone below -6.
	var net float64
	if err := s.pool.QueryRow(ctx, `
select coalesce(sum(amount_usd), 0) from allowance_grants
where user_id = any($1)`, []string{sender, first, second}).Scan(&net); err != nil {
		t.Fatalf("sum grants: %v", err)
	}
	if net != 0 {
		t.Fatalf("the three accounts net %v after a contended pass, want 0", net)
	}

	var senderTotal float64
	if err := s.pool.QueryRow(ctx,
		`select user_active_grants_usd($1, now())`, sender).Scan(&senderTotal); err != nil {
		t.Fatalf("read sender grants: %v", err)
	}
	if senderTotal != -cap {
		t.Fatalf("sender's active grants = %v, want %v — a second pass got through",
			senderTotal, -cap)
	}
}

// TestPassAllowancePreservesEligibilityRules covers what the security fix had
// to leave untouched: an admin is out of scope at BOTH ends, a suspended
// account cannot send or receive, and nobody passes to themselves. These moved
// from auth.uid() to a named-account column read when the function went
// service-role, so each one is re-proved rather than assumed to have survived.
// The status half matters most: it used to be is_active(), which reads
// auth.uid() and would be NULL under the service role — a check that silently
// stopped checking.
func TestPassAllowancePreservesEligibilityRules(t *testing.T) {
	s, ctx := passAllowanceStore(t)

	editor := seedEditor(ctx, t, s, "editor")
	other := seedEditor(ctx, t, s, "editor")
	admin := seedEditor(ctx, t, s, "admin")
	// 'pending', not 'suspended' — profiles_status_check allows only
	// pending/active/rejected (0052_account_approval.sql). Pending is the state
	// every account starts in, which makes it the one that matters here: a
	// brand-new signup must not be able to move allowance before an admin has
	// approved them.
	unapproved := seedEditor(ctx, t, s, "editor")
	setProfileStatus(ctx, t, s, unapproved, "pending")

	cases := []struct {
		name     string
		from, to string
		want     string
	}{
		{"admin_may_not_send", admin, other, "not an editor"},
		{"admin_may_not_receive", editor, admin, "not an editor"},
		{"unapproved_may_not_send", unapproved, other, "not an active account"},
		{"unapproved_may_not_receive", editor, unapproved, "not an active account"},
		{"nobody_passes_to_themselves", editor, editor, "themselves"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := callPass(ctx, s, c.from, c.to, 1, 100, 0, nil)
			if err == nil {
				t.Fatal("accepted an ineligible pass")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want a refusal mentioning %q, got: %v", c.want, err)
			}
		})
	}

	if got := grantsFor(ctx, t, s, editor, other, admin, unapproved); len(got) != 0 {
		t.Fatalf("ineligible passes wrote %d grant rows", len(got))
	}
}
