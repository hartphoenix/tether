/** Compare numeric release versions without pinning build or commit metadata. */
export function versionAtLeast(version: unknown, minimumVersion: string): version is string {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const actual = version.split(".").map(Number);
  const minimum = minimumVersion.split(".").map(Number);
  if (!actual.every(Number.isSafeInteger)) return false;
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] !== minimum[index]) return actual[index]! > minimum[index]!;
  }
  return true;
}
