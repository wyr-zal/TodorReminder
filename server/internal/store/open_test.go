package store

import (
	"context"
	"strings"
	"testing"
)

func TestOpenRejectsUnsafeConfiguration(t *testing.T) {
	for _, dsn := range []string{"", "root:do-not-log-me@tcp(127.0.0.1:3306)/", "bad-dsn"} {
		db, err := Open(context.Background(), dsn)
		if err == nil {
			db.Close()
			t.Fatal("accepted invalid DSN")
		}
		if strings.Contains(err.Error(), "do-not-log-me") {
			t.Fatal("leaked password")
		}
	}
}
