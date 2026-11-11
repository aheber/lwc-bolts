// Salesforce API names and their namespaces. An item belongs to a namespace: the project's own, or an
// installed package's (`dlrs`). Its name takes two forms:
// - the record form, as records and the values of schema imports name it, where custom names have their
//   namespace (`acme__Invoice__c`; see `recordName`);
// - the import form, as a component in the project must name it in an import: LWC rejects the project's
//   own namespace there and requires any other (`Invoice__c`, `dlrs__Log__c`; see `importName`).
import type { Component } from "./types.ts";

/**
 * Suffixes of custom API names: objects and fields (`__c`), relationships (`__r`), custom metadata types
 * (`__mdt`), platform events (`__e`), big objects (`__b`) and external objects (`__x`).
 */
const CUSTOM_SUFFIXES = new Set(["c", "r", "mdt", "e", "b", "x"]);

/** Whether a name ends in a custom suffix (`Invoice__c`, `acme__Lines__r`). */
function isCustomName(name: string): boolean {
  const parts = name.split("__");
  return parts.length > 1 && CUSTOM_SUFFIXES.has(parts.at(-1)!.toLowerCase());
}

/**
 * A custom name with the project's namespace (`acme__Invoice__c` for `Invoice__c`), as records and the
 * values of schema imports have it inside the namespace. Standard names (`Account`, `Name`), names that
 * already have a namespace (`other__Invoice__c`), and every name without a project namespace are left as
 * they are.
 */
export function recordName(name: string, namespace: string | undefined): string {
  return namespace && isCustomName(name) && name.split("__").length === 2 ? `${namespace}__${name}` : name;
}

/**
 * An API name's namespace and its name without it. Salesforce names can't contain `__` themselves, so a
 * name ending in a custom suffix has a namespace when it has three parts (`dlrs__Log__c`), and any other
 * name when it has two (`dlrs__RollupController`, a label's `dlrs__fflib_error`).
 */
export function splitNamespace(apiName: string): { namespace: string | undefined; name: string } {
  const parts = apiName.split("__");
  const custom = isCustomName(apiName);
  if ((custom && parts.length === 3) || (!custom && parts.length === 2)) {
    return { namespace: parts[0], name: parts.slice(1).join("__") };
  }
  return { namespace: undefined, name: apiName };
}

/**
 * How a component in the project names an item in an import: inside a namespace, LWC rejects the
 * project's own namespace and requires any other. So `namespace` is the item's namespace when it's
 * another's (an installed package's, such as `dlrs`), and undefined when it's the project's or it has
 * none; `name` is the item's name without its namespace either way.
 */
export function importNameParts(apiName: string, projectNamespace: string | undefined): { namespace: string | undefined; name: string } {
  const { namespace, name } = splitNamespace(apiName);
  return namespace === undefined || namespace.toLowerCase() === projectNamespace?.toLowerCase()
    ? { namespace: undefined, name }
    : { namespace, name };
}

/**
 * A name without the project's namespace (`Invoice__c` for `acme__Invoice__c`, `logo` for `acme__logo`),
 * as LWC inside the namespace must import it. Other namespaces' names are left as they are.
 */
export function importName(name: string, namespace: string | undefined): string {
  const split = splitNamespace(name);
  return namespace !== undefined && split.namespace?.toLowerCase() === namespace.toLowerCase() ? split.name : name;
}

/**
 * The name of a metadata file: its file name up to the first `.`, such as `Account` for
 * `objects/Account/Account.object-meta.xml`. Paths can use either separator.
 */
export function metadataName(path: string): string {
  const name = path.split(/[\\/]/).pop()?.split(".")[0];
  if (!name) {
    throw new Error(`no metadata name in the file path ${path}`);
  }
  return name;
}

/** The import form of a metadata file's name (see `metadataName`), such as `logo` for `acme__logo.resource-meta.xml` in project `acme`. */
export function fileImportName(component: Component, projectNamespace: string | undefined): string {
  return importName(metadataName(component.path), projectNamespace);
}
