package store

import (
	"context"
	"errors"
	"testing"
)

func TestCheckExpectedDataset(t *testing.T) {
	const expected = "11111111-1111-4111-8111-111111111111"
	ctx := WithExpectedDataset(context.Background(), expected)

	if err := CheckExpectedDataset(ctx, expected); err != nil {
		t.Fatalf("matching dataset rejected: %v", err)
	}
	if err := CheckExpectedDataset(ctx, "22222222-2222-4222-8222-222222222222"); !errors.Is(err, ErrDatasetMismatch) {
		t.Fatalf("mismatched dataset error: %v", err)
	}
	if err := CheckExpectedDataset(context.Background(), expected); err != nil {
		t.Fatalf("unbound request rejected: %v", err)
	}
}
