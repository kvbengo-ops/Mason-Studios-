// Package kie is the worker's only video-generation vendor client — for
// kie.ai's job API. fal.ai is decommissioned; this package (client.go for
// the HTTP client, models.go for the model/rate tables and per-model
// request shapes, types.go for the vendor vocabulary the rest of the
// worker imports) is the whole of "talk to a video vendor" now. A key
// exists and several probes have run against it (see models.go's
// Descriptors history, this file's recordInfoResponse.CreditsConsumed
// comment, and ErrInsufficientBalance's own doc comment below) —
// createTask, recordInfo, the KLING input shape and the
// insufficient-balance envelope are each MEASURED, not guessed.
//
// SEEDANCE'S IS NOT, and this sentence used to say it was. seedanceInput's
// own doc comment has said "unverified" the whole time, and kie's published
// schema for bytedance/seedance-2-5 does not carry the key that shape was
// built around — see that function for what changed and what is still open.
// A probe having run against this API is not the same fact as a probe having
// confirmed a particular model's field names, and this comment collapsed the
// two.
//
// What
// remains a best-effort reconstruction from kie.ai's publicly documented
// job-submission shape rather than a confirmed response is marked
// UNVERIFIED at the specific field or path it applies to — see each such
// comment below for exactly what a future probe still needs to check.
//
// Job API shape (UNVERIFIED AGAINST THE LIVE API — reconstructed from
// kie.ai's publicly described job-submission pattern, not from a response
// this client has ever received):
//
//	POST   https://api.kie.ai/api/v1/jobs/createTask
//	       Header: Authorization: Bearer {apiKey}
//	       Body:   {"model": "...", "input": {...}, "callBackUrl": "..."}
//	       Resp:   {"code":200,"msg":"success","data":{"taskId":"..."}}
//
//	GET    https://api.kie.ai/api/v1/jobs/recordInfo?taskId={taskId}
//	       Resp:   {"code":200,"data":{"taskId":"...","state":"waiting"|
//	               "queuing"|"generating"|"success"|"fail",
//	               "resultJson":"{\"resultUrls\":[\"...\"]}",
//	               "failMsg":"...","creditsConsumed":123}}
//
// Unlike fal, there is no separate status vs. result endpoint — recordInfo
// is UNVERIFIED to carry both a state and (once terminal) the output in one
// response, which is why Status and Result below hit the same URL. If the
// real API splits these the way fal does, that split is one function each
// away from here, not a redesign.
//
// callBackUrl (createTask's webhook field) is also UNVERIFIED to carry no
// signature — see internal/http/webhook_kie.go's own comment for why the
// webhook handler built against that assumption re-fetches from recordInfo
// rather than ever trusting the callback body's contents.
package kie

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	baseURL           = "https://api.kie.ai" // UNVERIFIED — kie.ai's documented API host, never called from this codebase.
	fileUploadBaseURL = "https://kieai.redpandaai.co"

	// requestTimeout/maxAttempts/retryAfterCap mirror fal/client.go's own
	// constants of the same name and the same reasoning: bound every attempt
	// independently of ctx, retry a handful of times, and never honour a
	// vendor's Retry-After longer than one attempt's own timeout.
	requestTimeout = 30 * time.Second
	maxAttempts    = 4
	retryAfterCap  = requestTimeout

	// mockRenderDelay/mockFailureRate mirror fal/client.go's mock behavior
	// exactly, for the same reason: MOCK_FAL_VIDEO-style local dev must
	// exercise the dispatch -> poll -> reconcile path realistically, and
	// occasionally simulate failure, without a real kie.ai account. There is
	// no MOCK_KIE env var wired up yet (see cmd/worker/main.go) because no
	// kie descriptor is Enabled, so mock mode here is only ever reached
	// directly by this package's own tests today.
	mockRenderDelay = 2 * time.Second
	mockFailureRate = 10 // 1 in 10

	// creditUSD is kie.ai's published rate: 1 credit = $0.005. Applied to
	// recordInfo's creditsConsumed to populate Result.ActualCostUSD — see
	// that field's doc comment (types.go) for why a vendor-reported charge
	// is preferred over EstimateCost's estimate (models.go) whenever one
	// exists.
	creditUSD = 0.005
)

