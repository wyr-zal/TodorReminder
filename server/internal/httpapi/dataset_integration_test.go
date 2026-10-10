package httpapi

import (
	"context"
	"focus-memo/server/internal/attachments"
	"focus-memo/server/internal/config"
	"focus-memo/server/internal/store"
	"github.com/go-sql-driver/mysql"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestDatasetWriteGuardIntegration(t *testing.T) {
	dsn := os.Getenv("MYSQL_TEST_DSN")
	if dsn == "" {
		t.Skip("authorized local MySQL required")
	}
	c, e := mysql.ParseDSN(dsn)
	if e != nil || c.DBName != "focus_memo_test" || c.Addr != "127.0.0.1:3306" {
		t.Fatal("local test DB only")
	}
	repo, e := store.Open(context.Background(), dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer repo.Close()
	files, e := attachments.New(t.TempDir(), 1<<20, 100)
	if e != nil {
		t.Fatal(e)
	}
	handler, e := New(config.Config{Token: testToken, MaxUploadBytes: 1 << 20}, repo, files)
	if e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	id := testOperation()
	op := testOperation()
	body := `{"id":"` + id + `","content":"dataset guard"}`
	r, _ := http.NewRequest("POST", server.URL+"/api/v1/memos", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", op)
	r.Header.Set("X-Focus-Dataset-ID", testOperation())
	res, e := server.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	data, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 409 || !strings.Contains(string(data), "dataset_mismatch") {
		t.Fatalf("wrong dataset wrote data: %d %s", res.StatusCode, data)
	}
	if _, e := repo.GetMemo(context.Background(), id); e != store.ErrNotFound {
		t.Fatalf("unexpected persisted memo: %v", e)
	}
	// Same operation is safe after correcting only the expected dataset: failed guard committed nothing.
	meta, _ := repo.Meta(context.Background())
	r, _ = http.NewRequest("POST", server.URL+"/api/v1/memos", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", op)
	r.Header.Set("X-Focus-Dataset-ID", meta.DatasetID)
	res, e = server.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	if res.StatusCode != 201 {
		t.Fatalf("correct dataset failed: %d", res.StatusCode)
	}
}
