import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MetadataResolver } from "@salesforce/source-deploy-retrieve";
import { parse } from "jsonc-parser";
import { findLwcFolders, readPackageDirectories, SFDX_PROJECT_FILE } from "./packageDirectories.ts";

export const FORCE_IGNORE_FILE = ".forceignore";

/**
 * The SObject definitions the Salesforce extensions generate ("SFDX: Refresh SObject Definitions"), as
 * Apex classes, relative to the project root.
 */
const SOBJECT_DEFINITION = /^\.sfdx\/tools\/sobjects\/(standardObjects|customObjects)\/([^/]+)\.cls$/;
/** Describes of the same objects, written by the same command; they list each lookup's targets. */
const SOQL_METADATA = ".sfdx/tools/soqlMetadata";
/** The org's objects, which the command rewrites whenever it refreshes the definitions. */
export const TYPE_NAMES_FILE = `${SOQL_METADATA}/typeNames.json`;

/** What's known about an SObject definition's polymorphic relationships (sf2ts's component options). */
export interface PolymorphicRelationships {
  /** Each polymorphic relationship's targets, by relationship name (such as `What` on Task). */
  readonly polymorphicTargets: Record<string, string[]>;
}

/** How an SFDX project is loaded. */
export interface SfdxProjectOptions {
  /**
   * Whether files the project's .forceignore denies are left out, as the Salesforce CLI leaves them out
   * of deploys (the default), or treated like any other file.
   */
  readonly respectForceIgnore?: boolean;
}