// kieStatus is kie.ai's own task-state vocabulary, UNVERIFIED — see this
// file's header comment. Kept unexported and distinct from this package's
// own Status type: the Status method is what translates one into the
// other, and keeping the raw vendor vocabulary as its own type makes that
// translation a single visible switch (statusFromState) instead of vendor
// strings leaking into Status's constants, which loop/reconcile.go already
// switches on.
type kieStatus string

const (
	kieStatusWaiting    kieStatus = "waiting"
	kieStatusQueuing    kieStatus = "queuing"
	kieStatusGenerating kieStatus = "generating"
	kieStatusSuccess    kieStatus = "success"
	kieStatusFail       kieStatus = "fail"
)

// statusFromState maps kie's (guessed) state vocabulary onto this package's
// own Status type. An unrecognized state (a real kie.ai account may use
// different words than the four guessed above) maps to StatusInProgress
// rather than erroring: loop/reconcile.go already treats an unrecognized
// Status as "still working, check again later" (see reconcileScene's
// default case), which is the only safe reading of a state this client
// doesn't understand — the alternative, erroring, would make the reconcile
// loop mark a possibly-still-rendering (and already billed) scene 'failed'
// outright.
func statusFromState(state string) Status {
	switch kieStatus(state) {
	case kieStatusSuccess:
		return StatusCompleted
	case kieStatusFail:
		return StatusFailed
	case kieStatusWaiting, kieStatusQueuing:
		return StatusInQueue
	case kieStatusGenerating:
		return StatusInProgress
	default:
		return StatusInProgress
	}
}

// Client talks to kie.ai's job API, or simulates it entirely in mock mode.
type Client struct {
	apiKey        string
	mock          bool
	httpClient    *http.Client
	baseURL       string // overridable in tests
	uploadBaseURL string // Kie File Upload API; overridable in tests
	mockVideoURL  string
	// Optional. nil falls back to slog.Default(), so no call site has to
	// thread a logger through just to get the wire record above.
	log *slog.Logger
}

// NewClient builds a Client. mockVideoURL is the URL Submit/Result hand
// back in mock mode — see cmd/worker/main.go, which points it at this
// worker's own /mock/clip.mp4 route so ingest.FromResult can download it
// back over HTTP like any other result.
func NewClient(apiKey string, mock bool, httpClient *http.Client, mockVideoURL string) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: requestTimeout}
	}
	return &Client{
		apiKey:        apiKey,
		mock:          mock,
		httpClient:    httpClient,
		baseURL:       baseURL,
		uploadBaseURL: fileUploadBaseURL,
		mockVideoURL:  mockVideoURL,
	}
}

// createTaskRequest is UNVERIFIED against the live API — see this file's
// header comment. `input` is built per model by Descriptor.BuildInput, so
// this struct carries no field names of its own; see seedanceInput and
// klingInput for the two shapes and what is established about each.
//
// THE FAILURE MODE IS SILENT, and this comment used to promise the opposite:
// "If kie's real schema uses different keys, createTask 4xxs and the failure
// is loud, not silent." It is not loud. kie accepts unknown and wrongly-typed
// fields, returns 200, and BILLS THE RENDER — which is why logSubmittedInput
// below exists at all, and why a wrong key name can sit in this package for
// months while every render appears to succeed. A reader who trusts that old
// sentence will skip the one check that would catch it.
type createTaskRequest struct {
	Model       string         `json:"model"`
	Input       map[string]any `json:"input"`
	CallBackURL string         `json:"callBackUrl,omitempty"`
}

type createTaskResponse struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data struct {
		TaskID string `json:"taskId"`
	} `json:"data"`
}

