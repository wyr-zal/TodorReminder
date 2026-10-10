package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

var (
	ErrVersionConflict         = errors.New("version conflict")
	ErrPurged                  = errors.New("memo permanently deleted")
	ErrInvalidTransition       = errors.New("memo must be deleted before purge")
	ErrInvalidMemo             = errors.New("invalid memo")
	ErrSnapshotTooLarge        = errors.New("snapshot exceeds limit")
	ErrInvalidChangeCursor     = errors.New("invalid change cursor")
	ErrChangeSequenceExhausted = errors.New("change sequence exhausted")
)

type PatchMemoRequest struct {
	BaseVersion   string    `json:"baseVersion"`
	Content       *string   `json:"content,omitempty"`
	Type          *string   `json:"type,omitempty"`
	Priority      *string   `json:"priority,omitempty"`
	Status        *string   `json:"status,omitempty"`
	Tags          *[]string `json:"tags,omitempty"`
	AttachmentIDs *[]string `json:"attachmentIds,omitempty"`
	Deleted       *bool     `json:"deleted,omitempty"`
}

func ValidVersion(v string) bool {
	if v == "" || v[0] == '0' {
		return false
	}
	for _, c := range v {
		if c < '0' || c > '9' {
			return false
		}
	}
	n, e := strconv.ParseUint(v, 10, 64)
	return e == nil && n > 0
}
func nextVersion(v string) (string, error) {
	if !ValidVersion(v) {
		return "", ErrInvalidMemo
	}
	n, _ := strconv.ParseUint(v, 10, 64)
	if n == ^uint64(0) {
		return "", ErrInvalidMemo
	}
	return strconv.FormatUint(n+1, 10), nil
}

func (s *MySQL) ChangeMemo(ctx context.Context, operation, id string, patch PatchMemoRequest, remove, permanent bool) (Receipt, error) {
	var receipt Receipt
	payload := struct {
		ID                string
		Patch             PatchMemoRequest
		Remove, Permanent bool
	}{id, patch, remove, permanent}
	hash, err := requestHash("memo.change", payload)
	if err != nil {
		return receipt, err
	}
	raw, err := s.mutate(ctx, operation, "memo.change", hash, func(tx *sql.Tx) (any, error) {
		m, err := scanMemo(tx.QueryRowContext(ctx, "SELECT "+memoColumns+" FROM memos WHERE id = ? FOR UPDATE", id))
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if !ValidVersion(patch.BaseVersion) {
			return nil, ErrInvalidMemo
		}
		if m.Version != patch.BaseVersion {
			return nil, ErrVersionConflict
		}
		if m.Purged {
			return nil, ErrPurged
		}
		if permanent && (!remove || !m.Deleted) {
			return nil, ErrInvalidTransition
		}
		beforeStatus := m.Status
		if remove {
			m.Deleted = true
		} else {
			if patch.Content != nil {
				m.Content = *patch.Content
			}
			if patch.Type != nil {
				m.Type = *patch.Type
			}
			if patch.Priority != nil {
				m.Priority = *patch.Priority
			}
			if patch.Status != nil {
				m.Status = *patch.Status
			}
			if patch.Tags != nil {
				m.Tags = *patch.Tags
			}
			if patch.AttachmentIDs != nil {
				m.AttachmentIDs = *patch.AttachmentIDs
			}
			if patch.Deleted != nil {
				m.Deleted = *patch.Deleted
			}
			if strings.TrimSpace(m.Content) == "" && len(m.AttachmentIDs) == 0 {
				return nil, ErrInvalidMemo
			}
		}
		if permanent {
			m.Purged = true
			m.Content = ""
			m.Type = "text"
			m.Priority = "unimportant"
			m.Status = "not_started"
			m.Tags = []string{}
			m.AttachmentIDs = []string{}
			m.CompletedAt = nil
			m.DeviceID = ""
		}
		for _, aid := range m.AttachmentIDs {
			var found string
			e := tx.QueryRowContext(ctx, `SELECT id FROM attachments WHERE id = ? AND ready = 1 LOCK IN SHARE MODE`, aid).Scan(&found)
			if errors.Is(e, sql.ErrNoRows) {
				return nil, ErrAttachmentNotReady
			}
			if e != nil {
				return nil, e
			}
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		stamp := now.Format(time.RFC3339Nano)
		if m.Status != "completed" {
			m.CompletedAt = nil
		} else if beforeStatus != "completed" {
			m.CompletedAt = &stamp
		}
		version, err := nextVersion(m.Version)
		if err != nil {
			return nil, err
		}
		var completed any
		if m.CompletedAt != nil {
			completed, err = time.Parse(time.RFC3339Nano, *m.CompletedAt)
			if err != nil {
				return nil, err
			}
		}
		tags, _ := json.Marshal(m.Tags)
		ids, _ := json.Marshal(m.AttachmentIDs)
		_, err = tx.ExecContext(ctx, `UPDATE memos SET content=?, type=?, priority=?, status=?, tags=?, attachment_ids=?, updated_at=?, completed_at=?, device_id=?, version=?, deleted=?, purged=? WHERE id=?`, m.Content, m.Type, m.Priority, m.Status, string(tags), string(ids), now, completed, m.DeviceID, version, m.Deleted, m.Purged, id)
		if err != nil {
			return nil, err
		}
		if err = recordMemoChange(ctx, tx, id); err != nil {
			return nil, err
		}
		return Receipt{ID: id, AppliedVersion: version, CreatedAt: m.CreatedAt, UpdatedAt: stamp, CompletedAt: m.CompletedAt, Deleted: m.Deleted, Purged: m.Purged}, nil
	})
	if err != nil {
		return receipt, err
	}
	err = json.Unmarshal(raw, &receipt)
	return receipt, err
}
