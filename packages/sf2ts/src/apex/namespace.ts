// The Apex namespace sf2ts declares Apex types and SObjects in, and the registries in it that references
// to names the standard library also has resolve through (see library.ts).

/**
 * Apex types are declared in this namespace (and merged across files) so class names such as
 * `Response` or `File` don't merge with the DOM's global types.
 */
export const DEFAULT_APEX_NAMESPACE = "Apex";

/**
 * A name in the namespace Apex types are declared in, as a reference: `Apex.Account` (or
 * `Acme.Apex.Account`), or `Account` when they're declared globally (`namespace` null).
 */
export function qualifyApex(namespace: string | null, parts: readonly string[]): string {
  return (namespace === null ? parts : [namespace, ...parts]).join(".");
}

/**
 * Registries: interfaces that each file adds its types to, keyed by lower-cased name, so a reference can
 * check whether the project has a type without an error when it doesn't (see resolution.ts).
 * `__lwcClasses` has the project's Apex types whose names a library type has (such as a class named
 * `Exception`), which shadow it; an installed package's classes have one of their own in its namespace.
 * `__lwcSObjects` has every SObject.
 */
export const CLASSES_REGISTRY = "__lwcClasses";
export const SOBJECTS_REGISTRY = "__lwcSObjects";

/**
 * Adds types to a registry: `interface __lwcSObjects { location: Location }`. Each name is added once, as
 * a key twice is an error: a self-lookup field names its object as both the parent and the child.
 */
export function registration(indent: string, registry: string, names: readonly string[]): string {
  const unique = [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];
  return `${indent}interface ${registry} { ${unique.map((name) => `${JSON.stringify(name.toLowerCase())}: ${name};`).join(" ")} }\n`;
}

/**
 * A registry's type for `name` (looked up by its lower-cased name) when it has one, and otherwise
 * `otherwise`: `R extends { "key": infer T } ? T : otherwise`. Inferring the type, rather than indexing
 * `R["key"]`, isn't an error when the registry doesn't have the key. TypeScript checks a conditional
 * type's branches even when it doesn't take them, so `otherwise` must only refer to types that exist,
 * such as another registry's lookup, a library type, or `unknown`.
 */
export function registryLookup(registry: string, name: string, otherwise: string): string {
  return `${registry} extends { ${JSON.stringify(name.toLowerCase())}: infer T } ? T : ${otherwise}`;
}
