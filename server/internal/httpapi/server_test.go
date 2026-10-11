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

func TestUnauthenticatedAPI(t *testing.T) {
	cfg := config.Config{MaxUploadBytes: 1 << 20, MaxImagePixels: 100}
	files, err := attachments.New(t.TempDir(), cfg.MaxUploadBytes, cfg.MaxImagePixels)
	if err != nil {
		t.Fatal(err)
	}
	repo := &fakeRepo{}
	handler, err := New(cfg, repo, files)
	if err != nil {
		t.Fatal(err)
	}
	for _, authorization := range []string{"", "Bearer obsolete-token"} {
		for path, want := range map[string]int{
			"/api/v1/meta":            200,
			"/api/v1/memos/any":       404,
			"/api/v1/attachments/any": 404,
			"/api/v1/sync/changes":    422,
		} {
			req := httptest.NewRequest("GET", path, nil)
			if authorization != "" {
				req.Header.Set("Authorization", authorization)
			}
			out := httptest.NewRecorder()
			handler.ServeHTTP(out, req)
			if out.Code != want || out.Header().Get("WWW-Authenticate") != "" {
				t.Fatalf("%s: got %d want %d", path, out.Code, want)
			}
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
	if _, err := New(cfg, nil, files); err == nil {
		t.Fatal("nil repository accepted")
	}
}
