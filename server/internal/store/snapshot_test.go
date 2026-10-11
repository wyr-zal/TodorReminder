package store

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestSnapshotIncludesDatasetAndCursorFromSameTransaction(t *testing.T) {
	for _, bound := range []bool{false, true} {
		t.Run(map[bool]string{false: "unbound", true: "bound"}[bound], func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			dataset := "11111111-1111-4111-8111-111111111111"
			ctx := context.Background()
			if bound {
				ctx = WithExpectedDataset(ctx, dataset)
			}
			mock.ExpectBegin()
			mock.ExpectQuery("SELECT dataset_id, schema_version FROM service_meta").WillReturnRows(sqlmock.NewRows([]string{"dataset_id", "schema_version"}).AddRow(dataset, 1))
			mock.ExpectQuery("SELECT sequence FROM sync_change_state").WillReturnRows(sqlmock.NewRows([]string{"sequence"}).AddRow(uint64(7)))
			mock.ExpectQuery("SELECT .* FROM memos").WillReturnRows(sqlmock.NewRows([]string{"id"}))
			mock.ExpectQuery("SELECT .* FROM attachments").WillReturnRows(sqlmock.NewRows([]string{"id"}))
			mock.ExpectCommit()
			snapshot, err := New(db).Snapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if snapshot.DatasetID != dataset || snapshot.SchemaVersion != 1 || snapshot.ChangeCursor != "7" || !snapshot.Complete || snapshot.TotalRows != 0 || snapshot.Memos == nil || snapshot.Attachments == nil {
				t.Fatalf("invalid bootstrap snapshot: %+v", snapshot)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSnapshotRejectsChangedDatasetBeforeReadingMemos(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT dataset_id, schema_version FROM service_meta").WillReturnRows(sqlmock.NewRows([]string{"dataset_id", "schema_version"}).AddRow("22222222-2222-4222-8222-222222222222", 1))
	mock.ExpectRollback()
	ctx := WithExpectedDataset(context.Background(), "11111111-1111-4111-8111-111111111111")
	if _, err = New(db).Snapshot(ctx); !errors.Is(err, ErrDatasetMismatch) {
		t.Fatalf("wanted dataset mismatch, got %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