// Submit submits a render to kie.ai and returns kie's task id. That id is
// what dispatch.go persists into scenes.kie_task_id / runs.kie_task_id
// — see store.Scene.KieTaskID's doc comment for why that column, named
// before this worker spoke to more than one vendor, is kept rather than
// renamed now that only kie remains.
//
// In mock mode this returns a synthetic id immediately with no network
// call (including a simulated-failure rate) — see
// mockRenderDelay/mockFailureRate.
// redactURLs returns a copy of an input map with every URL's query string
// removed, so the body can be logged without leaking a signed URL's token.
//
// Recursive over slices because that is where the URLs actually live —
// image_urls is an array, and a redactor that only walked top-level strings
// would log exactly the field most worth redacting, in full.
func redactURLs(v any) any {
	switch t := v.(type) {
	case string:
		if strings.HasPrefix(t, "http") {
			if i := strings.Index(t, "?"); i >= 0 {
				return t[:i] + "?<redacted>"
			}
		}
		return t
	case []string:
		out := make([]any, 0, len(t))
		for _, s := range t {
			out = append(out, redactURLs(s))
		}
		return out
	case []any:
		out := make([]any, 0, len(t))
		for _, e := range t {
			out = append(out, redactURLs(e))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, e := range t {
			out[k] = redactURLs(e)
		}
		return out
	default:
		return v
	}
}

// logSubmittedInput records the EXACT input body posted to kie, once per
// submission.
//
// This existed nowhere, and its absence is why a wire-shape question could
// not be answered from our own records. kie accepts unknown fields, returns
// 200 and bills the render, so a wrong key name is invisible on the way out
// AND on the way back: the only place the truth was ever written down was a
// request nobody kept.
//
// Concretely open at the time of writing, all three on Seedance 2.5:
// kie's docs for `bytedance/seedance-2-5` list `first_frame_url` and
// `reference_image_urls` and no `image_urls` at all; they type `duration` as
// an integer where DurationSendAsString sends a string; and they spell the
// resolution enum lowercase where AllowedResolutions uses "720P". Two of
// those three contradict a previous claim of having checked the live API.
// One real render with this line in place settles all three, because what
// was sent is finally written down beside what came back.
func (c *Client) logSubmittedInput(modelID string, input map[string]any) {
	redacted, err := json.Marshal(redactURLs(input))
	if err != nil {
		// Never fail a submission over a diagnostic.
		c.logger().Warn("kie: submit: could not marshal input for logging", slog.String("model", modelID))
		return
	}
	c.logger().Info("kie: submit input",
		slog.String("model", modelID),
		slog.String("input", string(redacted)))
}

func (c *Client) logger() *slog.Logger {
	if c.log != nil {
		return c.log
	}
	return slog.Default()
}

func (c *Client) Submit(ctx context.Context, req SubmitRequest) (string, error) {
	if req.KieModelID == "" {
		return "", fmt.Errorf("kie: submit: kie model id is required")
	}
	// NO REFERENCE IS LEGAL NOW. This used to refuse an empty ImageURL
	// outright, on the assumption that every render conditions on a picture.
	// The /ugc route no longer sends one: its references are read by Claude
	// at Refine time and written into the prompt as prose, so what reaches
	// kie is text alone. The scripted pipeline still sends its frame, and
	// still fails loudly upstream when it has none — see dispatchScene.

	if c.mock {
		// The input is BUILT AND LOGGED even here, where nothing is sent.
		//
		// This is the only way to read the exact request body without paying
		// for a render, and the first version of this logging missed it: the
		// mock returned above the descriptor lookup, so a local run — the one
		// place an operator can experiment freely — produced no record at all,
		// while the only path that did produce one cost money. That is exactly
		// backwards for a diagnostic whose whole purpose is answering a
		// question kie bills us to ask.
		//
		// Best-effort by design. A diagnostic must never fail a submission, and
		// a mock caller may use a model id no descriptor knows, so an unknown
		// id logs nothing rather than erroring — unlike the real path below,
		// where the same lookup is a hard failure.
		if d, ok := DescriptorByKieModelID(req.KieModelID); ok {
			c.logSubmittedInput(req.KieModelID, d.BuildInput(req))
		}
		return c.mockSubmit(), nil
	}

	// d.BuildInput owns this model's ENTIRE input shape — see
	// Descriptor.BuildInput's doc comment in models.go for why that lives
	// there rather than as per-field `if`s here. Submit's only job below is
	// to look the descriptor up, call it, and post the result.
	d, ok := DescriptorByKieModelID(req.KieModelID)
	if !ok {
		return "", fmt.Errorf("kie: no descriptor for kie model id %q — kie carries Seedance 2.5, Kling 3.0 Pro and Hailuo 2.3 Pro only; see kie/models.go", req.KieModelID)
	}
	req, err := c.uploadLocalImageReferences(ctx, req)
	if err != nil {
		return "", fmt.Errorf("kie: prepare image references: %w", err)
	}
	input := d.BuildInput(req)
	c.logSubmittedInput(req.KieModelID, input)

	body := createTaskRequest{
		Model:       req.KieModelID,
		Input:       input,
		CallBackURL: req.WebhookURL,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("kie: submit %s: marshal request: %w", req.KieModelID, err)
	}

	u := c.baseURL + "/api/v1/jobs/createTask" // UNVERIFIED path — see header comment.
	var out createTaskResponse
	if err := c.doJSON(ctx, http.MethodPost, u, payload, &out); err != nil {
		return "", fmt.Errorf("kie: submit %s: %w", req.KieModelID, err)
	}
	if out.Code != 0 && out.Code != http.StatusOK {
		// See ErrInsufficientBalance's doc comment: kie's own out-of-credit
		// signal arrives in this envelope's `code`/`msg`, not necessarily as
		// an HTTP status — the same place TestClient_Submit_VendorReportedError
		// already established kie reports a rejected credential (HTTP 200,
		// body code=401). Checked here, not in doOnce's HTTP-status switch,
		// for exactly that reason.
		if looksLikeInsufficientBalance(out.Code, out.Msg) {
			return "", fmt.Errorf("%w: kie: submit %s: vendor reported code=%d msg=%q", ErrInsufficientBalance, req.KieModelID, out.Code, out.Msg)
		}
		return "", fmt.Errorf("kie: submit %s: vendor reported code=%d msg=%q", req.KieModelID, out.Code, out.Msg)
	}
	if out.Data.TaskID == "" {
		return "", fmt.Errorf("kie: submit %s: response had no taskId", req.KieModelID)
	}
	return out.Data.TaskID, nil
}

// recordInfoResponse is UNVERIFIED — see this file's header comment.
// CreditsConsumed is a pointer so "field absent" (not yet billed, or this
// client's guess at the field name is wrong) is distinguishable from
// "billed zero credits" — mirrors Result.ActualCostUSD's own
// nil-means-unknown contract (types.go).
type recordInfoResponse struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data struct {
		TaskID     string `json:"taskId"`
		State      string `json:"state"`
		ResultJSON string `json:"resultJson"`
		FailMsg    string `json:"failMsg"`
		// float64, NOT int: kie sends this as a JSON float — a real
		// recordInfo response carries `"creditsConsumed": 378.0`, and
		// encoding/json refuses to unmarshal `378.0` into an int at all.
		// It fails the WHOLE response, not just this field, so Status()
		// and Result() both returned "decode response" errors and every
		// kie render hung in `rendering` until reconcile's 20-minute
		// timeout — after kie had finished it and billed for it.
		//
		// Probing the API with a JSON tool that has one number type (curl
		// piped to Python, which is how this shape was confirmed) cannot
		// surface this: 378.0 and 378 read identically there. Verifying a
		// vendor's response shape is not the same as verifying it decodes
		// into the structs that will actually receive it.
		CreditsConsumed *float64 `json:"creditsConsumed"`
	} `json:"data"`
}

