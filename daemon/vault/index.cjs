// Phase 7 Plan 1: barrel exports for daemon/vault/*.
//
// Plan 07-02 extends this barrel with parseWikilinks / buildVaultIndex /
// resolveWikilink from ./wikilink.cjs.

const config = require('./config.cjs');
const glob = require('./glob.cjs');

module.exports = {
  loadVaultConfig: config.loadVaultConfig,
  saveVaultConfig: config.saveVaultConfig,
  vaultConfigPath: config.vaultConfigPath,
  defaultVaultConfig: config.defaultVaultConfig,
  checkVaultAccess: glob.checkVaultAccess,
  makeMatcher: glob.makeMatcher,
};
