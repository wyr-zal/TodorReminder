package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"time"

	"focus-memo/server/internal/store"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func operationID(w http.ResponseWriter, r *http.Request) (string, bool) {
	v := r.Header.Get("Idempotency-Key")
	if !uuidPattern.MatchString(v) {
		fail(w, 422, "invalid_request", "A UUID Idempotency-Key is required")
		return "", false
	}
	return v, true
}
func normalize(input *store.CreateMemoRequest) bool {
	if len(input.DeviceID) > 128 {
		return false
	}
	for _, stamp := range []*string{input.CreatedAt, input.UpdatedAt, input.CompletedAt} {
		if stamp != nil {
			if _, err := time.Parse(time.RFC3339Nano, *stamp); err != nil {
				return false
			}
		}
	}
	if input.CompletedAt != nil && input.Status != "completed" {
		return false
	}
	if input.ID != "" && !uuidPattern.MatchString(input.ID) {
		return false
	}
	if input.Priority == "" {
		input.Priority = "unimportant"
	}
	if input.Priority != "unimportant" && input.Priority != "important" {
		return false
	}
	if input.Status == "" {
		input.Status = "not_started"
	}
	if input.Status != "not_started" && input.Status != "in_progress" && input.Status != "completed" {
		return false
	}
	if input.Tags == nil {
		input.Tags = []string{}
	}
	if input.AttachmentIDs == nil {
		input.AttachmentIDs = []string{}
	}
	for _, id := range input.AttachmentIDs {
		if !uuidPattern.MatchString(id) {
			return false
		}
	}
	if input.Type == "" {
		input.Type = "text"
		if len(input.AttachmentIDs) > 0 {
			input.Type = "image"
		}
	}
	if input.Type != "text" && input.Type != "image" {
		return false
	}
	return strings.TrimSpace(input.Content) != "" || len(input.AttachmentIDs) > 0
}
func (s *Server) createMemo(w http.ResponseWriter, r *http.Request) {
	operation, ok := operationID(w, r)
	if !ok {
		return
	}
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		fail(w, 415, "unsupported_media_type", "Expected application/json")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input store.CreateMemoRequest
	err = decoder.Decode(&input)
	if err == nil {
		var extra any
		if e := decoder.Decode(&extra); e != io.EOF {
			if e == nil {
				e = errors.New("multiple JSON values")
			}
			err = e
		}
	}
	if err != nil {
		var max *http.MaxBytesError
		if errors.As(err, &max) {
			fail(w, 413, "body_too_large", "JSON body exceeds limit")
		} else {
			fail(w, 422, "invalid_request", "Invalid JSON request")
		}
		return
	}
	if !normalize(&input) {
		fail(w, 422, "invalid_request", "Invalid memo fields")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	receipt, err := s.repo.CreateMemo(ctx, operation, input)
	if err != nil {
		storeError(w, err)
		return
	}
	respond(w, 201, receipt)
}
func (s *Server) getMemo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		fail(w, 404, "not_found", "Memo not found")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	memo, err := s.repo.GetMemo(ctx, id)
	if err != nil {
		storeError(w, err)
		return
	}
	respond(w, 200, memo)
}
func storeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrDatasetMismatch):
		fail(w, 409, "dataset_mismatch", "Server dataset changed; no mutation applied")
	case errors.Is(err, store.ErrVersionConflict):
		fail(w, 409, "version_conflict", "Server version changed")
	case errors.Is(err, store.ErrPurged):
		fail(w, 409, "memo_purged", "Memo permanently deleted")
	case errors.Is(err, store.ErrInvalidTransition):
		fail(w, 409, "invalid_transition", "Delete the memo before purging")
	case errors.Is(err, store.ErrInvalidMemo), errors.Is(err, store.ErrInvalidChangeCursor):
		fail(w, 422, "invalid_request", "Invalid memo or change cursor")
	case errors.Is(err, store.ErrSnapshotTooLarge):
		fail(w, 413, "snapshot_too_large", "Metadata response exceeds limit")
	case errors.Is(err, store.ErrNotFound):
		fail(w, 404, "not_found", "Not found")
	case errors.Is(err, store.ErrIdempotencyMismatch):
		fail(w, 409, "idempotency_mismatch", "Idempotency-Key was reused for a different request")
	case errors.Is(err, store.ErrMemoExists):
		fail(w, 409, "memo_exists", "Memo ID already exists")
	case errors.Is(err, store.ErrAttachmentNotReady):
		fail(w, 422, "attachment_not_ready", "An attachment is missing or not ready")
	default:
		fail(w, 503, "unavailable", "Service unavailable; retry with the same Idempotency-Key")
	}
}
