package accounts

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"

	"github.com/murongg/SubLane/internal/audit"
	"github.com/murongg/SubLane/internal/storage/db"
)

// ErrFingerprintUnsupported reports a provider without a client fingerprint (API channels and
// providers whose SDK executor sends a fixed client identity).
var ErrFingerprintUnsupported = errors.New("fingerprint_unsupported")

// ClientProfile is the client fingerprint one upstream account presents to its provider, so every
// client sharing the account looks like the same machine. Empty fields fall back to SubLane's
// managed defaults. Versions of the client itself always come from SubLane's version policy.
type ClientProfile struct {
	// Source is "learned" (copied from the first native client) or "manual" (set by an administrator).
	Source string `json:"source"`
	// Platform is the Codex User-Agent platform, for example "(Mac OS 15.5.0; arm64) iTerm.app/3.6.1".
	Platform string `json:"platform,omitempty"`
	// OS, Arch, RuntimeVersion and PackageVersion are Claude's X-Stainless headers.
	OS             string `json:"os,omitempty"`
	Arch           string `json:"arch,omitempty"`
	RuntimeVersion string `json:"runtime_version,omitempty"`
	PackageVersion string `json:"package_version,omitempty"`
}

// Fingerprint is the administrator view of an account's client fingerprint. DeviceID is a short
// prefix of the Claude device identifier, never the full value.
type Fingerprint struct {
	Provider string        `json:"provider"`
	Profile  ClientProfile `json:"profile"`
	DeviceID string        `json:"device_id,omitempty"`
}

var (
	// codexClientAgent matches a native Codex User-Agent:
	// "<originator>/<version> (<os> <os version>; <arch>) <terminal>[ (<suffix>)]".
	codexClientAgent = regexp.MustCompile(`^(?:codex_cli_rs|codex-tui|codex_exec|codex_vscode)/[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]{0,24} (\([A-Za-z][A-Za-z0-9 ._-]{0,48} [0-9][0-9A-Za-z._-]{0,24}; [A-Za-z0-9_]{1,16}\)(?: [A-Za-z0-9][A-Za-z0-9._+-]{0,40}(?:/[A-Za-z0-9._+-]{1,40})?)?)`)
	codexPlatform    = regexp.MustCompile(`^\([A-Za-z][A-Za-z0-9 ._-]{0,48} [0-9][0-9A-Za-z._-]{0,24}; [A-Za-z0-9_]{1,16}\)(?: [A-Za-z0-9][A-Za-z0-9._+-]{0,40}(?:/[A-Za-z0-9._+-]{1,40})?)?$`)
	claudeClient     = regexp.MustCompile(`^claude-cli/[0-9]+\.[0-9]+\.[0-9]+ \(external, [a-z-]{1,32}\)$`)
	// The Stainless values the Anthropic SDK reports on the platforms Claude Code runs on.
	claudeOS      = regexp.MustCompile(`^(MacOS|Windows|Linux|FreeBSD)$`)
	claudeArch    = regexp.MustCompile(`^(arm64|x64|x86|arm)$`)
	claudeRuntime = regexp.MustCompile(`^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$`)
	claudePackage = regexp.MustCompile(`^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$`)
)

// CodexClientPlatform extracts the platform portion of a native Codex User-Agent, or "".
func CodexClientPlatform(userAgent string) string {
	if len(userAgent) > 512 {
		return ""
	}
	match := codexClientAgent.FindStringSubmatch(userAgent)
	if match == nil {
		return ""
	}
	return match[1]
}

// ObservedProfile returns the fingerprint a native client of provider presents, or false. Claude
// learns only machine attributes (OS and architecture): runtime and SDK versions belong to the
// Claude Code release, which SubLane's version policy manages.
func ObservedProfile(provider string, headers http.Header) (ClientProfile, bool) {
	switch provider {
	case "codex":
		if platform := CodexClientPlatform(headers.Get("User-Agent")); platform != "" {
			return ClientProfile{Source: "learned", Platform: platform}, true
		}
	case "claude":
		os, arch := headers.Get("X-Stainless-Os"), headers.Get("X-Stainless-Arch")
		if claudeClient.MatchString(headers.Get("User-Agent")) && claudeOS.MatchString(os) && claudeArch.MatchString(arch) {
			return ClientProfile{Source: "learned", OS: os, Arch: arch}, true
		}
	}
	return ClientProfile{}, false
}

func (p ClientProfile) valid(provider string) bool {
	switch provider {
	case "codex":
		return p.OS == "" && p.Arch == "" && p.RuntimeVersion == "" && p.PackageVersion == "" && (p.Platform == "" || len(p.Platform) <= 160 && codexPlatform.MatchString(p.Platform))
	case "claude":
		return p.Platform == "" && (p.OS == "" || claudeOS.MatchString(p.OS)) && (p.Arch == "" || claudeArch.MatchString(p.Arch)) &&
			(p.RuntimeVersion == "" || claudeRuntime.MatchString(p.RuntimeVersion)) && (p.PackageVersion == "" || claudePackage.MatchString(p.PackageVersion))
	}
	return false
}

