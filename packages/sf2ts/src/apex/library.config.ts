// Which of Apex's standard library namespaces sf2ts knows, and how references resolve to their types.
// To add a namespace, list it in `namespaces` and run `npm run generate:apex-library`, which reads its
// types from the Salesforce extensions' StandardApexLibrary into library.generated.ts.
import type { LibraryType } from "./library.ts";

export interface ApexNamespaceConfig {
  /** The namespace's name, as Apex and the StandardApexLibrary folder spell it. */
  readonly name: string;
  /**
   * Whether the project's SObjects belong to this namespace, as they do to Schema. Where the namespace
   * comes in an unqualified name's resolution, an SObject of that name is found there.
   */
  readonly sobjects?: boolean;
}

export interface ApexLibraryConfig {
  /**
   * The namespaces, in the order an unqualified name (such as `Exception`) is looked for in them. The
   * project's own types come before all of them, so a project class shadows a library type of the same
   * name, which then needs its namespace (`System.Exception`).
   */
  readonly namespaces: readonly ApexNamespaceConfig[];
  /** Names (case-insensitive) looked for in a different order of namespaces than `namespaces` gives. */
  readonly resolutionOrder: Readonly<Record<string, readonly string[]>>;
  /** Types the StandardApexLibrary leaves out, by namespace and name. They're added to the generated ones. */
  readonly additionalTypes: Readonly<Record<string, Readonly<Record<string, LibraryType>>>>;
}

export const APEX_LIBRARY_CONFIG: ApexLibraryConfig = {
  namespaces: [{ name: "Schema", sobjects: true }, { name: "System" }],
  resolutionOrder: {
    // Unqualified, these are the compound field types, even in an org with the Address and Location
    // objects, which need `Schema.Address` and `Schema.Location` (as System.Address's and
    // System.Location's documentation says). The SObject definitions use them for compound fields.
    address: ["System", "Schema"],
    location: ["System", "Schema"],
  },
  additionalTypes: {
    System: {
      // the base of every exception, built into the language
      Exception: { kind: "class" },
      AuraHandledException: { kind: "class", extends: "System.Exception" },
    },
  },
};
