package store

import "testing"

func TestNextVersion(t *testing.T) {
	for _, tc := range []struct{ before, after string }{{"1", "2"}, {"9007199254740993", "9007199254740994"}} {
		got, err := nextVersion(tc.before)
		if err != nil || got != tc.after {
			t.Fatalf("%s -> %s: %v", tc.before, got, err)
		}
	}
	for _, v := range []string{"0", "01", "-1", "1.2", "18446744073709551615", "18446744073709551616"} {
		if _, err := nextVersion(v); err == nil {
			t.Fatalf("accepted invalid/overflow version %s", v)
		}
	}
}
