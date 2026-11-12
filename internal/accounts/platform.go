package accounts

import (
	"context"
	"regexp"

	"github.com/murongg/SubLane/internal/storage/db"
)

// codexClientAgent matches a native Codex User-Agent:
// "<originator>/<version> (<os> <os version>; <arch>) <terminal>[ (<suffix>)]".
// Only the platform and terminal are kept; the version always comes from SubLane's version policy.
var codexClientAgent = regexp.MustCompile(`^(?:codex_cli_rs|codex-tui|codex_exec|codex_vscode)/[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]{0,24} (\([A-Za-z][A-Za-z0-9 ._-]{0,48} [0-9][0-9A-Za-z._-]{0,24}; [A-Za-z0-9_]{1,16}\)(?: [A-Za-z0-9][A-Za-z0-9._+-]{0,40}(?:/[A-Za-z0-9._+-]{1,40})?)?)`)

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

// LearnClientPlatform pins an account's client platform from its first native client. Later
// observations never replace it, so every client sharing the account presents one fingerprint.
func (s *Service) LearnClientPlatform(ctx context.Context, id, platform string) error {
	if platform == "" || len(platform) > 160 {
		return nil
	}
	_, err := s.queries.LearnClientPlatform(ctx, db.LearnClientPlatformParams{ID: id, TenantID: s.tenantID, ClientPlatform: &platform})
	return err
}
