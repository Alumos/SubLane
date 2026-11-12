package accounts

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestObservedProfileKeepsOnlyNativeMachineAttributes(t *testing.T) {
	for _, test := range []struct {
		provider string
		headers  http.Header
		want     ClientProfile
	}{
		{"codex", http.Header{"User-Agent": {"codex_cli_rs/0.46.0 (Mac OS 15.5.0; arm64) iTerm.app/3.6.1"}}, ClientProfile{Source: "learned", Platform: "(Mac OS 15.5.0; arm64) iTerm.app/3.6.1"}},
		{"codex", http.Header{"User-Agent": {"codex-tui/0.154.0 (Windows 10.0.26100; x86_64) WindowsTerminal (codex-tui)"}}, ClientProfile{Source: "learned", Platform: "(Windows 10.0.26100; x86_64) WindowsTerminal"}},
		{"codex", http.Header{"User-Agent": {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}}, ClientProfile{}},
		// os_info reports free-text versions, and the terminal falls back to TERM over SSH.
		{"codex", http.Header{"User-Agent": {"codex_cli_rs/0.155.1 (Arch Linux Rolling Release; x86_64) xterm-256color"}}, ClientProfile{Source: "learned", Platform: "(Arch Linux Rolling Release; x86_64) xterm-256color"}},
		{"codex", http.Header{"User-Agent": {"codex_exec/0.155.1 (Ubuntu 24.4.0; aarch64) unknown"}}, ClientProfile{Source: "learned", Platform: "(Ubuntu 24.4.0; aarch64) unknown"}},
		{"claude", http.Header{"User-Agent": {"claude-cli/2.1.287 (external, cli)"}, "X-Stainless-Os": {"Windows"}, "X-Stainless-Arch": {"x64"}, "X-Stainless-Runtime-Version": {"v22.1.0"}}, ClientProfile{Source: "learned", OS: "Windows", Arch: "x64"}},
		{"claude", http.Header{"User-Agent": {"SyntheticClient/1.0"}, "X-Stainless-Os": {"Windows"}, "X-Stainless-Arch": {"x64"}}, ClientProfile{}},
		{"claude", http.Header{"User-Agent": {"claude-cli/2.1.287 (external, cli)"}, "X-Stainless-Os": {"Plan9"}, "X-Stainless-Arch": {"x64"}}, ClientProfile{}},
	} {
		got, _ := ObservedProfile(test.provider, test.headers)
		if got != test.want {
			t.Errorf("%s %v: got %+v, want %+v", test.provider, test.headers, got, test.want)
		}
	}
}

func TestLearnedProfileIsPinnedAndReachesExecution(t *testing.T) {
	s, account, _ := refreshFixture(t, "codex", time.Hour)
	ctx := context.Background()
	if err := s.LearnClientProfile(ctx, account.ID, ClientProfile{Source: "learned", Platform: "(Mac OS 15.5.0; arm64) iTerm.app/3.6.1"}); err != nil {
		t.Fatal(err)
	}
	// A later client on another machine must not replace the account's fingerprint.
	if err := s.LearnClientProfile(ctx, account.ID, ClientProfile{Source: "learned", Platform: "(Windows 10.0.26100; x86_64) WindowsTerminal"}); err != nil {
		t.Fatal(err)
	}
	credential, err := s.Prepare(ctx, account.ID, nil)
	if err != nil || credential.Profile.Platform != "(Mac OS 15.5.0; arm64) iTerm.app/3.6.1" {
		t.Fatalf("pinned platform missing from execution credential: %+v %v", credential.Profile, err)
	}
}

