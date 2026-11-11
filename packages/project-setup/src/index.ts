// The TypeScript configuration of an SFDX project for the content mapper (TypeScript 7), as the example
// project in the mapper's README sets it up:
//
// - The project config, in the `lwc` folder of the default package directory, is the one TypeScript
//   project for the whole SFDX project. Its `include` lists each `packageDirectories` path from
//   sfdx-project.json, which TypeScript can't read, and it registers the mapper.
// - Every other `lwc` folder gets a solution-style config with no files of its own that only references
//   the project config. Editors open the nearest config to a file, and the reference sends every
//   component there, so all packages share one program and their types are resolved once.
//
// The mapper's `lwcConfigFile` option picks the file. `jsconfig.json` (the default) is the one the
// Salesforce extensions write in each `lwc` folder. They merge their template into it when they start,
// so the editor extension keeps undoing just the parts that conflict, and leaves the rest.
// `tsconfig.json` sits next to theirs instead, which TypeScript looks for first and the Salesforce
// extensions leave alone.
//
// These functions have no editor dependency, so the editor extension and the sf plugin share them. Most
// only read files and compute their new content; the plans at the end work out a whole change, which
// applySetup and writeFiles write.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  findLwcFolders,
  normalizePath,
  readDefaultPackageDirectory,
  readPackageDirectories,
  SFDX_PROJECT_FILE,
} from "@lwc-bolts/sfdx-project";
import { applyEdits, modify } from "jsonc-parser";
import {
  CONTENT_MAPPER_EXTENSIONS,
  CONTENT_MAPPER_PACKAGE,
  installedVersion,
  LIGHTNING_TYPES_PACKAGE,
  typescriptError,
  type SetupError,
  type TypeScriptOptions,
} from "./packages.ts";
import {
  conformConfig,
  FORMATTING,
  indentation,
  parseConfig,
  type ArrayMatch,
  type BlockRule,
  type ConfigPolicy,
  type EnforceRule,
} from "./rules.ts";

export { findLwcFolders, normalizePath, readDefaultPackageDirectory, readPackageDirectories, SFDX_PROJECT_FILE };
export {
  compareVersions,
  CONTENT_MAPPER_EXTENSIONS,
  CONTENT_MAPPER_PACKAGE,
  installedVersion,
  KNOWN_VERSIONS,
  LIGHTNING_TYPES_PACKAGE,
  missingPackages,
  outdatedPackages,
  type OutdatedPackage,
  recommendedPackages,
  supportsContentMappers,
  TYPESCRIPT_PACKAGE,
  typescriptError,
  type SetupError,
  type TypeScriptOptions,
} from "./packages.ts";
export {
  checkConfig,
  conformConfig,
  describePath,
  type ArrayMatch,
  type BlockRule,
  type ConfigPolicy,
  type ConformResult,
  type EnforceEntries,
  type EnforceRule,
  type EnforceValue,
  type RulePath,
} from "./rules.ts";
export { MAX_REWRITES, REWRITE_WINDOW, RewriteLimiter, type RewriteDecision } from "./rewrites.ts";

/**
 * The config files an `lwc` folder can use to reference the project config, as the mapper's `lwcConfigFile`
 * option names them. The mapper validates the option against its own copy, which the tests check this against.
 */
export const LWC_CONFIG_FILES = ["jsconfig.json", "tsconfig.json"] as const;
export type LwcConfigFile = (typeof LWC_CONFIG_FILES)[number];
/** The option's default, which the Salesforce extensions also write. */
export const DEFAULT_LWC_CONFIG_FILE: LwcConfigFile = "jsconfig.json";

/**
 * Brings LIGHTNING_TYPES_PACKAGE into the project, as it asks: it's only types, so TypeScript needs a file
 * that imports it. The Salesforce extensions don't write this one. Setup and maintenance do, once it's installed.
 */
export const LIGHTNING_TYPINGS = ".sfdx/typings/lwc/lightning.d.ts";
const LIGHTNING_TYPES_IMPORT = `import "${LIGHTNING_TYPES_PACKAGE}";\n`;
/** The typings for modules the mapper doesn't declare (see the mapper's README), which `include` names one by one. */
export const SFDX_TYPINGS = [
  ".sfdx/typings/lwc/apex.d.ts",
  ".sfdx/typings/lwc/schema.d.ts",
  ".sfdx/typings/lwc/lds.d.ts",
  ".sfdx/typings/lwc/messageservice.d.ts",
  LIGHTNING_TYPINGS,
];
/** The SObject definitions from "SFDX: Refresh SObject Definitions". */
export const SOBJECT_DEFINITIONS = ".sfdx/tools/sobjects";

