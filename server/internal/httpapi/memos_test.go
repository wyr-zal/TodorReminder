package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"focus-memo/server/internal/attachments"
	"focus-memo/server/internal/config"
	"focus-memo/server/internal/store"
)

const testID = "11111111-1111-4111-8111-111111111111"
const testOp = "22222222-2222-4222-8222-222222222222"
const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func (f *fakeRepo) CreateMemo(_ context.Context, op string, input store.CreateMemoRequest) (store.Receipt, error) {
	f.input = input
	f.operation = op
	return store.Receipt{ID: testID, AppliedVersion: "1"}, f.writeErr
}
func (f *fakeRepo) GetMemo(_ context.Context, id string) (store.Memo, error) {
	if id != testID {
		return store.Memo{}, store.ErrNotFound
	}
	return f.memo, nil
}
func harness(t *testing.T) (*Server, *fakeRepo) {
	t.Helper()
	files, err := attachments.New(t.TempDir(), 1<<20, 100)
	if err != nil {
		t.Fatal(err)
	}
	repo := &fakeRepo{memo: store.Memo{ID: testID, Content: "hello", Version: "1"}}
	s, err := New(config.Config{Token: testToken, MaxUploadBytes: 1 << 20, MaxImagePixels: 100}, repo, files)
	if err != nil {
		t.Fatal(err)
	}
	return s, repo
}
func request(s *Server, method, path, body, op string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Content-Type", "application/json")
	if op != "" {
		r.Header.Set("Idempotency-Key", op)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestMemoHTTP(t *testing.T) {
	s, repo := harness(t)
	w := request(s, "POST", "/api/v1/memos", `{"content":"hello"}`, testOp)
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var receipt store.Receipt
	if err := json.Unmarshal(w.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.ID != testID || repo.operation != testOp || repo.input.Priority != "unimportant" || repo.input.Status != "not_started" || repo.input.Tags == nil {
		t.Fatalf("bad create normalization: %+v", repo.input)
	}
	w = request(s, "GET", "/api/v1/memos/"+testID, "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "hello") {
		t.Fatalf("get: %d %s", w.Code, w.Body.String())
	}
	for _, body := range []string{`{"content":"hello","unknown":1}`, `{"content":"hello","status":"pending"}`, `{"content":"hello"} {}`, `{"content":""}`, `{"content":"hello","attachmentIds":["../../etc/passwd"]}`} {
		w = request(s, "POST", "/api/v1/memos", body, testOp)
		if w.Code != 422 {
			t.Fatalf("bad input accepted: %d %s", w.Code, body)
		}
	}
	w = request(s, "POST", "/api/v1/memos", `{"content":"hello"}`, "")
	if w.Code != 422 {
		t.Fatal("missing idempotency accepted")
	}
	w = request(s, "POST", "/api/v1/memos", `{"content":"`+strings.Repeat("a", 1<<20)+`"}`, testOp)
	if w.Code != 413 {
		t.Fatalf("body limit: %d", w.Code)
	}
	repo.writeErr = store.ErrIdempotencyMismatch
	w = request(s, "POST", "/api/v1/memos", `{"content":"hello"}`, testOp)
	if w.Code != 409 {
		t.Fatalf("mismatch: %d", w.Code)
	}
}
