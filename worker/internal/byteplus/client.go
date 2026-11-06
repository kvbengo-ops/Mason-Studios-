// Package byteplus submits Seedance 2.5 renders to BytePlus ModelArk
// directly, instead of through kie, when BYTEPLUS_API_KEY is set.
//
// SEEDANCE 2.5 ONLY, by the owner's decision (2026-11-06) — every other model
// stays on kie, and so does Seedance 2.5 whenever no key is configured, the
// worker runs MODE=development, BYTEPLUS_ROUTE=0, or BytePlus is full or
// refuses. Router (router.go) is the only thing that decides.
//
// Read from BytePlus's own docs on 2026-11-06 (create / get / list video
// generation task, Seedance 2.5 tutorial, error codes, model pricing):
//
//	POST {base}/contents/generations/tasks      -> {"id": "cgt-..."}
//	GET  {base}/contents/generations/tasks/{id} -> status, content.video_url,
//	                                               usage.completion_tokens, error
//
// NOT USED: callback_url. BytePlus documents no signature on it, so a POST to
// it proves nothing and anyone could forge a "succeeded". The reconcile loop
// already polls every rendering scene (staleAfter 45s, 30s tick) — the same
// path a kie render takes when its webhook is lost.
package byteplus

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"ugc-pipeline/worker/internal/kie"
)

const (
	defaultBaseURL = "https://ark.ap-southeast.bytepluses.com/api/v3"

	// ModelSeedance25 is BytePlus's id for the model kie sells as
	// KieSeedance25. BYTEPLUS_MODEL overrides it — some accounts must call
	// through an endpoint id instead (error
	// InvalidEndpointOrModel.ModelIDAccessDisabled).
	ModelSeedance25 = "dreamina-seedance-2-5-260628"
	// KieSeedance25 is the kie model id dispatch hands Submit for Seedance
	// 2.5 (kie/models.go's seedance25 descriptor). It stays the id on every
	// run row even when BytePlus renders it, so spend_category_totals and
	// every rate lookup keep treating it as the same model.
	KieSeedance25 = "bytedance/seedance-2-5"

	requestTimeout = 60 * time.Second

	// executionExpiresAfterS is BytePlus's minimum (default 48h). The clock
	// includes time QUEUED at BytePlus, and a task it has not finished in an
	// hour is expired by BytePlus, unbilled — so a render this worker has
	// already given up on (reconcile's timeoutAfter) cannot finish later and
	// be charged with nowhere to land, the loss a slow kie render caused on
	// 2026-11-06.
	executionExpiresAfterS = 3600
)

// Client talks to BytePlus ModelArk's video generation API.
type Client struct {
	apiKey     string
	model      string
	baseURL    string
	httpClient *http.Client
	log        *slog.Logger
}

// NewClient builds a Client. model "" means ModelSeedance25; httpClient nil
// means a client with a 60s timeout.
func NewClient(apiKey, model string, httpClient *http.Client) *Client {
	if model == "" {
		model = ModelSeedance25
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: requestTimeout}
	}
	return &Client{apiKey: apiKey, model: model, baseURL: defaultBaseURL, httpClient: httpClient}
}

type urlRef struct {
	URL string `json:"url"`
}

// contentItem is one entry of the create request's `content` array. Only
// reference roles are ever sent: BytePlus refuses a first_frame/last_frame
// item mixed with reference items ("mutually exclusive scenarios"), and this
// product sends every picture as a reference, the way kie's seedanceInput
// sends reference_image_urls.
type contentItem struct {
	Type     string  `json:"type"`
	Text     string  `json:"text,omitempty"`
	ImageURL *urlRef `json:"image_url,omitempty"`
	VideoURL *urlRef `json:"video_url,omitempty"`
	AudioURL *urlRef `json:"audio_url,omitempty"`
	Role     string  `json:"role,omitempty"`
}

type createRequest struct {
	Model   string        `json:"model"`
	Content []contentItem `json:"content"`
	// "reference" whenever references are attached: an EXPLICIT task type is
	// validated at submit — refused immediately and unbilled — where "auto"
	// lets a bad combination queue and fail later as
	// InvalidParameter.TaskTypeConstraint. Omitted for text-only renders.
	OmniReferenceTaskType string `json:"omni_reference_task_type,omitempty"`
	Resolution            string `json:"resolution,omitempty"`
	Ratio                 string `json:"ratio,omitempty"`
	Duration              int    `json:"duration,omitempty"`
	GenerateAudio         *bool  `json:"generate_audio,omitempty"`
	Watermark             bool   `json:"watermark"`
	ExecutionExpiresAfter int    `json:"execution_expires_after"`
}

// kiePositional is the "@image3" form loop.bindUITags writes for kie;
// BytePlus documents "@Image 3".
var kiePositional = regexp.MustCompile(`@image(\d+)`)

