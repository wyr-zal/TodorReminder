package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"focus-memo/server/internal/store"
)

func (f *fakeRepo) SaveAttachment(_ context.Context, op string, a store.Attachment) (store.Attachment, error) {
	if f.writeErr != nil {
		return store.Attachment{}, f.writeErr
	}
	f.saves++
	a.ID = testID
	if f.files == nil {
		f.files = map[string]store.Attachment{}
	}
	f.files[a.ID] = a
	return a, nil
}
func (f *fakeRepo) GetAttachment(ctx context.Context, id string) (store.Attachment, error) {
	if err := store.CheckExpectedDataset(ctx, "11111111-1111-4111-8111-111111111111"); err != nil {
		return store.Attachment{}, err
	}
	a, ok := f.files[id]
	if !ok {
		return a, store.ErrNotFound
	}
	return a, nil
}
func upload(s *Server, data []byte, extra bool) *httptest.ResponseRecorder {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, _ := writer.CreateFormFile("file", "../../fake-name.jpg")
	part.Write(data)
	if extra {
		p, _ := writer.CreateFormFile("file", "second.png")
		p.Write(data)
	}
	writer.Close()
	req := httptest.NewRequest("POST", "/api/v1/attachments", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Idempotency-Key", testOp)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	return w
}
func TestAttachmentHTTP(t *testing.T) {
	s, repo := harness(t)
	var b bytes.Buffer
	png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	data := b.Bytes()
	w := upload(s, data, false)
	if w.Code != 201 {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	var a store.Attachment
	if err := json.Unmarshal(w.Body.Bytes(), &a); err != nil {
		t.Fatal(err)
	}
	if a.ID != testID || a.MIME != "image/png" || strings.Contains(w.Body.String(), "storage") {
		t.Fatalf("unsafe metadata: %s", w.Body.String())
	}
	w = request(s, "GET", "/api/v1/attachments/"+testID, "", "")
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) || w.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("download: %d", w.Code)
	}
	before := repo.saves
	if w = upload(s, data, true); w.Code != 422 {
		t.Fatalf("accepted two files: %d", w.Code)
	}
	if repo.saves != before {
		t.Fatal("saved metadata for invalid multipart")
	}
	if w = upload(s, []byte("<script>not an image</script>"), false); w.Code != 415 {
		t.Fatalf("invalid image: %d", w.Code)
	}
	if w = upload(s, bytes.Repeat([]byte("x"), 1<<20+1), false); w.Code != 413 {
		t.Fatalf("oversize: %d", w.Code)
	}
	repo.writeErr = errors.New("private db error")
	if w = upload(s, data, false); w.Code != 503 || strings.Contains(w.Body.String(), "private") {
		t.Fatalf("db error: %d %s", w.Code, w.Body.String())
	}
	// Files remain outside the metadata store and unmodified.
	file, err := s.files.Open(repo.files[testID].StorageKey)
	if err != nil {
		t.Fatal(err)
	}
	content, _ := io.ReadAll(file)
	file.Close()
	if !bytes.Equal(content, data) {
		t.Fatal("image changed")
	}
	if _, err = os.Stat("../../fake-name.jpg"); err == nil {
		t.Fatal("used upload filename as path")
	}
}

func TestAttachmentGetRejectsDatasetMismatch(t *testing.T) {
	s, _ := harness(t)
	req := httptest.NewRequest("GET", "/api/v1/attachments/"+testID, nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("X-Focus-Dataset-ID", "22222222-2222-4222-8222-222222222222")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)

	if w.Code != 409 || !strings.Contains(w.Body.String(), "dataset_mismatch") {
		t.Fatalf("dataset mismatch was not rejected: %d %s", w.Code, w.Body.String())
	}
}
