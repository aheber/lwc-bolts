// JavaScript identifiers in generated declarations, such as the `const` a module exports.

/** Words that can't name a variable, such as a `const` declared after a component or a field. */
export const RESERVED_WORDS: ReadonlySet<string> = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "implements interface let package private protected public static yield await"
  ).split(" "),
);

/**
 * Words that can't name a namespace, such as a part of the `apexNamespace` Apex types are declared in: the
 * reserved words but `await`, which TypeScript accepts as a namespace's name (`declare namespace
 * Acme.await`), though not as a variable's that's exported (`export default await;` is an expression).
 */
export const NAMESPACE_RESERVED_WORDS: ReadonlySet<string> = new Set([...RESERVED_WORDS].filter((word) => word !== "await"));

/** Whether a name is an identifier, so it can be written without quotes. */
export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

/** A name for a `const`: the name itself, or with a `_` prefix when it's a reserved word (`_delete`). */
export function variableName(name: string): string {
  return RESERVED_WORDS.has(name) ? `_${name}` : name;
}
