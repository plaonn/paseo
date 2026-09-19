# Development artifact delivery

Use the fork's Git history as the source of truth and keep development artifacts
separate from production releases.

## Source changes

- Keep personal changes on `plaonn/local` until upstream absorbs them.
- Refer to source changes by branch and commit. Do not commit generated APKs or
  ZIP files to the repository.
- Keep the existing `main` branch as the upstream synchronization baseline.

## Android development builds

Use the **Android Dev APK** GitHub Actions workflow for native changes:

1. Run it manually for the desired branch or commit.
2. Build the `development` EAS profile (`Paseo Debug`, package
   `sh.paseo.debug`).
3. Download the workflow artifact and verify its `SHA256SUMS.txt` file.

Workflow artifacts are the default delivery channel for iterative builds. They
retain build history without creating a GitHub Release for every change and are
kept for 14 days.

Set `publish_latest` when a build needs a stable browser URL. That option
updates the single prerelease tagged `dev-latest` and replaces its
`paseo-debug.apk` asset. The public `dev-latest` asset is for convenient testing,
not a production release.

The existing `android-apk-release.yml` workflow remains for production or
versioned APK releases. Do not use it for every development iteration.

## JavaScript-only changes

Reuse an installed `Paseo Debug` client with Metro when working against a local
development environment. Use an EAS Update channel only when that channel is
configured and the change does not require a native rebuild.

## Other artifacts

- Use Actions artifacts for short-lived logs, screenshots, and diagnostic ZIPs.
- Keep private or secret-bearing material out of public Releases and repository
  history.
- Use a versioned GitHub Release only for a build that should be retained or
  shared as a milestone.

Paseo's own workspace download remains a separate product path. Until relay-aware
file transfer is fixed, do not make it the only delivery path for artifacts.
