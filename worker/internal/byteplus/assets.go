package byteplus

// BytePlus ModelArk's private Asset Library, for Seedance 2.5 references.
//
// Read 2026-11-19 from ai.byteplus.com (region ap-southeast-1) docs:
// create-asset-group-api, 2318271 (CreateAsset), get-asset-api,
// base-url-and-authentication, seedance-portrait-asset-guide.
//
//	POST https://ark.ap-southeast-1.byteplusapi.com/?Action=CreateAsset&Version=2024-01-01
//	     {"GroupId","URL","AssetType"}           -> Result.Id ("asset-...")
//	POST ...?Action=GetAsset&Version=2024-01-01
//	     {"Id"}                                   -> Result.Status Processing|Active|Failed
//
// A reference is uploaded ONCE per source file (store.SceneReference.SourceKey,
// cached in byteplus_assets, 0147), then named in the video request as
// "asset://<id>". Uploads are asynchronous: until an asset is Active the scene
// goes back to the queue (ErrAssetsNotReady) rather than holding a dispatch
// tick, the same road byteplus.ErrAtCapacity takes.
//
// AUTH IS NOT THE ARK API KEY. The Assets API takes only an AccessKey pair,
// HMAC-SHA256-signed (region ap-southeast-1, service ark). The docs show the
// header shape but not the canonical request; sign below follows BytePlus's
// documented OpenAPI signing (the scheme its SDK signer implements). UNVERIFIED
// until the first real call — a wrong signature is a loud refusal, never a
// billed render.
//
// NOT A WAY AROUND THE REAL-FACE RULE. Seedance 2.x refuses references showing
// real people even from the library; a real person must be verified in the
// BytePlus console (a human step no API performs). Such an asset comes back
// Failed, and the scene fails with BytePlus's reason, unbilled.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/store"
)

const (
	assetsBaseURL = "https://ark.ap-southeast-1.byteplusapi.com"
	assetsRegion  = "ap-southeast-1"
	assetsService = "ark"
	assetsVersion = "2024-01-01"
)

// ErrAssetsNotReady: a reference is still uploading to (or queued for) the
// Asset Library. Nothing was submitted or billed; dispatch requeues the scene.
var ErrAssetsNotReady = errors.New("BytePlus is still preparing this scene's references in its Asset Library")

// AssetFailedError: BytePlus finished processing a reference and refused it.
// Permanent for that file, so it is cached and the scene fails.
type AssetFailedError struct{ Reason string }

func (e *AssetFailedError) Error() string {
	return "BytePlus's Asset Library refused a reference (" + e.Reason + "). " +
		"If it shows a real person, they must be verified in the BytePlus console first. Nothing was charged."
}

// AssetClient calls the Assets API with an AccessKey pair.
type AssetClient struct {
	accessKey, secretKey string
	baseURL              string
	httpClient           *http.Client
	now                  func() time.Time
}

// NewAssetClient builds an AssetClient; httpClient nil means a 60s timeout.
func NewAssetClient(accessKey, secretKey string, httpClient *http.Client) *AssetClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: requestTimeout}
	}
	return &AssetClient{accessKey: accessKey, secretKey: secretKey, baseURL: assetsBaseURL, httpClient: httpClient, now: time.Now}
}

// CreateAsset uploads one file by URL and returns its asset id. assetType is
// "Image", "Video" or "Audio".
func (c *AssetClient) CreateAsset(ctx context.Context, groupID, fileURL, assetType string) (string, error) {
	var out struct {
		ID string `json:"Id"`
	}
	if err := c.call(ctx, "CreateAsset", map[string]string{"GroupId": groupID, "URL": fileURL, "AssetType": assetType}, &out); err != nil {
		return "", err
	}
	if out.ID == "" {
		return "", errors.New("byteplus assets: CreateAsset returned no Id")
	}
	return out.ID, nil
}

