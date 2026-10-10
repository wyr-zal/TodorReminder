package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

const MaxChangePageSize = 10

const maxChangePageBytes = 32 << 20

func (s *MySQL) Changes(ctx context.Context, after uint64, through *uint64, limit int) (ChangePage, error) {
	page := ChangePage{Changes: []MemoChange{}, Attachments: []Attachment{}}
	if _, bound := ctx.Value(datasetContextKey{}).(string); !bound {
		return page, ErrDatasetMismatch
	}
	if limit < 1 || limit > MaxChangePageSize {
		return page, ErrInvalidChangeCursor
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return page, err
	}
	defer tx.Rollback()
	if err = tx.QueryRowContext(ctx, `SELECT dataset_id, schema_version FROM service_meta WHERE id = 1`).Scan(&page.DatasetID, &page.SchemaVersion); err != nil {
		return page, err
	}
	if err = CheckExpectedDataset(ctx, page.DatasetID); err != nil {
		return page, err
	}
	var current uint64
	if err = tx.QueryRowContext(ctx, `SELECT sequence FROM sync_change_state WHERE id = 1`).Scan(&current); err != nil {
		return page, err
	}
	upper := current
	if through != nil {
		if *through > current || *through < after {
			return page, ErrInvalidChangeCursor
		}
		upper = *through
	}
	if after > upper {
		return page, ErrInvalidChangeCursor
	}
	page.HighWater = strconv.FormatUint(upper, 10)
	rows, err := tx.QueryContext(ctx, `SELECT c.sequence, `+memoColumns+` FROM memo_change_cursor c JOIN memos ON memos.id = c.memo_id WHERE c.sequence > ? AND c.sequence <= ? ORDER BY c.sequence, c.memo_id LIMIT ?`, after, upper, limit+1)
	if err != nil {
		return page, err
	}
	for rows.Next() {
		if len(page.Changes) == limit {
			page.HasMore = true
			break
		}
		var sequence uint64
		memo, scanErr := scanMemo(sequenceRow{row: rows, sequence: &sequence})
		if scanErr != nil {
			rows.Close()
			return page, scanErr
		}
		page.Changes = append(page.Changes, MemoChange{Sequence: strconv.FormatUint(sequence, 10), Memo: memo})
	}
	rowsErr := rows.Err()
	rows.Close()
	if rowsErr != nil {
		return page, rowsErr
	}
	if page.HasMore {
		page.Cursor = page.Changes[len(page.Changes)-1].Sequence
	} else {
		page.Cursor = page.HighWater
	}

	attachmentIDs := make([]string, 0)
	seen := make(map[string]struct{})
	for _, change := range page.Changes {
		for _, id := range change.Memo.AttachmentIDs {
			if _, ok := seen[id]; !ok {
				seen[id] = struct{}{}
				attachmentIDs = append(attachmentIDs, id)
			}
		}
	}
	for start := 0; start < len(attachmentIDs); start += 500 {
		end := start + 500
		if end > len(attachmentIDs) {
			end = len(attachmentIDs)
		}
		chunk := attachmentIDs[start:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		args := make([]any, len(chunk))
		for i, id := range chunk {
			args[i] = id
		}
		attachmentRows, queryErr := tx.QueryContext(ctx, `SELECT id, storage_key, mime_type, size_bytes, sha256, created_at FROM attachments WHERE ready = 1 AND id IN (`+placeholders+`) ORDER BY id`, args...)
		if queryErr != nil {
			return page, queryErr
		}
		for attachmentRows.Next() {
			var attachment Attachment
			var created time.Time
			if queryErr = attachmentRows.Scan(&attachment.ID, &attachment.StorageKey, &attachment.MIME, &attachment.Size, &attachment.SHA256, &created); queryErr != nil {
				attachmentRows.Close()
				return page, queryErr
			}
			attachment.CreatedAt = created.UTC().Format(time.RFC3339Nano)
			page.Attachments = append(page.Attachments, attachment)
		}
		queryErr = attachmentRows.Err()
		attachmentRows.Close()
		if queryErr != nil {
			return page, queryErr
		}
	}
	if len(page.Attachments) != len(attachmentIDs) || len(page.Attachments) > 50000 {
		return page, ErrAttachmentNotReady
	}
	encoded, err := json.Marshal(struct {
		Changes     []MemoChange `json:"changes"`
		Attachments []Attachment `json:"attachments"`
	}{page.Changes, page.Attachments})
	if err != nil {
		return page, err
	}
	if len(encoded) > maxChangePageBytes {
		return page, ErrSnapshotTooLarge
	}
	if err = tx.Commit(); err != nil {
		return page, err
	}
	return page, nil
}

type sequenceRow struct {
	row      rowScanner
	sequence *uint64
}

func (r sequenceRow) Scan(dest ...any) error {
	values := make([]any, 0, len(dest)+1)
	values = append(values, r.sequence)
	values = append(values, dest...)
	return r.row.Scan(values...)
}
