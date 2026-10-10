package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

type MemoFilter struct {
	Status, Priority, Tag, Query string
	Deleted                      bool
	Limit, Offset                int
}
type Snapshot struct {
	Meta
	ChangeCursor string       `json:"changeCursor"`
	Complete     bool         `json:"complete"`
	TotalRows    int          `json:"totalRows"`
	Memos        []Memo       `json:"memos"`
	Attachments  []Attachment `json:"attachments"`
}

type ChangePage struct {
	Meta
	Cursor      string       `json:"cursor"`
	HighWater   string       `json:"highWater"`
	HasMore     bool         `json:"hasMore"`
	Changes     []MemoChange `json:"changes"`
	Attachments []Attachment `json:"attachments"`
}

func (s *MySQL) ListMemos(ctx context.Context, f MemoFilter) ([]Memo, error) {
	where := []string{"purged = 0", "deleted = ?"}
	args := []any{f.Deleted}
	for _, item := range []struct{ field, value string }{{"status", f.Status}, {"priority", f.Priority}} {
		if item.value != "" {
			where = append(where, item.field+" = ?")
			args = append(args, item.value)
		}
	}
	if f.Tag != "" {
		where = append(where, "JSON_CONTAINS(tags, JSON_QUOTE(?))")
		args = append(args, f.Tag)
	}
	if f.Query != "" {
		where = append(where, "LOCATE(?, content) > 0")
		args = append(args, f.Query)
	}
	args = append(args, f.Limit, f.Offset)
	rows, err := s.db.QueryContext(ctx, "SELECT "+memoColumns+" FROM memos WHERE "+strings.Join(where, " AND ")+" ORDER BY created_at DESC, id LIMIT ? OFFSET ?", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return readMemos(rows, 500)
}
func readMemos(rows *sql.Rows, limit int) ([]Memo, error) {
	out := []Memo{}
	size := 0
	for rows.Next() {
		m, err := scanMemo(rows)
		if err != nil {
			return nil, err
		}
		b, _ := json.Marshal(m)
		size += len(b)
		if len(out) >= limit || size > 16<<20 {
			return nil, ErrSnapshotTooLarge
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func (s *MySQL) Snapshot(ctx context.Context) (Snapshot, error) {
	result := Snapshot{Memos: []Memo{}, Attachments: []Attachment{}}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err != nil {
		return result, err
	}
	var changeCursor uint64
	if err = tx.QueryRowContext(ctx, `SELECT sequence FROM sync_change_state WHERE id = 1`).Scan(&changeCursor); err != nil {
		return result, err
	}
	result.ChangeCursor = strconv.FormatUint(changeCursor, 10)
	rows, err := tx.QueryContext(ctx, "SELECT "+memoColumns+" FROM memos ORDER BY id LIMIT 10001")
	if err != nil {
		return result, err
	}
	result.Memos, err = readMemos(rows, 10000)
	rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT id, storage_key, mime_type, size_bytes, sha256, created_at FROM attachments WHERE ready = 1 ORDER BY id LIMIT 50001`)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var a Attachment
		var created time.Time
		if err = rows.Scan(&a.ID, &a.StorageKey, &a.MIME, &a.Size, &a.SHA256, &created); err != nil {
			return result, err
		}
		a.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		result.Attachments = append(result.Attachments, a)
		if len(result.Attachments) > 50000 {
			return result, ErrSnapshotTooLarge
		}
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	rows.Close()
	if err = tx.Commit(); err != nil {
		return result, err
	}
	result.Complete = true
	result.TotalRows = len(result.Memos)
	return result, nil
}
