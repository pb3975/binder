# Releasing Binder

Binder uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). [CHANGELOG.md](../CHANGELOG.md) is the record of every release, and `package.json` holds the current version.

## What a version number promises

| Change | Before 1.0 | From 1.0 |
|---|---|---|
| A fix that changes no behavior people rely on | patch (0.2.0 to 0.2.1) | patch |
| New feature, new env variable, new API route or field, a database schema upgrade | minor (0.2 to 0.3) | minor |
| Anything that breaks an existing setup: a removed or renamed env variable, a changed default for auth, a removed API route or field, a data change an older Binder cannot read back | minor, with an **Upgrading** note in the changelog | major |

- The publish API (`POST /api/artifacts`) is v1. Changes inside v1 are additive only, at any version.
- Binder upgrades its database schema on start and cannot downgrade it. Every release that changes the schema says so in the changelog and tells people to back up first.
- Security fixes go to the latest minor release only (see [SECURITY.md](../SECURITY.md)).

## What a release publishes

A tag `vX.Y.Z` runs `.github/workflows/release.yml`:

1. Checks that the tag, `package.json`, and a dated `## [X.Y.Z]` section in `CHANGELOG.md` agree (`scripts/release-check.ts`).
2. Builds both images for `linux/amd64` and `linux/arm64`, with an SBOM and build provenance, and pushes them to `ghcr.io/pb3975/binder`:
   - `X.Y.Z`, `X.Y`, and `latest`: the `slim` image (the default).
   - `X.Y.Z-full`, `X.Y-full`, and `latest-full`: the `full` image with Chromium previews.
   - A pre-release tag such as `v0.3.0-rc.1` never moves `latest`.
3. Pulls the image without logging in, starts it, and checks that `/healthz` reports the version.
4. Creates the GitHub release with that version's changelog section as its notes.

Pull requests that change the Dockerfile, the release workflow, `package.json`, or the changelog run steps 1 and 2 without pushing anything.

## Make a release

1. Open a pull request that:
   - renames `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and adds a new empty `## [Unreleased]` above it,
   - sets `"version": "X.Y.Z"` in `package.json`,
   - updates the compare links at the bottom of the changelog.
2. Merge it when CI passes.
3. Tag the merge commit on `main` and push the tag:

   ```sh
   git switch main && git pull
   git tag -a vX.Y.Z -m "Binder X.Y.Z"
   git push origin vX.Y.Z
   ```

4. Watch the release workflow. When it finishes, check the release page and `docker pull ghcr.io/pb3975/binder:X.Y.Z`.

If a release is broken, do not move or delete its tag. Fix forward with a patch release.
