package webui

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"focus-memo/server/internal/config"
)

func testConfig(t *testing.T) config.Config {
	t.Helper()
	hash, err := EncodePasswordHash("correct horse battery staple")
	if err != nil {
		t.Fatalf("encode password: %v", err)
	}
	key := base64.RawStdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
	return config.Config{WebPasswordHash: hash, WebSessionKey: key}
}

func stubAPI() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"path":   r.URL.Path,
			"method": r.Method,
			"query":  r.URL.RawQuery,
		})
	})
}

func do(handler http.Handler, method, target string, body string, headers map[string]string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	for key, value := range headers {
		if key == "Host" {
			req.Host = value
			continue
		}
		req.Header.Set(key, value)
	}
	for _, cookie := range cookies {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func login(t *testing.T, handler http.Handler) *http.Cookie {
	t.Helper()
	rec := do(handler, http.MethodPost, "/web/login", `{"password":"correct horse battery staple"}`,
		map[string]string{"Content-Type": "application/json", "X-Focus-Web": "1"})
	if rec.Code != http.StatusOK {
		t.Fatalf("login status = %d body=%s", rec.Code, rec.Body.String())
	}
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == sessionCookieName {
			return cookie
		}
	}
	t.Fatal("login did not set session cookie")
	return nil
}

func TestPBKDF2SHA256Vectors(t *testing.T) {
	cases := []struct {
		iterations int
		want       string
	}{
		{1, "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"},
		{2, "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"},
	}
	for _, tc := range cases {
		got := hex.EncodeToString(pbkdf2SHA256([]byte("password"), []byte("salt"), tc.iterations, 32))
		if got != tc.want {
			t.Fatalf("iterations %d: got %s want %s", tc.iterations, got, tc.want)
		}
	}
}

func TestPasswordHashRoundTrip(t *testing.T) {
	encoded, err := EncodePasswordHash("s3cret-pass")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parsePasswordHash(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !parsed.verify("s3cret-pass") {
		t.Fatal("correct password rejected")
	}
	if parsed.verify("s3cret-pas") {
		t.Fatal("wrong password accepted")
	}
	if _, err := parsePasswordHash("bcrypt$whatever"); err == nil {
		t.Fatal("malformed hash accepted")
	}
}

func TestSessionSigner(t *testing.T) {
	key := base64.RawStdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
	signer, err := newSessionSigner(key)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	value := signer.issue(now)
	if value == "" || !signer.valid(value, now) {
		t.Fatal("fresh session rejected")
	}
	if signer.valid(value, now.Add(8*24*time.Hour)) {
		t.Fatal("expired session accepted")
	}
	if signer.valid(value+"x", now) {
		t.Fatal("tampered session accepted")
	}
	other, _ := newSessionSigner(base64.RawStdEncoding.EncodeToString([]byte("ffffffffffffffffffffffffffffffff")))
	if other.valid(value, now) {
		t.Fatal("session accepted under a different key")
	}
	if _, err := newSessionSigner("short"); err == nil {
		t.Fatal("short key accepted")
	}
}

func TestWebUIRequiresLoginForAPI(t *testing.T) {
	handler := New(testConfig(t), stubAPI())

	rec := do(handler, http.MethodGet, "/web/api/v1/memos", "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous API status = %d", rec.Code)
	}

	cookie := login(t, handler)
	rec = do(handler, http.MethodGet, "/web/api/v1/memos?limit=1", "", nil, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("authorized API status = %d body=%s", rec.Code, rec.Body.String())
	}
	var payload map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["path"] != "/api/v1/memos" || payload["query"] != "limit=1" {
		t.Fatalf("proxy did not rewrite path: %+v", payload)
	}
}

func TestLoginRejectsWrongPassword(t *testing.T) {
	handler := New(testConfig(t), stubAPI())
	rec := do(handler, http.MethodPost, "/web/login", `{"password":"nope"}`,
		map[string]string{"Content-Type": "application/json", "X-Focus-Web": "1"})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password status = %d", rec.Code)
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("failed login set a cookie")
	}
}

func TestWritesRequireCSRFHeaderAndSameOrigin(t *testing.T) {
	handler := New(testConfig(t), stubAPI())
	cookie := login(t, handler)

	rec := do(handler, http.MethodPost, "/web/api/v1/memos", `{}`, nil, cookie)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("missing header status = %d", rec.Code)
	}

	rec = do(handler, http.MethodPost, "/web/api/v1/memos", `{}`,
		map[string]string{"X-Focus-Web": "1", "Origin": "https://evil.example"}, cookie)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cross-origin status = %d", rec.Code)
	}

	rec = do(handler, http.MethodPost, "/web/api/v1/memos", `{}`,
		map[string]string{"X-Focus-Web": "1", "Origin": "https://memo-api.cliproxy.com.cn", "Host": "memo-api.cliproxy.com.cn"}, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("same-origin status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestStaticAssetsAndHeaders(t *testing.T) {
	handler := New(testConfig(t), stubAPI())

	rec := do(handler, http.MethodGet, "/", "", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "专注备忘录") {
		t.Fatalf("index status = %d", rec.Code)
	}
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'self'") {
		t.Fatalf("missing CSP: %q", csp)
	}

	rec = do(handler, http.MethodGet, "/assets/styles.css", "", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Header().Get("Content-Type"), "text/css") {
		t.Fatalf("css status = %d type=%s", rec.Code, rec.Header().Get("Content-Type"))
	}

	rec = do(handler, http.MethodGet, "/assets/js/app.js", "", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Header().Get("Content-Type"), "javascript") {
		t.Fatalf("js status = %d type=%s", rec.Code, rec.Header().Get("Content-Type"))
	}
	// 网页端只在打开/回到前台/手动点击时拉取，不允许后台定时轮询。
	script := rec.Body.String()
	if strings.Contains(script, "setInterval") {
		t.Fatalf("app.js must not poll on a timer")
	}
	for _, want := range []string{"visibilitychange", "FOREGROUND_REFRESH_GAP_MS"} {
		if !strings.Contains(script, want) {
			t.Fatalf("app.js missing %q", want)
		}
	}

	for _, target := range []string{"/assets/../webui.go", "/assets/%2e%2e/webui.go", "/secret"} {
		rec = do(handler, http.MethodGet, target, "", nil)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404", target, rec.Code)
		}
	}
}

func TestDisabledWhenNotConfigured(t *testing.T) {
	handler := New(config.Config{}, stubAPI())

	rec := do(handler, http.MethodGet, "/web/session", "", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"enabled":false`) || !strings.Contains(rec.Body.String(), `"localAttachmentDir":""`) {
		t.Fatalf("session status = %d body=%s", rec.Code, rec.Body.String())
	}
	rec = do(handler, http.MethodPost, "/web/login", `{"password":"x"}`,
		map[string]string{"Content-Type": "application/json", "X-Focus-Web": "1"})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("login status = %d", rec.Code)
	}
	rec = do(handler, http.MethodGet, "/web/api/v1/memos", "", nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("proxy status = %d", rec.Code)
	}
}

func TestLoginRateLimit(t *testing.T) {
	handler := New(testConfig(t), stubAPI())
	headers := map[string]string{"Content-Type": "application/json", "X-Focus-Web": "1"}
	for i := 0; i < maxLoginFailures; i++ {
		rec := do(handler, http.MethodPost, "/web/login", `{"password":"nope"}`, headers)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d status = %d", i, rec.Code)
		}
	}
	rec := do(handler, http.MethodPost, "/web/login", `{"password":"correct horse battery staple"}`, headers)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("rate limit status = %d", rec.Code)
	}
}
