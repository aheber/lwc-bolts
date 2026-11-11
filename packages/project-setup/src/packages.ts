// The packages a set-up project needs installed: the content mapper its config registers, and a TypeScript
// that runs content mappers. The VS Code extension and the sf plugin both check them.
import { execFileSync, execSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

/** The package a project config's `contentMappers` entry registers. The tests check it's the mapper's name. */
export const CONTENT_MAPPER_PACKAGE = "@lwc-bolts/typescript-content-mapper";
/** The file extensions to register the mapper for: Apex, metadata XML and LWC templates. */
export const CONTENT_MAPPER_EXTENSIONS: readonly string[] = [".cls", ".xml", ".html"];
/** The TypeScript that supports content mappers, as `npm install` takes it. */
export const TYPESCRIPT_PACKAGE = "typescript@7.1.0-beta";
/** Salesforce's types for the `lightning/*` modules, which a project is recommended to install but doesn't need. */
export const LIGHTNING_TYPES_PACKAGE = "@salesforce/lightning-types";
/**
 * The latest version of each package a project installs that this release knows of, tested with it. A
 * project with an older one is offered an update. Bump these with each release: the tests check the
 * mapper's against its package.json, and TypeScript's against TYPESCRIPT_PACKAGE.
 */
export const KNOWN_VERSIONS: Readonly<Record<string, string>> = {
  [CONTENT_MAPPER_PACKAGE]: "1.0.0",
  typescript: "7.1.0-beta",
  [LIGHTNING_TYPES_PACKAGE]: "0.10.1",
};

/** A package installed in a project at a version older than KNOWN_VERSIONS names. */
export interface OutdatedPackage {
  readonly name: string;
  readonly installed: string;
  readonly known: string;
  /** The package at the known version, as `npm install` takes it. */
  readonly spec: string;
}

/**
 * Compares two versions such as `1.2.3` and `7.1.0-beta`, as semver orders them: by `major.minor.patch`,
 * then a release after its prereleases, and prereleases by their dot-separated identifiers. Build metadata
 * (`+...`) is ignored. A version that can't be parsed compares as equal, so it's never called outdated.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
  const [left, right] = [parse(a), parse(b)];
  if (!left || !right) {
    return 0;
  }
  for (let i = 1; i <= 3; i++) {
    const difference = Number(left[i]) - Number(right[i]);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  const [leftPre, rightPre] = [left[4], right[4]];
  if (leftPre === undefined || rightPre === undefined) {
    return leftPre === rightPre ? 0 : leftPre === undefined ? 1 : -1;
  }
  const [leftIds, rightIds] = [leftPre.split("."), rightPre.split(".")];
  for (let i = 0; i < Math.max(leftIds.length, rightIds.length); i++) {
    const [x, y] = [leftIds[i], rightIds[i]];
    if (x === undefined || y === undefined) {
      return x === undefined ? -1 : 1;
    }
    const [xNumber, yNumber] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xNumber && yNumber && Number(x) !== Number(y)) {
      return Math.sign(Number(x) - Number(y));
    }
    if (xNumber !== yNumber) {
      return xNumber ? -1 : 1;
    }
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The packages installed in the project at `root` at a version older than KNOWN_VERSIONS names. Packages
 * that aren't installed are missingPackages' and recommendedPackages' business. TypeScript only counts
 * when the project's is a TypeScript 7, the one that runs the mapper: an older one can be there for other
 * tools, and when the mapper needs it replaced, missingPackages asks for it.
 */
export function outdatedPackages(root: string): OutdatedPackage[] {
  return Object.entries(KNOWN_VERSIONS).flatMap(([name, known]) => {
    const installed = installedVersion(root, name);
    if (installed === undefined || compareVersions(installed, known) >= 0) {
      return [];
    }
    if (name === "typescript" && !/^v?7\./.test(installed.trim())) {
      return [];
    }
    return [{ name, installed, known, spec: `${name}@${known}` }];
  });
}

/** The first TypeScript `major.minor` that runs content mappers. */
const CONTENT_MAPPERS_SINCE = [7, 1] as const;

/** Where a caller knows of a TypeScript to use. */
export interface TypeScriptOptions {
  /**
   * A TypeScript SDK folder (or its `lib` or `bin` folder), a folder with a `tsc`, or a `tsc` executable,
   * absolute or relative to the project, used instead of resolving the project's or a global one. A `tsc`
   * is run to read its version, so this mustn't come from a project that isn't trusted.
   */
  readonly typescriptPath?: string;
}

/** Why a project can't be set up. */
export interface SetupError {
  readonly error: string;
  /** The packages to install to fix it, as `npm install` takes them, when that's what it needs. */
  readonly missing?: readonly string[];
}

/** Whether TypeScript `version` (such as `7.1.0-beta`) runs content mappers, counting prereleases of 7.1. */
export function supportsContentMappers(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return false;
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const [wantedMajor, wantedMinor] = CONTENT_MAPPERS_SINCE;
  return major > wantedMajor || (major === wantedMajor && minor >= wantedMinor);
}

function versionIn(packageJson: string): string | undefined {
  try {
    const version: unknown = JSON.parse(readFileSync(packageJson, "utf8")).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The version of package `name` installed for the project at `root`, resolved from it as TypeScript
 * resolves a config's `contentMappers`, or undefined when it isn't installed. Its package.json is read
 * each time, so a version installed since is seen.
 */
export function installedVersion(root: string, name: string): string | undefined {
  try {
    return versionIn(createRequire(path.join(root, "package.json")).resolve(`${name}/package.json`));
  } catch {
    return undefined;
  }
}

/** The names of a `tsc` executable, which on Windows npm installs as a script. */
const TSC_NAMES = process.platform === "win32" ? ["tsc.cmd", "tsc.exe", "tsc.bat"] : ["tsc"];

function tscIn(folder: string): string | undefined {
  return TSC_NAMES.map((name) => path.join(folder, name)).find((file) => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * The version a `tsc` executable reports. It's run away from the project, as Windows' shell looks in the
 * current folder first, for the `node` an npm script runs too.
 */
function tscVersion(tsc: string): string | undefined {
  const options = {
    cwd: tmpdir(),
    encoding: "utf8" as const,
    stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
    timeout: 5000,
    windowsHide: true,
  };
  try {
    const output = /\.(cmd|bat)$/i.test(tsc)
      ? execSync(`"${tsc}" --version`, options)
      : /\.[cm]?js$/.test(tsc)
        ? execFileSync("node", [tsc, "--version"], options)
        : execFileSync(tsc, ["--version"], options);
    return /\d+\.\d+\.\d+\S*/.exec(output)?.[0];
  } catch {
    return undefined;
  }
}

/** A TypeScript that was resolved, whether or not it could be tested. */
interface ResolvedTypeScript {
  /** The path that was tested. */
  readonly path: string;
  readonly version: string | undefined;
}

/**
 * Tests the TypeScript at `target`: a `tsc` executable reports its version, and a folder has it in its
 * package.json (a `lib` or `bin` folder, in its parent's), or else in the `tsc` it holds.
 */
function testTypeScript(target: string): ResolvedTypeScript {
  if (statSync(target, { throwIfNoEntry: false })?.isFile()) {
    return { path: target, version: tscVersion(target) };
  }
  const folders = [target, ...(["lib", "bin"].includes(path.basename(target)) ? [path.dirname(target)] : [])];
  const version = folders.map((folder) => versionIn(path.join(folder, "package.json"))).find((each) => each !== undefined);
  if (version !== undefined) {
    return { path: target, version };
  }
  const tsc = tscIn(target);
  return tsc === undefined ? { path: target, version } : { path: tsc, version: tscVersion(tsc) };
}

/** The folder of the TypeScript installed for the project at `root`. Node caches what it resolves, so one removed since is checked for. */
function projectTypeScript(root: string): string | undefined {
  try {
    const packageJson = createRequire(path.join(root, "package.json")).resolve("typescript/package.json");
    return existsSync(packageJson) ? path.dirname(packageJson) : undefined;
  } catch {
    return undefined;
  }
}

/** The first `tsc` on the PATH. A relative entry isn't global: it's whatever folder this runs in. */
function globalTsc(): string | undefined {
  for (const folder of (process.env.PATH ?? "").split(path.delimiter).filter((entry) => path.isAbsolute(entry))) {
    const tsc = tscIn(folder);
    if (tsc !== undefined) {
      return tsc;
    }
  }
  return undefined;
}

/**
 * The TypeScript available to the project at `root`: `typescriptPath` when it's given, or else the one
 * installed in the project, and only when there's none, the global `tsc`, so a project's old TypeScript
 * isn't made up for by a newer global one. Undefined when nothing was found.
 */
function resolveTypeScript(root: string, { typescriptPath }: TypeScriptOptions): ResolvedTypeScript | undefined {
  const target = typescriptPath === undefined ? (projectTypeScript(root) ?? globalTsc()) : path.resolve(root, typescriptPath);
  return target === undefined ? undefined : testTypeScript(target);
}

function runsContentMappers(typescript: ResolvedTypeScript | undefined): boolean {
  return typescript?.version !== undefined && supportsContentMappers(typescript.version);
}

function missingMapper(root: string): string[] {
  return installedVersion(root, CONTENT_MAPPER_PACKAGE) === undefined ? [CONTENT_MAPPER_PACKAGE] : [];
}

/**
 * Why the project at `root` can't be set up with the TypeScript available to it (see resolveTypeScript),
 * naming the path tested, or undefined when that TypeScript runs content mappers.
 */
export function typescriptError(root: string, options: TypeScriptOptions = {}): SetupError | undefined {
  const typescript = resolveTypeScript(root, options);
  if (runsContentMappers(typescript)) {
    return undefined;
  }
  const found =
    typescript === undefined
      ? "it isn't installed in the project or globally"
      : typescript.version === undefined
        ? `no TypeScript version could be read from ${typescript.path}`
        : `${typescript.path} is ${typescript.version}`;
  const needs = `the content mapper needs TypeScript 7.1 or later, but ${found}.`;
  // a path given elsewhere is used whatever the project has installed
  const projectFolder = path.join(path.resolve(root), "node_modules", "typescript");
  const given = options.typescriptPath === undefined ? undefined : path.resolve(root, options.typescriptPath);
  return given === undefined || given === projectFolder || given.startsWith(projectFolder + path.sep)
    ? {
        error: `${needs} Install it (npm install --save-dev ${TYPESCRIPT_PACKAGE}), then set the project up again.`,
        missing: [...missingMapper(root), TYPESCRIPT_PACKAGE],
      }
    : { error: `${needs} Use a newer one, then set the project up again.` };
}

/**
 * The packages the project at `root` needs installed for its config, as `npm install` takes them: the
 * content mapper, and a TypeScript that runs it (TYPESCRIPT_PACKAGE) unless one is available (see
 * resolveTypeScript).
 */
export function missingPackages(root: string, options: TypeScriptOptions = {}): string[] {
  return [...missingMapper(root), ...(runsContentMappers(resolveTypeScript(root, options)) ? [] : [TYPESCRIPT_PACKAGE])];
}

/** The packages the project at `root` doesn't need, but is better off with, as `npm install` takes them. */
export function recommendedPackages(root: string): string[] {
  return installedVersion(root, LIGHTNING_TYPES_PACKAGE) === undefined ? [LIGHTNING_TYPES_PACKAGE] : [];
}
