package accounts

import (
	"context"
	"errors"
	"net/http"
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
	if _, err := s.SetFingerprint(ctx, account.ID, ClientProfile{OS: "Plan9"}); !errors.Is(err, ErrInput) {
		t.Fatal("invalid OS accepted", err)
	}
	if _, err := s.SetFingerprint(ctx, account.ID, ClientProfile{Platform: "(Mac OS 15.5.0; arm64)"}); !errors.Is(err, ErrInput) {
		t.Fatal("Codex field accepted for Claude", err)
	}
	manual, err := s.SetFingerprint(ctx, account.ID, ClientProfile{OS: "Linux", Arch: "x64", RuntimeVersion: "v22.1.0"})
	if err != nil || manual.Profile.Source != "manual" || manual.Profile.OS != "Linux" || manual.Profile.RuntimeVersion != "v22.1.0" {
		t.Fatalf("manual fingerprint: %+v %v", manual, err)
	}
	// A manual profile is never overwritten by a learned one.
	if err := s.LearnClientProfile(ctx, account.ID, ClientProfile{Source: "learned", OS: "Windows", Arch: "x64"}); err != nil {
		t.Fatal(err)
	}
	credential, err := s.Prepare(ctx, account.ID, nil)
	if err != nil || credential.Profile.OS != "Linux" {
		t.Fatalf("manual fingerprint did not reach execution: %+v %v", credential.Profile, err)
	}
	reset, err := s.ResetFingerprint(ctx, account.ID, true)
	if err != nil || reset.Profile != (ClientProfile{}) || reset.DeviceID == before.DeviceID || len(reset.DeviceID) != 8 {
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
	codex, codexAccount, _ := refreshFixture(t, "codex", time.Hour)
	if _, err := codex.ResetFingerprint(context.Background(), codexAccount.ID, true); !errors.Is(err, ErrFingerprintUnsupported) {
		t.Fatal("Codex accepted a device reset", err)
	}
}
