package kie

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
)

const maxKieUploadBytes = 100 << 20

// Kie cannot fetch loopback or private Supabase URLs from its servers. Copy
// only those references through its free, temporary file upload endpoint.
func (c *Client) uploadLocalImageReferences(ctx context.Context, req SubmitRequest) (SubmitRequest, error) {
	if len(req.ImageURLs) > 0 {
		req.ImageURLs = append([]string(nil), req.ImageURLs...)
	}
	uploaded := make(map[string]string)
	localURL := func(raw string) (string, error) {
		if !isPrivateURL(raw) {
			return raw, nil
		}
		if found, ok := uploaded[raw]; ok {
			return found, nil
		}
		found, err := c.uploadImageURL(ctx, raw)
		if err != nil {
			return "", err
		}
		uploaded[raw] = found
		return found, nil
	}
	for i, raw := range req.ImageURLs {
		resolved, err := localURL(raw)
		if err != nil {
			return req, err
		}
		req.ImageURLs[i] = resolved
	}
	if req.ImageURL != "" {
		resolved, err := localURL(req.ImageURL)
		if err != nil {
			return req, err
		}
		req.ImageURL = resolved
	}
	return req, nil
}

func isPrivateURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	storagePath := strings.TrimPrefix(u.Path, "/storage/v1")
	if !strings.HasPrefix(storagePath, "/object/sign/media/") {
		return false
	}
	if host == "" || host == "host.docker.internal" || strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".test") ||
		!strings.Contains(host, ".") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified()
	}
	return false
}

type kieFileUploadResponse struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data struct {
		DownloadURL string `json:"downloadUrl"`
	} `json:"data"`
}

func (c *Client) uploadImageURL(ctx context.Context, imageURL string) (string, error) {
	getReq, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return "", fmt.Errorf("build local image download: %w", withoutURL(err))
	}
	source, err := c.httpClient.Do(getReq)
	if err != nil {
		return "", fmt.Errorf("download local image: %w", withoutURL(err))
	}
	defer source.Body.Close()
	if source.StatusCode < 200 || source.StatusCode >= 300 {
		return "", fmt.Errorf("download local image: storage returned HTTP %d", source.StatusCode)
	}

	parsed, _ := url.Parse(imageURL)
	filename := path.Base(parsed.Path)
	if filename == "." || filename == "/" || filename == "" {
		filename = "reference-image"
	}
	pipeReader, pipeWriter := io.Pipe()
	form := multipart.NewWriter(pipeWriter)
	go func() {
		writeErr := form.WriteField("uploadPath", "images/ugc-reference")
		if writeErr == nil {
			writeErr = form.WriteField("fileName", filename)
		}
		if writeErr == nil {
			var file io.Writer
			file, writeErr = form.CreateFormFile("file", filename)
			if writeErr == nil {
				var size int64
				size, writeErr = io.Copy(file, io.LimitReader(source.Body, maxKieUploadBytes+1))
				if writeErr == nil && size > maxKieUploadBytes {
					writeErr = fmt.Errorf("local image exceeds Kie's 100 MB upload limit")
				}
			}
		}
		if writeErr == nil {
			writeErr = form.Close()
		}
		_ = pipeWriter.CloseWithError(writeErr)
	}()

	postReq, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.uploadBaseURL, "/")+"/api/file-stream-upload", pipeReader)
	if err != nil {
		_ = pipeReader.CloseWithError(err)
		return "", fmt.Errorf("build Kie file upload: %w", err)
	}
	postReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	postReq.Header.Set("Content-Type", form.FormDataContentType())
	response, err := c.httpClient.Do(postReq)
	if err != nil {
		_ = pipeReader.CloseWithError(err)
		return "", fmt.Errorf("upload local image to Kie: %w", withoutURL(err))
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("upload local image to Kie: HTTP %d", response.StatusCode)
	}
	var result kieFileUploadResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
		return "", fmt.Errorf("decode Kie file upload response: %w", err)
	}
	if result.Code != http.StatusOK || result.Data.DownloadURL == "" {
		return "", fmt.Errorf("Kie file upload failed: code=%d msg=%q", result.Code, result.Msg)
	}
	return result.Data.DownloadURL, nil
}

func withoutURL(err error) error {
	var requestErr *url.Error
	if errors.As(err, &requestErr) {
		return requestErr.Err
	}
	return err
}
