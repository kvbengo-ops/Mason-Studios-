package http

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"ugc-pipeline/worker/internal/config"
)

// WHY THIS EXISTS. Every kie webhook rejection in production logged the same
// three booleans, for a month, on every single callback:
//
//	secret_configured=true signature_header_present=true timestamp_header_present=true
//
// ...and refused anyway, while reconcile picked each render up 45 seconds
// late. THREE different faults produce that exact line — a wrong secret, a
// timestamp outside the window, a signed string kie builds differently — and
// the log could not tell them apart, so the only way to guess was to rotate
// the secret and wait for the next render to find out.
//
// Same shape as every other bug this project has lost a day to: a refusal
// that does not say why.

// The unit confusion this was written to catch, and the one candidate the old
// log could never have revealed. A millisecond timestamp is a perfectly valid
// integer, so it parses; time.Unix then reads it as SECONDS, lands ~50,000
// years in the future, and the window refuses it with nothing anywhere
// suggesting the unit was the problem.
func TestTimestampUnitGuessNamesMilliseconds(t *testing.T) {
	nowS := strconv.FormatInt(time.Now().Unix(), 10)
	nowMS := strconv.FormatInt(time.Now().UnixMilli(), 10)

	if got := timestampUnitGuess(nowS); !strings.Contains(got, "seconds, as expected") {
		t.Errorf("a %d-digit timestamp read as %q, want it called seconds", len(nowS), got)
	}
	if got := timestampUnitGuess(nowMS); !strings.Contains(got, "MILLISECONDS") {
		t.Errorf("a %d-digit timestamp read as %q, want milliseconds named", len(nowMS), got)
	}
	if got := timestampUnitGuess("123"); !strings.Contains(got, "too short") {
		t.Errorf("a 3-digit timestamp read as %q", got)
	}
}

func TestCheckKieSignatureNamesTheDoorThatWasLocked(t *testing.T) {
	const secret = "shh"
	const taskID = "abc"
	nowS := strconv.FormatInt(time.Now().Unix(), 10)
	nowMS := strconv.FormatInt(time.Now().UnixMilli(), 10)
	dayOld := strconv.FormatInt(time.Now().Add(-24*time.Hour).Unix(), 10)

	for _, tc := range []struct {
		name       string
		secret     string
		timestamp  string
		signature  string
		taskID     string
		wantOK     bool
		wantReason string
	}{
		{
			name:   "a correct callback verifies and carries no reason",
			secret: secret, timestamp: nowS, taskID: taskID,
			signature: kieSign(secret, taskID, nowS),
			wantOK:    true,
		},
		{
			// What production is left with once the other two are eliminated.
			name:   "a wrong secret is named as a signature mismatch",
			secret: secret, timestamp: nowS, taskID: taskID,
			signature:  kieSign("not-the-secret", taskID, nowS),
			wantReason: "signature mismatch",
		},
		{
			// THE HYPOTHESIS. Signed perfectly, in the wrong unit.
			name:   "a millisecond timestamp is called out by UNIT, not merely refused",
			secret: secret, timestamp: nowMS, taskID: taskID,
			signature:  kieSign(secret, taskID, nowMS),
			wantReason: "MILLISECONDS",
		},
		{
			name:   "a genuinely old timestamp blames the window, not the secret",
			secret: secret, timestamp: dayOld, taskID: taskID,
			signature:  kieSign(secret, taskID, dayOld),
			wantReason: "outside the",
		},
		{
			name:   "an unset secret is not reported as a signature problem",
			secret: "", timestamp: nowS, taskID: taskID, signature: "anything",
			wantReason: "no secret configured",
		},
		{
			name:   "a missing timestamp header is distinguished from a missing signature",
			secret: secret, timestamp: "", taskID: taskID, signature: "anything",
			wantReason: "no timestamp header",
		},
		{
			name:   "a missing signature header is its own reason",
			secret: secret, timestamp: nowS, taskID: taskID, signature: "",
			wantReason: "no signature header",
		},
		{
			name:   "a non-numeric timestamp is not blamed on the window",
			secret: secret, timestamp: "not-a-number", taskID: taskID, signature: "anything",
			wantReason: "not an integer",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{
				config: &config.Config{KieWebhookSecret: tc.secret},
				logger: testLogger(),
			}

			ok, reason := s.checkKieSignature(kieReq(tc.taskID, tc.timestamp, tc.signature), tc.taskID)
			if ok != tc.wantOK {
				t.Fatalf("verified = %v (reason %q), want %v", ok, reason, tc.wantOK)
			}
			if tc.wantReason != "" && !strings.Contains(reason, tc.wantReason) {
				t.Errorf("reason = %q, want it to contain %q", reason, tc.wantReason)
			}
			if tc.wantOK && reason != "" {
				t.Errorf("a verified request carried a reason: %q", reason)
			}
		})
	}
}

// The reason must never quote the request. A rejected payload is
// attacker-controlled, and this line exists to say which door was locked, not
// to repeat whatever was pushed through it.
func TestTheReasonNeverEchoesTheRequest(t *testing.T) {
	const secret = "shh"
	nowS := strconv.FormatInt(time.Now().Unix(), 10)
	s := &Server{config: &config.Config{KieWebhookSecret: secret}, logger: testLogger()}

	forged := "FORGED-SIGNATURE-VALUE"
	_, reason := s.checkKieSignature(kieReq("abc", nowS, forged), "abc")

	if strings.Contains(reason, forged) {
		t.Errorf("the reason quoted the attacker's signature: %q", reason)
	}
	if strings.Contains(reason, secret) {
		t.Errorf("the reason leaked the secret: %q", reason)
	}
}
