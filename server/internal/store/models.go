package store

import "errors"

var (
	ErrNotFound            = errors.New("not found")
	ErrIdempotencyMismatch = errors.New("idempotency key was reused for another request")
	ErrMemoExists          = errors.New("memo already exists")
	ErrAttachmentNotReady  = errors.New("attachment is not ready")
)

type CreateMemoRequest struct {
	CreatedAt     *string  `json:"createdAt,omitempty"`
	UpdatedAt     *string  `json:"updatedAt,omitempty"`
	CompletedAt   *string  `json:"completedAt,omitempty"`
	DeviceID      string   `json:"deviceId,omitempty"`
	ID            string   `json:"id,omitempty"`
	Content       string   `json:"content"`
	Type          string   `json:"type,omitempty"`
	Priority      string   `json:"priority,omitempty"`
	Status        string   `json:"status,omitempty"`
	Tags          []string `json:"tags"`
	AttachmentIDs []string `json:"attachmentIds"`
}

type Receipt struct {
	ID             string  `json:"id"`
	AppliedVersion string  `json:"appliedVersion"`
	CreatedAt      string  `json:"createdAt"`
	UpdatedAt      string  `json:"updatedAt"`
	CompletedAt    *string `json:"completedAt"`
	Deleted        bool    `json:"deleted"`
	Purged         bool    `json:"purged"`
}

type Meta struct {
	DatasetID     string `json:"datasetId"`
	SchemaVersion int    `json:"schemaVersion"`
}

type Memo struct {
	ID            string   `json:"id"`
	Content       string   `json:"content"`
	Type          string   `json:"type"`
	Priority      string   `json:"priority"`
	Status        string   `json:"status"`
	Tags          []string `json:"tags"`
	AttachmentIDs []string `json:"attachmentIds"`
	CreatedAt     string   `json:"createdAt"`
	UpdatedAt     string   `json:"updatedAt"`
	CompletedAt   *string  `json:"completedAt"`
	DeviceID      string   `json:"deviceId"`
	Version       string   `json:"version"`
	Deleted       bool     `json:"deleted"`
	Purged        bool     `json:"purged"`
}

type Attachment struct {
	ID         string `json:"id"`
	StorageKey string `json:"-"`
	MIME       string `json:"mimeType"`
	Size       int64  `json:"size"`
	SHA256     string `json:"sha256"`
	CreatedAt  string `json:"createdAt"`
}

type MemoChange struct {
	Sequence string `json:"sequence"`
	Memo     Memo   `json:"memo"`
}
