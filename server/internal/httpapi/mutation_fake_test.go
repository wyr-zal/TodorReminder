package httpapi

import (
	"context"
	"focus-memo/server/internal/store"
)

func (f *fakeRepo) ChangeMemo(context.Context, string, string, store.PatchMemoRequest, bool, bool) (store.Receipt, error) {
	return store.Receipt{}, f.writeErr
}
func (f *fakeRepo) ListMemos(context.Context, store.MemoFilter) ([]store.Memo, error) {
	return []store.Memo{f.memo}, f.writeErr
}
func (f *fakeRepo) Snapshot(context.Context) (store.Snapshot, error) {
	return store.Snapshot{}, f.writeErr
}
func (f *fakeRepo) Changes(context.Context, uint64, *uint64, int) (store.ChangePage, error) {
	return store.ChangePage{Meta: store.Meta{DatasetID: testID, SchemaVersion: 1}, Cursor: "0", HighWater: "0", Changes: []store.MemoChange{}, Attachments: []store.Attachment{}}, f.writeErr
}
