package store

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// These tests exercise the database-owned notification boundary. A scene is
// completed by the worker, while credit events are committed by SQL allowance
// workflows; trigger emission keeps both paths atomic and avoids an HTTP call
// between the two services.
func TestNotificationTriggersEmitOnceForEachWorkflowEvent(t *testing.T) {
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

	requester := seedUser(ctx, t, s)
	admin := seedUser(ctx, t, s)
	trusted := seedUser(ctx, t, s)
	makeAdmin(ctx, t, s, admin)
	if _, err := s.pool.Exec(ctx, `UPDATE profiles SET role = 'trusted_editor' WHERE id = $1`, trusted); err != nil {
		t.Fatalf("make trusted approver: %v", err)
	}

	var requestID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO allowance_requests (user_id, requested_usd)
VALUES ($1, 5)
RETURNING id`, requester).Scan(&requestID); err != nil {
		t.Fatalf("create allowance request: %v", err)
	}

	var requestedCount int
	if err := s.pool.QueryRow(ctx, `
SELECT count(*) FROM notifications
WHERE kind = 'credit_requested' AND allowance_request_id = $1 AND user_id = any($2::uuid[])`, requestID, []string{admin, trusted}).Scan(&requestedCount); err != nil {
		t.Fatalf("count credit-requested notifications: %v", err)
	}
	if requestedCount != 2 {
		t.Errorf("credit-requested notifications = %d, want 2 eligible approvers", requestedCount)
	}
	var requesterCount int
	if err := s.pool.QueryRow(ctx, `
SELECT count(*) FROM notifications
WHERE kind = 'credit_requested' AND allowance_request_id = $1 AND user_id = $2`, requestID, requester).Scan(&requesterCount); err != nil {
		t.Fatalf("count requester credit-requested notifications: %v", err)
	}
	if requesterCount != 0 {
		t.Errorf("requester's credit-requested notifications = %d, want 0", requesterCount)
	}

	if _, err := s.pool.Exec(ctx, `
UPDATE allowance_requests
SET status = 'approved', decided_by = $2, decided_at = now()
WHERE id = $1`, requestID, admin); err != nil {
		t.Fatalf("approve allowance request: %v", err)
	}

	var resolvedCount int
	if err := s.pool.QueryRow(ctx, `
SELECT count(*) FROM notifications
WHERE kind = 'credit_requested'
  AND allowance_request_id = $1
  AND user_id = any($2::uuid[])
  AND read_at IS NOT NULL
  AND title = 'Credit request approved'`, requestID, []string{admin, trusted}).Scan(&resolvedCount); err != nil {
		t.Fatalf("count resolved credit-requested notifications: %v", err)
	}
	if resolvedCount != 2 {
		t.Errorf("resolved credit-requested notifications = %d, want 2", resolvedCount)
	}

	var grantID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO allowance_grants (user_id, amount_usd, expires_at, granted_by, request_id)
VALUES ($1, 4, now() + interval '1 day', $2, $3)
RETURNING id`, requester, admin, requestID).Scan(&grantID); err != nil {
		t.Fatalf("create approved allowance grant: %v", err)
	}

	var approvedCount int
	if err := s.pool.QueryRow(ctx, `
SELECT count(*) FROM notifications
WHERE user_id = $1 AND kind = 'credit_approved' AND allowance_grant_id = $2`, requester, grantID).Scan(&approvedCount); err != nil {
		t.Fatalf("count credit-approved notifications: %v", err)
	}
	if approvedCount != 1 {
		t.Errorf("credit-approved notifications = %d, want 1", approvedCount)
	}

	recipient := seedUser(ctx, t, s)
	var receivedGrantID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO allowance_grants (user_id, amount_usd, expires_at, granted_by, transfer_peer_id)
VALUES ($1, 3, now() + interval '1 day', $2, $3)
RETURNING id`, recipient, admin, requester).Scan(&receivedGrantID); err != nil {
		t.Fatalf("create received-credit grant: %v", err)
	}

	var receivedCount int
	if err := s.pool.QueryRow(ctx, `
