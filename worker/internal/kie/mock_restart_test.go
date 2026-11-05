package kie

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

// The bug: the mock kept its submissions in a map on the Client, so a worker
// restart orphaned every in-flight mock render. Status answered "unknown task
// id" — an error, not a verdict — so reconcile could neither finish the scene
// nor fail it. It stayed 'rendering' forever, and the trigger was restarting
// the worker, which is the most common thing a developer does all day.
//
// Every existing mock test passed throughout, because they all submit and
// then query through the SAME Client. The restart is the whole bug and no
// test crossed it.

// The regression test proper: two Clients, as a restart produces. The second
// has never seen the id.
func TestMockStatus_SurvivesAWorkerRestart(t *testing.T) {
	ctx := context.Background()

	before := NewClient("", true, nil, "http://127.0.0.1:8080/mock/clip.mp4")
	taskID, err := before.Submit(ctx, SubmitRequest{KieModelID: "bytedance/seedance-2-5", ImageURL: "http://example.test/f.png"})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	// The restart. Nothing carries over but the id, which is all that
	// survives in the database too.
	after := NewClient("", true, nil, "http://127.0.0.1:8080/mock/clip.mp4")

	if _, err := after.Status(ctx, taskID); err != nil {
		t.Fatalf("Status on a fresh client: %v — a restarted worker must still be able to resolve a task id it never issued, or the scene wedges in 'rendering'", err)
	}
}

// Status has to reach a terminal verdict, not merely avoid erroring: an
// in-progress answer forever is the same wedged scene by another route.
func TestMockStatus_ReachesATerminalVerdictAfterTheDelay(t *testing.T) {
	ctx := context.Background()
	c := NewClient("", true, nil, "http://127.0.0.1:8080/mock/clip.mp4")

	taskID, err := c.Submit(ctx, SubmitRequest{KieModelID: "bytedance/seedance-2-5", ImageURL: "http://example.test/f.png"})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	if got, err := c.Status(ctx, taskID); err != nil || got != StatusInProgress {
		t.Fatalf("Status immediately after submit = (%q, %v), want in-progress", got, err)
	}

	time.Sleep(mockRenderDelay + 250*time.Millisecond)

	got, err := c.Status(ctx, taskID)
	if err != nil {
		t.Fatalf("Status after the render delay: %v", err)
	}
	if got != StatusCompleted && got != StatusFailed {
		t.Errorf("Status after the render delay = %q, want completed or failed — anything else leaves the scene rendering forever", got)
	}
}

// The verdict must be a property of the id, not of a coin flip at submit
// time: that is what makes it survive the restart above, and it also makes a
// simulated failure replayable instead of a thing you chase.
func TestMockParse_VerdictIsDeterministicForAnID(t *testing.T) {
	id := fmt.Sprintf("%s%d-%d", mockTaskPrefix, time.Now().UnixNano(), 7)

	_, first, err := mockParse(id)
	if err != nil {
		t.Fatalf("mockParse: %v", err)
	}
	for i := 0; i < 20; i++ {
		_, again, err := mockParse(id)
		if err != nil {
			t.Fatalf("mockParse (repeat %d): %v", i, err)
		}
		if again != first {
			t.Fatalf("mockParse gave a different verdict on repeat %d — the same id must always resolve the same way", i)
		}
	}
}

// A random suffix divisible by mockFailureRate is the failure case; the point
// here is that BOTH verdicts are reachable, so a mock run exercises the
// failure path some of the time rather than never or always.
func TestMockParse_BothVerdictsAreReachable(t *testing.T) {
	nanos := time.Now().UnixNano()

	_, shouldFail, err := mockParse(fmt.Sprintf("%s%d-%d", mockTaskPrefix, nanos, mockFailureRate*3))
	if err != nil {
		t.Fatalf("mockParse: %v", err)
	}
	if !shouldFail {
		t.Errorf("a suffix divisible by mockFailureRate (%d) should be the simulated failure", mockFailureRate)
	}

	_, shouldPass, err := mockParse(fmt.Sprintf("%s%d-%d", mockTaskPrefix, nanos, mockFailureRate*3+1))
	if err != nil {
		t.Fatalf("mockParse: %v", err)
	}
	if shouldPass {
		t.Error("a suffix not divisible by mockFailureRate should succeed")
	}
}

// A real kie task id reaching the mock parser is a genuine bug — a production
// id being resolved by a development worker — so it must stay an error rather
// than being silently treated as a finished render.
func TestMockParse_RejectsANonMockID(t *testing.T) {
	for _, id := range []string{"", "abc123", "mock-kie-", "mock-kie-notanumber-1", "mock-kie-123"} {
		if _, _, err := mockParse(id); err == nil {
			t.Errorf("mockParse(%q) = nil error, want an error — a non-mock id must never resolve to a verdict", id)
		}
	}
}

// Result must agree with Status across the restart too: reconcile calls
// Status first and Result second, and a Result that errored where Status said
// completed would fail the scene after telling the loop it had succeeded.
func TestMockResult_SurvivesAWorkerRestart(t *testing.T) {
	ctx := context.Background()
	const mockURL = "http://127.0.0.1:8080/mock/clip.mp4"

	before := NewClient("", true, nil, mockURL)

	// Mint an id that is already past the render delay and is on the success
	// side of the verdict, so this asserts the ingest-ready path specifically.
	taskID := fmt.Sprintf("%s%d-%d", mockTaskPrefix, time.Now().Add(-time.Hour).UnixNano(), 1)
	if _, _, err := mockParse(taskID); err != nil {
		t.Fatalf("constructed id does not parse: %v", err)
	}
	_ = before

	after := NewClient("", true, nil, mockURL)

	status, err := after.Status(ctx, taskID)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status != StatusCompleted {
		t.Fatalf("Status = %q, want completed for a suffix off the failure multiple", status)
	}

	res, err := after.Result(ctx, taskID)
	if err != nil {
		t.Fatalf("Result on a fresh client: %v", err)
	}
	if !strings.HasSuffix(res.VideoURL, "/mock/clip.mp4") {
		t.Errorf("VideoURL = %q, want the mock clip route", res.VideoURL)
	}
	if res.ActualCostUSD != nil {
		t.Errorf("ActualCostUSD = %v, want nil — no real render happened for it to describe", *res.ActualCostUSD)
	}
}
