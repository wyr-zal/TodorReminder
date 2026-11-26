package webui

import (
	"encoding/json"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"focus-memo/server/internal/config"
)

// Handler serves the mobile web client and gates writes behind a password
// session. Existing /api/v1 clients (the desktop app) bypass this handler
// entirely and keep their previous behaviour.
type Handler struct {
	api          http.Handler
	assets       fs.FS
	hash         passwordHash
	signer       sessionSigner
	enabled      bool
	disabledNote string
	limiter      loginLimiter
}

func New(cfg config.Config, api http.Handler) *Handler {
	h := &Handler{api: api, assets: assetFiles}
	if strings.TrimSpace(cfg.WebPasswordHash) == "" || strings.TrimSpace(cfg.WebSessionKey) == "" {
		h.disabledNote = "网页端尚未设置访问口令，请在服务器配置 WEB_PASSWORD_HASH 与 WEB_SESSION_KEY 后重启服务。"
		return h
	}
	hash, err := parsePasswordHash(strings.TrimSpace(cfg.WebPasswordHash))
	if err != nil {
		h.disabledNote = "网页端口令配置无效，请重新生成 WEB_PASSWORD_HASH。"
		return h
	}
	signer, err := newSessionSigner(strings.TrimSpace(cfg.WebSessionKey))
	if err != nil {
		h.disabledNote = "网页端会话密钥无效，请重新生成 WEB_SESSION_KEY。"
		return h
	}
	h.hash, h.signer, h.enabled = hash, signer, true
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	switch {
	case r.URL.Path == "/" || r.URL.Path == "/index.html":
		h.serveIndex(w, r)
	case strings.HasPrefix(r.URL.Path, "/assets/"):
		h.serveAsset(w, r)
	case r.URL.Path == "/manifest.webmanifest":
		h.serveAsset(w, r)
	case strings.HasPrefix(r.URL.Path, "/icon-") || r.URL.Path == "/apple-touch-icon.png":
		h.serveAsset(w, r)
	case r.URL.Path == "/robots.txt":
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		_, _ = io.WriteString(w, "User-agent: *\nDisallow: /\n")
	case r.URL.Path == "/web/session":
		h.sessionStatus(w, r)
	case r.URL.Path == "/web/login":
		h.login(w, r)
	case r.URL.Path == "/web/logout":
		h.logout(w, r)
	case strings.HasPrefix(r.URL.Path, "/web/api/"):
		h.proxy(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) serveIndex(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.NotFound(w, r)
		return
	}
	body, err := fs.ReadFile(h.assets, "assets/index.html")
	if err != nil {
		http.Error(w, "web client unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; "+
			"object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; "+
			"connect-src 'self'; manifest-src 'self'; font-src 'self'")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
	_, _ = w.Write(body)
}

func (h *Handler) serveAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.NotFound(w, r)
		return
	}
	clean := path.Clean(r.URL.Path)
	var key string
	if strings.HasPrefix(clean, "/assets/") {
		key = "assets/" + strings.TrimPrefix(clean, "/assets/")
	} else if strings.HasPrefix(clean, "/icon-") || clean == "/apple-touch-icon.png" || clean == "/manifest.webmanifest" {
		name := strings.TrimPrefix(clean, "/")
		if strings.Contains(name, "/") {
			http.NotFound(w, r)
			return
		}
		key = "assets/" + name
	} else {
		http.NotFound(w, r)
		return
	}
	if !fs.ValidPath(key) {
		http.NotFound(w, r)
		return
	}
	body, err := fs.ReadFile(h.assets, key)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	contentType := mime.TypeByExtension(path.Ext(key))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if strings.HasSuffix(key, "manifest.webmanifest") {
		contentType = "application/manifest+json"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=0, must-revalidate")
	w.Header().Set("Referrer-Policy", "no-referrer")
	_, _ = w.Write(body)
}

func respondJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (h *Handler) sessionStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"enabled":       h.enabled,
		"authenticated": h.authenticated(r),
		"note":          h.disabledNote,
	})
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	if !h.enabled {
		respondJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "web_disabled", "message": h.disabledNote})
		return
	}
	if r.Header.Get("X-Focus-Web") != "1" {
		respondJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	ip := clientIP(r)
	now := time.Now()
	if !h.limiter.allow(ip, now) {
		respondJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too_many_attempts", "message": "尝试次数过多，请稍后再试。"})
		return
	}
	var input struct {
		Password string `json:"password"`
	}
	body := http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(body).Decode(&input); err != nil || input.Password == "" {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request", "message": "请输入访问口令。"})
		return
	}
	if !h.hash.verify(input.Password) {
		h.limiter.fail(ip, now)
		time.Sleep(250 * time.Millisecond)
		respondJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_password", "message": "访问口令不正确。"})
		return
	}
	h.limiter.reset(ip)
	if !h.setSessionCookie(w, r) {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "session_failed", "message": "无法创建会话。"})
		return
	}
	respondJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	h.clearSessionCookie(w)
	respondJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) proxy(w http.ResponseWriter, r *http.Request) {
	if !h.enabled {
		respondJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "web_disabled", "message": h.disabledNote})
		return
	}
	if !h.authenticated(r) {
		respondJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated", "message": "请先登录。"})
		return
	}
	apiPath := strings.TrimPrefix(r.URL.Path, "/web")
	if !strings.HasPrefix(apiPath, "/api/v1/") {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		if r.Header.Get("X-Focus-Web") != "1" || !sameOrigin(r) {
			respondJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
	}
	cloned := r.Clone(r.Context())
	cloned.URL.Path = apiPath
	cloned.URL.RawPath = ""
	cloned.RequestURI = apiPath
	if r.URL.RawQuery != "" {
		cloned.RequestURI += "?" + r.URL.RawQuery
	}
	h.api.ServeHTTP(w, cloned)
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(parsed.Host, r.Host)
}
