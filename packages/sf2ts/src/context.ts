import { DEFAULT_APEX_NAMESPACE } from "./apex/namespace.ts";
import type { ConvertOptions, InaccessibleApexProperties } from "./types.ts";
import { isIdentifier, NAMESPACE_RESERVED_WORDS } from "./identifiers.ts";

const INACCESSIBLE_APEX_PROPERTIES: readonly InaccessibleApexProperties[] = ["include", "exclude", "include as deprecated"];

/** `convert`'s options as the converters use them: defaults applied, and an empty namespace as none. */
export interface ConversionContext {
  /** The namespace Apex types are declared in (`"Apex"` by default), or `null` to declare them globally. */
  readonly apexNamespace: string | null;
  /** What becomes of Apex classes' fields LWC can't read (`"include as deprecated"` by default). */
  readonly inaccessibleApexProperties: InaccessibleApexProperties;
  /** The project's namespace, or undefined without one. */
  readonly projectNamespace: string | undefined;
}

/**
 * A Salesforce namespace prefix: letters, digits and single underscores, starting with a letter and not
 * ending with an underscore.
 */
const NAMESPACE_PREFIX = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;

/**
 * Applies `convert`'s defaults, and throws for a namespace that would make the declarations invalid: an
 * `apexNamespace` that isn't a dotted TypeScript identifier, or a `projectNamespace` that isn't a
 * namespace prefix, and for an `inaccessibleApexProperties` that isn't one of its values.
 */
export function conversionContext(options?: ConvertOptions): ConversionContext {
  const apexNamespace = options?.apexNamespace === undefined ? DEFAULT_APEX_NAMESPACE : options.apexNamespace;
  if (apexNamespace !== null && !apexNamespace.split(".").every((part) => isIdentifier(part) && !NAMESPACE_RESERVED_WORDS.has(part))) {
    throw new TypeError(
      `apexNamespace ${JSON.stringify(apexNamespace)} isn't a namespace TypeScript can declare; use dotted identifiers (such as "Acme.Apex"), or null`,
    );
  }
  const inaccessibleApexProperties = options?.inaccessibleApexProperties ?? "include as deprecated";
  if (!INACCESSIBLE_APEX_PROPERTIES.includes(inaccessibleApexProperties)) {
    throw new TypeError(
      `inaccessibleApexProperties must be one of ${INACCESSIBLE_APEX_PROPERTIES.map((value) => JSON.stringify(value)).join(", ")}, but got ${JSON.stringify(inaccessibleApexProperties)}`,
    );
  }
  const projectNamespace = options?.projectNamespace?.trim() || undefined;
  if (projectNamespace !== undefined && !NAMESPACE_PREFIX.test(projectNamespace)) {
    throw new TypeError(`projectNamespace ${JSON.stringify(projectNamespace)} isn't a Salesforce namespace prefix`);
  }
  return { apexNamespace, inaccessibleApexProperties, projectNamespace };
}
