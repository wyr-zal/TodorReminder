package store

import (
	"context"
	"github.com/DATA-DOG/go-sqlmock"
	"testing"
)

func TestSaveAttachment(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	s := New(db)
	mock.ExpectBegin()
	mock.ExpectExec("INSERT INTO mutation_receipts").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("INSERT INTO attachments").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("UPDATE mutation_receipts").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	a, err := s.SaveAttachment(context.Background(), "upload-op", Attachment{StorageKey: "storage-key", MIME: "image/png", Size: 80, SHA256: "hash"})
	if err != nil || a.ID == "" || a.MIME != "image/png" || a.Size != 80 {
		t.Fatalf("bad metadata save: %+v %v", a, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
