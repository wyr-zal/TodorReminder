package store

import (
	"context"
	"errors"
)

type datasetContextKey struct{}

var ErrDatasetMismatch = errors.New("dataset mismatch")

func WithExpectedDataset(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, datasetContextKey{}, id)
}

func CheckExpectedDataset(ctx context.Context, actual string) error {
	expected, ok := ctx.Value(datasetContextKey{}).(string)
	if ok && actual != expected {
		return ErrDatasetMismatch
	}
	return nil
}
