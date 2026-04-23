# Security Policy

GhostBrowse is a browser-impersonating HTTP client. Network access is a core
runtime capability of the package.

## Expected Capabilities

- `createBrowserNative()` uses the runtime `fetch` implementation.
- `createBrowser()` can use an external `curl-impersonate` binary when one is
  installed by the user and available through `GHOSTBROWSE_CURL_IMPERSONATE` or
  `PATH`.
- The package does not bundle Chromium, browser binaries, or curl binaries.
- The package has no runtime dependencies.
- The package has no install, postinstall, or prepare scripts.
- The package does not collect telemetry.

## Socket.dev

Socket.dev may report `networkAccess`. That is expected for an HTTP client and
is accepted for this repository. Other high-risk supply-chain findings should be
treated as regressions.

## Reporting

Please report security issues through GitHub issues or GitHub private security
advisories for this repository.
