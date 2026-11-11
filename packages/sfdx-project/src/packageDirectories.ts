// An SFDX project's package directories (sfdx-project.json's `packageDirectories`), and the `lwc` folders
// in them where components live.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "jsonc-parser";

export const SFDX_PROJECT_FILE = "sfdx-project.json";

/**
 * A path as tsconfig `include` and sfdx-project.json spell it: forward slashes, without `./` or a trailing
 * `/`, and with `..` and repeated slashes resolved, as the Salesforce CLI resolves package directories.
 */
export function normalizePath(value: string): string {
  const slashes = value.replace(/\\/g, "/");
  // path.posix.normalize turns "" into "."
  if (slashes === "") {
    return "";
  }
  return path.posix
    .normalize(slashes)
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
}

/**
 * The `packageDirectories` paths of the SFDX project at `root`, normalized and without duplicates, or
 * undefined when sfdx-project.json can't be read or has none listed.
 */
export function readPackageDirectories(root: string): string[] | undefined {
  const entries = readPackageDirectoryEntries(root);
  return entries === undefined ? undefined : [...new Set(entries.map((entry) => entry.path))];
}

/**
 * The default package directory of the SFDX project at `root`, normalized: the one marked `"default":
 * true`, as the Salesforce CLI uses for new metadata, or the first listed when none is. Undefined when
 * sfdx-project.json can't be read or lists none.
 */
export function readDefaultPackageDirectory(root: string): string | undefined {
  const entries = readPackageDirectoryEntries(root);
  return (entries?.find((entry) => entry.isDefault) ?? entries?.[0])?.path;
}

function readPackageDirectoryEntries(root: string): { path: string; isDefault: boolean }[] | undefined {
  let project: unknown;
  try {
    project = parse(readFileSync(path.join(root, SFDX_PROJECT_FILE), "utf8"));
  } catch {
    return undefined;
  }
  const directories = (project as { packageDirectories?: unknown } | undefined)?.packageDirectories;
  if (!Array.isArray(directories)) {
    return undefined;
  }
  return directories
    .map((directory) => ({
      path: typeof directory?.path === "string" ? normalizePath(directory.path) : "",
      isDefault: directory?.default === true,
    }))
    .filter((directory) => directory.path !== "");
}

/**
 * Folders named `lwc` in the package directories, where components live, sorted. Like
 * source-deploy-retrieve, which puts a file in the bundle under the last `lwc` folder in its path, this
 * includes `lwc` folders nested in another's subfolders (`lwc/group/lwc/cmp`). A folder is listed once,
 * even when package directories overlap.
 */
export function findLwcFolders(root: string, packageDirectories: readonly string[]): string[] {
  const found = new Set<string>();
  const visit = (directory: string) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const child = path.join(directory, entry.name);
      if (entry.name === "lwc") {
        found.add(child);
      }
      visit(child);
    }
  };
  for (const directory of packageDirectories) {
    visit(path.join(root, directory));
  }
  return [...found].sort();
}