// GetAsset returns an asset's status and, when Failed, BytePlus's reason.
func (c *AssetClient) GetAsset(ctx context.Context, id string) (status, reason string, err error) {
	var out struct {
		Status string `json:"Status"`
		Error  *struct {
			Code    string `json:"Code"`
			Message string `json:"Message"`
		} `json:"Error"`
	}
	if err := c.call(ctx, "GetAsset", map[string]string{"Id": id}, &out); err != nil {
		return "", "", err
	}
	if out.Error != nil {
		reason = strings.TrimSpace(out.Error.Code + ": " + out.Error.Message)
	}
	return out.Status, reason, nil
}

// call posts one signed Action and decodes Result into out. A refusal comes
// back as *APIError (Status 429 or a throttling code = rate limited).
func (c *AssetClient) call(ctx context.Context, action string, body any, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("byteplus assets: marshal %s: %w", action, err)
	}
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	u := c.baseURL + "/?" + url.Values{"Action": {action}, "Version": {assetsVersion}}.Encode()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, u, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("byteplus assets: build %s: %w", action, err)
	}
	sign(req, payload, c.accessKey, c.secretKey, c.now())

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("byteplus assets: %s: %w", action, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("byteplus assets: %s: read body: %w", action, err)
	}
	var envelope struct {
		ResponseMetadata struct {
			Error *struct {
				Code    string `json:"Code"`
				Message string `json:"Message"`
			} `json:"Error"`
		} `json:"ResponseMetadata"`
		Result json.RawMessage `json:"Result"`
	}
	decodeErr := json.Unmarshal(raw, &envelope)
	if e := envelope.ResponseMetadata.Error; e != nil && e.Code != "" {
		return &APIError{Status: resp.StatusCode, Code: e.Code, Message: e.Message}
	}
	if resp.StatusCode >= 400 {
		return &APIError{Status: resp.StatusCode, Message: string(raw)}
	}
	if decodeErr != nil {
		return fmt.Errorf("byteplus assets: %s: decode response: %w", action, decodeErr)
	}
	if out != nil && len(envelope.Result) > 0 {
		if err := json.Unmarshal(envelope.Result, out); err != nil {
			return fmt.Errorf("byteplus assets: %s: decode result: %w", action, err)
		}
	}
	return nil
}

// sign adds BytePlus OpenAPI's HMAC-SHA256 headers to req.
func sign(req *http.Request, body []byte, accessKey, secretKey string, now time.Time) {
	xDate := now.UTC().Format("20060102T150405Z")
	shortDate := xDate[:8]
	bodyHash := sha256Hex(body)
	host := req.URL.Host

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Date", xDate)
	req.Header.Set("X-Content-Sha256", bodyHash)

	const signedHeaders = "content-type;host;x-content-sha256;x-date"
	canonicalHeaders := "content-type:application/json\n" +
		"host:" + host + "\n" +
		"x-content-sha256:" + bodyHash + "\n" +
		"x-date:" + xDate + "\n"
	path := req.URL.EscapedPath()
	if path == "" {
		path = "/"
	}
	canonicalRequest := strings.Join([]string{
		req.Method, path, req.URL.Query().Encode(), canonicalHeaders, signedHeaders, bodyHash,
	}, "\n")

	scope := shortDate + "/" + assetsRegion + "/" + assetsService + "/request"
	stringToSign := "HMAC-SHA256\n" + xDate + "\n" + scope + "\n" + sha256Hex([]byte(canonicalRequest))

	key := hmacSHA256([]byte(secretKey), shortDate)
	key = hmacSHA256(key, assetsRegion)
	key = hmacSHA256(key, assetsService)
	key = hmacSHA256(key, "request")
	signature := hex.EncodeToString(hmacSHA256(key, stringToSign))

	req.Header.Set("Authorization", "HMAC-SHA256 Credential="+accessKey+"/"+scope+
		", SignedHeaders="+signedHeaders+", Signature="+signature)
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, msg string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(msg))
	return m.Sum(nil)
}

// AssetCache is byteplus_assets (store.Store satisfies it).
type AssetCache interface {
	BytePlusAsset(ctx context.Context, sourceKey string) (store.BytePlusAsset, bool, error)
	SaveBytePlusAsset(ctx context.Context, sourceKey string, a store.BytePlusAsset) error
}

