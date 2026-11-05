package http

import (
	"encoding/json"
	"testing"
)

// THE GAP THAT LET THIS SHIP, and the reason a green suite meant nothing.
//
// Every existing webhook test builds kieWebhookPayload as a Go struct
// literal, so the JSON decoding — the only part that was actually wrong —
// was never exercised. The struct read taskId, state and failMsg from the
// TOP level; kie sends all three inside `data`. Result: an empty TaskID on
// every real delivery, verification refused before anything else was
// looked at, and every render in production picked up 45 seconds late by
// the reconcile poll instead.
//
//	kie webhook: rejected unverified request  reason="no taskId in the payload to sign"
//
// A test that constructs the struct can never catch that. This one starts
// from bytes.

// The exact envelope kie documents for docs.kie.ai/market/bytedance/seedance-2-5,
// read from its OpenAPI spec on 2026-09-04.
const kieCallbackBody = `{
  "code": 200,
  "msg": "Playground task completed successfully.",
  "data": {
    "taskId": "f540cd4209751ab50b15b3d1f534a8d2",
    "model": "bytedance/seedance-2-5",
    "state": "success",
    "resultJson": "{}",
    "failCode": null,
    "failMsg": null,
    "costTime": 12,
    "creditsConsumed": 112
  }
}`

func TestWebhookPayloadDecodesKiesActualBody(t *testing.T) {
	var payload kieWebhookPayload
	if err := json.Unmarshal([]byte(kieCallbackBody), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if payload.Data.TaskID != "f540cd4209751ab50b15b3d1f534a8d2" {
		t.Errorf(
			"TaskID = %q, want the id from data.taskId — an empty one is refused at the signature "+
				"with 'no taskId in the payload to sign', which is what production did for a month",
			payload.Data.TaskID,
		)
	}
	if payload.Data.State != "success" {
		t.Errorf("State = %q, want %q — the verdict is read from data.state", payload.Data.State, "success")
	}
	if payload.Code != 200 {
		t.Errorf("Code = %d, want 200 from the envelope", payload.Code)
	}
}

// A failure carries its reason in the same place. Reading failMsg from the
// top level would report every kie failure as a bare "kie reported state
// fail" with the vendor's actual explanation discarded.
func TestWebhookPayloadCarriesTheFailureReason(t *testing.T) {
	const body = `{
	  "code": 501,
	  "msg": "task failed",
	  "data": {"taskId": "abc", "state": "fail", "failCode": 500, "failMsg": "File type not supported"}
	}`

	var payload kieWebhookPayload
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Data.State != "fail" {
		t.Errorf("State = %q, want \"fail\"", payload.Data.State)
	}
	if payload.Data.FailMsg != "File type not supported" {
		t.Errorf(
			"FailMsg = %q, want the vendor's own words — without them a failed scene records only "+
				"that it failed",
			payload.Data.FailMsg,
		)
	}
}

// The shape this handler used to expect. Kept as an explicit negative so the
// old reading cannot quietly return: a flat body must NOT satisfy it, or the
// struct has grown a fallback and the next shape change goes silent again.
func TestAFlatBodyIsNotAccepted(t *testing.T) {
	const flat = `{"taskId": "abc", "state": "success", "failMsg": null}`

	var payload kieWebhookPayload
	if err := json.Unmarshal([]byte(flat), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Data.TaskID != "" {
		t.Errorf(
			"a flat body produced TaskID %q — someone added a top-level fallback, which is how a "+
				"vendor moving this field again would go unnoticed for another month",
			payload.Data.TaskID,
		)
	}
}
