// How an Apex file's type references become TypeScript types: Apex's primitive types, the file's own
// types, the project's and installed packages' types, SObjects, and the standard library's (library.ts).
// Which type a name is often depends on the whole project, while sf2ts converts one file at a time, so
// such references check registries that the project's files add their types to (namespace.ts), and
// TypeScript picks the type.
import { apexLibrary, type LibraryTypeRef, type ResolutionStep } from "./library.ts";
import { CLASSES_REGISTRY, qualifyApex, registration, registryLookup, SOBJECTS_REGISTRY } from "./namespace.ts";
import { recordName } from "../names.ts";
import { RESERVED_WORDS } from "../identifiers.ts";

/**
 * Apex types as LWC receives them: Apex values are serialized to JSON, so dates, times and blobs
 * arrive as strings (ISO-8601 / base64) and every numeric type as a number.
 */
export const PRIMITIVE_TYPES: Readonly<Record<string, string>> = {
  string: "string",
  id: "string",
  date: "string",
  datetime: "string",
  time: "string",
  blob: "string",
  decimal: "number",
  double: "number",
  integer: "number",
  long: "number",
  boolean: "boolean",
  // any value, including null, which TypeScript's `Object` rejects
  object: "unknown",
  // a record of any SObject type, such as a polymorphic lookup (`Owner`, `What`)
  sobject: "Record<string, unknown>",
  // used by the generated SObject definitions for JSON-typed fields
  json: "unknown",
  void: "void",
};

export interface ResolverOptions {
  /** The namespace Apex types are declared in; `null` declares them globally. */
  readonly namespace: string | null;
  /** The project's namespace, or undefined without one. */
  readonly projectNamespace: string | undefined;
  /** The installed package the file's class belongs to, when it isn't the project's. */
  readonly packageNamespace: string | undefined;
  /** The file's top-level type. */
  readonly className: string;
  /** Whether the file is an SObject definition, whose aliases are apart from classes' (see `#alias`). */
  readonly isSobject: boolean;
  /**
   * The top-level type's nested classes, interfaces and enums, keyed by lower-cased name to their declared
   * spelling. The file adds them as it finds them, before its fields refer to them.
   */
  readonly nestedTypes: ReadonlyMap<string, string>;
}

/** Names TypeScript's types are, which an alias can't have. */
const TYPE_KEYWORDS = new Set(["any", "bigint", "boolean", "never", "number", "object", "string", "symbol", "undefined", "unknown"]);

/**
 * Resolves one Apex file's type references, and collects what its declarations then need: the library
 * types they use, and the registries they read.
 */
export class TypeResolver {
  readonly #options: ResolverOptions;
  /** The library types the declarations reference, by namespace and name; they're declared with them. */
  readonly #libraryTypes = new Map<string, LibraryTypeRef>();
  /** The registries references resolve through, which are declared (empty) so they always exist. */
  readonly #registries = new Set<string>();
  /**
   * The resolved types of references that look through registries, by type, to the names of the aliases
   * the file declares for them, so each is written once however many references it has.
   */
  readonly #aliases = new Map<string, string>();

  constructor(options: ResolverOptions) {
    this.#options = options;
  }

  /** The namespace the file's types are declared in: the Apex namespace, or a package's in it. */
  get typesNamespace(): string | null {
    const { namespace, packageNamespace } = this.#options;
    if (packageNamespace === undefined) {
      return namespace;
    }
    return namespace === null ? packageNamespace : `${namespace}.${packageNamespace}`;
  }