// AssetLibrary turns a render's reference URLs into asset:// ids, uploading
// each source file once.
type AssetLibrary struct {
	Client  *AssetClient
	GroupID string
	Cache   AssetCache
}

// rateLimited reports a refusal that clears by waiting (CreateAsset is 3/min
// on the Entry tier), which requeues the scene rather than failing it.
func rateLimited(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	return apiErr.Status == http.StatusTooManyRequests ||
		strings.Contains(apiErr.Code, "Throttl") || strings.Contains(apiErr.Code, "RateLimit") ||
		strings.Contains(apiErr.Code, "QuotaExceeded")
}

// resolve returns "asset://<id>" once the source's asset is Active. It
// uploads on first sight and reports ErrAssetsNotReady while BytePlus works.
func (l *AssetLibrary) resolve(ctx context.Context, sourceKey, fileURL, assetType string) (string, error) {
	cached, ok, err := l.Cache.BytePlusAsset(ctx, sourceKey)
	if err != nil {
		return "", err
	}
	if !ok {
		id, err := l.Client.CreateAsset(ctx, l.GroupID, fileURL, assetType)
		if err != nil {
			if rateLimited(err) {
				return "", ErrAssetsNotReady
			}
			return "", fmt.Errorf("upload a reference to the BytePlus Asset Library: %w", err)
		}
		if err := l.Cache.SaveBytePlusAsset(ctx, sourceKey, store.BytePlusAsset{AssetID: id, Status: "Processing"}); err != nil {
			return "", err
		}
		return "", ErrAssetsNotReady
	}
	if cached.Status == "Processing" {
		status, reason, err := l.Client.GetAsset(ctx, cached.AssetID)
		if err != nil {
			if rateLimited(err) {
				return "", ErrAssetsNotReady
			}
			return "", fmt.Errorf("check a BytePlus Asset Library upload: %w", err)
		}
		if status != cached.Status {
			cached.Status = status
			if reason != "" {
				cached.Error = &reason
			}
			if err := l.Cache.SaveBytePlusAsset(ctx, sourceKey, cached); err != nil {
				return "", err
			}
		}
	}
	switch cached.Status {
	case "Active":
		return "asset://" + cached.AssetID, nil
	case "Failed", "Rejected":
		reason := "no reason given"
		if cached.Error != nil && *cached.Error != "" {
			reason = *cached.Error
		}
		return "", &AssetFailedError{Reason: reason}
	default:
		return "", ErrAssetsNotReady
	}
}

// rewrite swaps every reference URL in req for its asset:// id. It resolves
// them all before answering, so every upload of a scene starts in one pass.
func (l *AssetLibrary) rewrite(ctx context.Context, req kie.SubmitRequest) (kie.SubmitRequest, error) {
	notReady := false
	convert := func(urls []string, assetType string) ([]string, error) {
		if len(urls) == 0 {
			return urls, nil
		}
		out := make([]string, len(urls))
		for i, u := range urls {
			key := req.ReferenceSourceKeys[u]
			if key == "" {
				// The storage path: stable across signings of the same file.
				key, _, _ = strings.Cut(u, "?")
			}
			id, err := l.resolve(ctx, key, u, assetType)
			if errors.Is(err, ErrAssetsNotReady) {
				notReady = true
				continue
			}
			if err != nil {
				return nil, err
			}
			out[i] = id
		}
		return out, nil
	}

	images := req.ImageURLs
	if len(images) == 0 && req.ImageURL != "" {
		images = []string{req.ImageURL}
	}
	var err error
	if images, err = convert(images, "Image"); err != nil {
		return req, err
	}
	videos, err := convert(req.VideoURLs, "Video")
	if err != nil {
		return req, err
	}
	audios, err := convert(req.AudioURLs, "Audio")
	if err != nil {
		return req, err
	}
	if notReady {
		return req, ErrAssetsNotReady
	}
	req.ImageURLs, req.VideoURLs, req.AudioURLs = images, videos, audios
	if len(images) > 0 {
		req.ImageURL = images[0]
	}
	return req, nil
}