// recordInfo fetches taskID's current record from kie.ai. Both Status and
// Result hit this same endpoint (see this file's header comment on why kie
// is guessed to have no separate status/result split the way fal did).
// kie's recordInfo is taskId-scoped, not model-scoped, so neither method
// needs a model identifier at all — unlike the fal-era loop.VideoVendor
// signature this used to satisfy, which carried one for fal's own
// endpoint-scoped status check.
func (c *Client) recordInfo(ctx context.Context, taskID string) (recordInfoResponse, error) {
	u := c.baseURL + "/api/v1/jobs/recordInfo?taskId=" + taskID // UNVERIFIED path — see header comment.
	var out recordInfoResponse
	if err := c.doJSON(ctx, http.MethodGet, u, nil, &out); err != nil {
		return recordInfoResponse{}, err
	}
	if out.Code != 0 && out.Code != http.StatusOK {
		return recordInfoResponse{}, fmt.Errorf("vendor reported code=%d msg=%q", out.Code, out.Msg)
	}
	return out, nil
}

// Status reports taskID's current state, translated to this package's
// Status type via statusFromState.
func (c *Client) Status(ctx context.Context, taskID string) (Status, error) {
	if c.mock {
		return c.mockStatus(taskID)
	}
	out, err := c.recordInfo(ctx, taskID)
	if err != nil {
		return "", fmt.Errorf("kie: status %s: %w", taskID, err)
	}
	return statusFromState(out.Data.State), nil
}

