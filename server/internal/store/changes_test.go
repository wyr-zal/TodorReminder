package store

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestChangesReturnsPageAndHighWater(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := New(db)
	ctx := WithExpectedDataset(context.Background(), "11111111-1111-4111-8111-111111111111")
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	memoColumns := []string{"sequence", "id", "content", "type", "priority", "status", "tags", "attachment_ids", "created_at", "updated_at", "completed_at", "device_id", "version", "deleted", "purged"}
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT dataset_id, schema_version FROM service_meta").WillReturnRows(sqlmock.NewRows([]string{"dataset_id", "schema_version"}).AddRow("11111111-1111-4111-8111-111111111111", 1))
	mock.ExpectQuery("SELECT sequence FROM sync_change_state").WillReturnRows(sqlmock.NewRows([]string{"sequence"}).AddRow(uint64(5)))
	mock.ExpectQuery("SELECT c.sequence").WithArgs(uint64(0), uint64(5), 2).WillReturnRows(sqlmock.NewRows(memoColumns).
		AddRow(uint64(2), "22222222-2222-4222-8222-222222222222", "latest", "text", "unimportant", "not_started", "[]", "[]", now, now, nil, "desktop", "2", false, false))
	mock.ExpectCommit()

	page, err := s.Changes(ctx, 0, nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	if page.Cursor != "5" || page.HighWater != "5" || page.HasMore || len(page.Changes) != 1 || page.Changes[0].Sequence != "2" || page.Changes[0].Memo.Content != "latest" {
		t.Fatalf("unexpected change page: %+v", page)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestChangesKeepsPageCursorWhenMoreRowsExist(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := New(db)
	ctx := WithExpectedDataset(context.Background(), "11111111-1111-4111-8111-111111111111")
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	memoColumns := []string{"sequence", "id", "content", "type", "priority", "status", "tags", "attachment_ids", "created_at", "updated_at", "completed_at", "device_id", "version", "deleted", "purged"}
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT dataset_id, schema_version FROM service_meta").WillReturnRows(sqlmock.NewRows([]string{"dataset_id", "schema_version"}).AddRow("11111111-1111-4111-8111-111111111111", 1))
	mock.ExpectQuery("SELECT sequence FROM sync_change_state").WillReturnRows(sqlmock.NewRows([]string{"sequence"}).AddRow(uint64(5)))
	mock.ExpectQuery("SELECT c.sequence").WithArgs(uint64(1), uint64(5), 2).WillReturnRows(sqlmock.NewRows(memoColumns).
		AddRow(uint64(2), "22222222-2222-4222-8222-222222222222", "first", "text", "unimportant", "not_started", "[]", "[]", now, now, nil, "desktop", "2", false, false).
		AddRow(uint64(4), "33333333-3333-4333-8333-333333333333", "second", "text", "unimportant", "not_started", "[]", "[]", now, now, nil, "desktop", "2", false, false))
	mock.ExpectCommit()

	through := uint64(5)
	page, err := s.Changes(ctx, 1, &through, 1)
	if err != nil {
		t.Fatal(err)
	}
	if page.Cursor != "2" || page.HighWater != "5" || !page.HasMore || len(page.Changes) != 1 {
		t.Fatalf("unexpected paged cursor: %+v", page)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestChangesRequiresDatasetAndValidCursor(t *testing.T) {
	s := New(nil)
	if _, err := s.Changes(context.Background(), 0, nil, 1); err != ErrDatasetMismatch {
		t.Fatalf("unbound changes request: %v", err)
	}
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s = New(db)
	ctx := WithExpectedDataset(context.Background(), "11111111-1111-4111-8111-111111111111")
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT dataset_id, schema_version FROM service_meta").WillReturnRows(sqlmock.NewRows([]string{"dataset_id", "schema_version"}).AddRow("11111111-1111-4111-8111-111111111111", 1))
	mock.ExpectQuery("SELECT sequence FROM sync_change_state").WillReturnRows(sqlmock.NewRows([]string{"sequence"}).AddRow(uint64(3)))
	mock.ExpectRollback()
	if _, err := s.Changes(ctx, 4, nil, 1); err != ErrInvalidChangeCursor {
		t.Fatalf("cursor beyond high-water accepted: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
