'use strict';
// electron-builder afterSign hook (issue #31): submits the signed .app for
// Apple notarization with @electron/notarize.
//
// Gated on purpose: this only runs when all three Apple credentials are
// present in the environment. Without them (any local/dev build, and CI
// runs until the secrets are configured) it just logs and returns, so
// nobody is ever prompted for a password. See docs/DISTRIBUTION.md for how
// to obtain and set APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID.

const { notarize } = require('@electron/notarize');

module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log(
      '[notarize] APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID not set in the environment — skipping notarization.'
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[notarize] submitting ${appPath} to Apple (this can take several minutes)…`);
  await notarize({
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('[notarize] done.');
};
