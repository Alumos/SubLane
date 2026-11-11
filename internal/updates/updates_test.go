package updates

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func releaseClient(body string, calls *int) transport {
	return func(r *http.Request) (*http.Response, error) {
		*calls++
		if r.URL.String() != releasesURL || r.Header.Get("Accept") != "application/vnd.github+json" {
			return nil, errors.New("unexpected release request")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	}
}

const stableRelease = `{"tag_name":"v1.3.0","draft":false,"prerelease":false}`

func TestChecksAreBoundedCachedAndNeverQueueInstallation(t *testing.T) {
	calls := 0
	s := New("1.2.0", t.TempDir(), releaseClient(stableRelease, &calls))
	defer s.Close()
	state, err := s.Check(context.Background(), false)
	if err != nil || !state.Available || state.LatestVersion != "1.3.0" || state.Enabled || state.Job != nil {
		t.Fatal(state, err)
	}
	if _, err := s.Check(context.Background(), false); err != nil || calls != 1 {
		t.Fatal(calls, err)
	}
	if _, err := s.Check(context.Background(), true); !errors.Is(err, ErrCooldown) {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(s.directory, "request.json")); !os.IsNotExist(err) {
		t.Fatal(err)
	}
}

func TestRejectsUnusableReleaseMetadata(t *testing.T) {
	for _, body := range []string{
		`{"tag_name":"v1.3.0","draft":true}`, `{"tag_name":"v1.3.0-rc.1","prerelease":true}`,
		`{"tag_name":"v01.3.0"}`, `{"tag_name":"v1.3.0;echo bad"}`, stableRelease + `{}`,
		`{"tag_name":"v1.3.0","body":"` + strings.Repeat("x", 2<<20) + `"}`,
	} {
		calls := 0
		s := New("1.2.0", "", releaseClient(body, &calls))
		if state, err := s.Check(context.Background(), true); !errors.Is(err, ErrCheck) || !state.CheckFailed || state.Available {
			t.Fatal(len(body), state, err)
		}
		s.Close()
	}
	s := New("1.2.0", "", transport(func(*http.Request) (*http.Response, error) { return nil, errors.New("synthetic failure") }))
	defer s.Close()
	if state, err := s.Check(context.Background(), false); !errors.Is(err, ErrCheck) || !state.CheckFailed {
		t.Fatal(state, err)
	}
}

func TestOnlyNewerStableVersionsCanBeInstalled(t *testing.T) {
	for _, current := range []string{"1.3.0", "1.4.0", "0.1.0-dev", "unknown"} {
		calls := 0
		s := New(current, "", releaseClient(stableRelease, &calls))
		state, err := s.Check(context.Background(), false)
		if err != nil || state.Available {
			t.Fatal(current, state, err)
		}
		s.Close()
	}
}

func TestQueueRequiresBackupFreshMetadataAndLiveWorker(t *testing.T) {
	dir := t.TempDir()
	calls := 0
	s := New("1.2.0", dir, releaseClient(stableRelease, &calls))
	defer s.Close()
	if _, err := s.Queue(context.Background(), "1.3.0", true); !errors.Is(err, ErrInput) {
		t.Fatal(err)
	}
	if _, err := s.Check(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Queue(context.Background(), "1.3.0", true); !errors.Is(err, ErrDisabled) {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "heartbeat"), []byte("ready"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, input := range []struct {
		version string
		backup  bool
	}{{"1.3.0", false}, {"1.4.0", true}, {"../1.3.0", true}, {"1.2.0", true}} {
		if _, err := s.Queue(context.Background(), input.version, input.backup); !errors.Is(err, ErrInput) {
			t.Fatal(input, err)
		}
	}
	s.checkedAt = time.Now().Add(-2 * time.Hour)
	if _, err := s.Queue(context.Background(), "1.3.0", true); !errors.Is(err, ErrInput) {
		t.Fatal("stale metadata", err)
	}
	s.checkedAt = time.Now()
	stale := time.Now().Add(-time.Minute)
	if err := os.Chtimes(filepath.Join(dir, "heartbeat"), stale, stale); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Queue(context.Background(), "1.3.0", true); !errors.Is(err, ErrDisabled) {
		t.Fatal("stale worker", err)
	}
}

func TestConcurrentQueueAndProcessRestartRetainOneJob(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "heartbeat"), []byte("ready"), 0644); err != nil {
		t.Fatal(err)
	}
	calls := 0
	s := New("1.2.0", dir, releaseClient(stableRelease, &calls))
	defer s.Close()
	if _, err := s.Check(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	peerCalls := 0
	peer := New("1.2.0", dir, releaseClient(stableRelease, &peerCalls))
	defer peer.Close()
	if _, err := peer.Check(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	results := make(chan error, 10)
	for i := range 10 {
		service := s
		if i%2 == 1 {
			service = peer
		}
		group.Go(func() { _, err := service.Queue(context.Background(), "1.3.0", true); results <- err })
	}
	group.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else if !errors.Is(err, ErrBusy) {
			t.Fatal(err)
		}
	}
	if success != 1 {
		t.Fatal(success)
	}
	other := New("1.2.0", dir, nil)
	defer other.Close()
	job := other.View().Job
	if job == nil || job.Version != "1.3.0" || job.Status != "queued" {
		t.Fatal(job)
	}
}

func TestMailboxRefusesSymlinksAndOversizedStatus(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("private synthetic data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "heartbeat")); err != nil {
		t.Fatal(err)
	}
	s := New("1.2.0", dir, nil)
	defer s.Close()
	if s.View().Enabled {
		t.Fatal("symlink heartbeat trusted")
	}
	if err := os.Symlink(outside, filepath.Join(dir, "status.json")); err != nil {
		t.Fatal(err)
	}
	if s.View().Job != nil {
		t.Fatal("symlink status trusted")
	}
	os.Remove(filepath.Join(dir, "status.json"))
	os.WriteFile(filepath.Join(dir, "status.json"), []byte(strings.Repeat("x", 2049)), 0644)
	if s.View().Job != nil {
		t.Fatal("oversized status trusted")
	}
}

func TestForkRevisionsOrderAfterTheirBaseRelease(t *testing.T) {
	for _, tc := range []struct {
		next, current string
		want          bool
	}{
		{"0.19.2-revised.8", "0.19.2-revised.7", true},
		{"0.19.2-revised.10", "0.19.2-revised.9", true},
		{"0.19.2-revised.1", "0.19.2", true},
		{"0.19.3", "0.19.2-revised.9", true},
		{"0.19.2-revised.7", "0.19.2-revised.7", false},
		{"0.19.2", "0.19.2-revised.1", false},
		{"0.19.2-revised.7", "0.20.0", false},
		{"0.19.2-rc.1", "0.19.1", false},
		{"0.19.2-revised.01", "0.19.1", false},
		{"0.19.2-revised.0", "0.19.1", false},
	} {
		if got := newer(tc.next, tc.current); got != tc.want {
			t.Fatal(tc.next, tc.current, got)
		}
	}
	var requested string
	s := New("0.19.2-revised.7", "", transport(func(r *http.Request) (*http.Response, error) {
		requested = r.URL.String()
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"tag_name":"v0.19.2-revised.8"}`))}, nil
	}))
	defer s.Close()
	state, err := s.Check(context.Background(), true)
	if err != nil || !state.Available || requested != "https://api.github.com/repos/Alumos/SubLane/releases/latest" {
		t.Fatal("fork release was not offered", requested, state, err)
	}
}
