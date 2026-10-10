package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/go-sql-driver/mysql"
)

type MySQL struct{ db *sql.DB }

func New(db *sql.DB) *MySQL { return &MySQL{db: db} }

func newID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
func requestHash(kind string, payload any) (string, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(append([]byte(kind+":"), b...))
	return hex.EncodeToString(h[:]), nil
}
func duplicate(err error) bool {
	var e *mysql.MySQLError
	return errors.As(err, &e) && e.Number == 1062
}

func recordMemoChange(ctx context.Context, tx *sql.Tx, id string) error {
	var sequence uint64
	if err := tx.QueryRowContext(ctx, `SELECT sequence FROM sync_change_state WHERE id = 1 FOR UPDATE`).Scan(&sequence); err != nil {
		return err
	}
	if sequence == ^uint64(0) {
		return ErrChangeSequenceExhausted
	}
	sequence++
	if _, err := tx.ExecContext(ctx, `UPDATE sync_change_state SET sequence = ? WHERE id = 1`, sequence); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO memo_change_cursor (memo_id, sequence) VALUES (?, ?) ON DUPLICATE KEY UPDATE sequence = VALUES(sequence)`, id, sequence)
	return err
}

// The claim and result commit with the data write, never independently.
func (s *MySQL) mutate(ctx context.Context, operation, kind, hash string, write func(*sql.Tx) (any, error)) ([]byte, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if expected, ok := ctx.Value(datasetContextKey{}).(string); ok {
		var actual string
		if err = tx.QueryRowContext(ctx, `SELECT dataset_id FROM service_meta WHERE id = 1 LOCK IN SHARE MODE`).Scan(&actual); err != nil {
			return nil, err
		}
		if actual != expected {
			return nil, ErrDatasetMismatch
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO mutation_receipts (operation_id, request_hash, kind, result_json) VALUES (?, ?, ?, '{}')`, operation, hash, kind)
	if duplicate(err) {
		if err = tx.Rollback(); err != nil {
			return nil, err
		}
		var oldHash, oldKind string
		var result []byte
		err = s.db.QueryRowContext(ctx, `SELECT request_hash, kind, result_json FROM mutation_receipts WHERE operation_id = ?`, operation).Scan(&oldHash, &oldKind, &result)
		if err != nil {
			return nil, err
		}
		if oldHash != hash || oldKind != kind {
			return nil, ErrIdempotencyMismatch
		}
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	value, err := write(tx)
	if err != nil {
		return nil, err
	}
	result, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE mutation_receipts SET result_json = ? WHERE operation_id = ?`, string(result), operation); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *MySQL) CreateMemo(ctx context.Context, operation string, input CreateMemoRequest) (Receipt, error) {
	var receipt Receipt
	hash, err := requestHash("memo.create", input)
	if err != nil {
		return receipt, err
	}
	raw, err := s.mutate(ctx, operation, "memo.create", hash, func(tx *sql.Tx) (any, error) {
		for _, id := range input.AttachmentIDs {
			var found string
			err := tx.QueryRowContext(ctx, `SELECT id FROM attachments WHERE id = ? AND ready = 1 LOCK IN SHARE MODE`, id).Scan(&found)
			if errors.Is(err, sql.ErrNoRows) {
				return nil, ErrAttachmentNotReady
			}
			if err != nil {
				return nil, err
			}
		}
		id := input.ID
		if id == "" {
			id = newID()
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		created, updated := now, now
		if input.CreatedAt != nil {
			created, err = time.Parse(time.RFC3339Nano, *input.CreatedAt)
			if err != nil {
				return nil, ErrInvalidMemo
			}
			created = created.UTC().Truncate(time.Millisecond)
		}
		if input.UpdatedAt != nil {
			updated, err = time.Parse(time.RFC3339Nano, *input.UpdatedAt)
			if err != nil {
				return nil, ErrInvalidMemo
			}
			updated = updated.UTC().Truncate(time.Millisecond)
		}
		result := Receipt{ID: id, AppliedVersion: "1", CreatedAt: created.Format(time.RFC3339Nano), UpdatedAt: updated.Format(time.RFC3339Nano)}
		var completed any
		if input.Status == "completed" {
			completedTime := now
			if input.CompletedAt != nil {
				completedTime, err = time.Parse(time.RFC3339Nano, *input.CompletedAt)
				if err != nil {
					return nil, ErrInvalidMemo
				}
				completedTime = completedTime.UTC().Truncate(time.Millisecond)
			}
			stamp := completedTime.Format(time.RFC3339Nano)
			result.CompletedAt = &stamp
			completed = completedTime
		}
		tags, _ := json.Marshal(input.Tags)
		attachments, _ := json.Marshal(input.AttachmentIDs)
		device := input.DeviceID
		if device == "" {
			device = "api"
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO memos (id, content, type, priority, status, tags, attachment_ids, created_at, updated_at, completed_at, device_id, version, deleted, purged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`, id, input.Content, input.Type, input.Priority, input.Status, string(tags), string(attachments), created, updated, completed, device)
		if duplicate(err) {
			return nil, ErrMemoExists
		}
		if err != nil {
			return nil, err
		}
		if err = recordMemoChange(ctx, tx, id); err != nil {
			return nil, err
		}
		return result, nil
	})
	if err != nil {
		return receipt, err
	}
	err = json.Unmarshal(raw, &receipt)
	return receipt, err
}

func (s *MySQL) SaveAttachment(ctx context.Context, operation string, input Attachment) (Attachment, error) {
	var result Attachment
	payload := struct {
		Key, MIME, SHA256 string
		Size              int64
	}{input.StorageKey, input.MIME, input.SHA256, input.Size}
	hash, err := requestHash("attachment.create", payload)
	if err != nil {
		return result, err
	}
	raw, err := s.mutate(ctx, operation, "attachment.create", hash, func(tx *sql.Tx) (any, error) {
		now := time.Now().UTC().Truncate(time.Millisecond)
		a := input
		a.ID = newID()
		a.CreatedAt = now.Format(time.RFC3339Nano)
		_, err := tx.ExecContext(ctx, `INSERT INTO attachments (id, storage_key, mime_type, size_bytes, sha256, ready, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`, a.ID, a.StorageKey, a.MIME, a.Size, a.SHA256, now)
		return a, err
	})
	if err != nil {
		return result, err
	}
	err = json.Unmarshal(raw, &result)
	return result, err
}