  /** A name in the Apex namespace, as a reference: `Apex.Account`, or `Account` without one. */
  qualify(parts: readonly string[]): string {
    return qualifyApex(this.#options.namespace, parts);
  }

  /** A type declared with the file's types (its classes), as a reference. */
  qualifyOwn(parts: readonly string[]): string {
    const { packageNamespace } = this.#options;
    return this.qualify(packageNamespace === undefined ? parts : [packageNamespace, ...parts]);
  }

  /**
   * Resolves an Apex type reference (`Outer.Inner`, `Inner` from inside `Outer`, `Exception`,
   * `System.Exception`) to its TypeScript type, as Apex looks names up. In order:
   *
   * 1. Through a namespace: the package's (`dlrs.RollupSummary`), which is one of its types, or the
   *    project's (`acme.Invoices`), which is the name without it.
   * 2. The file's own types, in their declared spelling, since Apex names are case-insensitive but
   *    TypeScript names aren't.
   * 3. A custom object (`Invoice__c`), named with the namespace of the code it's in.
   * 4. A name a library type has (see library.ts): the project's types and SObjects, which shadow it,
   *    then the library's namespaces in their configured order, through registries.
   * 5. A library type through its namespace (`System.Exception`). Apex's primitive types are System's
   *    (`System.String`), and a name in Schema that's no library type is an SObject (`Schema.Account`).
   * 6. Any other name, as written in the Apex namespace (the project's classes in other files, and
   *    standard objects).
   *
   * An installed package's class can't see the project's classes, and its copy may not have what it
   * refers to, so its names are its package's types when the copy has them (`RollupSummary`,
   * `RollupController.Result`), then library types and SObjects, and `unknown` otherwise, never an error
   * in code that isn't the project's to fix.
   *
   * A reference that looks through registries is a conditional type, written where it's used (see
   * `#lookup`).
   *
   * @param base whether the reference is a class's base class, which an interface can only extend by
   *   name and which can't be `unknown`: a name a package's class can't find is `{}` instead
   */
  resolve(parts: readonly string[], { base = false }: { base?: boolean } = {}): string {
    const unknown = base ? "{}" : "unknown";
    const [first, ...rest] = parts;
    if (first === undefined) {
      return "";
    }
    const { projectNamespace, packageNamespace, className, nestedTypes } = this.#options;
    // the namespace the code is in, whose custom objects it names without a namespace
    const ownNamespace = packageNamespace ?? projectNamespace;
    const inPackage = packageNamespace !== undefined;

    // 1. through a namespace
    if (inPackage && rest.length > 0 && first.toLowerCase() === packageNamespace.toLowerCase()) {
      // the class itself, or another of the package's, which the copy may not have
      return rest[0]!.toLowerCase() === className.toLowerCase()
        ? this.resolve(rest, { base })
        : this.#lookup(rest, this.#packageLookup(rest, unknown), base);
    }
    if (projectNamespace !== undefined && rest.length > 0 && first.toLowerCase() === projectNamespace.toLowerCase()) {
      return this.resolve(rest, { base });
    }
    // 2. the file's own types
    if (first.toLowerCase() === className.toLowerCase()) {
      return this.qualifyOwn([className, ...rest.map((part) => nestedTypes.get(part.toLowerCase()) ?? part)]);
    }
    const nested = rest.length === 0 ? nestedTypes.get(first.toLowerCase()) : undefined;
    if (nested !== undefined) {
      return this.qualifyOwn([className, nested]);
    }
    if (rest.length === 0) {
      // 3. a custom object, which a package's copy may refer to without its definition
      const custom = recordName(first, ownNamespace);
      if (custom !== first) {
        return inPackage ? this.#lookup([custom], this.#sobjectLookup(custom, unknown), base) : this.qualify([custom]);
      }
      // 4. a name a library type has
      const steps = apexLibrary.resolve(first);
      if (!inPackage) {
        return steps === undefined ? this.qualify([first]) : this.#lookup([first], this.#libraryLookup(first, steps, true), base);
      }
      return this.#lookup(
        [first],
        this.#packageLookup([first], steps === undefined ? this.#sobjectLookup(first, unknown) : this.#libraryLookup(first, steps, false)),
        base,
      );
    }
    // 5. a library type through its namespace
    const namespace = apexLibrary.namespace(first);
    const [name] = rest;
    if (namespace !== undefined && name !== undefined && rest.length === 1) {
      const primitive = namespace.name === "System" ? PRIMITIVE_TYPES[name.toLowerCase()] : undefined;
      if (primitive !== undefined) {
        return primitive;
      }
      const ref = apexLibrary.type(namespace.name, name);
      if (ref !== undefined) {
        return this.#libraryReference(ref);
      }
      if (namespace.sobjects) {
        const sobject = recordName(name, ownNamespace);
        return inPackage ? this.#lookup([sobject], this.#sobjectLookup(sobject, unknown), base) : this.qualify([sobject]);
      }
    }
    // 6. any other name: in a package, another of its classes' nested types, or another package's type
    return inPackage ? this.#lookup(parts, this.#packageLookup(parts, unknown), base) : this.qualify(parts);
  }

