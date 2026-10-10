package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"focus-memo/server/internal/store"
)

func parseChangeSequence(value string) (uint64, bool) {
	if value == "" {
		return 0, false
	}
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return 0, false
		}
	}
	sequence, err := strconv.ParseUint(value, 10, 64)
	return sequence, err == nil
}

func (s *Server) changes(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	for key, values := range q {
		if len(values) != 1 || (key != "cursor" && key != "through" && key != "limit") {
			fail(w, 422, "invalid_request", "Invalid change cursor query")
			return
		}
	}
	if !q.Has("cursor") {
		fail(w, 422, "invalid_request", "A change cursor is required")
		return
	}
	after, ok := parseChangeSequence(q.Get("cursor"))
	if !ok {
		fail(w, 422, "invalid_request", "Invalid change cursor")
		return
	}
	var through *uint64
	if q.Has("through") {
		value, valid := parseChangeSequence(q.Get("through"))
		if !valid {
			fail(w, 422, "invalid_request", "Invalid change high-water mark")
			return
		}
		through = &value
	}
	limit := store.MaxChangePageSize
	if q.Has("limit") {
		value, err := strconv.Atoi(q.Get("limit"))
		if err != nil || value < 1 || value > store.MaxChangePageSize {
			fail(w, 422, "invalid_request", "Invalid change page size")
			return
		}
		limit = value
	}
	if r.Header.Get("X-Focus-Dataset-ID") == "" {
		fail(w, 422, "invalid_request", "X-Focus-Dataset-ID is required for change sync")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	page, err := s.repo.Changes(ctx, after, through, limit)
	if err != nil {
		storeError(w, err)
		return
	}
	respond(w, 200, page)
}
