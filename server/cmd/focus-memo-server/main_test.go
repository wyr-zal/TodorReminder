package main

import (
	"context"
	"strings"
	"testing"
)

func TestRunRejectsMissingCredentials(t *testing.T) {
	err := run(context.Background(), func(string) string { return "" })
	if err == nil || !strings.Contains(err.Error(), "FOCUS_MEMO_TOKEN") {
		t.Fatalf("missing credentials did not stop startup: %v", err)
	}
}
