package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"focus-memo/server/internal/attachments"
	"focus-memo/server/internal/store"
)

func (s *Server) uploadAttachment(w http.ResponseWriter, r *http.Request) {
	operation, ok := operationID(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes+(64<<10))
	reader, err := r.MultipartReader()
	if err != nil {
		fail(w, 415, "unsupported_media_type", "Expected multipart/form-data")
		return
	}
	part, err := reader.NextPart()
	if err != nil {
		fail(w, 422, "invalid_request", "One image file is required")
		return
	}
	defer part.Close()
	if part.FormName() != "file" || part.FileName() == "" {
		fail(w, 422, "invalid_request", "Only the file form field is accepted")
		return
	}
	staged, err := s.files.Stage(r.Context(), operation, part)
	if err != nil {
		imageError(w, err)
		return
	}
	defer staged.Close()
	if _, err = reader.NextPart(); err != io.EOF {
		var max *http.MaxBytesError
		if errors.As(err, &max) {
			fail(w, 413, "body_too_large", "Upload exceeds request limit")
		} else {
			fail(w, 422, "invalid_request", "Exactly one file and no other fields are allowed")
		}
		return
	}
	if err = staged.Commit(); err != nil {
		fail(w, 503, "storage_unavailable", "Image storage unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	a, err := s.repo.SaveAttachment(ctx, operation, store.Attachment{StorageKey: staged.Key, MIME: staged.MIME, Size: staged.Size, SHA256: staged.SHA256})
	if err != nil {
		storeError(w, err)
		return
	}
	respond(w, 201, a)
}
func imageError(w http.ResponseWriter, err error) {
	var max *http.MaxBytesError
	switch {
	case errors.Is(err, attachments.ErrTooLarge), errors.Is(err, attachments.ErrPixelLimit), errors.As(err, &max):
		fail(w, 413, "image_too_large", "Image exceeds configured size or pixel limit")
	case errors.Is(err, attachments.ErrInvalidImage):
		fail(w, 415, "invalid_image", "Invalid or unsupported image")
	case errors.Is(err, io.ErrUnexpectedEOF):
		fail(w, 422, "invalid_request", "Incomplete upload")
	default:
		fail(w, 503, "storage_unavailable", "Image storage unavailable; retry with the same Idempotency-Key")
	}
}
func (s *Server) getAttachment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		fail(w, 404, "not_found", "Attachment not found")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	a, err := s.repo.GetAttachment(ctx, id)
	if err != nil {
		storeError(w, err)
		return
	}
	f, err := s.files.Open(a.StorageKey)
	if err != nil {
		fail(w, 503, "storage_unavailable", "Image unavailable")
		return
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || stat.Size() != a.Size {
		fail(w, 503, "storage_unavailable", "Image integrity check failed")
		return
	}
	w.Header().Set("Content-Type", a.MIME)
	w.Header().Set("ETag", `"`+a.SHA256+`"`)
	http.ServeContent(w, r, "", stat.ModTime(), f)
}
