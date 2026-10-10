package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"focus-memo/server/internal/store"
)

func (s *Server) patchMemo(w http.ResponseWriter, r *http.Request) {
	operation, ok := operationID(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		fail(w, 404, "not_found", "Memo not found")
		return
	}
	ct, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || ct != "application/json" {
		fail(w, 415, "unsupported_media_type", "Expected application/json")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		var max *http.MaxBytesError
		if errors.As(err, &max) {
			fail(w, 413, "body_too_large", "JSON body exceeds limit")
		} else {
			fail(w, 422, "invalid_request", "Invalid JSON")
		}
		return
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || len(fields) < 2 {
		fail(w, 422, "invalid_request", "baseVersion and changes required")
		return
	}
	for k, v := range fields {
		switch k {
		case "baseVersion", "content", "type", "priority", "status", "tags", "attachmentIds", "deleted":
		default:
			fail(w, 422, "invalid_request", "Unknown field")
			return
		}
		if string(v) == "null" {
			fail(w, 422, "invalid_request", "Null fields are not accepted")
			return
		}
	}
	var patch store.PatchMemoRequest
	if json.Unmarshal(data, &patch) != nil || !validPatch(patch) {
		fail(w, 422, "invalid_request", "Invalid memo fields or baseVersion")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	receipt, err := s.repo.ChangeMemo(ctx, operation, id, patch, false, false)
	if err != nil {
		storeError(w, err)
		return
	}
	respond(w, 200, receipt)
}
func validPatch(p store.PatchMemoRequest) bool {
	if !store.ValidVersion(p.BaseVersion) {
		return false
	}
	if p.Type != nil && *p.Type != "text" && *p.Type != "image" {
		return false
	}
	if p.Priority != nil && *p.Priority != "important" && *p.Priority != "unimportant" {
		return false
	}
	if p.Status != nil && *p.Status != "not_started" && *p.Status != "in_progress" && *p.Status != "completed" {
		return false
	}
	if p.Deleted != nil && *p.Deleted {
		return false
	}
	if p.AttachmentIDs != nil {
		for _, id := range *p.AttachmentIDs {
			if !uuidPattern.MatchString(id) {
				return false
			}
		}
	}
	return true
}
func (s *Server) deleteMemo(w http.ResponseWriter, r *http.Request) {
	operation, ok := operationID(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		fail(w, 404, "not_found", "Memo not found")
		return
	}
	q := r.URL.Query()
	permanent := q.Get("permanent") == "true"
	for k, v := range q {
		if len(v) != 1 || (k != "baseVersion" && k != "permanent") {
			fail(w, 422, "invalid_request", "Invalid query")
			return
		}
	}
	if !store.ValidVersion(q.Get("baseVersion")) || (q.Has("permanent") && q.Get("permanent") != "true" && q.Get("permanent") != "false") {
		fail(w, 422, "invalid_request", "Invalid baseVersion or permanent flag")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	receipt, err := s.repo.ChangeMemo(ctx, operation, id, store.PatchMemoRequest{BaseVersion: q.Get("baseVersion")}, true, permanent)
	if err != nil {
		storeError(w, err)
		return
	}
	respond(w, 200, receipt)
}
func (s *Server) listMemos(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.MemoFilter{Status: q.Get("status"), Priority: q.Get("priority"), Tag: q.Get("tag"), Query: q.Get("q"), Deleted: q.Get("deleted") == "true", Limit: 100}
	valid := true
	for k, v := range q {
		if len(v) != 1 {
			valid = false
		}
		switch k {
		case "status", "priority", "tag", "q", "deleted", "limit", "offset":
		default:
			valid = false
		}
	}
	if f.Status != "" && f.Status != "not_started" && f.Status != "in_progress" && f.Status != "completed" {
		valid = false
	}
	if f.Priority != "" && f.Priority != "important" && f.Priority != "unimportant" {
		valid = false
	}
	if q.Has("deleted") && q.Get("deleted") != "true" && q.Get("deleted") != "false" {
		valid = false
	}
	if len(f.Tag) > 1024 || len(f.Query) > 4096 {
		valid = false
	}
	if q.Has("limit") {
		n, e := strconv.Atoi(q.Get("limit"))
		if e != nil || n < 1 || n > 500 {
			valid = false
		} else {
			f.Limit = n
		}
	}
	if q.Has("offset") {
		n, e := strconv.Atoi(q.Get("offset"))
		if e != nil || n < 0 || n > 1000000 {
			valid = false
		} else {
			f.Offset = n
		}
	}
	if !valid {
		fail(w, 422, "invalid_request", "Invalid filters")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	memos, err := s.repo.ListMemos(ctx, f)
	if err != nil {
		storeError(w, err)
		return
	}
	respond(w, 200, map[string]any{"memos": memos})
}
func (s *Server) snapshot(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	snapshot, err := s.repo.Snapshot(ctx)
	if err != nil {
		storeError(w, err)
		return
	}
	respond(w, 200, snapshot)
}