/** Walks up from `dir` looking for the directory containing sfdx-project.json. */
export function findSfdxRoot(dir: string): string | undefined {
  let current = path.resolve(dir);
  while (true) {
    if (existsSync(path.join(current, SFDX_PROJECT_FILE))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

// source-deploy-retrieve is large; load it on first use so `initialize` answers well inside the host's timeout.
let sdr: Promise<typeof import("@salesforce/source-deploy-retrieve")> | undefined;
function loadSdr() {
  sdr ??= import("@salesforce/source-deploy-retrieve");
  return sdr;
}

/**
 * An SFDX project, resolved through @salesforce/source-deploy-retrieve (SDR) the same way the lwc-bolts
 * TypeScript plugin does. sfdx-project.json influences how files map to metadata types (for example
 * `decomposeCustomLabelsBeta2`), and SDR doesn't resolve files that the project's .forceignore denies,
 * so both files' content is part of the project's identity, as is the SObject definitions' list of objects.
 * With `respectForceIgnore: false`, SDR resolves the files .forceignore denies too.
 */
export class SfdxProject {
  readonly root: string;
  readonly projectFile: string;
  readonly forceIgnoreFile: string;
  readonly typeNamesFile: string;
  /** Fingerprint of the configuration that affects metadata type resolution and SObject definitions. */
  readonly identity: string;
  /**
   * The project's namespace (sfdx-project.json's `namespace`), or undefined without one. Custom objects
   * and fields are named with it in records and in the values of schema imports.
   */
  readonly namespace: string | undefined;
  /** Whether files the project's .forceignore denies are left out (see `SfdxProjectOptions`). */
  readonly respectForceIgnore: boolean;
  readonly #resolver: MetadataResolver;
  /** The objects with an SObject definition, read on first use. */
  /** The `lwc` folders in the package directories, read on first use. */
  #lwcFolders: string[] | undefined;

  private constructor(root: string, configuration: ProjectConfiguration, resolver: MetadataResolver, respectForceIgnore: boolean) {
    this.root = root;
    this.projectFile = path.join(root, SFDX_PROJECT_FILE);
    this.forceIgnoreFile = path.join(root, FORCE_IGNORE_FILE);
    this.typeNamesFile = path.join(root, TYPE_NAMES_FILE);
    this.identity = createHash("sha256").update(root).update("\0").update(configuration.key).digest("hex");
    this.namespace = configuration.namespace;
    this.respectForceIgnore = respectForceIgnore;
    this.#resolver = resolver;
  }

  /**
   * Loads the SFDX project at `root`. Every TypeScript project in the same SFDX project (such as each
   * package's `lwc/tsconfig.json`) shares one instance while sfdx-project.json and .forceignore are
   * unchanged and they load it with the same options, so the metadata registry is built once.
   */
  static async load(root: string, { respectForceIgnore = true }: SfdxProjectOptions = {}): Promise<SfdxProject> {
    const configuration = readConfiguration(root);
    const { key } = configuration;
    const cacheKey = `${root}\0${respectForceIgnore}`;
    const cached = loaded.get(cacheKey);
    if (cached?.key === key) {
      return cached.project;
    }
    const project = (async () => {
      const { MetadataResolver, RegistryAccess } = await loadSdr();
      // SDR finds the .forceignore above each resolved file, and re-reads it when it changes on disk. Without
      // it, SDR ignores nothing, not even its default ignores (such as dot files).
      const resolver = new MetadataResolver(new RegistryAccess(undefined, root), undefined, respectForceIgnore);
      return new SfdxProject(root, configuration, resolver, respectForceIgnore);
    })();
    loaded.set(cacheKey, { key, project });
    project.catch(() => {
      if (loaded.get(cacheKey)?.project === project) {
        loaded.delete(cacheKey);
      }
    });
    return project;
  }

  /**
   * Files whose changes can change how files resolve or what they declare; TypeScript watches them and
   * reopens the project. typeNames.json stands in for the SObject describes: "SFDX: Refresh SObject
   * Definitions" rewrites it with the definitions, and a polymorphic relationship's targets only change
   * when the org's objects do.
   */
  get watchedFiles(): string[] {
    return [this.projectFile, this.forceIgnoreFile, this.typeNamesFile];
  }

  /**
   * The polymorphic relationships of an SObject definition, from its describe in .sfdx/tools/soqlMetadata:
   * lookups whose `referenceTo` lists more than one object, with all of their targets: sf2ts's output
   * leaves a relationship `SObject` until TypeScript finds every target declared. Returns undefined when
   * the describe is missing or can't be read, and the relationships stay `SObject`.
   */
  polymorphicRelationships(fileName: string): PolymorphicRelationships | undefined {
    const match = SOBJECT_DEFINITION.exec(this.#relative(fileName));
    if (!match) {
      return undefined;
    }
    let describe: unknown;
    try {
      describe = JSON.parse(readFileSync(path.join(this.root, SOQL_METADATA, match[1]!, `${match[2]}.json`), "utf8"));
    } catch {
      return undefined;
    }
    const fields = (describe as { fields?: unknown } | null)?.fields;
    if (!Array.isArray(fields)) {
      return undefined;
    }
    const polymorphicTargets: Record<string, string[]> = {};
    for (const field of fields) {
      const targets: unknown = field?.referenceTo;
      const relationship: unknown = field?.relationshipName;
      if (
        typeof relationship === "string" &&
        Array.isArray(targets) &&
        targets.length > 1 &&
        targets.every((target) => typeof target === "string")
      ) {
        polymorphicTargets[relationship] = targets;
      }
    }
    return { polymorphicTargets };
  }

  /**
   * The module of the component `c/<name>` (`<name>.js` or `.ts` in its bundle), looked up first in
   * `lwcFolder` (where the component using it is) and then in the package directories' `lwc` folders.
   * Like a template's own bundle, the component's must be one SDR resolves, so a component the project's
   * .forceignore denies isn't found (unless the project doesn't respect it).
   */
  findComponentModule(name: string, lwcFolder: string): string | undefined {
    for (const folder of [lwcFolder, ...this.#lwcFolderList()]) {
      for (const extension of [".js", ".ts"]) {
        const file = path.join(folder, name, name + extension);
        if (existsSync(file) && this.componentBundle(file) !== undefined) {
          return file;
        }
      }
    }
    return undefined;
  }

  /**
   * The templates of the Lightning web component bundle at `bundle`, including those in its subfolders,
   * as SDR walks its files: without the ones the project's .forceignore denies (unless the project doesn't
   * respect it). Undefined when SDR doesn't resolve `bundle` as a bundle, as when it's denied itself.
   */
  componentTemplates(bundle: string): string[] | undefined {
    if (!this.contains(bundle)) {
      return undefined;
    }
    let files;
    try {
      files = this.#resolver
        .getComponentsFromPath(path.resolve(bundle))
        .find((component) => component.type.name === "LightningComponentBundle")
        ?.walkContent();
    } catch {
      // SDR throws for folders it can't find or classify
      return undefined;
    }
    // a bundle whose files are all denied is empty, which SDR doesn't count as a component
    if (files === undefined || files.length === 0) {
      return undefined;
    }
    return files.filter((file) => file.toLowerCase().endsWith(".html")).sort();
  }

  #lwcFolderList(): string[] {
    this.#lwcFolders ??= findLwcFolders(this.root, readPackageDirectories(this.root) ?? []);
    return this.#lwcFolders;
  }

  #relative(fileName: string): string {
    return path.relative(this.root, fileName).split(path.sep).join("/");
  }

  /**
   * Whether `fileName` is one of the SObject definitions the Salesforce extensions generate. SDR doesn't
   * resolve them, as they're outside the package directories, so they're recognized by their location.
   */
  isSObjectDefinition(fileName: string): boolean {
    return SOBJECT_DEFINITION.test(this.#relative(fileName));
  }

  contains(fileName: string): boolean {
    const relative = path.relative(this.root, fileName);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  /**
   * The folder of the Lightning web component bundle that `fileName` belongs to, as SDR resolves it: the
   * bundle's root, for files in its subfolders too. Undefined for files outside a bundle, files the
   * project ignores, and files that aren't on disk (such as a new, unsaved file).
   */
  componentBundle(fileName: string): string | undefined {
    if (!this.contains(fileName)) {
      return undefined;
    }
    try {
      return this.#resolver
        .getComponentsFromPath(path.resolve(fileName))
        .find((component) => component.type.name === "LightningComponentBundle")?.content;
    } catch {
      // SDR throws for files it can't find or classify, which aren't in a bundle as far as it knows
      return undefined;
    }
  }

  /**
   * Returns the metadata type of `fileName` (such as `ApexClass` or `CustomLabels`) when it's the primary
   * file of a component of a type `isSupported` accepts, or undefined otherwise. Matching the plugin, an
   * Apex class's primary file is its source (`.cls`), and every other type's is its metadata XML
   * (`-meta.xml`); companion files such as `.cls-meta.xml`, `.asset` or static resource bodies aren't.
   */
  resolveType(fileName: string, isSupported: (type: string) => boolean): string | undefined {
    // A content mapper registered for `.xml` gets arbitrary XML too; only `.cls` and `-meta.xml` files
    // can be primary files, so skip SDR for anything else.
    if (!this.contains(fileName) || !/(\.cls|-meta\.xml)$/i.test(fileName)) {
      return undefined;
    }
    const target = path.resolve(fileName);
    let components;
    try {
      components = this.#resolver.getComponentsFromPath(target);
    } catch (error) {
      // SDR throws for paths it can't classify; those files simply aren't metadata we convert.
      console.error(error);
      return undefined;
    }
    for (const component of components) {
      const type = component.type.name;
      if (!isSupported(type)) {
        continue;
      }
      const primary = type === "ApexClass" ? component.content : component.xml;
      if (primary !== undefined && path.resolve(primary) === target) {
        return type;
      }
    }
    return undefined;
  }
}

interface ProjectConfiguration {
  /** The content of every file the project depends on, which identifies it. */
  readonly key: string;
  /** sfdx-project.json's `namespace`, when it has one. */
  readonly namespace: string | undefined;
}

/**
 * Reads the files an SFDX project's identity depends on. A missing file is distinguished from an empty
 * one: SDR only applies its default ignores with a .forceignore, for example.
 */
function readConfiguration(root: string): ProjectConfiguration {
  const optional = (file: string) => {
    const content = readOptional(path.join(root, file));
    return content === undefined ? "\0" : `\x01${content}`;
  };
  const projectFile = readFileSync(path.join(root, SFDX_PROJECT_FILE), "utf8");
  const namespace = (parse(projectFile) as { namespace?: unknown } | undefined)?.namespace;
  return {
    key: [projectFile, optional(FORCE_IGNORE_FILE), optional(TYPE_NAMES_FILE)].join("\0"),
    namespace: typeof namespace === "string" && namespace.trim() !== "" ? namespace.trim() : undefined,
  };
}

/** SFDX projects by root, with the configuration they were loaded from. */
const loaded = new Map<string, { key: string; project: Promise<SfdxProject> }>();

function readOptional(fileName: string): string | undefined {
  try {
    return readFileSync(fileName, "utf8");
  } catch {
    return undefined;
  }
}
