package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestChangeMemoInfersImageTypeWhenAttachmentsAreAdded(t *testing.T) {
	const memoID = "11111111-1111-4111-8111-111111111111"
	const attachmentID = "33333333-3333-4333-8333-333333333333"
	const operationID = "44444444-4444-4444-8444-444444444444"
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	created := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	updated := created.Add(time.Minute)
	columns := []string{"id", "content", "type", "priority", "status", "tags", "attachment_ids", "created_at", "updated_at", "completed_at", "device_id", "version", "deleted", "purged"}
	mock.ExpectBegin()
	mock.ExpectExec("INSERT INTO mutation_receipts").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectQuery("SELECT id, content, type, priority, status, tags, attachment_ids").
		WithArgs(memoID).
		WillReturnRows(sqlmock.NewRows(columns).AddRow(memoID, "memo", "text", "unimportant", "not_started", []byte("[]"), []byte("[]"), created, updated, nil, "fixture", "1", false, false))
	mock.ExpectQuery("SELECT id FROM attachments WHERE id = ").
		WithArgs(attachmentID).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(attachmentID))
	mock.ExpectExec("UPDATE memos SET content=").
		WithArgs("memo", "image", "unimportant", "not_started", "[]", "[\""+attachmentID+"\"]", sqlmock.AnyArg(), nil, "fixture", "2", false, false, memoID).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT sequence FROM sync_change_state").WillReturnRows(sqlmock.NewRows([]string{"sequence"}).AddRow(uint64(0)))
	mock.ExpectExec("UPDATE sync_change_state SET sequence = ").WithArgs(uint64(1)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO memo_change_cursor").WithArgs(memoID, uint64(1)).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("UPDATE mutation_receipts SET result_json").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	ids := []string{attachmentID}
	receipt, err := New(db).ChangeMemo(context.Background(), operationID, memoID, PatchMemoRequest{BaseVersion: "1", AttachmentIDs: &ids}, false, false)
	if err != nil || receipt.AppliedVersion != "2" {
		t.Fatalf("attachment patch failed: receipt=%+v err=%v", receipt, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestChangeMemoRejectsTextTypeWithAttachments(t *testing.T) {
	const memoID = "11111111-1111-4111-8111-111111111111"
	const attachmentID = "33333333-3333-4333-8333-333333333333"
	const operationID = "44444444-4444-4444-8444-444444444445"
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	created := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	columns := []string{"id", "content", "type", "priority", "status", "tags", "attachment_ids", "created_at", "updated_at", "completed_at", "device_id", "version", "deleted", "purged"}
	mock.ExpectBegin()
	mock.ExpectExec("INSERT INTO mutation_receipts").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectQuery("SELECT id, content, type, priority, status, tags, attachment_ids").
		WithArgs(memoID).
		WillReturnRows(sqlmock.NewRows(columns).AddRow(memoID, "memo", "text", "unimportant", "not_started", []byte("[]"), []byte("[]"), created, created, nil, "fixture", "1", false, false))
	mock.ExpectRollback()

	ids := []string{attachmentID}
	typeText := "text"
	_, err = New(db).ChangeMemo(context.Background(), operationID, memoID, PatchMemoRequest{BaseVersion: "1", Type: &typeText, AttachmentIDs: &ids}, false, false)
	if !errors.Is(err, ErrInvalidMemo) {
		t.Fatalf("expected inconsistent type to be rejected, got %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