// promptFor picks the prompt BytePlus is sent. ReferencePrompt — the
// operator's own words with each tag bound to "@Image N" / "@Video N" /
// "@Audio N", BytePlus's documented syntax for all three — wins when
// dispatch could build one. That is the whole point of it: the kie prompt
// has every tag already replaced by the element's saved description, and a
// video reference's description (a blockout's "grey mannequin in a grey
// hallway") contradicts the scene it is meant to drive. BytePlus is handed
// the file itself and an index to it instead.
func promptFor(req kie.SubmitRequest) string {
	if req.ReferencePrompt != "" {
		return req.ReferencePrompt
	}
	return kiePositional.ReplaceAllString(req.Prompt, "@Image $1")
}

// buildCreateRequest translates the vendor-neutral request dispatch builds
// into BytePlus's body. Same references, same order, as kie's seedanceInput —
// and the per-type order IS the N in "@Image N" (BytePlus numbers each type
// by its position among that type in the content array).
func buildCreateRequest(req kie.SubmitRequest, model string) createRequest {
	images := req.ImageURLs
	if len(images) == 0 && req.ImageURL != "" {
		images = []string{req.ImageURL}
	}
	var content []contentItem
	if p := promptFor(req); p != "" {
		content = append(content, contentItem{Type: "text", Text: p})
	}
	for _, u := range images {
		content = append(content, contentItem{Type: "image_url", ImageURL: &urlRef{URL: u}, Role: "reference_image"})
	}
	for _, u := range req.VideoURLs {
		content = append(content, contentItem{Type: "video_url", VideoURL: &urlRef{URL: u}, Role: "reference_video"})
	}
	for _, u := range req.AudioURLs {
		content = append(content, contentItem{Type: "audio_url", AudioURL: &urlRef{URL: u}, Role: "reference_audio"})
	}
	taskType := ""
	if len(images)+len(req.VideoURLs)+len(req.AudioURLs) > 0 {
		taskType = "reference"
	}
	return createRequest{
		Model:                 model,
		Content:               content,
		OmniReferenceTaskType: taskType,
		// BytePlus spells the enum lowercase ("480p"); kie's table already
		// does, this only guards a stray capital.
		Resolution:            strings.ToLower(req.Resolution),
		Ratio:                 req.AspectRatio,
		Duration:              int(math.Round(req.DurationSeconds)),
		GenerateAudio:         req.GenerateAudio,
		Watermark:             false,
		ExecutionExpiresAfter: executionExpiresAfterS,
	}
}

