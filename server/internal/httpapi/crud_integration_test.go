package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"focus-memo/server/internal/attachments"
	"focus-memo/server/internal/config"
	"focus-memo/server/internal/store"
	"github.com/go-sql-driver/mysql"
)

func testOperation() string {
	var b [16]byte
	rand.Read(b[:])
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func TestCRUDIntegration(t *testing.T) {
	dsn := os.Getenv("MYSQL_TEST_DSN")
	if dsn == "" {
		t.Skip("requires explicitly authorized local test database")
	}
	c, err := mysql.ParseDSN(dsn)
	if err != nil || c.DBName != "focus_memo_test" || c.Addr != "127.0.0.1:3306" {
		t.Fatal("only local focus_memo_test is allowed")
	}
	repo, err := store.Open(context.Background(), dsn)
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
	live := httptest.NewServer(handler)
	defer live.Close()
	// Every assertion traverses a TCP HTTP connection and the real local MySQL store.
	call := func(method, path string, body any, op string) (int, map[string]any) {
		b, _ := json.Marshal(body)
		r, _ := http.NewRequest(method, live.URL+path, bytes.NewReader(b))
		r.Header.Set("Authorization", "Bearer "+testToken)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", op)
		res, e := live.Client().Do(r)
		if e != nil {
			t.Error(e)
			return 0, nil
		}
		defer res.Body.Close()
		data, _ := io.ReadAll(res.Body)
		var out map[string]any
		if e = json.Unmarshal(data, &out); e != nil {
			t.Errorf("non JSON %d: %s", res.StatusCode, data)
		}
		return res.StatusCode, out
	}
	require := func(want int, method, path string, body any, op string) map[string]any {
		code, out := call(method, path, body, op)
		if code != want {
			t.Fatalf("%s %s: got %d want %d: %+v", method, path, code, want, out)
		}
		return out
	}
	marker := "crud-" + testOperation()
	created := require(201, "POST", "/api/v1/memos", map[string]any{"content": marker, "tags": []string{marker}}, testOperation())
	id := created["id"].(string)
	path := "/api/v1/memos/" + id
	listed := require(200, "GET", "/api/v1/memos?tag="+marker+"&status=not_started&priority=unimportant", nil, "")
	if len(listed["memos"].([]any)) != 1 {
		t.Fatalf("filter mismatch: %+v", listed)
	}
	require(422, "GET", "/api/v1/memos?status=pending", nil, "")
	require(422, "GET", "/api/v1/memos?limit=99999", nil, "")
	require(422, "PATCH", path, map[string]any{"status": "completed"}, testOperation())
	require(422, "PATCH", path, map[string]any{"baseVersion": "01", "status": "completed"}, testOperation())
	patch := map[string]any{"baseVersion": "1", "status": "completed", "priority": "important"}
	op := testOperation()
	changed := require(200, "PATCH", path, patch, op)
	if changed["appliedVersion"] != "2" || changed["completedAt"] == nil {
		t.Fatalf("bad completion: %+v", changed)
	}
	repeat := require(200, "PATCH", path, patch, op)
	if repeat["updatedAt"] != changed["updatedAt"] {
		t.Fatal("retry changed receipt")
	}
	require(409, "PATCH", path, map[string]any{"baseVersion": "1", "content": "different"}, op)
	require(409, "PATCH", path, map[string]any{"baseVersion": "1", "content": "stale"}, testOperation())
	edited := require(200, "PATCH", path, map[string]any{"baseVersion": "2", "content": marker + " edited"}, testOperation())
	if edited["completedAt"] != changed["completedAt"] {
		t.Fatal("unrelated edit reset completion time")
	}
	reopened := require(200, "PATCH", path, map[string]any{"baseVersion": "3", "status": "in_progress"}, testOperation())
	if reopened["completedAt"] != nil {
		t.Fatal("reopening did not clear completion time")
	}
	require(409, "DELETE", path+"?permanent=true&baseVersion=4", nil, testOperation())
	deleted := require(200, "DELETE", path+"?baseVersion=4", nil, testOperation())
	if deleted["deleted"] != true || deleted["appliedVersion"] != "5" {
		t.Fatal("soft delete failed")
	}
	listed = require(200, "GET", "/api/v1/memos?tag="+marker, nil, "")
	if len(listed["memos"].([]any)) != 0 {
		t.Fatal("deleted record leaked into active list")
	}
	require(200, "PATCH", path, map[string]any{"baseVersion": "5", "deleted": false}, testOperation())
	require(200, "DELETE", path+"?baseVersion=6", nil, testOperation())
	purged := require(200, "DELETE", path+"?permanent=true&baseVersion=7", nil, testOperation())
	if purged["purged"] != true || purged["appliedVersion"] != "8" {
		t.Fatal("purge failed")
	}
	tombstone := require(200, "GET", path, nil, "")
	if tombstone["content"] != "" || len(tombstone["tags"].([]any)) != 0 || len(tombstone["attachmentIds"].([]any)) != 0 {
		t.Fatal("purged payload retained")
	}
	require(409, "PATCH", path, map[string]any{"baseVersion": "8", "deleted": false}, testOperation())
	snapshot := require(200, "GET", "/api/v1/sync/snapshot", nil, "")
	memos := snapshot["memos"].([]any)
	if snapshot["complete"] != true || int(snapshot["totalRows"].(float64)) != len(memos) {
		t.Fatal("incomplete snapshot")
	}
	found := false
	for _, raw := range memos {
		m := raw.(map[string]any)
		if m["id"] == id {
			found = m["purged"] == true
		}
	}
	if !found {
		t.Fatal("snapshot dropped tombstone")
	}
	// Two independent operations racing on version=1: exactly one must win.
	race := require(201, "POST", "/api/v1/memos", map[string]any{"content": marker + " race"}, testOperation())
	rp := "/api/v1/memos/" + race["id"].(string)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for _, text := range []string{"one", "two"} {
		wg.Add(1)
		go func(v string) {
			defer wg.Done()
			code, _ := call("PATCH", rp, map[string]any{"baseVersion": "1", "content": v}, testOperation())
			codes <- code
		}(text)
	}
	wg.Wait()
	close(codes)
	sum := 0
	for code := range codes {
		if code != 200 && code != 409 {
			t.Fatalf("unexpected race status %d", code)
		}
		sum += code
	}
	if sum != 609 {
		t.Fatal("both versioned writes won or both lost")
	}
	for _, route := range []string{"/api/v1/memos", "/api/v1/sync/snapshot"} {
		res, e := http.Get(live.URL + route)
		if e != nil {
			t.Fatal(e)
		}
		res.Body.Close()
		if res.StatusCode != 401 {
			t.Fatal("unprotected route " + route)
		}
	}
	if strings.Contains(fmt.Sprint(tombstone), marker) {
		t.Fatal("purge leaked original text/tag")
	}
}
