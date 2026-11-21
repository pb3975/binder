# Security policy

Binder serves HTML written by agents, so isolation bugs matter. Thank you for reporting them privately.

## Report a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security bug.

Include what you found, how to reproduce it, and the impact you expect. You will get an answer within 7 days.

## In scope

- An artifact page that can read or change Binder, its other artifacts, or a user's session.
- A preview render that can reach local files, internal network services, or anything outside the preview allowlist.
- Authentication bypass, token or session forgery, or a way to spoof the trusted proxy header.
- Path traversal, or reading another version's files without its signed URL.
- Script running in Binder's own pages (the UI shell).

## Known limits (not vulnerabilities)

These are documented trade-offs. See [docs/design.md](docs/design.md).

- A page can read its own signed URL and send it elsewhere. That grants read access to that one version until the URL expires (8 to 9 hours).
- Chromium in the `full` image runs without its own sandbox. Use the default `slim` image if you do not trust your publishers.
- In header mode, any process on the same host that can reach Binder's port can claim to be the proxy.
- Binder speaks plain HTTP. Put TLS in front of it.

## Supported versions

Only the latest release gets security fixes.