/**
 * Compiler options known to break the content mapper's types, which the Salesforce extensions' template
 * adds to a jsconfig.json, and which are removed from every `lwc` folder config, jsconfig.json or
 * tsconfig.json: TypeScript 7 rejects `baseUrl` and the `paths` that need it, and `experimentalDecorators`
 * checks LWC's decorators as legacy ones, which the real `lwc` types reject.
 */
const SALESFORCE_OPTIONS = ["baseUrl", "paths", "experimentalDecorators"];
/** The `include` entries their template adds, relative to the project root: `**\/*` is the folder itself. */
const SALESFORCE_TYPINGS = ".sfdx/typings/lwc/**/*.d.ts";

function read(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** A path relative to an `lwc` folder, as its config spells it. */
function relativeTo(lwcFolder: string, file: string): string {
  return normalizePath(path.relative(lwcFolder, file));
}

/**
 * A path relative to the project root as an `lwc` folder's config spells it: through the root, so a
 * package directory containing the folder is `../../../../force-app` rather than `../../..`.
 */
function fromFolder(lwcFolder: string, root: string, rootPath: string): string {
  return normalizePath(`${path.relative(lwcFolder, root)}/${rootPath}`);
}

/**
 * The `lwc` folder a new project config goes in: the first in the default package directory, or the
 * first in any package directory when the default one has no components.
 */
export function projectConfigFolder(root: string, packageDirectories: readonly string[]): string | undefined {
  const defaultDirectory = readDefaultPackageDirectory(root);
  const inDefault = defaultDirectory === undefined ? [] : findLwcFolders(root, [defaultDirectory]);
  return inDefault[0] ?? findLwcFolders(root, packageDirectories)[0];
}

/** An SFDX project's project config. */
export interface ProjectConfig {
  /** The `lwc` folder it's in. */
  readonly folder: string;
  /** Its path. */
  readonly path: string;
  readonly file: LwcConfigFile;
  readonly text: string;
}

/**
 * The project's config: the `lwc` folder config that registers the content mapper. It's looked for in
 * projectConfigFolder first, then in the other `lwc` folders, so it's found wherever setup put it even
 * when the default package directory has changed since. In each folder, `tsconfig.json` comes first, as
 * TypeScript looks for it first. The package directories are sfdx-project.json's unless given.
 */
export function findProjectConfig(
  root: string,
  packageDirectories: readonly string[] = readPackageDirectories(root) ?? [],
): ProjectConfig | undefined {
  const preferred = projectConfigFolder(root, packageDirectories);
  const folders = findLwcFolders(root, packageDirectories).sort((a, b) => Number(b === preferred) - Number(a === preferred));
  for (const folder of folders) {
    for (const file of ["tsconfig.json", "jsconfig.json"] as const) {
      const configPath = path.join(folder, file);
      const text = read(configPath);
      if (text !== undefined && registersContentMapper(text)) {
        return { folder, path: configPath, file, text };
      }
    }
  }
  return undefined;
}

/**
 * A new project config for the `lwc` folder `folder`, in `file`, for an SFDX project with these package
 * directories. Paths are relative to the folder. A `jsconfig.json` is strict JSON, with no comments: the
 * Salesforce extensions read it with JSON.parse when they start, and stop setting up the project (their
 * `.sfdx/typings` included) when it fails. The mapper's README explains what the entries are for.
 */
export function createProjectConfig(
  folder: string,
  root: string,
  packageDirectories: readonly string[],
  file: LwcConfigFile = DEFAULT_LWC_CONFIG_FILE,
): string {
  const entries = (values: readonly string[]) => values.map((value) => fromFolder(folder, root, value));
  if (file === "jsconfig.json") {
    const config = {
      // jsconfig.json implies allowJs, skipLibCheck and noEmit
      compilerOptions: { types: [] },
      include: entries([...packageDirectories, ...SFDX_TYPINGS, SOBJECT_DEFINITIONS]),
      contentMappers: [{ package: CONTENT_MAPPER_PACKAGE, extensions: CONTENT_MAPPER_EXTENSIONS }],
    };
    return JSON.stringify(config, null, 2) + "\n";
  }
  const lines = (values: readonly string[], last: boolean) =>
    entries(values)
      .map((value, i) => `    ${JSON.stringify(value)}${last && i === values.length - 1 ? "" : ","}`)
      .join("\n");
  return `{
  "compilerOptions": {
    // jsconfig.json implies these, but this is a tsconfig.json.
    "allowJs": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": []
  },
  "include": [
    // One entry per packageDirectories path in sfdx-project.json.
${lines(packageDirectories, false)}
    // The typings for modules the content mapper doesn't declare, most of them the Salesforce extensions'.
    // The rest of .sfdx/typings/lwc duplicates the mapper's @salesforce/... modules, so only these files are included.
${lines(SFDX_TYPINGS, false)}
    // SObject definitions from "SFDX: Refresh SObject Definitions", which the mapper declares as Apex
    // types (Apex.Account, ...) and @salesforce/schema modules.
${lines([SOBJECT_DEFINITIONS], true)}
  ],
  "contentMappers": [
    {
      "package": ${JSON.stringify(CONTENT_MAPPER_PACKAGE)},
      "extensions": ${JSON.stringify(CONTENT_MAPPER_EXTENSIONS).replace(/,/g, ", ")},
      "options": { "lwcConfigFile": "tsconfig.json" }
    }
  ]
}
`;
}

/** Whether a config is strict JSON, which the Salesforce extensions can read: no comments or trailing commas. */
export function isStrictJson(configText: string): boolean {
  try {
    JSON.parse(configText);
    return true;
  } catch {
    return false;
  }
}

/**
 * A project config moved to a `jsconfig.json`: strict JSON (see createProjectConfig), so its comments are
 * dropped. Undefined when it isn't valid JSONC.
 */
export function asJsconfig(configText: string): string | undefined {
  if (isStrictJson(configText)) {
    return configText;
  }
  const config = parseConfig(configText);
  return config === undefined ? undefined : JSON.stringify(config, null, 2) + "\n";
}

// Policies: what each `lwc` folder config must and mustn't have (see rules.ts). Setup and maintenance check
// a config against its policy, and when it doesn't conform, apply the blocks and enforcements, and only those.

/** The compiler options a `jsconfig.json` implies, which a `tsconfig.json` project config sets. */
const JSCONFIG_DEFAULTS = ["allowJs", "skipLibCheck", "noEmit"];

/** SALESFORCE_OPTIONS, blocked in every `lwc` folder config. */
const SALESFORCE_OPTION_BLOCKS: readonly BlockRule[] = SALESFORCE_OPTIONS.map((option) => ({ path: ["compilerOptions", option] }));

/** The content mapper's entry in `contentMappers`. */
const CONTENT_MAPPER_ENTRY: ArrayMatch = { where: "package", equals: CONTENT_MAPPER_PACKAGE };

/** The content mapper registered for CONTENT_MAPPER_EXTENSIONS: an entry, or the extensions an existing one lacks (such as `.html`). */
const CONTENT_MAPPER_RULE: EnforceRule = {
  path: ["contentMappers", CONTENT_MAPPER_ENTRY, "extensions"],
  contains: CONTENT_MAPPER_EXTENSIONS,
};

/** Whether two entries of a config in `folder` are paths to the same file or folder, however they're spelled. */
function samePath(folder: string): (a: unknown, b: unknown) => boolean {
  return (a, b) => typeof a === "string" && typeof b === "string" && path.resolve(folder, a) === path.resolve(folder, b);
}

/** The `include` entries a project config in `folder` needs, in order, as it spells them. */
function projectIncludes(folder: string, root: string, packageDirectories: readonly string[]): string[] {
  return [...packageDirectories, ...SFDX_TYPINGS, SOBJECT_DEFINITIONS].map((entry) => fromFolder(folder, root, entry));
}

/**
 * What the project config, `file` in the `lwc` folder `folder`, must and mustn't have. The package
 * directories are sfdx-project.json's, merged into what's enforced.
 *
 * Blocked:
 * - SALESFORCE_OPTIONS.
 * - The `include` entries the Salesforce extensions' template adds: `**\/*` (the folder itself, already in
 *   its package directory's entry) and SALESFORCE_TYPINGS (all of `.sfdx/typings/lwc`, which duplicates
 *   the mapper's modules).
 * - `include` entries for folders that no longer exist and aren't package directories, such as a removed
 *   package. Globs, entries under `.sfdx`, and existing paths, which are the project's own, are kept.
 *
 * Enforced:
 * - `include` has each package directory, then SFDX_TYPINGS, then SOBJECT_DEFINITIONS. The Salesforce
 *   extensions' merge drops every entry under `.sfdx/typings/lwc` (salesforcedx-vscode-lwc 68.4), so the
 *   typings are put back in their place.
 * - The mapper is registered for CONTENT_MAPPER_EXTENSIONS.
 * - In a `tsconfig.json`, which doesn't imply them, JSCONFIG_DEFAULTS are `true`.
 */
export function projectConfigPolicy(
  folder: string,
  root: string,
  file: LwcConfigFile,
  packageDirectories: readonly string[],
): ConfigPolicy {
  const fromRoot = (entry: string) => normalizePath(path.relative(root, path.resolve(folder, entry)));
  const packages = new Set(packageDirectories);
  const isSalesforceEntry = (entry: unknown) =>
    typeof entry === "string" && (normalizePath(entry) === "**/*" || fromRoot(entry) === SALESFORCE_TYPINGS);
  const isStale = (entry: unknown) => {
    if (typeof entry !== "string") {
      return false;
    }
    const normalized = fromRoot(entry);
    return (
      !packages.has(normalized) && !normalized.startsWith(".sfdx/") && !/[*?]/.test(normalized) && !existsSync(path.resolve(folder, entry))
    );
  };
  return {
    block: [...SALESFORCE_OPTION_BLOCKS, { path: ["include"], entries: isSalesforceEntry }, { path: ["include"], entries: isStale }],
    enforce: [
      { path: ["include"], contains: projectIncludes(folder, root, packageDirectories), same: samePath(folder) },
      CONTENT_MAPPER_RULE,
      ...(file === "tsconfig.json" ? JSCONFIG_DEFAULTS.map((option) => ({ path: ["compilerOptions", option], value: true })) : []),
    ],
  };
}

/**
 * What the config of an `lwc` folder other than the project config's must and mustn't have, in the file
 * `configPath` names (the project config's, as the mapper's `lwcConfigFile` option makes them the same):
 * no files of its own, and a reference to the project config, so its components open in the project
 * config's program. `existing` is its current text, if any.
 *
 * Blocked: SALESFORCE_OPTIONS.
 *
 * Enforced: `files` is empty; `include` is empty in a jsconfig.json, because older versions of the
 * Salesforce extensions' merge (lightning-language-server's) spread it and throw without one, and in a
 * tsconfig.json that has one or `extends` one; `references` has the project config.
 */
export function lwcFolderPolicy(lwcFolder: string, configPath: string, existing?: string): ConfigPolicy {
  const config = existing === undefined ? undefined : parseConfig(existing);
  const needsInclude = path.basename(configPath) === "jsconfig.json" || config?.include !== undefined || config?.extends !== undefined;
  const sameReference = (a: unknown, b: unknown) =>
    typeof a === "object" && a !== null && samePath(lwcFolder)((a as { path?: unknown }).path, (b as { path: string }).path);
  return {
    block: SALESFORCE_OPTION_BLOCKS,
    enforce: [
      { path: ["files"], value: [] },
      ...(needsInclude ? [{ path: ["include"], value: [] }] : []),
      { path: ["references"], contains: [{ path: relativeTo(lwcFolder, configPath) }], same: sameReference },
    ],
  };
}

/**
 * Adds a folder of the project's own, such as a cache of installed packages' metadata, to a project
 * config's `include`, after the package directories' entries. `directory` is relative to the project root,
 * and the entry relative to the config's folder, `folder`. Unchanged when an entry already names it, and
 * undefined when the config isn't valid JSON.
 */
export function addInclude(configText: string, folder: string, root: string, directory: string): string | undefined {
  const packageDirectories = readPackageDirectories(root) ?? [];
  const entry = fromFolder(folder, root, normalizePath(directory));
  const order = projectIncludes(folder, root, packageDirectories);
  order.splice(packageDirectories.length, 0, entry);
  return conformConfig(configText, { block: [], enforce: [{ path: ["include"], contains: [entry], same: samePath(folder), order }] })?.text;
}

/** Whether a config registers the content mapper in its `contentMappers`. */
export function registersContentMapper(configText: string): boolean {
  const mappers = parseConfig(configText)?.contentMappers;
  return Array.isArray(mappers) && mappers.some((mapper) => mapper?.package === CONTENT_MAPPER_PACKAGE);
}

/**
 * Adds the content mapper to a config's `contentMappers`, or the extensions an existing entry lacks
 * (such as `.html`, for templates). A config that isn't valid JSON is returned unchanged.
 */
export function addContentMapper(configText: string): string {
  return conformConfig(configText, { block: [], enforce: [CONTENT_MAPPER_RULE] })?.text ?? configText;
}

/**
 * Sets the content mapper's `options` in a config: each value of `options` is written, and an `undefined`
 * one is removed, so the mapper applies its default. Options not named, such as `lwcConfigFile`, are kept,
 * and an `options` left empty is removed. A config that doesn't register the mapper gets it first. Returns
 * undefined for a config that isn't valid JSON. Edits are made in place, so comments and formatting are kept.
 */
export function setContentMapperOptions(configText: string, options: Readonly<Record<string, unknown>>): string | undefined {
  if (parseConfig(configText) === undefined) {
    return undefined;
  }
  let text = registersContentMapper(configText) ? configText : addContentMapper(configText);
  const formattingOptions = { ...FORMATTING, ...indentation(text) };
  const mappers = () => parseConfig(text)!.contentMappers as { package?: unknown; options?: unknown }[];
  const index = mappers().findIndex((mapper) => mapper?.package === CONTENT_MAPPER_PACKAGE);
  const current = () => mappers()[index]?.options;
  for (const [name, value] of Object.entries(options)) {
    const existing = current();
    const isSet = existing !== null && typeof existing === "object" && Object.hasOwn(existing, name);
    if (value === undefined && !isSet) {
      continue;
    }
    text = applyEdits(text, modify(text, ["contentMappers", index, "options", name], value, { formattingOptions }));
  }
  const remaining = current();
  if (remaining !== null && typeof remaining === "object" && !Array.isArray(remaining) && Object.keys(remaining).length === 0) {
    text = applyEdits(text, modify(text, ["contentMappers", index, "options"], undefined, { formattingOptions }));
  }
  return text;
}

/**
 * The file a project config says the `lwc` folders use: the mapper's `lwcConfigFile` option, or the
 * default when it's unset or invalid (the mapper reports an invalid one).
 */
export function lwcConfigFile(configText: string): LwcConfigFile {
  const mappers = parseConfig(configText)?.contentMappers;
  const mapper = Array.isArray(mappers) ? mappers.find((entry) => entry?.package === CONTENT_MAPPER_PACKAGE) : undefined;
  const value: unknown = mapper?.options?.lwcConfigFile;
  return LWC_CONFIG_FILES.find((file) => file === value) ?? DEFAULT_LWC_CONFIG_FILE;
}

/**
 * The config for an `lwc` folder other than the project config's, in the file `configPath` names: a new
 * one when there's none (`existing`), or the existing one brought into line with lwcFolderPolicy, with
 * everything else kept, such as the Salesforce extensions' other settings and the project's own. Edits
 * are made in place, so comments and formatting are kept. Undefined for a file that isn't valid JSON,
 * which is left alone.
 */
export function lwcFolderConfig(lwcFolder: string, configPath: string, existing?: string): string | undefined {
  if (existing === undefined) {
    const reference = relativeTo(lwcFolder, configPath);
    const config =
      path.basename(configPath) === "jsconfig.json"
        ? { files: [], include: [], references: [{ path: reference }] }
        : { files: [], references: [{ path: reference }] };
    return JSON.stringify(config, null, 2) + "\n";
  }
  return conformConfig(existing, lwcFolderPolicy(lwcFolder, configPath, existing))?.text;
}

// Plans: what setting a project up and keeping its configs in shape change, worked
// out from the files without writing any, so a caller can ask first, then write them with applySetup or
// writeFiles. The VS Code extension and the sf plugin share them.

/** A file to write, with its new content. */
export interface FileWrite {
  readonly path: string;
  readonly text: string;
  /** For a config, what changed to bring it into line with its policy, such as `removed compilerOptions.baseUrl`. */
  readonly changes?: readonly string[];
}

/** Writes LIGHTNING_TYPINGS once LIGHTNING_TYPES_PACKAGE is installed, as nothing else does and `.sfdx` isn't committed. */
function lightningTypingsWrite(root: string): FileWrite[] {
  const file = path.join(root, LIGHTNING_TYPINGS);
  return installedVersion(root, LIGHTNING_TYPES_PACKAGE) === undefined || read(file) === LIGHTNING_TYPES_IMPORT
    ? []
    : [{ path: file, text: LIGHTNING_TYPES_IMPORT }];
}

/** What "set up the project" changes, as setUp works it out. Paths are absolute. */
export interface SetupPlan {
  readonly root: string;
  /** The file the `lwc` folders use (the mapper's `lwcConfigFile` option). */
  readonly file: LwcConfigFile;
  /** The project config, as it'll be written. */
  readonly projectConfig: FileWrite;
  /** How the project config changes; `moved` from `movedFrom`, which is removed. */
  readonly projectConfigChange: "created" | "moved" | "updated" | "unchanged";
  readonly movedFrom?: string;
  /**
   * The other `lwc` folders' configs to write, new ones and existing ones that change (see
   * lwcFolderConfig), and LIGHTNING_TYPINGS when its package is installed and it differs.
   */
  readonly writes: readonly FileWrite[];
  /** `tsconfig.json` files setup wrote for `"tsconfig.json"`, removed now that the project uses `jsconfig.json`. */
  readonly removals: readonly string[];
  /** Other `tsconfig.json` files that TypeScript uses instead of the `jsconfig.json` next to them. */
  readonly shadowing: readonly string[];
  /** Configs that aren't valid JSON, left alone. */
  readonly invalid: readonly string[];
}

/**
 * Works out the configuration the mapper's README describes, for the SFDX project at `root`: the project
 * config in the default package directory's `lwc` folder (or an existing one brought up to date, and moved
 * to the file its `lwcConfigFile` names), and a config in every other `lwc` folder that references it.
 * It leaves `.forceignore` alone: what the project deploys is the project's call. Returns an error when the project can't be set up, which includes its
 * available TypeScript not being one that runs content mappers (see typescriptError).
 */
export function planSetup(root: string, options: TypeScriptOptions = {}): SetupPlan | SetupError {
  const packageDirectories = readPackageDirectories(root);
  if (packageDirectories === undefined || packageDirectories.length === 0) {
    return { error: `${SFDX_PROJECT_FILE} has no packageDirectories to set up.` };
  }
  const existing = findProjectConfig(root, packageDirectories);
  const folder = existing?.folder ?? projectConfigFolder(root, packageDirectories);
  if (folder === undefined) {
    return { error: `none of ${SFDX_PROJECT_FILE}'s packageDirectories has an lwc folder, so there are no components to set up.` };
  }
  const typescript = typescriptError(root, options);
  if (typescript !== undefined) {
    return typescript;
  }

  let text: string;
  let file: LwcConfigFile;
  if (existing === undefined) {
    file = DEFAULT_LWC_CONFIG_FILE;
    text = createProjectConfig(folder, root, packageDirectories, file);
  } else {
    const conformed = conformConfig(existing.text, projectConfigPolicy(folder, root, existing.file, packageDirectories));
    if (conformed === undefined) {
      return { error: `${normalizePath(path.relative(root, existing.path))} isn't valid JSON, so it wasn't changed.` };
    }
    text = conformed.text;
    file = lwcConfigFile(text);
    if (file !== existing.file) {
      // moved to the file its lwcConfigFile names, where the other file's policy applies
      text =
        file === "tsconfig.json"
          ? conformConfig(text, projectConfigPolicy(folder, root, file, packageDirectories))!.text
          : (asJsconfig(text) ?? text);
    }
  }
  const configPath = path.join(folder, file);
  const projectConfigChange =
    existing === undefined ? "created" : configPath !== existing.path ? "moved" : text !== existing.text ? "updated" : "unchanged";

  const writes: FileWrite[] = [];
  const removals: string[] = [];
  const shadowing: string[] = [];
  const invalid: string[] = [];
  for (const lwcFolder of findLwcFolders(root, packageDirectories)) {
    if (lwcFolder !== folder) {
      const referencing = path.join(lwcFolder, file);
      const current = read(referencing);
      const desired = lwcFolderConfig(lwcFolder, configPath, current);
      if (desired === undefined) {
        invalid.push(referencing);
      } else if (desired !== current) {
        // only the parts that make it a project of its own change, so there's nothing to ask about
        writes.push({ path: referencing, text: desired });
      }
    }
    if (file === "jsconfig.json") {
      // TypeScript uses a tsconfig.json before a jsconfig.json: remove the one setup wrote when the project
      // used tsconfig.json, and point out any other
      const tsconfig = path.join(lwcFolder, "tsconfig.json");
      const current = read(tsconfig);
      if (current !== undefined && current === lwcFolderConfig(lwcFolder, path.join(folder, "tsconfig.json"))) {
        removals.push(tsconfig);
      } else if (current !== undefined && tsconfig !== existing?.path) {
        // the project config moving to jsconfig.json is removed, so it doesn't shadow it
        shadowing.push(tsconfig);
      }
    }
  }

  writes.push(...lightningTypingsWrite(root));

  return {
    root,
    file,
    projectConfig: { path: configPath, text },
    projectConfigChange,
    ...(projectConfigChange === "moved" && { movedFrom: existing!.path }),
    writes,
    removals,
    shadowing,
    invalid,
  };
}

/**
 * Writes a setup plan's changes. Returns the files it wrote or removed, by what happened to them, for the
 * caller's summary.
 */
export function applySetup(plan: SetupPlan): {
  readonly written: readonly string[];
  readonly removed: readonly string[];
} {
  if (plan.projectConfigChange !== "unchanged") {
    // a moved config's old file would be a second copy, and a tsconfig.json would take precedence over the new one
    writeFileSync(plan.projectConfig.path, plan.projectConfig.text);
    if (plan.movedFrom !== undefined) {
      rmSync(plan.movedFrom);
    }
  }
  const writes = plan.writes;
  writeFiles(writes);
  for (const file of plan.removals) {
    rmSync(file);
  }
  return { written: writes.map((write) => write.path), removed: plan.removals };
}

/** Writes files, and their folders, as `.sfdx` may not exist yet. */
export function writeFiles(writes: readonly FileWrite[]): void {
  for (const write of writes) {
    mkdirSync(path.dirname(write.path), { recursive: true });
    writeFileSync(write.path, write.text);
  }
}

/**
 * The files of a set-up project that don't conform to their policies, with the content that brings them
 * into line, whichever file the project uses, jsconfig.json or tsconfig.json: the project config checked
 * against projectConfigPolicy, with sfdx-project.json's package directories merged in, and every other
 * `lwc` folder's config against lwcFolderPolicy (a new package directory's folder gets a new one). The
 * Salesforce extensions merge their template into every `lwc` folder's jsconfig.json when they start,
 * which this undoes; other tools, or people, can change either file. Only what the policies block or
 * enforce changes, and each config write says what (`changes`). LIGHTNING_TYPINGS is restored once its
 * package is installed, as a new checkout has no `.sfdx`. Files that aren't valid JSON, such as
 * half-written ones, are left alone.
 */
export function planMaintenance(root: string): FileWrite[] {
  const packageDirectories = readPackageDirectories(root) ?? [];
  const project = findProjectConfig(root, packageDirectories);
  if (project === undefined) {
    return [];
  }
  const writes = lightningTypingsWrite(root);
  const conform = (file: string, text: string, policy: ConfigPolicy) => {
    const result = conformConfig(text, policy);
    if (result !== undefined && result.changes.length > 0) {
      writes.push({ path: file, text: result.text, changes: result.changes });
    }
  };
  conform(project.path, project.text, projectConfigPolicy(project.folder, root, project.file, packageDirectories));
  for (const folder of findLwcFolders(root, packageDirectories)) {
    if (folder === project.folder) {
      continue;
    }
    const file = path.join(folder, project.file);
    const existing = read(file);
    if (existing === undefined) {
      writes.push({ path: file, text: lwcFolderConfig(folder, project.path)!, changes: ["created"] });
    } else {
      conform(file, existing, lwcFolderPolicy(folder, project.path, existing));
    }
  }
  return writes;
}

/** The content mapper's `options` in a config, or undefined when it isn't valid JSON or doesn't register the mapper. */
export function contentMapperOptions(configText: string): Record<string, unknown> | undefined {
  const mappers = parseConfig(configText)?.contentMappers;
  const mapper = Array.isArray(mappers) ? mappers.find((entry) => entry?.package === CONTENT_MAPPER_PACKAGE) : undefined;
  if (mapper === undefined) {
    return undefined;
  }
  const options: unknown = mapper.options;
  return options !== null && typeof options === "object" && !Array.isArray(options) ? { ...options } : {};
}
