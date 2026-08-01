# Continuous Integration

`.github/workflows/ci.yml` runs on every push to `main` and on every pull request.

## What it covers

- **`test`** — matrix job on `macos-latest` and `windows-latest`. Checks out the
  repo, sets up Node 20 (with npm's cache handled by `actions/setup-node`), runs
  `npm ci`, then `npm test`. The core (formats, digitizing, lettering, etc.) is
  plain Node, so the full `tests/*.test.js` suite runs on both OSes with no
  Electron/GUI environment needed.
- **`package`** — `macos-latest` only, runs after `test` succeeds. Builds an
  unsigned app with `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir`
  and checks that `dist/mac*/Bastidor.app/Contents/MacOS/Bastidor` exists and is
  executable. This is a packaging smoke test only: no dmg/zip, no signing, no
  notarization, nothing is uploaded anywhere.
- **Concurrency**: pushing new commits to the same branch or PR cancels the
  older, still-running CI run for that ref, instead of queueing both.

## What it does not cover

- No Windows packaging (only macOS runs `electron-builder`).
- No signing/notarization/release artifacts.
- The Electron UI harness mentioned in issue #34 is not wired in here; it can
  be added as its own job later.
- The workflow reports pass/fail on every PR, but by itself it does not block
  merging — that requires the manual step below.

## Manual step: branch protection (owner-only)

GitHub Actions results do not block merges on their own. To make `main`
actually require green CI, a repository **owner/admin** needs to turn on
branch protection by hand, once:

1. **Settings > Branches** in `diogobernini/bastidor`.
2. Add (or edit) a protection rule for `main`.
3. Enable **Require status checks to pass before merging**.
4. Search for and select the checks: `test (macos-latest)`, `test (windows-latest)`,
   and `package`. (They only show up in the picker after the workflow has run
   at least once on the repo, e.g. from this PR.)
5. Save.

This is intentionally not automated: it needs repository admin permissions
that a CI token or an agent should not be granted, so it is left as a manual,
one-time action for the owner.
