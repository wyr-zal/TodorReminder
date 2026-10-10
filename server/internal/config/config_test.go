package config

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestLoad(t *testing.T) {
	env := map[string]string{"FOCUS_MEMO_TOKEN": strings.Repeat("a", 64), "MYSQL_DSN": "user:secret@tcp(127.0.0.1:3306)/focus_memo", "ATTACHMENTS_DIR": t.TempDir()}
	get := func(k string) string { return env[k] }
	c, err := Load(get)
	if err != nil {
		t.Fatal(err)
	}
	if c.ListenAddr != "127.0.0.1:8080" || c.MaxUploadBytes != 20<<20 || c.MaxImagePixels != 12_000_000 || !filepath.IsAbs(c.AttachmentsDir) {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	for _, key := range []string{"FOCUS_MEMO_TOKEN", "MYSQL_DSN", "ATTACHMENTS_DIR"} {
		saved := env[key]
		delete(env, key)
		if _, err := Load(get); err == nil {
			t.Fatalf("accepted missing %s", key)
		}
		env[key] = saved
	}
	env["FOCUS_MEMO_TOKEN"] = "weak"
	if _, err := Load(get); err == nil {
		t.Fatal("accepted weak token")
	}
	env["FOCUS_MEMO_TOKEN"] = strings.Repeat("a", 64)
	env["ATTACHMENTS_DIR"] = "relative"
	if _, err := Load(get); err == nil {
		t.Fatal("accepted relative data directory")
	}
	env["ATTACHMENTS_DIR"] = t.TempDir()
	env["MAX_UPLOAD_BYTES"] = "-1"
	if _, err := Load(get); err == nil {
		t.Fatal("accepted invalid upload bound")
	}
	env["MAX_UPLOAD_BYTES"] = "20971521"
	if _, err := Load(get); err == nil {
		t.Fatal("accepted upload bound above the desktop limit")
	}
	env["MAX_UPLOAD_BYTES"] = "20971520"
	env["MAX_IMAGE_PIXELS"] = "12000001"
	if _, err := Load(get); err == nil {
		t.Fatal("accepted image pixel bound above the 12 MP limit")
	}
	env["MAX_IMAGE_PIXELS"] = "12000000"
	if _, err := Load(get); err != nil {
		t.Fatalf("rejected the 12 MP image pixel limit: %v", err)
	}
	delete(env, "MAX_UPLOAD_BYTES")
	delete(env, "MAX_IMAGE_PIXELS")
	env["LISTEN_ADDR"] = "0.0.0.0:8080"
	if _, err := Load(get); err == nil {
		t.Fatal("accepted non-loopback listener without TLS")
	}
}
