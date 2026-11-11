// Apex's standard library (namespaces such as System and Schema): the types project Apex can reference,
// and how an unqualified name finds one. The types are generated (library.generated.ts); which
// namespaces there are, their order and the exceptions to it are configured (library.config.ts).
import { APEX_LIBRARY_CONFIG, type ApexLibraryConfig, type ApexNamespaceConfig } from "./library.config.ts";
import { STANDARD_APEX_LIBRARY } from "./library.generated.ts";

/**
 * A library type, as far as LWC sees it. A class or interface whose instances have properties is
 * `open`: their JSON names aren't known exactly, so any property can be read. An enum's values are its
 * names, which is how Apex serializes them.
 */
export type LibraryType =
  | {
      readonly kind: "class";
      /** The base class, with its namespace (`System.Exception`). */ readonly extends?: string;
      readonly open?: boolean;
    }
  | { readonly kind: "interface" }
  | { readonly kind: "enum"; readonly values: readonly string[] };

/** Library types by namespace and name, as Apex spells them. */
export type LibraryTypes = Readonly<Record<string, Readonly<Record<string, LibraryType>>>>;

export interface LibraryTypeRef {
  readonly namespace: string;
  readonly name: string;
  readonly type: LibraryType;
}

/**
 * Where an unqualified name is looked for after the project's own types: a library type, which ends the
 * search, or the project's SObjects (in a namespace that has them, such as Schema).
 */
export type ResolutionStep =
  | { readonly kind: "type"; readonly ref: LibraryTypeRef }
  | { readonly kind: "sobjects"; readonly namespace: string };

export interface ApexLibrary {
  /** The namespace of this name (case-insensitive), as configured, or undefined for any other. */
  namespace(name: string): ApexNamespaceConfig | undefined;
  /** The type of this namespace and name (both case-insensitive). */
  type(namespace: string, name: string): LibraryTypeRef | undefined;
  /**
   * Whether a library type has this name (case-insensitive): a project type or SObject of the name can
   * shadow it, so references to the name have to check for one.
   */
  hasTypeNamed(name: string): boolean;
  /**
   * The steps an unqualified name's resolution takes after the project's own types, ending with the
   * library type it finds. Undefined when no library type has the name, which leaves it to the
   * project's types and SObjects.
   */
  resolve(name: string): readonly ResolutionStep[] | undefined;
}

export function createApexLibrary(types: LibraryTypes, config: ApexLibraryConfig): ApexLibrary {
  const namespaces = new Map<string, { config: ApexNamespaceConfig; types: Map<string, LibraryTypeRef> }>();
  for (const namespaceConfig of config.namespaces) {
    const entry = { config: namespaceConfig, types: new Map<string, LibraryTypeRef>() };
    const { name } = namespaceConfig;
    for (const source of [types[name] ?? {}, config.additionalTypes[name] ?? {}]) {
      for (const [typeName, type] of Object.entries(source)) {
        entry.types.set(typeName.toLowerCase(), { namespace: name, name: typeName, type });
      }
    }
    namespaces.set(name.toLowerCase(), entry);
  }
  const order = new Map(Object.entries(config.resolutionOrder).map(([name, order]) => [name.toLowerCase(), order]));
  // every namespace's type names, lower-cased, which each file asks about its own name
  const typeNames = new Set([...namespaces.values()].flatMap(({ types }) => [...types.keys()]));
  return {
    namespace: (name) => namespaces.get(name.toLowerCase())?.config,
    type: (namespace, name) => namespaces.get(namespace.toLowerCase())?.types.get(name.toLowerCase()),
    hasTypeNamed: (name) => typeNames.has(name.toLowerCase()),
    resolve(name) {
      const key = name.toLowerCase();
      const steps: ResolutionStep[] = [];
      for (const namespaceName of order.get(key) ?? config.namespaces.map(({ name }) => name)) {
        const namespace = namespaces.get(namespaceName.toLowerCase());
        if (namespace === undefined) {
          continue; // not a configured namespace
        }
        const ref = namespace.types.get(key);
        if (ref !== undefined) {
          steps.push({ kind: "type", ref });
          return steps;
        }
        if (namespace.config.sobjects) {
          steps.push({ kind: "sobjects", namespace: namespace.config.name });
        }
      }
      return undefined;
    },
  };
}

/** The library as generated and configured. */
export const apexLibrary: ApexLibrary = createApexLibrary(STANDARD_APEX_LIBRARY, APEX_LIBRARY_CONFIG);