SELECT count(*) FROM notifications
WHERE user_id = $1 AND kind = 'credit_received' AND allowance_grant_id = $2`, recipient, receivedGrantID).Scan(&receivedCount); err != nil {
		t.Fatalf("count credit-received notifications: %v", err)
	}
	if receivedCount != 1 {
		t.Errorf("credit-received notifications = %d, want 1", receivedCount)
	}

	var sentGrantID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO allowance_grants (user_id, amount_usd, expires_at, granted_by, transfer_peer_id)
VALUES ($1, -3, now() + interval '1 day', $2, $3)
RETURNING id`, requester, admin, recipient).Scan(&sentGrantID); err != nil {
		t.Fatalf("create sent-credit debit: %v", err)
	}
	var sentCount int
	if err := s.pool.QueryRow(ctx, `
SELECT count(*) FROM notifications
WHERE kind = 'credit_received' AND allowance_grant_id = $1`, sentGrantID).Scan(&sentCount); err != nil {
		t.Fatalf("count sender credit-received notifications: %v", err)
	}
	if sentCount != 0 {
		t.Errorf("sender credit-received notifications = %d, want 0", sentCount)
	}
	if err := s.pool.QueryRow(ctx, `
SELECT count(*) FROM notifications
WHERE kind = 'credit_sent' AND allowance_grant_id = $1 AND user_id = $2
  AND (metadata->>'amount_usd')::numeric = 3`, sentGrantID, requester).Scan(&sentCount); err != nil {
		t.Fatalf("count sender credit-sent notifications: %v", err)
	}
	if sentCount != 1 {
		t.Errorf("sender credit-sent notifications = %d, want 1", sentCount)
	}

	t.Cleanup(func() {
		if _, err := s.pool.Exec(context.Background(), `DELETE FROM allowance_grants WHERE id = any($1::uuid[])`, []string{grantID, receivedGrantID, sentGrantID}); err != nil {
			t.Errorf("cleanup notification test grants: %v", err)
		}
		if _, err := s.pool.Exec(context.Background(), `DELETE FROM allowance_requests WHERE id = $1`, requestID); err != nil {
			t.Errorf("cleanup notification test request: %v", err)
		}
	})
}

func TestWeeklyCreditRenewalNotificationIsIdempotent(t *testing.T) {
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

	userID := seedUser(ctx, t, s)
	if err := s.NotifyWeeklyCreditRenewal(ctx); err != nil {
		t.Fatalf("notify weekly credit renewal: %v", err)
	}
	if err := s.NotifyWeeklyCreditRenewal(ctx); err != nil {
		t.Fatalf("repeat weekly credit renewal: %v", err)
	}

	var count int
	if err := s.pool.QueryRow(ctx, `
SELECT count(*) FROM notifications
WHERE user_id = $1 AND kind = 'credit_renewed'`, userID).Scan(&count); err != nil {
		t.Fatalf("count credit-renewal notifications: %v", err)
	}
	if count != 1 {
		t.Errorf("credit-renewal notifications = %d, want 1", count)
	}
}

func TestRLSNotificationsArePrivateAndReadOnlyExceptForReadState(t *testing.T) {
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

	owner := seedUser(ctx, t, s)
	other := seedUser(ctx, t, s)
	requestID := seedAllowanceRequest(ctx, t, s, owner, "pending", nil)

	var notificationID string
	if err := s.pool.QueryRow(ctx, `
INSERT INTO notifications (user_id, kind, title, body, allowance_request_id)
VALUES ($1, 'credit_requested', 'Credit request pending', 'test', $2)
RETURNING id`, owner, requestID).Scan(&notificationID); err != nil {
		t.Fatalf("seed notification: %v", err)
	}

	runAsUser(ctx, t, s, other, func(tx pgx.Tx) {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE id = $1`, notificationID).Scan(&count); err != nil {
			t.Fatalf("select another user's notification: %v", err)
		}
		if count != 0 {
			t.Errorf("other user's visible notifications = %d, want 0", count)
		}

		var marked int
		if err := tx.QueryRow(ctx, `SELECT mark_notifications_read(array[$1]::uuid[])`, notificationID).Scan(&marked); err != nil {
			t.Fatalf("mark another user's notification read: %v", err)
		}
		if marked != 0 {
			t.Errorf("other user's marked notifications = %d, want 0", marked)
		}
	})

	runAsUser(ctx, t, s, owner, func(tx pgx.Tx) {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE id = $1`, notificationID).Scan(&count); err != nil {
			t.Fatalf("select own notification: %v", err)
		}
		if count != 1 {
			t.Errorf("own visible notifications = %d, want 1", count)
		}

		var marked int
		if err := tx.QueryRow(ctx, `SELECT mark_notifications_read(array[$1]::uuid[])`, notificationID).Scan(&marked); err != nil {
			t.Fatalf("mark own notification read: %v", err)
		}
		if marked != 1 {
			t.Errorf("own marked notifications = %d, want 1", marked)
		}

		tag, err := tx.Exec(ctx, `UPDATE notifications SET title = 'forged' WHERE id = $1`, notificationID)
		if err == nil && tag.RowsAffected() != 0 {
			t.Errorf("direct notification update affected %d rows, want 0", tag.RowsAffected())
		}

		if _, err := tx.Exec(ctx, `
INSERT INTO notifications (user_id, kind, title, body, allowance_request_id)
VALUES ($1, 'credit_requested', 'forged', 'forged', $2)`, owner, requestID); err == nil {
			t.Error("direct notification insert succeeded, want RLS denial")
		}
	})
}
