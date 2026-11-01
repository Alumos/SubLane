// Package updates checks SubLane releases and publishes jobs to an opt-in host worker.
// It never executes programs or controls Docker from the web process.
package updates

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const releasesURL = "https://api.github.com/repos/murongg/SubLane/releases/latest"
const releaseBase = "https://github.com/murongg/SubLane/releases/tag/v"

var stable = regexp.MustCompile(`^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$`)
var jobID = regexp.MustCompile(`^[a-f0-9]{32}$`)
var (
	ErrCheck    = errors.New("release check failed")
	ErrCooldown = errors.New("release check cooldown")
	ErrInput    = errors.New("invalid update request")
	ErrDisabled = errors.New("host updater unavailable")
	ErrBusy     = errors.New("update already queued")
)

type Job struct {
	ID        string `json:"id"`
	Version   string `json:"version"`
	Status    string `json:"status"`
	UpdatedAt int64  `json:"updated_at"`
}
type State struct {
	CurrentVersion string `json:"current_version"`
	LatestVersion  string `json:"latest_version"`
	ReleaseURL     string `json:"release_url"`
	CheckedAt      int64  `json:"checked_at"`
	CheckFailed    bool   `json:"check_failed"`
	Available      bool   `json:"available"`
	Enabled        bool   `json:"enabled"`
	Job            *Job   `json:"job"`
}
type Service struct {
	mu                         sync.Mutex
	current, directory, latest string
	checkedAt, attemptedAt     time.Time
	checkFailed                bool
	client                     *http.Client
}

func New(current, directory string, transport http.RoundTripper) *Service {
	if transport == nil {
		t := http.DefaultTransport.(*http.Transport).Clone()
		t.ResponseHeaderTimeout = 10 * time.Second
		t.MaxIdleConnsPerHost = 1
		transport = t
	}
	return &Service{current: current, directory: directory, client: &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (s *Service) Close() { s.client.CloseIdleConnections() }
func (s *Service) View() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.view()
}
func (s *Service) view() State {
	state := State{CurrentVersion: s.current, LatestVersion: s.latest, CheckFailed: s.checkFailed}
	if !s.checkedAt.IsZero() {
		state.CheckedAt = s.checkedAt.Unix()
	}
	if s.latest != "" {
		state.ReleaseURL = releaseBase + s.latest
	}
	state.Available = !s.checkFailed && time.Since(s.checkedAt) < time.Hour && newer(s.latest, s.current)
	root, err := s.mailbox()
	if err != nil {
		return state
	}
	defer root.Close()
	if info, err := root.Lstat("heartbeat"); err == nil && info.Mode().IsRegular() {
		age := time.Since(info.ModTime())
		state.Enabled = age >= 0 && age < 15*time.Second
	}
	// A pending request remains present until readiness has been checked by the host.
	var request Job
	if readJob(root, "request.json", &request) == nil {
		state.Job = &request
		var status Job
		if readJob(root, "status.json", &status) == nil && status.ID == request.ID {
			state.Job = &status
		}
	} else {
		var status Job
		if readJob(root, "status.json", &status) == nil {
			state.Job = &status
		}
	}
	return state
}
func (s *Service) mailbox() (*os.Root, error) {
	if s.directory == "" {
		return nil, ErrDisabled
	}
	info, err := os.Lstat(s.directory)
	if err != nil || !info.IsDir() {
		return nil, ErrDisabled
	}
	return os.OpenRoot(s.directory)
}
func readJob(root *os.Root, name string, value *Job) error {
	info, err := root.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 2048 {
		return ErrInput
	}
	f, err := root.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	decoder := json.NewDecoder(io.LimitReader(f, 2049))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil || decoder.Decode(new(any)) != io.EOF || !jobID.MatchString(value.ID) || !stable.MatchString(value.Version) || value.UpdatedAt <= 0 {
		return ErrInput
	}
	switch value.Status {
	case "queued", "running", "succeeded", "failed", "interrupted":
		return nil
	}
	return ErrInput
}
func (s *Service) Check(ctx context.Context, force bool) (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !force && time.Since(s.attemptedAt) < time.Hour {
		return s.view(), nil
	}
	if time.Since(s.attemptedAt) < time.Minute {
		return s.view(), ErrCooldown
	}
	s.attemptedAt = time.Now()
	latest, err := s.fetch(ctx)
	s.checkFailed = err != nil
	if err != nil {
		return s.view(), ErrCheck
	}
	s.latest = latest
	s.checkedAt = time.Now()
	return s.view(), nil
}
func (s *Service) fetch(ctx context.Context) (string, error) {
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, releasesURL, nil)
	if err != nil {
		return "", err
	}
	r.Header.Set("Accept", "application/vnd.github+json")
	r.Header.Set("User-Agent", "SubLane")
	response, err := s.client.Do(r)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return "", ErrCheck
	}
	limited := &io.LimitedReader{R: response.Body, N: (2 << 20) + 1}
	decoder := json.NewDecoder(limited)
	var release struct {
		Tag        string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
	}
	if decoder.Decode(&release) != nil || decoder.Decode(new(any)) != io.EOF || limited.N <= 0 || release.Draft || release.Prerelease || !strings.HasPrefix(release.Tag, "v") {
		return "", ErrCheck
	}
	version := strings.TrimPrefix(release.Tag, "v")
	if !stable.MatchString(version) {
		return "", ErrCheck
	}
	return version, nil
}
func newer(next, current string) bool {
	if !stable.MatchString(next) || !stable.MatchString(current) {
		return false
	}
	a, b := strings.Split(next, "."), strings.Split(current, ".")
	for i := range a {
		x, _ := strconv.Atoi(a[i])
		y, _ := strconv.Atoi(b[i])
		if x != y {
			return x > y
		}
	}
	return false
}
func (s *Service) Queue(ctx context.Context, version string, backupConfirmed bool) (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.view()
	if !backupConfirmed || !state.Available || version != s.latest {
		return state, ErrInput
	}
	if !state.Enabled {
		return state, ErrDisabled
	}
	if err := ctx.Err(); err != nil {
		return state, err
	}
	root, err := s.mailbox()
	if err != nil {
		return state, ErrDisabled
	}
	defer root.Close()
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return state, err
	}
	job := Job{ID: hex.EncodeToString(bytes[:]), Version: version, Status: "queued", UpdatedAt: time.Now().Unix()}
	temp := ".request-" + job.ID
	f, err := root.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil {
		return state, err
	}
	defer root.Remove(temp)
	// The host worker can have a different UID from the application container.
	err = f.Chmod(0644)
	if err == nil {
		err = json.NewEncoder(f).Encode(job)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return state, err
	}
	if closeErr != nil {
		return state, closeErr
	}
	// Linking publishes a complete job without replacing a job from another process.
	if err := root.Link(temp, "request.json"); err != nil {
		if os.IsExist(err) {
			return s.view(), ErrBusy
		}
		return state, err
	}
	return s.view(), nil
}
