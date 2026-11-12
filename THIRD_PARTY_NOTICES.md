# Third-party notices

SubLane is licensed under AGPL-3.0-only. Third-party components retain their own licenses.

## Shadcn Admin

- Project: https://github.com/satnaing/shadcn-admin
- Revision: `e16c87f213a5ba5e45964e9b67c792105ec74d26`
- Copyright: (c) 2024 Sat Naing
- License: MIT; full text in `licenses/shadcn-admin.txt`.
- Adapted files: `web/src/components/ui/`, `web/src/hooks/use-mobile.ts`, and the `cn` function in `web/src/lib/cn.ts`. The application shell and `Session` menu follow the upstream header, sidebar, and NavUser patterns.
- Changes: component filename conventions, local import paths, bilingual accessibility labels, menu checkmarks and touch targets, and removal of the unused randomized sidebar skeleton. SubLane uses its own administrator session and business routes.

Go and JavaScript dependencies are pinned in `go.mod`, `go.sum`, `web/package.json`, and `web/pnpm-lock.yaml`. Their licenses remain available in their respective source packages. CLIProxyAPI SDK packages are linked as described below.

The Radix dropdown menu is pinned to 2.1.16 alongside Dialog 1.1.15 so they share focus-scope and dismissable-layer dependencies. Keep those primitives aligned when upgrading and verify keyboard focus in the account menu inside the mobile navigation sheet.

## Prism

- Project: https://github.com/PrismJS/prism, version `1.30.0`.
- Copyright: (c) 2012 Lea Verou.
- License: MIT; full text in `licenses/prismjs.txt`.
- Integration: Prism core and its regular-expression grammar tokenize local editor input. React renders token text without highlighted HTML or page-wide DOM mutation; Go RE2 remains the validation authority.

## chi and sqlc

- chi: https://github.com/go-chi/chi, version `v5.3.2`, MIT; full text in `licenses/chi.txt`. Used for HTTP routing over `net/http`.
- sqlc: https://github.com/sqlc-dev/sqlc, version `v1.31.1`, MIT. Used during development to generate Go from SQL; the generator itself is not shipped in the runtime binary.

## Inter

- Project: https://github.com/rsms/inter
- Copyright: (c) 2020 The Inter Project Authors
- License: SIL Open Font License 1.1; full text in `brand/source/OFL.txt`.
- Font source: Google Fonts, revision `1edf95b4328bc5997ca93d2c0c7205272ec7347f`, `ofl/inter/Inter[opsz,wght].ttf`.
- The unmodified variable font is included as `brand/source/Inter.ttf`. Brand graphics use outlined glyphs generated at the documented weights and optical size.
- Brand export tooling is isolated in `tools/brand`; it does not add a font or graphics renderer to the application runtime.

## CLIProxyAPI

- Project: https://github.com/router-for-me/CLIProxyAPI
- Version: `v8.0.35` (pinned in `go.mod` and `go.sum`).
- License: MIT; full text in `licenses/cliproxyapi.txt`.
- Integration: public `sdk/cliproxy`, auth/executor interfaces, `sdk/auth` Antigravity helpers, `sdk/api`, `sdk/config`, and translator packages. SubLane retains OAuth state, encrypted persistence, refresh orchestration, routing, and transport ownership. Codex/Claude OAuth parameters and provider metadata handling are adapted from this version’s MIT-licensed sources. Antigravity authorization and refresh reuse public SDK interfaces; Google installed-app client credentials are not duplicated in SubLane source.
- The SDK starts an internal loopback HTTP listener with all routes blocked, an empty credential registry, a no-op watcher, and automatic refresh disabled. Its CLI, management panel, Home mode, and Redis service are not enabled.

## uTLS

- Project: https://github.com/refraction-networking/utls, version `v1.8.2` (pinned in `go.mod` and `go.sum`).
- License: BSD-3-Clause; full text in `licenses/utls.txt`.
- Used to present Claude Code's TLS ClientHello on Claude accounts that opt in to the TLS fingerprint. The Node.js 24 ClientHello parameters follow the capture published by sub2api (https://github.com/Wei-Shaw/sub2api); no sub2api source code is included.

## Provider logos (Lobe Icons)

- Project: https://github.com/lobehub/lobe-icons
- Revision: `a94750e3f5f8fc33757b839d85030e742284e43a`.
- Copyright: (c) 2023 LobeHub.
- License: MIT; full text in `licenses/lobe-icons.txt`.
- Adapted files: `packages/static-svg/icons/codex-color.svg`, `claude-color.svg`, and `antigravity-color.svg`. They are bundled under `web/src/assets/providers/` and displayed by `ProviderLogo.tsx` with decorative accessibility semantics, retaining their original brand colors. API platform icons from the same revision are bundled under `web/src/assets/channels/` and displayed by `ChannelLogo.tsx`. No icon package or remote asset request is required at runtime.
- Provider names and marks remain the property of their respective owners.

## git-cliff

- Project: https://github.com/orhun/git-cliff, version `2.14.2`.
- License for the adapted template: MIT; full text in `licenses/git-cliff.txt` (upstream also offers Apache-2.0).
- Adapted file: `cliff.toml`, based on the upstream Keep a Changelog example, with SubLane-specific Conventional Commit categories, breaking-change visibility and comparison links.
- The generator is a development/CI tool and is not included in the application binary or container runtime.

## Browser authentication

- WebAuthn: https://github.com/go-webauthn/webauthn, version `v0.18.2`, BSD-3-Clause; full text in `licenses/webauthn.txt`. Validates passkey registration and assertions, including origin, challenge, user verification, and authenticator state.
- OTP: https://github.com/pquerna/otp, version `v1.5.0`, Apache-2.0; full text in `licenses/otp.txt`, with its notice in `licenses/otp-NOTICE.txt`. Generates TOTP setup keys, QR codes and time-based verification codes. SubLane owns encryption, replay prevention, recovery-code consumption, sessions and policy.

## Encrypted backups

- Project: https://github.com/FiloSottile/age, version `v1.3.2`, BSD-3-Clause; full text in `licenses/age.txt`.
- Integration: binary age v1 password encryption around the existing streamed gzip/tar backup. SubLane enforces password input limits, caps imported scrypt work, validates through authenticated EOF, and owns archive bounds, key separation, private staging and atomic publication.
