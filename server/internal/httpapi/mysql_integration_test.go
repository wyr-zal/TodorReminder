package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"strings"
	"testing"
	"time"

	"focus-memo/server/internal/attachments"
	"focus-memo/server/internal/config"
	"focus-memo/server/internal/store"
	"github.com/go-sql-driver/mysql"
)

// Explicit opt-in only; the test database must be initialized separately.
func TestMySQL57Integration(t *testing.T) {
	dsn := os.Getenv("MYSQL_TEST_DSN")
	if dsn == "" {
		t.Skip("MYSQL_TEST_DSN not provided; real MySQL 5.7 is not verified")
	}
	parsed, err := mysql.ParseDSN(dsn)
	if err != nil || parsed.DBName != "focus_memo_test" {
		t.Fatal("integration test requires the dedicated focus_memo_test database")
	}
	probe, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal("cannot configure test database")
	}
	defer probe.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var version string
	if err = probe.QueryRowContext(ctx, "SELECT VERSION()").Scan(&version); err != nil {
		t.Fatal("test database unavailable")
	}
	if !strings.HasPrefix(version, "5.7.") {
		t.Fatal("this test requires real MySQL 5.7")
	}
	repo, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()
	files, err := attachments.New(t.TempDir(), 1<<20, 100)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := New(config.Config{Token: testToken, MaxUploadBytes: 1 << 20}, repo, files)
	if err != nil {
		t.Fatal(err)
	}
	// Dedicated fixed fixture identifiers must not collide with pre-existing data.
	var count int
	if err = probe.QueryRowContext(ctx, "SELECT COUNT(*) FROM mutation_receipts WHERE operation_id IN (?, ?)", testOp, "33333333-3333-4333-8333-333333333333").Scan(&count); err != nil || count != 0 {
		t.Fatal("test fixture operation IDs already exist; refusing to overwrite")
	}
	var imageID, memoID string
	defer func() {
		if memoID != "" {
			probe.Exec("DELETE FROM memos WHERE id = ?", memoID)
		}
		probe.Exec("DELETE FROM mutation_receipts WHERE operation_id IN (?, ?)", testOp, "33333333-3333-4333-8333-333333333333")
		if imageID != "" {
			probe.Exec("DELETE FROM attachments WHERE id = ?", imageID)
		}
	}()
	var img bytes.Buffer
	png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	w := upload(handler, img.Bytes(), false)
	if w.Code != 201 {
		t.Fatalf("real upload: %d %s", w.Code, w.Body.String())
	}
	var att store.Attachment
	json.Unmarshal(w.Body.Bytes(), &att)
	imageID = att.ID
	body, _ := json.Marshal(map[string]any{"content": "integration fixture", "attachmentIds": []string{imageID}})
	op := "33333333-3333-4333-8333-333333333333"
	first := request(handler, "POST", "/api/v1/memos", string(body), op)
	if first.Code != 201 {
		t.Fatalf("real create: %d %s", first.Code, first.Body.String())
	}
	var receipt store.Receipt
	json.Unmarshal(first.Body.Bytes(), &receipt)
	memoID = receipt.ID
	second := request(handler, "POST", "/api/v1/memos", string(body), op)
	if second.Code != 201 || first.Body.String() != second.Body.String() {
		t.Fatal("real retry did not replay original receipt")
	}
	got := request(handler, "GET", "/api/v1/attachments/"+imageID, "", "")
	if got.Code != 200 || !bytes.Equal(got.Body.Bytes(), img.Bytes()) {
		t.Fatal("real attachment retrieval failed")
	}
}
