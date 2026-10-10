package attachments

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"testing"
)

func picture(t *testing.T, kind string, width int) []byte {
	t.Helper()
	im := image.NewRGBA(image.Rect(0, 0, width, 2))
	im.Set(0, 0, color.RGBA{255, 0, 0, 255})
	var b bytes.Buffer
	var err error
	if kind == "jpeg" {
		err = jpeg.Encode(&b, im, nil)
	} else {
		err = png.Encode(&b, im)
	}
	if err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestStage(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir, 1<<20, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"png", "jpeg"} {
		data := picture(t, kind, 2)
		staged, err := s.Stage(context.Background(), "operation-"+kind, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		if staged.MIME != "image/"+kind || staged.Size != int64(len(data)) {
			t.Fatalf("bad metadata: %+v", staged.File)
		}
		if err = staged.Commit(); err != nil {
			t.Fatal(err)
		}
		staged.Close()
		f, err := s.Open(staged.Key)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(f)
		f.Close()
		if !bytes.Equal(got, data) {
			t.Fatal("image bytes changed")
		}
		again, err := s.Stage(context.Background(), "operation-"+kind, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		if again.Key != staged.Key {
			t.Fatal("retry changed storage key")
		}
		if err = again.Commit(); err != nil {
			t.Fatal(err)
		}
		again.Close()
	}
	for _, tc := range []struct {
		name string
		data []byte
		want error
	}{
		{"not-image", []byte("<svg>fake</svg>"), ErrInvalidImage},
		{"oversized", bytes.Repeat([]byte("a"), 1<<20+1), ErrTooLarge},
		{"too-many-pixels", picture(t, "png", 60), ErrPixelLimit},
		{"truncated", picture(t, "png", 2)[:30], ErrInvalidImage},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, err := s.Stage(context.Background(), tc.name, bytes.NewReader(tc.data))
			if st != nil {
				st.Close()
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v want %v", err, tc.want)
			}
		})
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if len(e.Name()) != 64 {
			t.Fatalf("temporary file leaked: %s", e.Name())
		}
	}
	if _, err := s.Open("../outside"); err == nil {
		t.Fatal("accepted path traversal")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if st, err := s.Stage(ctx, "cancelled", bytes.NewReader(picture(t, "png", 2))); err == nil {
		st.Close()
		t.Fatal("ignored cancellation")
	}
}
