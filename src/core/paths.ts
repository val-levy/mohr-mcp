import { fileURLToPath } from 'node:url';

// This file sits two levels below the package root in both src/core/ and the compiled dist/core/.
const PACKAGE_ROOT = new URL('../../', import.meta.url);

/** Absolute path of a file or directory shipped with the package, e.g. `db/migrations`. */
export function packagePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, PACKAGE_ROOT));
}
