// Package byteplus submits Seedance 2.5 renders to BytePlus ModelArk
// directly, instead of through kie, when BYTEPLUS_API_KEY is set.
//
// SEEDANCE 2.5 ONLY, by the owner's decision (2026-11-06) — every other model
// stays on kie, and so does Seedance 2.5 whenever no key is configured or the
// worker runs MODE=development. Router (router.go) is the only thing that
// decides; nothing else in the worker knows this package exists.
//
// Read from BytePlus's own docs on 2026-11-06 (create / get video generation
// task, Seedance 2.5 tutorial, model pricing):
//
//	POST {base}/contents/generations/tasks      -> {"id": "cgt-..."}
//	GET  {base}/contents/generations/tasks/{id} -> status, content.video_url,
//	                                               usage.completion_tokens
//
// NOT USED: callback_url. BytePlus documents no signature on it, so a POST to
// it proves nothing and anyone could forge a "succeeded". The reconcile loop
// already polls every rendering scene (staleAfter 45s, 30s tick), which is
// the same path a kie render takes when its webhook is lost.
package byteplus

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"

	"ugc-pipeline/worker/internal/kie"
)

const (
	defaultBaseURL = "https://ark.ap-southeast.bytepluses.com/api/v3"

	// ModelSeedance25 is BytePlus's id for the model kie sells as
	// KieSeedance25.
	ModelSeedance25 = "dreamina-seedance-2-5-260628"
	// KieSeedance25 is the kie model id dispatch hands Submit for Seedance
	// 2.5 (kie/models.go's seedance25 descriptor). It stays the id on every
	// run row even when BytePlus renders it, so spend_category_totals and
	// every rate lookup keep treating it as the same model.
	KieSeedance25 = "bytedance/seedance-2-5"

	requestTimeout = 60 * time.Second

	// executionExpiresAfterS is BytePlus's minimum (default 48h). A task it
	// has not finished within an hour is expired BY BYTEPLUS, unbilled, so a
	// render this worker has already given up on (reconcile's timeoutAfter)
	// cannot finish later and be charged with nowhere to land — the exact
	// loss a slow kie render caused on 2026-11-06.
	executionExpiresAfterS = 3600
)

// Client talks to BytePlus ModelArk's video generation API.
type Client struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client
	log        *slog.Logger
}

// NewClient builds a Client. httpClient nil means a client with a 60s timeout.
func NewClient(apiKey string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: requestTimeout}
	}
	return &Client{apiKey: apiKey, baseURL: defaultBaseURL, httpClient: httpClient}
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
	Model                 string        `json:"model"`
	Content               []contentItem `json:"content"`
	Resolution            string        `json:"resolution,omitempty"`
	Ratio                 string        `json:"ratio,omitempty"`
	Duration              int           `json:"duration,omitempty"`
	GenerateAudio         *bool         `json:"generate_audio,omitempty"`
	Watermark             bool          `json:"watermark"`
	ExecutionExpiresAfter int           `json:"execution_expires_after"`
}

// buildCreateRequest translates the vendor-neutral request dispatch builds
// into BytePlus's body. Same references, same order, as kie's seedanceInput.
func buildCreateRequest(req kie.SubmitRequest) createRequest {
	images := req.ImageURLs
	if len(images) == 0 && req.ImageURL != "" {
		images = []string{req.ImageURL}
	}
	var content []contentItem
	if req.Prompt != "" {
		content = append(content, contentItem{Type: "text", Text: req.Prompt})
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
	return createRequest{
		Model:   ModelSeedance25,
		Content: content,
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
// reconcile pass anyway, and a POST must never be replayed blind.
//
// A POST that fails in transport, times out (408) or gets a 5xx may already
// have been accepted — and so billed — so it is wrapped in
// kie.ErrSubmissionOutcomeUnknown, which dispatch records as billing-unknown
// rather than a confident $0 failure. Same rule as kie's doOnce.
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
		// A clear refusal (bad parameter, rate limit, no balance): nothing
		// was started, nothing billed.
		return fmt.Errorf("byteplus: %s: status %d: %s", method, resp.StatusCode, respBody)
	}
	if out != nil {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("byteplus: %s: decode response: %w", method, err)
		}
	}
	return nil
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
	logger := c.log
	if logger == nil {
		logger = slog.Default()
	}
	logger.Info("byteplus: submit input", slog.String("model", body.Model), slog.String("input", string(b)))
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
func costUSD(t task, withVideo bool) *float64 {
	if t.Usage == nil || t.Usage.CompletionTokens == nil {
		return nil
	}
	usd := *t.Usage.CompletionTokens / 1e6 * pricePerMillionUSD(t.Resolution, withVideo)
	return &usd
}