// task is the get-task response, trimmed to what this worker reads.
type task struct {
	ID      string `json:"id"`
	Status  string `json:"status"`
	Content struct {
		VideoURL string `json:"video_url"`
	} `json:"content"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Usage *struct {
		// float64 so "108900" and "108900.0" both decode — the lesson
		// kie's creditsConsumed taught (kie/client.go recordInfoResponse).
		CompletionTokens *float64 `json:"completion_tokens"`
	} `json:"usage"`
	Duration   float64 `json:"duration"`
	Resolution string  `json:"resolution"`
}

// APIError is a clear HTTP refusal from BytePlus (4xx), with its error code.
// Nothing was started and nothing billed. Router decides from Status/Code
// whether the render can go to kie instead.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	return "byteplus: " + readable(e.Code, e.Message) + fmt.Sprintf(" (HTTP %d)", e.Status)
}

// readable turns a BytePlus error code into a sentence an editor can act on.
// Codes from the error-codes page, 2026-11-06.
func readable(code, message string) string {
	switch {
	case strings.HasSuffix(code, ".PrivacyInformation"):
		return "BytePlus refused a reference that may show a real person (" + code + "). Use a different reference, or render this scene on kie."
	case strings.Contains(code, "SensitiveContentDetected"):
		return "BytePlus blocked this as sensitive content (" + code + "). Change the prompt or references; nothing was charged."
	case strings.HasPrefix(code, "InvalidParameter.TaskType"):
		return "BytePlus rejected this combination of references (" + code + "): " + message
	case code == "":
		return message
	default:
		return code + ": " + message
	}
}

// create posts a render and returns BytePlus's task id.
func (c *Client) create(ctx context.Context, body createRequest) (string, error) {
	c.logRequest(body)
	payload, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("byteplus: marshal request: %w", err)
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := c.do(ctx, http.MethodPost, c.baseURL+"/contents/generations/tasks", payload, &out); err != nil {
		return "", err
	}
	if out.ID == "" {
		return "", fmt.Errorf("byteplus: create task: response had no id")
	}
	return out.ID, nil
}

// get fetches one task.
func (c *Client) get(ctx context.Context, id string) (task, error) {
	var out task
	if err := c.do(ctx, http.MethodGet, c.baseURL+"/contents/generations/tasks/"+id, nil, &out); err != nil {
		return task{}, err
	}
	return out, nil
}

// do sends one request. No retry loop: a failed GET is retried by the next
// reconcile pass anyway, and a POST must never be replayed blind (BytePlus
// documents no idempotency key).
//
// A POST that fails in transport, times out (408) or gets a 5xx may already
// have been accepted — and so billed — so it is wrapped in
// kie.ErrSubmissionOutcomeUnknown, which dispatch records as billing-unknown
// rather than a confident $0 failure, and which Router never retries on kie.
func (c *Client) do(ctx context.Context, method, url string, body []byte, out any) error {
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(reqCtx, method, url, reader)
	if err != nil {
		return fmt.Errorf("byteplus: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	ambiguous := func(e error) error {
		if method == http.MethodGet {
			return e
		}
		return fmt.Errorf("%w: %w", kie.ErrSubmissionOutcomeUnknown, e)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return ambiguous(fmt.Errorf("byteplus: %s: %w", method, err))
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return ambiguous(fmt.Errorf("byteplus: %s: read body: %w", method, err))
	}

	switch {
	case resp.StatusCode >= 500 || resp.StatusCode == http.StatusRequestTimeout:
		return ambiguous(fmt.Errorf("byteplus: %s: status %d: %s", method, resp.StatusCode, respBody))
	case resp.StatusCode >= 400:
		apiErr := &APIError{Status: resp.StatusCode, Message: string(respBody)}
		var envelope struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(respBody, &envelope) == nil && envelope.Error.Code != "" {
			apiErr.Code, apiErr.Message = envelope.Error.Code, envelope.Error.Message
		}
		return apiErr
	}
	if out != nil {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("byteplus: %s: decode response: %w", method, err)
		}
	}
	return nil
}

// fallsBackToKie reports whether a create error is a refusal kie can absorb:
// capacity (429: rate, queue, concurrency-by-balance, set limits) or account
// state (401/403 auth, overdue, model not open; 404 model/endpoint access).
// None of these started a task, so nothing was billed.
//
// NOT parameter errors or content-safety refusals — those describe the
// render, and the scene should fail with BytePlus's reason. And never an
// ambiguous failure (ErrSubmissionOutcomeUnknown): BytePlus may already be
// rendering it, and a second render on kie would bill twice.
func fallsBackToKie(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	switch apiErr.Status {
	case http.StatusTooManyRequests, http.StatusUnauthorized, http.StatusForbidden:
		return true
	case http.StatusNotFound:
		return apiErr.Code == "ModelNotOpen" || strings.HasPrefix(apiErr.Code, "InvalidEndpointOrModel")
	default:
		return false
	}
}

// logRequest records the exact body sent, with every URL's signed query
// stripped — the same diagnostic kie's logSubmittedInput keeps, for the
// same reason: what was sent should never have to be reconstructed.
func (c *Client) logRequest(body createRequest) {
	redacted := body
	redacted.Content = make([]contentItem, len(body.Content))
	for i, item := range body.Content {
		for _, ref := range []**urlRef{&item.ImageURL, &item.VideoURL, &item.AudioURL} {
			if *ref != nil {
				*ref = &urlRef{URL: stripQuery((*ref).URL)}
			}
		}
		redacted.Content[i] = item
	}
	b, err := json.Marshal(redacted)
	if err != nil {
		return
	}
	c.logger().Info("byteplus: submit input", slog.String("model", body.Model), slog.String("input", string(b)))
}

func (c *Client) logger() *slog.Logger {
	if c.log != nil {
		return c.log
	}
	return slog.Default()
}

func stripQuery(u string) string {
	if i := strings.Index(u, "?"); i >= 0 {
		return u[:i] + "?<redacted>"
	}
	return u
}

// pricePerMillionUSD is BytePlus's published Seedance 2.5 token price
// (model-pricing page, read 2026-11-06): USD per million completion tokens,
// lower when a reference video is attached.
func pricePerMillionUSD(resolution string, withVideo bool) float64 {
	hd := strings.EqualFold(resolution, "1080p")
	switch {
	case hd && withVideo:
		return 7.0
	case hd:
		return 11.7
	case withVideo:
		return 6.40
	default:
		return 10.70
	}
}

// costUSD is what BytePlus billed for a finished task, or nil when it did not
// report usage. BytePlus bills only successful videos, on
// usage.completion_tokens (input video seconds are already folded in).
//
// UNVERIFIED: a render with a video input is billed at least a minimum token
// count (pricing page; the table is an external sheet not read), and whether
// completion_tokens already reflects that floor is not stated. The first
// measured render settles it — compare runs.cost_usd with the BytePlus bill.
func costUSD(t task, withVideo bool) *float64 {
	if t.Usage == nil || t.Usage.CompletionTokens == nil {
		return nil
	}
	usd := *t.Usage.CompletionTokens / 1e6 * pricePerMillionUSD(t.Resolution, withVideo)
	return &usd
}
