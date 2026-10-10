package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChangesHTTPRequiresAndValidatesCursor(t *testing.T) {
	s, _ := harness(t)
	for _, path := range []string{
		"/api/v1/sync/changes",
		"/api/v1/sync/changes?cursor=invalid",
		"/api/v1/sync/changes?cursor=0&cursor=1",
	} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer "+testToken)
		r.Header.Set("X-Focus-Dataset-ID", testID)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s: got %d, body %s", path, w.Code, w.Body.String())
		}
	}
}

func TestChangesHTTPReturnsDatasetBoundPage(t *testing.T) {
	s, _ := harness(t)
	r := httptest.NewRequest(http.MethodGet, "/api/v1/sync/changes?cursor=0&limit=10", nil)
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("X-Focus-Dataset-ID", testID)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, body %s", w.Code, w.Body.String())
	}
	for _, value := range []string{`"datasetId":"` + testID + `"`, `"cursor":"0"`, `"highWater":"0"`, `"hasMore":false`} {
		if !strings.Contains(w.Body.String(), value) {
			t.Fatalf("missing %s in %s", value, w.Body.String())
		}
	}
}
