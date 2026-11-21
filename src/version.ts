import pkg from "../package.json";

/** The released version (package.json) and, in images, the git ref they were built from. */
export const VERSION: string = pkg.version;
export const BUILD: string | null = process.env.BINDER_BUILD || null;
