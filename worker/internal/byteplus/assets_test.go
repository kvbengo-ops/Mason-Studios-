package byteplus

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/store"
)

// memCache is byteplus_assets in memory.
type memCache map[string]store.BytePlusAsset

func (m memCache) BytePlusAsset(_ context.Context, key string) (store.BytePlusAsset, bool, error) {
	a, ok := m[key]
	return a, ok, nil
}

func (m memCache) SaveBytePlusAsset(_ context.Context, key string, a store.BytePlusAsset) error {
	m[key] = a
	return nil
}

// fakeAssets is a fake Assets API: CreateAsset hands out asset-1, asset-2, ...
// and GetAsset answers status[id] (default Processing).
type fakeAssets struct {
	created []map[string]string
	status  map[string]string
	gone    map[string]bool // GetAsset answers 404 (deleted in the console)
}

func (f *fakeAssets) library(t *testing.T, cache memCache) *AssetLibrary {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "HMAC-SHA256 Credential=AK/") {
			t.Errorf("Authorization = %q, want an AK/SK signature, not the ARK key", r.Header.Get("Authorization"))
		}
		b, _ := io.ReadAll(r.Body)
		var body map[string]string
		_ = json.Unmarshal(b, &body)
		switch r.URL.Query().Get("Action") {
		case "CreateAsset":
			f.created = append(f.created, body)
			_, _ = io.WriteString(w, `{"ResponseMetadata":{},"Result":{"Id":"asset-`+string(rune('0'+len(f.created)))+`"}}`)
		case "GetAsset":
			if f.gone[body["Id"]] {
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, `{"ResponseMetadata":{"Error":{"Code":"ResourceNotFound","Message":"asset not found"}}}`)
				return
			}
			s := f.status[body["Id"]]
			if s == "" {
				s = "Processing"
			}
			resp := `{"ResponseMetadata":{},"Result":{"Id":"` + body["Id"] + `","Status":"` + s + `"`
			if s == "Failed" {
				resp += `,"Error":{"Code":"PrivacyInformation","Message":"real person"}`
			}
			_, _ = io.WriteString(w, resp+`}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	c := NewAssetClient("AK", "SK", srv.Client())
	c.baseURL = srv.URL
	return &AssetLibrary{Client: c, GroupID: "group-1", Cache: cache}
}

func TestResolveUploadsOnceThenWaitsForActive(t *testing.T) {
	f := &fakeAssets{status: map[string]string{}}
	cache := memCache{}
	lib := f.library(t, cache)
	ctx := context.Background()

	if _, err := lib.resolve(ctx, "el-asset-1", "https://store.test/a.png?token=x", "Image"); !errors.Is(err, ErrAssetsNotReady) {
		t.Fatalf("first sight: err = %v, want ErrAssetsNotReady", err)
	}
	if len(f.created) != 1 || f.created[0]["GroupId"] != "group-1" || f.created[0]["AssetType"] != "Image" {
		t.Fatalf("CreateAsset calls = %v, want one Image upload to group-1", f.created)
	}
	if _, err := lib.resolve(ctx, "el-asset-1", "https://store.test/a.png?token=y", "Image"); !errors.Is(err, ErrAssetsNotReady) {
		t.Fatalf("still processing: err = %v, want ErrAssetsNotReady", err)
	}
	if len(f.created) != 1 {
		t.Fatalf("uploaded the same source again (%d uploads); a source uploads once", len(f.created))
	}

	f.status["asset-1"] = "Active"
	got, err := lib.resolve(ctx, "el-asset-1", "https://store.test/a.png?token=z", "Image")
	if err != nil || got != "asset://asset-1" {
		t.Fatalf("active: got %q, %v; want asset://asset-1", got, err)
	}
	if cache["el-asset-1"].Status != "Active" {
		t.Fatalf("cache status = %q, want Active saved", cache["el-asset-1"].Status)
	}
}

// An Active asset deleted in BytePlus is uploaded again, never sent as a dead id.
func TestResolveReuploadsAnAssetDeletedInBytePlus(t *testing.T) {
	f := &fakeAssets{status: map[string]string{}, gone: map[string]bool{"asset-old": true}}
	cache := memCache{"src": {AssetID: "asset-old", Status: "Active"}}
	lib := f.library(t, cache)

	_, err := lib.resolve(context.Background(), "src", "https://store.test/a.png", "Image")
	if !errors.Is(err, ErrAssetsNotReady) {
		t.Fatalf("deleted asset: err = %v, want ErrAssetsNotReady while the new upload processes", err)
	}
	if len(f.created) != 1 || cache["src"].AssetID != "asset-1" || cache["src"].Status != "Processing" {
		t.Fatalf("uploads %d, cache %+v; want one re-upload cached as asset-1 Processing", len(f.created), cache["src"])
	}
}

func TestResolveFailedAssetFailsWithReason(t *testing.T) {
	f := &fakeAssets{status: map[string]string{"asset-9": "Failed"}}
	cache := memCache{"src": {AssetID: "asset-9", Status: "Processing"}}
	lib := f.library(t, cache)

	_, err := lib.resolve(context.Background(), "src", "https://store.test/face.png", "Image")
	var failed *AssetFailedError
	if !errors.As(err, &failed) || !strings.Contains(failed.Reason, "PrivacyInformation") {
		t.Fatalf("err = %v, want AssetFailedError carrying BytePlus's reason", err)
	}
}

func TestRewriteSendsAssetIDsInOrderOnlyWhenAllActive(t *testing.T) {
	cache := memCache{
		"img-1": {AssetID: "asset-a", Status: "Active"},
		"img-2": {AssetID: "asset-b", Status: "Active"},
		"vid-1": {AssetID: "asset-v", Status: "Processing"},
	}
	f := &fakeAssets{status: map[string]string{"asset-a": "Active", "asset-b": "Active"}}
	lib := f.library(t, cache)
	req := kie.SubmitRequest{
		ImageURLs: []string{"https://s/1?t", "https://s/2?t"},
		VideoURLs: []string{"https://s/v?t"},
		ReferenceSourceKeys: map[string]string{
			"https://s/1?t": "img-1", "https://s/2?t": "img-2", "https://s/v?t": "vid-1",
		},
	}

	if _, err := lib.rewrite(context.Background(), req); !errors.Is(err, ErrAssetsNotReady) {
		t.Fatalf("a processing video: err = %v, want ErrAssetsNotReady", err)
	}

	f.status["asset-v"] = "Active"
	out, err := lib.rewrite(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(out.ImageURLs, ",") != "asset://asset-a,asset://asset-b" || out.ImageURL != "asset://asset-a" ||
		strings.Join(out.VideoURLs, ",") != "asset://asset-v" {
		t.Fatalf("rewrite = images %v (first %q), videos %v; want asset ids in reference order", out.ImageURLs, out.ImageURL, out.VideoURLs)
	}
}

func TestRouterRequeuesWithoutCreatingWhileAssetsProcess(t *testing.T) {
	ark := &fakeArk{}
	r := router(&fakeKie{}, ark.client(t))
	r.Assets = (&fakeAssets{status: map[string]string{}}).library(t, memCache{})

	_, err := r.Submit(context.Background(), seedanceRequest())
	if !errors.Is(err, ErrAssetsNotReady) {
		t.Fatalf("err = %v, want ErrAssetsNotReady so dispatch requeues", err)
	}
	if len(ark.created) != 0 {
		t.Fatalf("created a render (%d) before its references were Active", len(ark.created))
	}
}

func TestSignIsStableAndScoped(t *testing.T) {
	req := httptestRequest(t)
	at := time.Date(2026, 11, 19, 8, 30, 0, 0, time.UTC)
	sign(req, []byte(`{"Id":"asset-1"}`), "AK", "SK", at)

	auth := req.Header.Get("Authorization")
	want := "HMAC-SHA256 Credential=AK/20261119/ap-southeast-1/ark/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature="
	if !strings.HasPrefix(auth, want) || len(auth) != len(want)+64 {
		t.Fatalf("Authorization = %q, want %q + 64 hex chars", auth, want)
	}
	if req.Header.Get("X-Date") != "20261119T083000Z" {
		t.Fatalf("X-Date = %q", req.Header.Get("X-Date"))
	}
	again := httptestRequest(t)
	sign(again, []byte(`{"Id":"asset-1"}`), "AK", "SK", at)
	if again.Header.Get("Authorization") != auth {
		t.Fatal("the same request signed twice gave two signatures")
	}
}

func httptestRequest(t *testing.T) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, assetsBaseURL+"/?Action=GetAsset&Version="+assetsVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	return req
}
