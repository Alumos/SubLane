package accounts

import (
	"context"
	"testing"
	"time"
)

func TestCodexClientPlatformKeepsOnlyNativePlatform(t *testing.T) {
	for agent, want := range map[string]string{
		"codex_cli_rs/0.46.0 (Mac OS 15.5.0; arm64) iTerm.app/3.6.1":                 "(Mac OS 15.5.0; arm64) iTerm.app/3.6.1",
		"codex-tui/0.154.0 (Windows 10.0.26100; x86_64) WindowsTerminal (codex-tui)": "(Windows 10.0.26100; x86_64) WindowsTerminal",
		"codex_exec/0.50.0 (Ubuntu 24.04; x86_64)":                                   "(Ubuntu 24.04; x86_64)",
		"claude-cli/2.1.287 (external, cli)":                                         "",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)":                            "",
		"codex_cli_rs/0.46.0":                                                        "",
	} {
		if got := CodexClientPlatform(agent); got != want {
			t.Errorf("%q: got %q, want %q", agent, got, want)
		}
	}
}

func TestLearnedClientPlatformIsPinnedAndReachesExecution(t *testing.T) {
	s, account, _ := refreshFixture(t, "codex", time.Hour)
	ctx := context.Background()
	if err := s.LearnClientPlatform(ctx, account.ID, "(Mac OS 15.5.0; arm64) iTerm.app/3.6.1"); err != nil {
		t.Fatal(err)
	}
	// A later client on another machine must not replace the account's fingerprint.
	if err := s.LearnClientPlatform(ctx, account.ID, "(Windows 10.0.26100; x86_64) WindowsTerminal"); err != nil {
		t.Fatal(err)
	}
	credential, err := s.Prepare(ctx, account.ID, nil)
	if err != nil || credential.ClientPlatform != "(Mac OS 15.5.0; arm64) iTerm.app/3.6.1" {
		t.Fatalf("pinned platform missing from execution credential: %q %v", credential.ClientPlatform, err)
	}
}
