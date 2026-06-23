# Release

OpenMindSteed currently supports local development builds and debug macOS app bundles. Production release signing is intentionally separate from local development because it requires Apple Developer credentials.

## Local Debug Bundle

```bash
corepack enable
pnpm install
pnpm exec tauri build --debug --bundles app
```

The debug app bundle is written to:

```text
src-tauri/target/debug/bundle/macos/OpenMindSteed.app
```

This bundle is useful for local smoke testing. It is not a notarized public release.

## Release Build

```bash
pnpm run tauri:build
```

Run the full verification set before cutting a release:

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run test:e2e
pnpm run build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

## App Icon

The source icon is `src-tauri/icons/app-icon.png`, copied from the original MindSteed AppIcon source so the open-source desktop build keeps the same app identity. Tauri-generated desktop icon assets are committed under `src-tauri/icons/` and wired in `src-tauri/tauri.conf.json`.

Regenerate the icon set after replacing the PNG source:

```bash
pnpm exec tauri icon src-tauri/icons/app-icon.png
```

Then run a debug bundle smoke check:

```bash
pnpm exec tauri build --debug --bundles app
```

## GitHub Release Workflow

The repository includes `.github/workflows/release.yml`.

Run it in either mode:

- Push a semantic version tag such as `v0.1.0` to build macOS artifacts and publish a GitHub Release.
- Use `workflow_dispatch` from GitHub Actions to build and upload artifacts without creating a tag release.

The workflow:

1. Installs Node 22.13.0 and Rust stable.
2. Runs lint, typecheck, unit tests, web build, and Playwright smoke tests.
3. Runs Rust fmt, tests, and check.
4. Runs `pnpm run tauri:build`.
5. Collects `.dmg`, `.tar.gz`, `.zip`, and zipped `.app` artifacts into `release-assets/`.
6. Uploads artifacts; for tag builds, publishes them to the GitHub Release with `gh release create`.

If Apple signing secrets are not configured, the workflow builds unsigned macOS artifacts. When `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, and `APPLE_SIGNING_IDENTITY` are all present, the signed build path is used.

## macOS Signing and Notarization

Tauri's macOS signing flow requires an Apple Developer account and code-signing certificate. For distribution outside the Mac App Store, use a `Developer ID Application` certificate. Free Apple Developer accounts can sign for development testing but cannot notarize public downloads.

Set these as GitHub Actions repository secrets for signed/notarized CI releases, or as local shell variables for local release builds:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_CERTIFICATE="<base64-p12-certificate>"
export APPLE_CERTIFICATE_PASSWORD="<p12-password>"
export APPLE_ID="<apple-id-email>"
export APPLE_PASSWORD="<app-specific-password>"
export APPLE_TEAM_ID="<team-id>"
```

For API-key based notarization, Tauri also supports `APPLE_API_KEY` and `APPLE_API_ISSUER`. Keep all signing values in local shell secrets or CI secrets; never commit them.

References:

- Tauri macOS code signing: https://v2.tauri.app/distribute/sign/macos/
- Tauri environment variables: https://v2.tauri.app/reference/environment-variables/