  /**
   * The declarations the file's references need, in a block of their own, or "" without any: the
   * library types they use (and their base classes), the registries they read, and the file's own type
   * in `ownRegistry`, if given. Other files declare the same library types and registries, which merge.
   */
  declarations(ownName: string, ownRegistry: string | undefined): string {
    if (this.#libraryTypes.size === 0 && this.#registries.size === 0 && ownRegistry === undefined) {
      // a package's registry is declared by its classes' files themselves, so its aliases can be all there is
      return this.#aliasDeclarations();
    }
    // base classes are declared too
    for (const ref of this.#libraryTypes.values()) {
      const base = ref.type.kind === "class" ? ref.type.extends : undefined;
      const [namespace, name] = base?.split(".") ?? [];
      const baseRef = namespace !== undefined && name !== undefined ? apexLibrary.type(namespace, name) : undefined;
      if (baseRef !== undefined) {
        this.#libraryReference(baseRef);
      }
    }
    const { namespace: apexNamespace } = this.#options;
    const indent = apexNamespace === null ? "" : "  ";
    const lines: string[] = [];
    for (const registry of new Set([...this.#registries, ...(ownRegistry === undefined ? [] : [ownRegistry])])) {
      lines.push(registry === ownRegistry ? registration(indent, registry, [ownName]) : `${indent}interface ${registry} {}\n`);
    }
    const byNamespace = new Map<string, LibraryTypeRef[]>();
    for (const ref of this.#libraryTypes.values()) {
      byNamespace.set(ref.namespace, [...(byNamespace.get(ref.namespace) ?? []), ref]);
    }
    for (const [namespace, refs] of [...byNamespace].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${indent}${indent === "" ? "declare " : ""}namespace ${namespace} {\n`);
      const enums: string[] = [];
      for (const { name, type } of refs.sort((a, b) => a.name.localeCompare(b.name))) {
        if (type.kind === "enum") {
          enums.push(`${name}: ${type.values.length === 0 ? "never" : type.values.map((value) => JSON.stringify(value)).join(" | ")};`);
          continue;
        }
        const bases = [
          ...(type.kind === "class" && type.extends !== undefined ? [this.qualify(type.extends.split("."))] : []),
          // its properties' JSON names aren't known exactly, so any can be read
          ...(type.kind === "interface" || (type.kind === "class" && type.open) ? ["Record<string, unknown>"] : []),
        ];
        lines.push(`${indent}  interface ${name}${bases.length === 0 ? "" : ` extends ${bases.join(", ")}`} {}\n`);
      }
      if (enums.length > 0) {
        lines.push(`${indent}  interface __lwcEnums {\n${enums.map((line) => `${indent}    ${line}\n`).join("")}${indent}  }\n`);
      }
      lines.push(`${indent}}\n`);
    }
    const libraryBlock = apexNamespace === null ? lines.join("") : `declare namespace ${apexNamespace} {\n${lines.join("")}}\n`;
    return libraryBlock + this.#aliasDeclarations();
  }

  /** The file's aliases (see `#alias`), in a namespace named for its class, or "" without any. */
  #aliasDeclarations(): string {
    if (this.#aliases.size === 0) {
      return "";
    }
    const aliases = [...this.#aliases].map(([type, name]) => `  type ${name} = ${type};\n`).join("");
    return `declare namespace ${this.#aliasNamespace} {\n${aliases}}\n`;
  }

  /**
   * The namespace the file's aliases are in: one of their own for the file's class, in the namespace of
   * aliases for classes (`Apex.__lwcRefs.Billing`, `Apex.dlrs.__lwcRefs.RollupController`) or for SObject
   * definitions (`Apex.__lwcSObjectRefs.Account`). A class has one file, and so does an SObject
   * definition, so no other file declares aliases in it, even when a class and an SObject share a name.
   * Being apart from the class's own namespace also keeps them out of editors' suggestions for it.
   */
  get #aliasNamespace(): string {
    const { isSobject, className } = this.#options;
    const scope = isSobject ? this.qualify(["__lwcSObjectRefs"]) : this.qualifyOwn(["__lwcRefs"]);
    return `${scope}.${className}`;
  }

  /**
   * A reference that looks through registries, of type `type`: written where it's used, in parentheses
   * so it can be an array's element or part of an intersection; or, for a base class, as an alias, since
   * an interface can only extend a type by name.
   */
  #lookup(parts: readonly string[], type: string, base: boolean): string {
    return base ? this.#alias(parts, type) : `(${type})`;
  }

  /** An alias for `type`, a base class's resolved type, named for the reference (`base`). */
  #alias(parts: readonly string[], type: string): string {
    let name = this.#aliases.get(type);
    if (name === undefined) {
      let base = parts
        .join("_")
        .toLowerCase()
        .replace(/[^\w$]/g, "_");
      // names a type can't have, such as `object`, or a reserved word
      if (TYPE_KEYWORDS.has(base) || RESERVED_WORDS.has(base)) {
        base = `${base}_`;
      }
      const taken = new Set(this.#aliases.values());
      name = base;
      for (let n = 2; taken.has(name); n++) {
        name = `${base}_${n}`;
      }
      this.#aliases.set(type, name);
    }
    return `${this.#aliasNamespace}.${name}`;
  }

  /** A library type, which is declared with the file's declarations. */
  #libraryReference(ref: LibraryTypeRef): string {
    this.#libraryTypes.set(`${ref.namespace}.${ref.name}`.toLowerCase(), ref);
    return ref.type.kind === "enum"
      ? `${this.qualify([ref.namespace, "__lwcEnums"])}[${JSON.stringify(ref.name)}]`
      : this.qualify([ref.namespace, ref.name]);
  }

  /**
   * The SObjects' registry (`Apex.__lwcSObjects`), which every declared SObject adds itself to, by
   * lower-cased name: what `registryLookup` reads to refer to an SObject that may not be declared.
   */
  get sobjectsRegistry(): string {
    return this.#registry(SOBJECTS_REGISTRY);
  }

  /** A registry in the Apex namespace, which the file's declarations then declare. */
  #registry(name: string): string {
    this.#registries.add(name);
    return this.qualify([name]);
  }