// BilledUSD is what kie says it charged for taskID (recordInfo's
// creditsConsumed), or nil when kie does not say.
func (c *Client) BilledUSD(ctx context.Context, taskID string) (*float64, error) {
	if c.mock {
		return nil, nil
	}
	out, err := c.recordInfo(ctx, taskID)
	if err != nil {
		return nil, fmt.Errorf("kie: billed %s: %w", taskID, err)
	}
	if out.Data.CreditsConsumed == nil {
		return nil, nil
	}
	usd := *out.Data.CreditsConsumed * creditUSD
	return &usd, nil
}

// FailedRunCost is the cost a run records for a render kie reported FAILED:
// kie's own charge when it states one, nil when that charge is zero (the
// runs convention for "not billed", so the attempt stops counting against
// the caps), and the held estimate when kie says nothing or cannot be read.
//
// Zero is observed, not assumed: task 736d288aa09ee5ee52f3b0bfd6ac3bef
// (seedance-2-5, failCode 400, 2026-10-30) reported creditsConsumed 0 and
// the balance did not move. Only for kie's own "fail" -- a timed-out task
// may still be rendering and bill later, so those keep holding.
func FailedRunCost(ctx context.Context, b interface {
	BilledUSD(ctx context.Context, taskID string) (*float64, error)
}, taskID string, estimate *float64) *float64 {
	billed, err := b.BilledUSD(ctx, taskID)
	if err != nil || billed == nil {
		return estimate
	}
	if *billed == 0 {
		return nil
	}
	return billed
}

// resultJSON is UNVERIFIED — see this file's header comment. Modelled as a
// JSON-encoded string field on recordInfo's response (rather than a nested
// object) because that is the shape kie.ai's job-family APIs are commonly
// described to use; ResultURLs is guessed to be a list on the theory that
// some kie-fronted models return multiple outputs, even though this client
// only ever reads the first one.
type resultJSON struct {
	ResultURLs []string `json:"resultUrls"`
}

// Result fetches taskID's completed output. Callers should only call this
// once Status reports StatusCompleted.
func (c *Client) Result(ctx context.Context, taskID string) (Result, error) {
	if c.mock {
		return c.mockResult(taskID)
	}

	out, err := c.recordInfo(ctx, taskID)
	if err != nil {
		return Result{}, fmt.Errorf("kie: result %s: %w", taskID, err)
	}
	if statusFromState(out.Data.State) != StatusCompleted {
		return Result{}, fmt.Errorf("kie: result %s: task is not complete (state=%q)", taskID, out.Data.State)
	}

	var parsed resultJSON
	if out.Data.ResultJSON == "" || json.Unmarshal([]byte(out.Data.ResultJSON), &parsed) != nil || len(parsed.ResultURLs) == 0 {
		return Result{}, fmt.Errorf("kie: result %s: response had no usable resultJson.resultUrls", taskID)
	}

	// The reply half of the same record. resultJson is where kie describes
	// what it actually produced, and creditsConsumed is what it actually
	// charged — the two facts that say whether the input above was
	// understood or quietly ignored.
	//
	// Redacted through the SAME function the submit half uses. The first
	// version of this line logged out.Data.ResultJSON verbatim, which is
	// where kie's own download URLs live — writing the credential half of a
	// signed URL into the log while the sibling call three functions up went
	// to the trouble of stripping exactly that. Re-marshalled from the raw
	// string rather than from `parsed`, because the point of this record is
	// to show which fields kie ACTUALLY returned, and `parsed` only carries
	// the one field we already knew to ask for.
	var whole any
	if err := json.Unmarshal([]byte(out.Data.ResultJSON), &whole); err != nil {
		c.logger().Info("kie: result",
			slog.String("taskId", taskID),
			slog.String("resultJson", "<unparseable>"),
			slog.Bool("creditsReported", out.Data.CreditsConsumed != nil))
	} else {
		redacted, mErr := json.Marshal(redactURLs(whole))
		if mErr != nil {
			redacted = []byte(`"<unmarshalable>"`)
		}
		c.logger().Info("kie: result",
			slog.String("taskId", taskID),
			slog.String("resultJson", string(redacted)),
			slog.Bool("creditsReported", out.Data.CreditsConsumed != nil))
	}

	res := Result{VideoURL: parsed.ResultURLs[0]}
	if out.Data.CreditsConsumed != nil {
		cost := float64(*out.Data.CreditsConsumed) * creditUSD
		res.ActualCostUSD = &cost
	}
	return res, nil
}

