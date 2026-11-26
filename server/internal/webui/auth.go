package webui

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	passwordIterations = 210_000
	passwordKeyLength  = 32
	sessionCookieName  = "fm_web_session"
	sessionLifetime    = 7 * 24 * time.Hour
	maxLoginFailures   = 8
	loginFailWindow    = 10 * time.Minute
)

var errInvalidHash = errors.New("invalid password hash")

// pbkdf2SHA256 implements PBKDF2 (RFC 8018) with HMAC-SHA-256 using only the
// standard library, so the server needs no extra dependency for password
// hashing.
func pbkdf2SHA256(password, salt []byte, iterations, keyLength int) []byte {
	prf := hmac.New(sha256.New, password)
	hashLength := prf.Size()
	blocks := (keyLength + hashLength - 1) / hashLength
	derived := make([]byte, 0, blocks*hashLength)
	u := make([]byte, hashLength)
	var counter [4]byte
	for block := 1; block <= blocks; block++ {
		prf.Reset()
		prf.Write(salt)
		counter[0] = byte(block >> 24)
		counter[1] = byte(block >> 16)
		counter[2] = byte(block >> 8)
		counter[3] = byte(block)
		prf.Write(counter[:])
		derived = prf.Sum(derived)
		t := derived[len(derived)-hashLength:]
		copy(u, t)
		for n := 2; n <= iterations; n++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(u[:0])
			for i := range u {
				t[i] ^= u[i]
			}
		}
	}
	return derived[:keyLength]
}

// EncodePasswordHash produces the "pbkdf2_sha256$iterations$salt$hash" value
// expected in WEB_PASSWORD_HASH.
func EncodePasswordHash(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := pbkdf2SHA256([]byte(password), salt, passwordIterations, passwordKeyLength)
	return "pbkdf2_sha256$" + strconv.Itoa(passwordIterations) + "$" +
		base64.RawStdEncoding.EncodeToString(salt) + "$" +
		base64.RawStdEncoding.EncodeToString(key), nil
}

type passwordHash struct {
	iterations int
	salt       []byte
	key        []byte
}

func parsePasswordHash(encoded string) (passwordHash, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2_sha256" {
		return passwordHash{}, errInvalidHash
	}
	iterations, err := strconv.Atoi(parts[1])
	if err != nil || iterations < 10_000 || iterations > 2_000_000 {
		return passwordHash{}, errInvalidHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil || len(salt) < 8 {
		return passwordHash{}, errInvalidHash
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil || len(key) < 16 {
		return passwordHash{}, errInvalidHash
	}
	return passwordHash{iterations: iterations, salt: salt, key: key}, nil
}

func (p passwordHash) verify(password string) bool {
	candidate := pbkdf2SHA256([]byte(password), p.salt, p.iterations, len(p.key))
	return subtle.ConstantTimeCompare(candidate, p.key) == 1
}

type sessionSigner struct {
	key []byte
}

func newSessionSigner(encoded string) (sessionSigner, error) {
	raw, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil || len(raw) < 32 {
		return sessionSigner{}, errors.New("WEB_SESSION_KEY must be base64 of at least 32 random bytes")
	}
	return sessionSigner{key: raw}, nil
}

func (s sessionSigner) sign(payload string) string {
	mac := hmac.New(sha256.New, s.key)
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s sessionSigner) issue(now time.Time) string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	payload := "v1|" + strconv.FormatInt(now.Add(sessionLifetime).Unix(), 10) + "|" +
		base64.RawURLEncoding.EncodeToString(buf)
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + s.sign(payload)
}

func (s sessionSigner) valid(value string, now time.Time) bool {
	encoded, signature, ok := strings.Cut(value, ".")
	if !ok {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return false
	}
	if !hmac.Equal([]byte(s.sign(string(payload))), []byte(signature)) {
		return false
	}
	parts := strings.Split(string(payload), "|")
	if len(parts) != 3 || parts[0] != "v1" {
		return false
	}
	expires, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return false
	}
	return now.Before(time.Unix(expires, 0))
}

func (h *Handler) authenticated(r *http.Request) bool {
	if !h.enabled {
		return false
	}
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return false
	}
	return h.signer.valid(cookie.Value, time.Now())
}

func (h *Handler) setSessionCookie(w http.ResponseWriter, r *http.Request) bool {
	value := h.signer.issue(time.Now())
	if value == "" {
		return false
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   int(sessionLifetime.Seconds()),
		HttpOnly: true,
		Secure:   requestIsHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
	return true
}

func (h *Handler) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

func requestIsHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func clientIP(r *http.Request) string {
	if forwarded := r.Header.Get("X-Real-IP"); net.ParseIP(forwarded) != nil {
		return forwarded
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

type failureWindow struct {
	count int
	reset time.Time
}

type loginLimiter struct {
	mu       sync.Mutex
	failures map[string]failureWindow
}

func (l *loginLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry, ok := l.failures[key]
	if !ok || now.After(entry.reset) {
		return true
	}
	return entry.count < maxLoginFailures
}

func (l *loginLimiter) fail(key string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.failures == nil || len(l.failures) > 4096 {
		l.failures = make(map[string]failureWindow)
	}
	entry, ok := l.failures[key]
	if !ok || now.After(entry.reset) {
		entry = failureWindow{reset: now.Add(loginFailWindow)}
	}
	entry.count++
	l.failures[key] = entry
}

func (l *loginLimiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.failures, key)
}
