package loop

import (
	"context"
	"testing"

	"ugc-pipeline/worker/internal/kie"
)

// This file used to hold ~520 lines pinning the fal-era dual-vendor routing
// seam: TestVideoVendorClient_* (fal.VendorFal/fal.VendorKie resolving to
// Deps.Fal/Deps.Kie), TestEffectiveVendor_*/TestDescriptors_* (the runtime
// Seedance-to-kie cutover table, KIE_MODELS/KieEnabled), and
// TestDispatchAndReconcile_AgreeOnKieRouting/
// TestDispatchScene_NonSeedanceModel_NeverRoutesToKie (proving dispatch and
// reconcile could never disagree about which vendor a scene actually went
// to), and TestWebhookURLFor. Every one of those tested a routing DECISION
// between two vendors that no longer exists: vendor_routing.go
// (effectiveVendor, kieConfigured, webhookURLFor) is deleted, and
// videoVendorClient's switch collapsed to "return deps.Kie" once kie became
// the only vendor — see deps.go and dispatch.go/reconcile.go's own doc
// comments. There is nothing left to route AWAY from, so there is nothing
// left for those tests to distinguish.
//
// fakeVideoVendor (the double those tests built Deps.Kie/Deps.Fal from) is
// kept below, retyped to this package's own VideoVendor interface — it is
// still useful wherever a test wants to observe what dispatch/reconcile
// actually called Deps.Kie with, without a real HTTP round trip.
//
// What replaces the deleted tests: dispatch_test.go and reconcile_test.go
// exercise dispatchScene/reconcileScene directly against deps.Kie (real,
// unconditional now — see Deps.Kie's own doc comment), so "does dispatch
// reach the vendor client, with the right arguments" is covered there
// rather than through a routing seam this file no longer has anything to
// route.

// fakeVideoVendor is a minimal VideoVendor double.
type fakeVideoVendor struct {
	name string

	// status overrides what Status() reports; the zero value "" reads as
	// kie.StatusCompleted.
	status kie.Status

	submitCalls int
	statusCalls int
	resultCalls int
	// lastRequestID records Status's most recent argument, so a test can
	// confirm reconcile polled with the exact request id dispatch
	// submitted.
	lastRequestID string
	// lastWebhookURL records Submit's most recent WebhookURL.
	lastWebhookURL string
	// submitErr, when set, is what Submit returns instead of an id.
	submitErr error
}

func (f *fakeVideoVendor) Submit(ctx context.Context, req kie.SubmitRequest) (string, error) {
	f.submitCalls++
	f.lastWebhookURL = req.WebhookURL
	if f.submitErr != nil {
		return "", f.submitErr
	}
	return f.name, nil
}
func (f *fakeVideoVendor) Status(ctx context.Context, requestID string) (kie.Status, error) {
	f.statusCalls++
	f.lastRequestID = requestID
	if f.status != "" {
		return f.status, nil
	}
	return kie.StatusCompleted, nil
}
func (f *fakeVideoVendor) Result(ctx context.Context, requestID string) (kie.Result, error) {
	f.resultCalls++
	return kie.Result{VideoURL: f.name}, nil
}

func (f *fakeVideoVendor) BilledUSD(ctx context.Context, requestID string) (*float64, error) {
	return nil, nil
}

var _ VideoVendor = (*fakeVideoVendor)(nil)

// TestFakeVideoVendorSatisfiesInterface is a trivial smoke test: the real
// coverage of dispatch/reconcile calling into a VideoVendor lives in
// dispatch_test.go and reconcile_test.go now.
func TestFakeVideoVendorSatisfiesInterface(t *testing.T) {
	var v VideoVendor = &fakeVideoVendor{name: "x"}
	if _, err := v.Submit(context.Background(), kie.SubmitRequest{}); err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
}