func TestManualFingerprintValidatesAndResetRelearns(t *testing.T) {
	s, account, _ := refreshFixture(t, "claude", time.Hour)
	ctx := context.Background()
	if _, err := s.Prepare(ctx, account.ID, nil); err != nil {
		t.Fatal(err)
	}
	before, err := s.Fingerprint(ctx, account.ID)
	if err != nil || before.Provider != "claude" || len(before.DeviceID) != 8 || before.Profile.Source != "" {
		t.Fatalf("initial fingerprint: %+v %v", before, err)
	}
	if _, err := s.SetFingerprint(ctx, account.ID, ClientProfile{OS: "Plan9"}, ClientIdentity{Mode: "off"}); !errors.Is(err, ErrInput) {
		t.Fatal("invalid OS accepted", err)
	}
	if _, err := s.SetFingerprint(ctx, account.ID, ClientProfile{Platform: "(Mac OS 15.5.0; arm64)"}, ClientIdentity{Mode: "off"}); !errors.Is(err, ErrInput) {
		t.Fatal("Codex field accepted for Claude", err)
	}
	manual, err := s.SetFingerprint(ctx, account.ID, ClientProfile{OS: "Linux", Arch: "x64", RuntimeVersion: "v22.1.0"}, ClientIdentity{Mode: "off", TLS: true})
	if err != nil || manual.Profile.Source != "manual" || manual.Profile.OS != "Linux" || manual.Profile.RuntimeVersion != "v22.1.0" || !manual.Identity.TLS {
		t.Fatalf("manual fingerprint: %+v %v", manual, err)
	}
	// A manual profile is never overwritten by a learned one.
	if err := s.LearnClientProfile(ctx, account.ID, ClientProfile{Source: "learned", OS: "Windows", Arch: "x64"}); err != nil {
		t.Fatal(err)
	}
	credential, err := s.Prepare(ctx, account.ID, nil)
	if err != nil || credential.Profile.OS != "Linux" || !credential.Identity.TLS {
		t.Fatalf("manual fingerprint did not reach execution: %+v %v", credential.Profile, err)
	}
	reset, err := s.ResetFingerprint(ctx, account.ID, true)
	// Reset clears the learned or manual profile but keeps the administrator's identity settings.
	if err != nil || reset.Profile != (ClientProfile{}) || reset.DeviceID == before.DeviceID || len(reset.DeviceID) != 8 || !reset.Identity.TLS {
		t.Fatalf("reset kept fingerprint or device: %+v %v", reset, err)
	}
	if err := s.LearnClientProfile(ctx, account.ID, ClientProfile{Source: "learned", OS: "Windows", Arch: "x64"}); err != nil {
		t.Fatal(err)
	}
	if relearned, err := s.Fingerprint(ctx, account.ID); err != nil || relearned.Profile.OS != "Windows" || relearned.Profile.Source != "learned" {
		t.Fatalf("reset account did not learn again: %+v %v", relearned, err)
	}
}

func TestFingerprintRejectsProvidersWithoutOne(t *testing.T) {
	s, account, _ := refreshFixture(t, "antigravity", time.Hour)
	if _, err := s.Fingerprint(context.Background(), account.ID); !errors.Is(err, ErrFingerprintUnsupported) {
		t.Fatal(err)
	}
}

func TestCodexConvergenceSeedsAndRotatesInstallation(t *testing.T) {
	s, account, _ := refreshFixture(t, "codex", time.Hour)
	ctx := context.Background()
	if _, err := s.SetFingerprint(ctx, account.ID, ClientProfile{}, ClientIdentity{Mode: "loud"}); !errors.Is(err, ErrInput) {
		t.Fatal("unknown mode accepted", err)
	}
	if _, err := s.SetFingerprint(ctx, account.ID, ClientProfile{}, ClientIdentity{Mode: "off", TLS: true}); !errors.Is(err, ErrInput) {
		t.Fatal("Claude TLS profile accepted for Codex", err)
	}
	converged, err := s.SetFingerprint(ctx, account.ID, ClientProfile{}, ClientIdentity{Mode: "session"})
	if err != nil || converged.Identity.Mode != "session" || len(converged.DeviceID) != 8 {
		t.Fatalf("convergence not enabled: %+v %v", converged, err)
	}
	credential, err := s.Prepare(ctx, account.ID, nil)
	if err != nil || credential.Identity.Seed == "" || CodexInstallationID(credential.Identity.Seed)[:8] != converged.DeviceID {
		t.Fatalf("execution lacks the converged seed: %+v %v", credential.Identity, err)
	}
	// The converged identity is stable until an administrator asks for a new device.
	again, err := s.SetFingerprint(ctx, account.ID, ClientProfile{}, ClientIdentity{Mode: "full"})
	if err != nil || again.DeviceID != converged.DeviceID {
		t.Fatalf("mode change rotated the device: %+v %v", again, err)
	}
	rotated, err := s.ResetFingerprint(ctx, account.ID, true)
	if err != nil || rotated.DeviceID == converged.DeviceID || rotated.Identity.Mode != "full" {
		t.Fatalf("device reset kept the installation: %+v %v", rotated, err)
	}
}

func TestDerivedCodexIdentifiersAreStableUUIDs(t *testing.T) {
	seed := "6f1f8e7a-6b1c-4c55-9a43-0c1d2e3f4a5b"
	for _, id := range []string{CodexInstallationID(seed), CodexSessionID(seed), CodexThreadID(seed, "a")} {
		if len(id) != 36 || id[14] != '4' || !strings.ContainsRune("89ab", rune(id[19])) {
			t.Fatal("not a UUIDv4", id)
		}
	}
	if CodexInstallationID(seed) != CodexInstallationID(seed) || CodexThreadID(seed, "a") == CodexThreadID(seed, "b") || CodexSessionID(seed) == CodexInstallationID(seed) {
		t.Fatal("derived identifiers are not stable and distinct")
	}
}
