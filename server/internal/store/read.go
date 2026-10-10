package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

func (s *MySQL) Health(ctx context.Context) error { return s.db.PingContext(ctx) }
func (s *MySQL) Meta(ctx context.Context) (Meta, error) {
	var m Meta
	err := s.db.QueryRowContext(ctx, `SELECT dataset_id, schema_version FROM service_meta WHERE id = 1`).Scan(&m.DatasetID, &m.SchemaVersion)
	return m, err
}

const memoColumns = "id, content, type, priority, status, tags, attachment_ids, created_at, updated_at, completed_at, device_id, version, deleted, purged"

type rowScanner interface{ Scan(...any) error }

func scanMemo(row rowScanner) (Memo, error) {
	var m Memo
	var tags, ids []byte
	var created, updated time.Time
	var completed sql.NullTime
	err := row.Scan(&m.ID, &m.Content, &m.Type, &m.Priority, &m.Status, &tags, &ids, &created, &updated, &completed, &m.DeviceID, &m.Version, &m.Deleted, &m.Purged)
	if err != nil {
		return m, err
	}
	if err = json.Unmarshal(tags, &m.Tags); err != nil {
		return m, err
	}
	if err = json.Unmarshal(ids, &m.AttachmentIDs); err != nil {
		return m, err
	}
	m.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	m.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	if completed.Valid {
		v := completed.Time.UTC().Format(time.RFC3339Nano)
		m.CompletedAt = &v
	}
	if m.Tags == nil {
		m.Tags = []string{}
	}
	if m.AttachmentIDs == nil {
		m.AttachmentIDs = []string{}
	}
	return m, nil
}
func (s *MySQL) GetMemo(ctx context.Context, id string) (Memo, error) {
	m, err := scanMemo(s.db.QueryRowContext(ctx, "SELECT "+memoColumns+" FROM memos WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}

type attachmentQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func scanAttachment(row rowScanner) (Attachment, error) {
	var a Attachment
	var created time.Time
	err := row.Scan(&a.ID, &a.StorageKey, &a.MIME, &a.Size, &a.SHA256, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	if err != nil {
		return a, err
	}
	a.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	return a, nil
}

func getAttachment(ctx context.Context, queryer attachmentQueryer, id string) (Attachment, error) {
	return scanAttachment(queryer.QueryRowContext(ctx, `SELECT id, storage_key, mime_type, size_bytes, sha256, created_at FROM attachments WHERE id = ? AND ready = 1`, id))
}

func (s *MySQL) GetAttachment(ctx context.Context, id string) (Attachment, error) {
	if _, bound := ctx.Value(datasetContextKey{}).(string); !bound {
		return getAttachment(ctx, s.db, id)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Attachment{}, err
	}
	defer tx.Rollback()
	var actual string
	if err = tx.QueryRowContext(ctx, `SELECT dataset_id FROM service_meta WHERE id = 1 LOCK IN SHARE MODE`).Scan(&actual); err != nil {
		return Attachment{}, err
	}
	if err = CheckExpectedDataset(ctx, actual); err != nil {
		return Attachment{}, err
	}
	attachment, err := getAttachment(ctx, tx, id)
	if err != nil {
		return Attachment{}, err
	}
	if err = tx.Commit(); err != nil {
		return Attachment{}, err
	}
	return attachment, nil
}
