# Distribution (macOS signing/notarization, Windows, releases)

Everything below is already wired in code (`package.json` build config,
`build/notarize.js`, `.github/workflows/release.yml`, electron-updater in
`src/main/main.js`). Nobody is prompted for a password until *you* run
step 1 below on your own Mac. This is the exact, minimal path to turn it on.

## 1. Authorize codesign in your keychain (one time, local)

The "Developer ID Application: VISIMOB TECNOLOGIAS EIRELI (7P4NY6VY5Q)"
certificate is already in your login keychain, but codesign/electron-builder
can't use it non-interactively until macOS records your approval.

From a normal Terminal (not through any automation/CI), with the cert's
private key unlocked in your keychain:

```bash
npm run dist:mac
```

Run it **without** `CSC_IDENTITY_AUTO_DISCOVERY=false`. When macOS shows a
"codesign wants to sign using key ... in your keychain" prompt, enter your
login password and click **Always Allow**. From then on, local signed builds
no longer prompt.

## 2. Create an app-specific password (for notarization)

1. https://appleid.apple.com -> Sign-In and Security -> App-Specific Passwords.
2. Generate one (label it `bastidor-notarize`) and save it now — Apple shows it once.

## 3. Confirm your Team ID

https://developer.apple.com/account -> Membership details. The `7P4NY6VY5Q`
in the certificate name is very likely already your Team ID; confirm it
matches there.

## 4. Set the repo secrets

GitHub -> repo -> Settings -> Secrets and variables -> Actions -> New
repository secret (or `gh secret set NAME --repo diogobernini/bastidor`).
Add all five — the release workflow degrades gracefully if any are missing:

| Secret | Value |
|---|---|
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | Password from step 2 |
| `APPLE_TEAM_ID` | Team ID from step 3 |
| `CSC_LINK` | Base64 of the exported `.p12` (below) |
| `CSC_KEY_PASSWORD` | Export password you set for that `.p12` |

To get the `.p12` for `CSC_LINK`:

```bash
# Keychain Access -> My Certificates -> "Developer ID Application: VISIMOB
# TECNOLOGIAS EIRELI (7P4NY6VY5Q)" -> right-click -> Export... -> save as
# DeveloperID.p12, set an export password (this is CSC_KEY_PASSWORD).
base64 -i DeveloperID.p12 | pbcopy   # paste this as the CSC_LINK secret
rm DeveloperID.p12                   # delete the local export once saved
```

## 5. Tag a release

```bash
git checkout main && git pull
git tag v0.2.0
git push origin v0.2.0
```

The tag push runs `.github/workflows/release.yml`: builds macOS (dmg/zip,
signed + notarized once the secrets exist) and Windows (nsis/portable,
x64), then attaches every artifact to a GitHub Release named `v0.2.0`.

## Notes

- No secrets yet -> the workflow still runs, producing **unsigned** artifacts
  (Gatekeeper/SmartScreen will warn). That is today's safe default.
- `build/notarize.js` only calls Apple when `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` are all set; otherwise it
  logs a skip line and does nothing.
- electron-updater checks this repo's Releases (`build.publish` in
  `package.json`), but only in packaged builds and only if
  `updates.autoCheck` isn't disabled in the user's `settings.json` (default
  `true`). It starts working the first time a release is tagged here — no
  further setup needed.
