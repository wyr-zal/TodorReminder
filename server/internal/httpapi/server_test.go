package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"focus-memo/server/internal/attachments"
	"focus-memo/server/internal/config"
	"focus-memo/server/internal/store"
)

type fakeRepo struct {
	files map[string]store.Attachment
	saves int

	healthErr error
	input     store.CreateMemoRequest
	operation string
	writeErr  error
	memo      store.Memo
}

func (f *fakeRepo) Health(context.Context) error { return f.healthErr }
func (f *fakeRepo) Meta(context.Context) (store.Meta, error) {
	return store.Meta{DatasetID: "11111111-1111-4111-8111-111111111111", SchemaVersion: 1}, nil
}

func TestAuth(t *testing.T) {
	cfg := config.Config{Token: strings.Repeat("x", 64), MaxUploadBytes: 1 << 20, MaxImagePixels: 100}
	files, err := attachments.New(t.TempDir(), cfg.MaxUploadBytes, cfg.MaxImagePixels)
	if err != nil {
		t.Fatal(err)
	}
	repo := &fakeRepo{}
	handler, err := New(cfg, repo, files)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v1/meta", "/api/v1/memos/any", "/api/v1/attachments/any", "/api/v1/sync/changes?cursor=0"} {
		req := httptest.NewRequest("GET", path, nil)
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, req)
		if out.Code != 401 {
			t.Fatalf("unprotected %s: %d", path, out.Code)
		}
	}
	for _, token := range []string{"wrong", cfg.Token} {
		req := httptest.NewRequest("GET", "/api/v1/meta", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, req)
		want := 200
		if token == "wrong" {
			want = 401
		}
		if out.Code != want {
			t.Fatalf("meta: got %d want %d", out.Code, want)
		}
	}
	repo.healthErr = errors.New("password=private-db-secret")
	out := httptest.NewRecorder()
	handler.ServeHTTP(out, httptest.NewRequest("GET", "/healthz", nil))
	if out.Code != 503 || strings.Contains(out.Body.String(), "secret") {
		t.Fatalf("unsafe health error: %d %s", out.Code, out.Body.String())
	}
	repo.healthErr = nil
	live := httptest.NewServer(handler)
	defer live.Close()
	res, err := http.Get(live.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("startup health: %d", res.StatusCode)
	}
	cfg.Token = ""
	if _, err := New(cfg, repo, files); err == nil {
		t.Fatal("empty server token accepted")
	}
}