// ---------------------------------------------------------------------------
// insufficient balance
// ---------------------------------------------------------------------------

// ErrInsufficientBalance is returned (wrapped, so errors.Is finds it) by
// Submit when kie refuses a request because the account has run out of
// credits. dispatch.go checks for this specifically so the run recorded by
// failScene says "the account is out of credit" instead of a bare
// vendor-reported code.
//
// MEASURED, not a guess — this is the one thing in this package that isn't.
// Probed against the live API on 2026-08-29 by draining a 64-credit account
// (too few to run a real render, but enough to hit the wall): a createTask
// call answered with the envelope
//
//	{"code":402,"msg":"Credits insufficient : Your current balance isn't
//	enough to run this request."}
//
// at HTTP 200 — the same "real outcome lives in the envelope, not the HTTP
// status" shape TestClient_Submit_VendorReportedError already pinned for a
// rejected credential (HTTP 200, body code=401). looksLikeInsufficientBalance
// below is checked in Submit's own decode path for exactly that reason: an
// HTTP-status classifier the way fal/client.go's doOnce checks would never
// see this signal, because kie does not put it in the HTTP status.
//
// This header used to say the shape was unobserved and that porting fal's
// own unconfirmed guess would compound one assumption onto another. That
// reason no longer applies: the shape above is a real response, not a
// guess, so unlike fal's own ErrInsufficientBalance (still unconfirmed —
// see fal/client.go's own doc comment) this one is not a bet.
var ErrInsufficientBalance = errors.New("kie: insufficient account balance")

// insufficientBalancePhrases are checked case-insensitively against a
// vendor-reported msg when the envelope code alone isn't 402 — kie may
// reuse a different code for the same underlying refusal on an endpoint
// this hasn't been probed against yet (recordInfo, for instance, has never
// been observed failing this way). Mirrors fal/client.go's own
// insufficientBalancePhrases in spirit, not by copying its list: fal's
// phrases were guessed from no observed response at all, where this one
// leads with the exact substring kie's own message used.
var insufficientBalancePhrases = []string{
	"credits insufficient",
	"insufficient balance",
	"insufficient credit",
	"insufficient funds",
}

// looksLikeInsufficientBalance is Submit's classifier for a non-OK envelope
// code. code == 402 is trusted outright — the exact value the live probe
// returned — and any other code falls back to a substring match on msg
// against insufficientBalancePhrases, the same two-signal structure
// fal/client.go's own looksLikeInsufficientBalance uses for the same
// reason: a vendor is free to reuse a code for more than one failure kind.
func looksLikeInsufficientBalance(code int, msg string) bool {
	if code == http.StatusPaymentRequired {
		return true
	}
	lower := strings.ToLower(msg)
	for _, phrase := range insufficientBalancePhrases {
		if strings.Contains(lower, phrase) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// HTTP with retry
// ---------------------------------------------------------------------------

// doJSON mirrors fal/client.go's own doJSON: idempotent GETs retry on
// transient failure, POST only retries after an explicit 429 (kie may have
// already accepted and billed a POST whose response was lost), and a 429/408
// Retry-After is honoured when present, capped by retryAfterCap.
func (c *Client) doJSON(ctx context.Context, method, rawURL string, body []byte, out any) error {
	var lastErr error
	var retryAfter time.Duration
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			var waitErr error
			if retryAfter > 0 {
				waitErr = sleepFor(ctx, retryAfter)
			} else {
				waitErr = sleepBackoff(ctx, attempt)
			}
			if waitErr != nil {
				return fmt.Errorf("kie: %s %s: %w", method, rawURL, waitErr)
			}
		}

		retry, wait, err := c.doOnce(ctx, method, rawURL, body, out)
		retryAfter = wait
		if err == nil {
			return nil
		}
		lastErr = err
		if !retry {
			return err
		}
	}
	return fmt.Errorf("kie: %s %s: giving up after %d attempts: %w", method, rawURL, maxAttempts, lastErr)
}

