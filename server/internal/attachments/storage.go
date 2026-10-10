package attachments

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
	"regexp"

	_ "golang.org/x/image/webp"
)

var (
	ErrTooLarge     = errors.New("image exceeds upload limit")
	ErrInvalidImage = errors.New("invalid or unsupported image")
	ErrPixelLimit   = errors.New("image exceeds pixel limit")
	keyPattern      = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type File struct {
	Key    string
	MIME   string
	Size   int64
	SHA256 string
}
type Storage struct {
	root                string
	maxBytes, maxPixels int64
	decodeSlot          chan struct{}
}
type Staged struct {
	File
	owner  *Storage
	path   string
	closed bool
}

func New(root string, maxBytes, maxPixels int64) (*Storage, error) {
	if !filepath.IsAbs(root) || maxBytes <= 0 || maxPixels <= 0 {
		return nil, errors.New("invalid attachment storage configuration")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	probe, err := os.CreateTemp(root, ".probe-")
	if err != nil {
		return nil, err
	}
	name := probe.Name()
	closeErr := probe.Close()
	removeErr := os.Remove(name)
	if closeErr != nil {
		return nil, closeErr
	}
	if removeErr != nil {
		return nil, removeErr
	}
	return &Storage{root: root, maxBytes: maxBytes, maxPixels: maxPixels, decodeSlot: make(chan struct{}, 1)}, nil
}

func (s *Storage) Stage(ctx context.Context, operation string, source io.Reader) (_ *Staged, err error) {
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case s.decodeSlot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-s.decodeSlot }()
	f, err := os.CreateTemp(s.root, ".upload-")
	if err != nil {
		return nil, err
	}
	name := f.Name()
	defer func() {
		f.Close()
		if err != nil {
			os.Remove(name)
		}
	}()
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, hash), io.LimitReader(&cancelReader{ctx, source}, s.maxBytes+1))
	if err != nil {
		return nil, err
	}
	if n > s.maxBytes {
		return nil, ErrTooLarge
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	cfg, format, err := image.DecodeConfig(f)
	if err != nil {
		return nil, ErrInvalidImage
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width) > s.maxPixels/int64(cfg.Height) {
		return nil, ErrPixelLimit
	}
	if format != "png" && format != "jpeg" && format != "gif" && format != "webp" {
		return nil, ErrInvalidImage
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	if _, _, err = image.Decode(f); err != nil {
		return nil, ErrInvalidImage
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = f.Sync(); err != nil {
		return nil, err
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	key := sha256.Sum256([]byte(operation + ":" + digest))
	return &Staged{File: File{Key: hex.EncodeToString(key[:]), MIME: "image/" + format, Size: n, SHA256: digest}, owner: s, path: name}, nil
}

type cancelReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *cancelReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func (f *Staged) Commit() error {
	if f.closed {
		return errors.New("staged image already closed")
	}
	dst := filepath.Join(f.owner.root, f.Key)
	if err := os.Link(f.path, dst); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		existing, err := f.owner.Open(f.Key)
		if err != nil {
			return err
		}
		defer existing.Close()
		hash := sha256.New()
		n, err := io.Copy(hash, io.LimitReader(existing, f.Size+1))
		if err != nil {
			return err
		}
		if n != f.Size || hex.EncodeToString(hash.Sum(nil)) != f.SHA256 {
			return errors.New("stored image integrity mismatch")
		}
	}
	dir, err := os.Open(f.owner.root)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (f *Staged) Close() error {
	if f.closed {
		return nil
	}
	f.closed = true
	return os.Remove(f.path)
}

func (s *Storage) Open(key string) (*os.File, error) {
	if !keyPattern.MatchString(key) {
		return nil, errors.New("invalid storage key")
	}
	path := filepath.Join(s.root, key)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("attachment is not a regular file")
	}
	return os.Open(path)
}
