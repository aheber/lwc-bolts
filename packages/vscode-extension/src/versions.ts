/** Parses `major.minor.patch` from a version such as `v24.21.0` or `7.1.0-beta`, ignoring any suffix. */
function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Compares two `[major, minor, patch]` versions. */
function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * Whether `version` satisfies an `engines.node` range of the form `>=major[.minor[.patch]]`, the only
 * form supported. Anything else, or a version that can't be parsed, doesn't satisfy it.
 */
export function satisfiesMinimum(version: string, range: string | undefined): boolean {
  const minimum = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range?.trim() ?? "");
  const actual = parseVersion(version);
  if (!minimum || !actual) {
    return false;
  }
  return compare(actual, [Number(minimum[1]), Number(minimum[2] ?? 0), Number(minimum[3] ?? 0)]) >= 0;
}
