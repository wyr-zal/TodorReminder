package httpapi

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"focus-memo/server/internal/attachments"
	"focus-memo/server/internal/config"
	"focus-memo/server/internal/store"
)

type Repository interface {
	ChangeMemo(context.Context, string, string, store.PatchMemoRequest, bool, bool) (store.Receipt, error)
	ListMemos(context.Context, store.MemoFilter) ([]store.Memo, error)
	Snapshot(context.Context) (store.Snapshot, error)
	Changes(context.Context, uint64, *uint64, int) (store.ChangePage, error)
	Health(context.Context) error
	Meta(context.Context) (store.Meta, error)
	CreateMemo(context.Context, string, store.CreateMemoRequest) (store.Receipt, error)
	GetMemo(context.Context, string) (store.Memo, error)
	SaveAttachment(context.Context, string, store.Attachment) (store.Attachment, error)
	GetAttachment(context.Context, string) (store.Attachment, error)
}

type Server struct {
	cfg       config.Config
	repo      Repository
	files     *attachments.Storage
	mux       *http.ServeMux
	tokenHash [32]byte
}

func New(cfg config.Config, repo Repository, files *attachments.Storage) (*Server, error) {
	if len(cfg.Token) < 32 || repo == nil || files == nil {
		return nil, errors.New("invalid HTTP server configuration")
	}
	s := &Server{cfg: cfg, repo: repo, files: files, mux: http.NewServeMux(), tokenHash: sha256.Sum256([]byte(cfg.Token))}
	s.mux.HandleFunc("GET /healthz", s.health)
	s.mux.HandleFunc("GET /api/v1/meta", s.meta)
	s.mux.HandleFunc("POST /api/v1/memos", s.createMemo)
	s.mux.HandleFunc("GET /api/v1/memos", s.listMemos)
	s.mux.HandleFunc("PATCH /api/v1/memos/{id}", s.patchMemo)
	s.mux.HandleFunc("DELETE /api/v1/memos/{id}", s.deleteMemo)
	s.mux.HandleFunc("GET /api/v1/sync/snapshot", s.snapshot)
	s.mux.HandleFunc("GET /api/v1/sync/changes", s.changes)
	s.mux.HandleFunc("GET /api/v1/memos/{id}", s.getMemo)
	s.mux.HandleFunc("POST /api/v1/attachments", s.uploadAttachment)
	s.mux.HandleFunc("GET /api/v1/attachments/{id}", s.getAttachment)
	return s, nil
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Path != "/healthz" {
		auth := r.Header.Get("Authorization")
		validScheme := strings.HasPrefix(auth, "Bearer ")
		digest := sha256.Sum256([]byte(strings.TrimPrefix(auth, "Bearer ")))
		if !validScheme || subtle.ConstantTimeCompare(digest[:], s.tokenHash[:]) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			fail(w, 401, "unauthorized", "Authentication required")
			return
		}
	}
	if expected := r.Header.Get("X-Focus-Dataset-ID"); expected != "" {
		if !uuidPattern.MatchString(expected) {
			fail(w, 422, "invalid_request", "Invalid dataset identifier")
			return
		}
		r = r.WithContext(store.WithExpectedDataset(r.Context(), expected))
	}
	s.mux.ServeHTTP(w, r)
}
func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, status int, code, message string) {
	respond(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.repo.Health(ctx); err != nil {
		fail(w, 503, "unavailable", "Service unavailable")
		return
	}
	respond(w, 200, map[string]string{"status": "ok"})
}
func (s *Server) meta(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	meta, err := s.repo.Meta(ctx)
	if err != nil || meta.SchemaVersion != 1 {
		fail(w, 503, "unavailable", "Service unavailable")
		return
	}
	respond(w, 200, meta)
}
