import pkg from '../package.json';

/**
 * The version this bundle was built from. app.config.ts feeds the same
 * package.json number to the native projects, so it matches the store listing.
 */
export const APP_VERSION: string = pkg.version;