func (p ClientProfile) empty() bool {
	return p.Platform == "" && p.OS == "" && p.Arch == "" && p.RuntimeVersion == "" && p.PackageVersion == ""
}

func fingerprintProvider(provider string) bool { return provider == "codex" || provider == "claude" }

func decodeProfile(raw *string) ClientProfile {
	var profile ClientProfile
	if raw != nil {
		_ = json.Unmarshal([]byte(*raw), &profile)
	}
	return profile
}

// LearnClientProfile pins an account's fingerprint from its first native client. Later clients
// and an existing manual profile are never replaced.
func (s *Service) LearnClientProfile(ctx context.Context, id string, profile ClientProfile) error {
	row, err := s.get(ctx, id)
	if err != nil || row.ClientProfile != nil || !profile.valid(row.Provider) || profile.empty() {
		return err
	}
	raw, err := json.Marshal(profile)
	if err != nil {
		return err
	}
	encoded := string(raw)
	_, err = s.queries.LearnClientProfile(ctx, db.LearnClientProfileParams{ID: id, TenantID: s.tenantID, ClientProfile: &encoded})
	return err
}

// Fingerprint returns an account's current client fingerprint.
func (s *Service) Fingerprint(ctx context.Context, id string) (Fingerprint, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, err := s.get(ctx, id)
	if err != nil {
		return Fingerprint{}, err
	}
	if !fingerprintProvider(row.Provider) {
		return Fingerprint{}, ErrFingerprintUnsupported
	}
	result := Fingerprint{Provider: row.Provider, Profile: decodeProfile(row.ClientProfile)}
	if row.Provider == "claude" {
		credential, err := s.decrypt(row)
		if err != nil {
			return Fingerprint{}, err
		}
		if device := claudeDeviceID(credential.Metadata); device != "" {
			result.DeviceID = device[:8]
		}
	}
	return result, nil
}

// SetFingerprint stores an administrator's fingerprint. An empty profile clears it, so the next
// native client is learned again.
func (s *Service) SetFingerprint(ctx context.Context, id string, profile ClientProfile) (Fingerprint, error) {
	return s.changeFingerprint(ctx, id, &profile, false, "account.fingerprint")
}

// ResetFingerprint clears the profile; with device it also gives a Claude account a new device ID,
// which the provider sees as a new machine.
func (s *Service) ResetFingerprint(ctx context.Context, id string, device bool) (Fingerprint, error) {
	return s.changeFingerprint(ctx, id, nil, device, "account.fingerprint_reset")
}

func (s *Service) changeFingerprint(ctx context.Context, id string, profile *ClientProfile, device bool, action string) (Fingerprint, error) {
	s.mu.Lock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		s.mu.Unlock()
		return Fingerprint{}, err
	}
	defer tx.Rollback()
	q := s.queries.WithTx(tx)
	row, err := q.GetAccount(ctx, db.GetAccountParams{ID: id, TenantID: s.tenantID})
	if errors.Is(err, sql.ErrNoRows) {
		s.mu.Unlock()
		return Fingerprint{}, ErrNotFound
	}
	if err != nil {
		s.mu.Unlock()
		return Fingerprint{}, err
	}
	if !fingerprintProvider(row.Provider) || device && row.Provider != "claude" {
		s.mu.Unlock()
		return Fingerprint{}, ErrFingerprintUnsupported
	}
	var stored *string
	if profile != nil && !profile.empty() {
		profile.Source = "manual"
		if !profile.valid(row.Provider) {
			s.mu.Unlock()
			return Fingerprint{}, ErrInput
		}
		raw, err := json.Marshal(profile)
		if err != nil {
			s.mu.Unlock()
			return Fingerprint{}, err
		}
		encoded := string(raw)
		stored = &encoded
	}
	if _, err := q.SetClientProfile(ctx, db.SetClientProfileParams{ID: id, TenantID: s.tenantID, ClientProfile: stored, UpdatedAt: s.now().Unix()}); err != nil {
		s.mu.Unlock()
		return Fingerprint{}, err
	}
	if device {
		credential, err := s.decrypt(row)
		if err != nil {
			s.mu.Unlock()
			return Fingerprint{}, err
		}
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			s.mu.Unlock()
			return Fingerprint{}, err
		}
		if credential, _, err = prepareClaudeIdentity(credential, hex.EncodeToString(raw)); err != nil {
			s.mu.Unlock()
			return Fingerprint{}, err
		}
		if err := s.persist(ctx, q, id, credential, row.Status); err != nil {
			s.mu.Unlock()
			return Fingerprint{}, err
		}
	}
	if err := audit.Record(ctx, q, action, "account", id); err != nil {
		s.mu.Unlock()
		return Fingerprint{}, err
	}
	if err := tx.Commit(); err != nil {
		s.mu.Unlock()
		return Fingerprint{}, err
	}
	s.mu.Unlock()
	return s.Fingerprint(ctx, id)
}