func (c *Client) doOnce(ctx context.Context, method, rawURL string, body []byte, out any) (retry bool, retryAfter time.Duration, err error) {
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	var reqBody io.Reader
	if body != nil {
		reqBody = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(reqCtx, method, rawURL, reqBody)
	if err != nil {
		return false, 0, fmt.Errorf("build request: %w", err)
	}
	// Bearer, not fal's "Key {apiKey}" scheme — kie.ai's documented auth
	// header shape. UNVERIFIED like everything else in this file, but this
	// specific detail (Bearer vs. a custom scheme) is the most commonly
	// consistent convention across kie.ai's publicly described endpoints, so
	// it is treated as the most likely guess rather than copying fal's.
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		r, e := classifyAmbiguousFailure(method, fmt.Errorf("do request: %w", err))
		return r, 0, e
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		r, e := classifyAmbiguousFailure(method, fmt.Errorf("read response body: %w", err))
		return r, 0, e
	}

	switch {
	case resp.StatusCode >= 500:
		r, e := classifyAmbiguousFailure(method, fmt.Errorf("server error: status %d: %s", resp.StatusCode, string(respBody)))
		return r, 0, e
	case resp.StatusCode >= 400:
		baseErr := fmt.Errorf("client error: status %d: %s", resp.StatusCode, string(respBody))
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusRequestTimeout {
			if resp.StatusCode == http.StatusRequestTimeout && method != http.MethodGet {
				// A 408 on a POST is ambiguous — kie may have accepted and
				// started (and billed) the job before timing out on the
				// response. Wrapped with ErrSubmissionOutcomeUnknown so
				// dispatch.go's failScene tags the resulting run
				// billing-unknown instead of a confident $0 failure. Mirrors
				// fal/client.go's doJSON, which used to be this codebase's
				// only producer of that sentinel — see
				// ErrSubmissionOutcomeUnknown's own doc comment in types.go
				// for why this was a real gap, not a cosmetic one, once kie
				// became the only vendor.
				return false, 0, fmt.Errorf("%w: %w", ErrSubmissionOutcomeUnknown, baseErr)
			}
			wait, _ := parseRetryAfter(resp.Header.Get("Retry-After"))
			if wait > retryAfterCap {
				wait = retryAfterCap
			}
			return true, wait, baseErr
		}
		return false, 0, baseErr
	}

	if out != nil {
		if err := json.Unmarshal(respBody, out); err != nil {
			return false, 0, fmt.Errorf("decode response: %w", err)
		}
	}
	return false, 0, nil
}

// classifyAmbiguousFailure: only GET is safely retryable after a
// transport-level or 5xx failure, since a POST's createTask may already
// have been accepted and billed even though the response was lost. A POST
// failure is wrapped with ErrSubmissionOutcomeUnknown for exactly that
// reason — see this file's own header comment and the 408-on-POST branch
// in doOnce above, the two places this sentinel can originate. Until this
// fix, only fal.Client's now-deleted doJSON ever produced it; this
// function used to return the bare error for a POST, which meant an
// ambiguous lost-POST failure on kie was recorded as a confident, free
// failure instead of a billing-unknown one. Invisible while fal still took
// most submissions; a real gap the moment kie became the only vendor.
func classifyAmbiguousFailure(method string, err error) (retry bool, out error) {
	if method == http.MethodGet {
		return true, err
	}
	return false, fmt.Errorf("%w: %w", ErrSubmissionOutcomeUnknown, err)
}