  /**
   * A name a library type has: the project's type of that name if it has one (unless `projectClasses` is
   * false, in a package's class), else what `steps` find (an SObject, or the library type).
   */
  #libraryLookup(name: string, steps: readonly ResolutionStep[], projectClasses: boolean): string {
    const resolve = ([step, ...rest]: readonly ResolutionStep[]): string => {
      if (step === undefined) {
        return "never";
      }
      return step.kind === "type"
        ? this.#libraryReference(step.ref)
        : registryLookup(this.#registry(SOBJECTS_REGISTRY), name, resolve(rest));
    };
    return projectClasses ? registryLookup(this.#registry(CLASSES_REGISTRY), name, resolve(steps)) : resolve(steps);
  }

  /** An SObject that may not be declared: `unknown` when no file declares it, rather than an error. */
  #sobjectLookup(name: string, unknown: string): string {
    return registryLookup(this.#registry(SOBJECTS_REGISTRY), name, unknown);
  }

  /**
   * In a package's class, the package's type of a name (`RollupSummary`, `RollupController.Result`) when
   * it has one, and otherwise `otherwise`. Its types are in its registry, which each of its classes' files
   * adds itself and its nested types to, by lower-cased dotted name.
   */
  #packageLookup(path: readonly string[], otherwise: string): string {
    return registryLookup(this.qualifyOwn([CLASSES_REGISTRY]), path.join("."), otherwise);
  }
}
