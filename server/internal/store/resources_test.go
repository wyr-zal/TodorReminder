package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResources(t *testing.T) {
	root := filepath.Join("..", "..", "resources")
	for _, name := range []string{"schema.sql", "init.sql", "data.sql", "migrations/001_initial.sql", "migrations/002_incremental_sync.sql"} {
		b, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		s := strings.ToUpper(string(b))
		expectedDatabase := "USE `FOCUS_MEMO`;"
		if name == "migrations/002_incremental_sync.sql" {
			expectedDatabase = "USE `FOCUS_MEMO_PROD_20261010`;"
		}
		if !strings.HasPrefix(s, expectedDatabase) {
			t.Fatalf("missing explicit database: %s", name)
		}
		if strings.Contains(s, " BLOB") || strings.Contains(s, "BASE64") {
			t.Fatalf("image payload column: %s", name)
		}
		if strings.Contains(name, "migrations/") && strings.Contains(s, "DROP TABLE") {
			t.Fatal("production initial migration drops tables")
		}
	}
	b, _ := os.ReadFile(filepath.Join(root, "schema.sql"))
	for _, table := range []string{"memos", "attachments", "mutation_receipts", "service_meta", "sync_change_state", "memo_change_cursor"} {
		if !strings.Contains(string(b), "CREATE TABLE IF NOT EXISTS "+table) {
			t.Fatalf("missing table %s", table)
		}
	}
	b, err := os.ReadFile(filepath.Join(root, "openapi.json"))
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		OpenAPI string         `json:"openapi"`
		Paths   map[string]any `json:"paths"`
	}
	if err = json.Unmarshal(b, &spec); err != nil {
		t.Fatal(err)
	}
	if spec.OpenAPI != "3.0.3" || len(spec.Paths) != 8 {
		t.Fatalf("wrong API scope: %+v", spec)
	}
}
