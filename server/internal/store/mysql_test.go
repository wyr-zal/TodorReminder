package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/go-sql-driver/mysql"
)

func TestCreateMemo(t *testing.T) {
	input := CreateMemoRequest{ID: "11111111-1111-4111-8111-111111111111", Content: "private memo text", Type: "text", Priority: "unimportant", Status: "not_started", Tags: []string{}, AttachmentIDs: []string{}}
	op := "22222222-2222-4222-8222-222222222222"
	t.Run("commit with receipt", func(t *testing.T) {
		db, mock, err := sqlmock.New()
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		s := New(db)
		mock.ExpectBegin()
		mock.ExpectExec("INSERT INTO mutation_receipts").WillReturnResult(sqlmock.NewResult(1, 1))
		mock.ExpectExec("INSERT INTO memos").WillReturnResult(sqlmock.NewResult(1, 1))
		mock.ExpectQuery("SELECT sequence FROM sync_change_state WHERE id = 1 FOR UPDATE").WillReturnRows(sqlmock.NewRows([]string{"sequence"}).AddRow(0))
		mock.ExpectExec("UPDATE sync_change_state SET sequence = \\? WHERE id = 1").WithArgs(uint64(1)).WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectExec("INSERT INTO memo_change_cursor").WithArgs(input.ID, uint64(1)).WillReturnResult(sqlmock.NewResult(1, 1))
		mock.ExpectExec("UPDATE mutation_receipts").WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectCommit()
		got, err := s.CreateMemo(context.Background(), op, input)
		if err != nil {
			t.Fatal(err)
		}
		if got.ID != input.ID || got.AppliedVersion != "1" || got.CompletedAt != nil {
			t.Fatalf("bad receipt: %+v", got)
		}
		data, _ := json.Marshal(got)
		var body map[string]any
		json.Unmarshal(data, &body)
		if _, ok := body["content"]; ok {
			t.Fatal("receipt retained memo content")
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("rollback does not commit receipt", func(t *testing.T) {
		db, mock, _ := sqlmock.New()
		defer db.Close()
		s := New(db)
		mock.ExpectBegin()
		mock.ExpectExec("INSERT INTO mutation_receipts").WillReturnResult(sqlmock.NewResult(1, 1))
		mock.ExpectExec("INSERT INTO memos").WillReturnError(errors.New("write failed"))
		mock.ExpectRollback()
		if _, err := s.CreateMemo(context.Background(), op, input); err == nil {
			t.Fatal("expected failure")
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
	})
	for _, mismatch := range []bool{false, true} {
		t.Run(map[bool]string{false: "idempotent retry", true: "changed payload"}[mismatch], func(t *testing.T) {
			db, mock, _ := sqlmock.New()
			defer db.Close()
			s := New(db)
			hash, _ := requestHash("memo.create", input)
			mock.ExpectBegin()
			mock.ExpectExec("INSERT INTO mutation_receipts").WillReturnError(&mysql.MySQLError{Number: 1062})
			mock.ExpectRollback()
			mock.ExpectQuery("SELECT request_hash, kind, result_json FROM mutation_receipts").WithArgs(op).WillReturnRows(sqlmock.NewRows([]string{"request_hash", "kind", "result_json"}).AddRow(hash, "memo.create", `{"id":"11111111-1111-4111-8111-111111111111","appliedVersion":"1"}`))
			req := input
			if mismatch {
				req.Content = "new text"
			}
			got, err := s.CreateMemo(context.Background(), op, req)
			if mismatch {
				if !errors.Is(err, ErrIdempotencyMismatch) {
					t.Fatalf("expected mismatch, got %v", err)
				}
			} else if err != nil || got.ID != input.ID {
				t.Fatalf("bad replay: %+v %v", got, err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
