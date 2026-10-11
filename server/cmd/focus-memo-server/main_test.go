package main

import (
	"context"
	"strings"
	"testing"
)

func TestRunRejectsMissingDatabaseConfiguration(t *testing.T) {
	err := run(context.Background(), func(string) string { return "" })
	if err == nil || !strings.Contains(err.Error(), "MYSQL_DSN") {
		t.Fatalf("missing database configuration did not stop startup: %v", err)
	}
}