// parseRetryAfter mirrors fal/client.go's own — see that function's doc
// comment.
func parseRetryAfter(header string) (d time.Duration, ok bool) {
	header = strings.TrimSpace(header)
	if header == "" {
		return 0, false
	}
	if secs, err := strconv.Atoi(header); err == nil {
		if secs < 0 {
			return 0, false
		}
		return time.Duration(secs) * time.Second, true
	}
	if t, err := http.ParseTime(header); err == nil {
		if until := time.Until(t); until > 0 {
			return until, true
		}
		return 0, true
	}
	return 0, false
}

func sleepBackoff(ctx context.Context, attempt int) error {
	backoff := 500 * time.Millisecond * time.Duration(uint(1)<<uint(attempt-1))
	const backoffCap = 8 * time.Second
	if backoff > backoffCap {
		backoff = backoffCap
	}
	jitter := time.Duration(rand.Int63n(int64(backoff/2) + 1))

	select {
	case <-time.After(backoff + jitter):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func sleepFor(ctx context.Context, d time.Duration) error {
	select {
	case <-time.After(d):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ---------------------------------------------------------------------------
// mock mode
// ---------------------------------------------------------------------------

// The mock is STATELESS: everything Status and Result need is encoded in the
// task id, and nothing about a submission is remembered in this process.
//
// It used to keep a map of submissions, which meant a worker restart orphaned
// every in-flight mock render. The status check answered "unknown task id"
// forever — an error, not a verdict — so the scene never advanced and never
// failed either. It sat in 'rendering' permanently, and restarting the worker
// is the single most common thing a developer does.
//
// Deriving the verdict from the id instead costs nothing and buys two things:
// a mock that survives a restart, and a simulated failure that is
// reproducible — the same id always fails, so a bad render can be replayed
// instead of chased. A retry mints a new id and gets a fresh roll.
//
// Format: mock-kie-<unix nanos>-<random>.
const mockTaskPrefix = "mock-kie-"

func (c *Client) mockSubmit() string {
	return fmt.Sprintf("%s%d-%d", mockTaskPrefix, time.Now().UnixNano(), rand.Intn(1_000_000))
}

// mockParse recovers a submission's creation time and its simulated verdict
// from the id alone.
func mockParse(taskID string) (createdAt time.Time, fail bool, err error) {
	rest, ok := strings.CutPrefix(taskID, mockTaskPrefix)
	if !ok {
		return time.Time{}, false, fmt.Errorf("kie: mock: task id %q is not a mock id", taskID)
	}
	nanosStr, randStr, ok := strings.Cut(rest, "-")
	if !ok {
		return time.Time{}, false, fmt.Errorf("kie: mock: malformed mock task id %q", taskID)
	}
	nanos, err := strconv.ParseInt(nanosStr, 10, 64)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("kie: mock: malformed timestamp in task id %q: %w", taskID, err)
	}
	n, err := strconv.ParseInt(randStr, 10, 64)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("kie: mock: malformed suffix in task id %q: %w", taskID, err)
	}
	return time.Unix(0, nanos), n%int64(mockFailureRate) == 0, nil
}

func (c *Client) mockStatus(taskID string) (Status, error) {
	createdAt, fail, err := mockParse(taskID)
	if err != nil {
		return "", err
	}
	if time.Since(createdAt) < mockRenderDelay {
		return StatusInProgress, nil
	}
	if fail {
		return StatusFailed, nil
	}
	return StatusCompleted, nil
}

func (c *Client) mockResult(taskID string) (Result, error) {
	createdAt, fail, err := mockParse(taskID)
	if err != nil {
		return Result{}, err
	}
	if time.Since(createdAt) < mockRenderDelay {
		return Result{}, fmt.Errorf("kie: mock: task %s not yet complete", taskID)
	}
	if fail {
		return Result{}, fmt.Errorf("kie: mock: simulated failure for task %s", taskID)
	}
	// ActualCostUSD deliberately left nil: there is no real kie render
	// behind a mock submission for it to describe.
	return Result{VideoURL: c.mockVideoURL, DurationSeconds: 8}, nil
}
