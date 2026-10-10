package store

import (
	"context"
	"errors"
	"github.com/DATA-DOG/go-sqlmock"
	"testing"
	"time"
)

func TestRead(t *testing.T) {
	db, mock, _ := sqlmock.New(sqlmock.MonitorPingsOption(true))
	defer db.Close()
	s := New(db)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)
	mock.ExpectPing()
	if err := s.Health(ctx); err != nil {
		t.Fatal(err)
	}
	mock.ExpectQuery("SELECT dataset_id, schema_version FROM service_meta").WillReturnRows(sqlmock.NewRows([]string{"dataset_id", "schema_version"}).AddRow("11111111-1111-4111-8111-111111111111", 1))
	meta, err := s.Meta(ctx)
	if err != nil || meta.SchemaVersion != 1 {
		t.Fatalf("bad meta: %+v %v", meta, err)
	}
	columns := []string{"id", "content", "type", "priority", "status", "tags", "attachment_ids", "created_at", "updated_at", "completed_at", "device_id", "version", "deleted", "purged"}
	mock.ExpectQuery("SELECT id, content").WithArgs("memo-id").WillReturnRows(sqlmock.NewRows(columns).AddRow("memo-id", "hello", "text", "unimportant", "not_started", "[]", "[]", now, now, nil, "api", "9007199254740993", false, false))
	memo, err := s.GetMemo(ctx, "memo-id")
	if err != nil || memo.Version != "9007199254740993" || memo.Tags == nil {
		t.Fatalf("bad memo: %+v %v", memo, err)
	}
	mock.ExpectQuery("SELECT id, content").WithArgs("missing").WillReturnRows(sqlmock.NewRows(columns))
	if _, err = s.GetMemo(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("not-found mapping: %v", err)
	}
	mock.ExpectQuery("SELECT id, storage_key").WithArgs("file-id").WillReturnRows(sqlmock.NewRows([]string{"id", "storage_key", "mime_type", "size_bytes", "sha256", "created_at"}).AddRow("file-id", "key", "image/png", 123, "digest", now))
	att, err := s.GetAttachment(ctx, "file-id")
	if err != nil || att.StorageKey != "key" {
		t.Fatalf("bad attachment: %+v %v", att, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGetAttachmentRejectsDatasetMismatch(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := New(db)
	ctx := WithExpectedDataset(context.Background(), "11111111-1111-4111-8111-111111111111")

	mock.ExpectBegin()
	mock.ExpectQuery("SELECT dataset_id FROM service_meta WHERE id = 1 LOCK IN SHARE MODE").WillReturnRows(sqlmock.NewRows([]string{"dataset_id"}).AddRow("22222222-2222-4222-8222-222222222222"))
	mock.ExpectRollback()

	if _, err := s.GetAttachment(ctx, "file-id"); !errors.Is(err, ErrDatasetMismatch) {
		t.Fatalf("dataset mismatch error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
