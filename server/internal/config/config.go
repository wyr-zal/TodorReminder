package config

import (
	"errors"
	"net"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	ListenAddr     string
	DSN            string
	AttachmentsDir string
	MaxUploadBytes int64
	MaxImagePixels int64
}

func Load(get func(string) string) (Config, error) {
	c := Config{ListenAddr: "127.0.0.1:8080", DSN: get("MYSQL_DSN"), AttachmentsDir: get("ATTACHMENTS_DIR"), MaxUploadBytes: 20 << 20, MaxImagePixels: 12_000_000}
	if c.DSN == "" {
		return Config{}, errors.New("MYSQL_DSN is required")
	}
	if !filepath.IsAbs(c.AttachmentsDir) {
		return Config{}, errors.New("ATTACHMENTS_DIR must be an absolute persistent directory")
	}
	if v := get("LISTEN_ADDR"); v != "" {
		c.ListenAddr = v
	}
	host, _, err := net.SplitHostPort(c.ListenAddr)
	if err != nil {
		return Config{}, errors.New("invalid LISTEN_ADDR")
	}
	ip := net.ParseIP(host)
	if !strings.EqualFold(host, "localhost") && (ip == nil || !ip.IsLoopback()) {
		return Config{}, errors.New("LISTEN_ADDR must use loopback; terminate TLS at a reverse proxy")
	}
	limits := map[string]struct {
		target *int64
		max    int64
	}{
		"MAX_UPLOAD_BYTES": {target: &c.MaxUploadBytes, max: 20 << 20},
		"MAX_IMAGE_PIXELS": {target: &c.MaxImagePixels, max: 12_000_000},
	}
	for name, limit := range limits {
		if v := get(name); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n <= 0 || n > limit.max {
				return Config{}, errors.New("invalid " + name)
			}
			*limit.target = n
		}
	}
	return c, nil
}
