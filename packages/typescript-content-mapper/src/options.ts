// The mapper's options, as a project config's `contentMappers` entry sets them: what they are, their
// defaults and how they're validated. The sf plugin and the VS Code extension name, default and validate
// them from here, through the package's `./options` export. It imports nothing at runtime, so they can
// load it without the mapper's converters.
import type { InaccessibleApexProperties as Sf2tsInaccessibleApexProperties, MetadataType as Sf2tsMetadataType } from "@lwc-bolts/sf2ts";

/**
 * The metadata types the mapper converts, as `disabledMetadataTypes` names them. sf2ts keeps its own
 * list, its `MetadataType`: this one is checked to be part of it here, and to be all of it by the tests.
 * May sub-classify this over time to be able to disable sub-types inside of the LWC Bundle (turn off the XML or HTML handling)
 */
export const METADATA_TYPES = [
  "ApexClass",
  "ContentAsset",
  "CustomField",
  "CustomLabel",
  "CustomLabels",
  "CustomObject",
  "CustomPermission",
  "LightningComponentBundle",
  "LightningMessageChannel",
  "StaticResource",
] as const satisfies readonly Sf2tsMetadataType[];
export type MetadataType = (typeof METADATA_TYPES)[number];

/**
 * What becomes of Apex classes' fields LWC can't read, as `inaccessibleApexProperties` names it: declared
 * plainly, left out, or declared `@deprecated`. Checked to be sf2ts's `InaccessibleApexProperties`, as above.
 */
export const INACCESSIBLE_APEX_PROPERTIES = [
  "include",
  "exclude",
  "include as deprecated",
] as const satisfies readonly Sf2tsInaccessibleApexProperties[];
export type InaccessibleApexProperties = (typeof INACCESSIBLE_APEX_PROPERTIES)[number];

/** A problem with a value in the options, at its path in the `options` object (TypeScript shows it there). */
export interface OptionDiagnostic {
  path: (string | number)[];
  messageText: string;
  code: number;
}

/** The `options` object of this mapper's `contentMappers` entry, after validation. */
export interface MapperOptions {
  /** Namespace Apex types are declared in (possibly dotted), or `null` to declare them globally. */
  readonly apexNamespace: string | null;
  /**
   * Whether Apex classes' fields LWC can't read are declared `@deprecated` (`"include as deprecated"`),
   * declared like the others (`"include"`), or left out (`"exclude"`).
   */
  readonly inaccessibleApexProperties: InaccessibleApexProperties;
  /** Metadata types whose files produce empty output. */
  readonly disabledMetadataTypes: ReadonlySet<MetadataType>;
  /** Whether files the SFDX project's .forceignore denies are left out (`true`) or mapped like others (`false`). */
  readonly respectForceIgnore: boolean;
  /**
   * File extensions (such as `.cls`), lowercased, whose files' TypeScript errors are suppressed, so they don't
   * show in those files. Matched case-insensitively against the end of a file's name.
   */
  readonly suppressDiagnosticsExtensions: readonly string[];
  /**
   * The config file each `lwc` folder gets, which only references the root project. The mapper only
   * validates it: the Lightning Bolts extension reads it to know which file to write and keep.
   */
  readonly lwcConfigFile: LwcConfigFile;
}

/**
 * The config files an `lwc` folder can use to reference the root project. project-setup, which writes them,
 * keeps its own copy, which its tests check against this one.
 */
export const LWC_CONFIG_FILES = ["jsconfig.json", "tsconfig.json"] as const;
export type LwcConfigFile = (typeof LWC_CONFIG_FILES)[number];
export const DEFAULT_LWC_CONFIG_FILE: LwcConfigFile = "jsconfig.json";

/** The options' defaults, as a config writes them: what the mapper uses for each option a config doesn't set. */
export const OPTION_DEFAULTS = {
  apexNamespace: "Apex" as string | null,
  inaccessibleApexProperties: "include as deprecated" as InaccessibleApexProperties,
  disabledMetadataTypes: [] as readonly MetadataType[],
  respectForceIgnore: true,
  suppressDiagnosticsExtensions: [] as readonly string[],
  lwcConfigFile: DEFAULT_LWC_CONFIG_FILE,
} satisfies Record<keyof MapperOptions, unknown>;
export type OptionName = keyof typeof OPTION_DEFAULTS;
export const OPTION_NAMES = Object.keys(OPTION_DEFAULTS) as OptionName[];

export const DEFAULT_OPTIONS: MapperOptions = {
  ...OPTION_DEFAULTS,
  disabledMetadataTypes: new Set(OPTION_DEFAULTS.disabledMetadataTypes),
};

/** Codes of the diagnostics reported against `contentMappers[].options` (displayed as `lwc-bolts<code>`). */
export const OptionDiagnosticCode = {
  InvalidOptions: 1101,
  UnknownOption: 1102,
  InvalidApexNamespace: 1103,
  InvalidDisabledMetadataTypes: 1104,
  UnknownMetadataType: 1105,
  InvalidInaccessibleApexProperties: 1106,
  InvalidRespectForceIgnore: 1107,
  InvalidLwcConfigFile: 1108,
  InvalidSuppressDiagnosticsExtensions: 1109,
} as const;

// Reserved words (including strict mode ones) can't name a namespace.
const RESERVED_WORDS = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "implements interface let package private protected public static yield"
  ).split(" "),
);

/**
 * Validates the options object TypeScript passes to `openProject`. Every problem is reported as an option
 * diagnostic (TypeScript shows it on the offending value in the tsconfig), and an invalid value falls
 * back to its default so the project still type checks.
 */
export function parseOptions(raw: unknown): { options: MapperOptions; diagnostics: OptionDiagnostic[] } {
  const diagnostics: OptionDiagnostic[] = [];
  if (raw === undefined || raw === null) {
    return { options: DEFAULT_OPTIONS, diagnostics };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    diagnostics.push({ path: [], code: OptionDiagnosticCode.InvalidOptions, messageText: "Options must be an object." });
    return { options: DEFAULT_OPTIONS, diagnostics };
  }
  const values = raw as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!(OPTION_NAMES as string[]).includes(key)) {
      diagnostics.push({
        path: [key],
        code: OptionDiagnosticCode.UnknownOption,
        messageText: `Unknown option '${key}'. Expected one of: ${OPTION_NAMES.join(", ")}.`,
      });
    }
  }
  return {
    options: {
      apexNamespace: Object.hasOwn(values, "apexNamespace")
        ? parseApexNamespace(values.apexNamespace, diagnostics)
        : DEFAULT_OPTIONS.apexNamespace,
      inaccessibleApexProperties: parseInaccessibleApexProperties(values.inaccessibleApexProperties, diagnostics),
      disabledMetadataTypes: parseDisabledMetadataTypes(values.disabledMetadataTypes, diagnostics),
      respectForceIgnore: parseRespectForceIgnore(values.respectForceIgnore, diagnostics),
      suppressDiagnosticsExtensions: parseSuppressDiagnosticsExtensions(values.suppressDiagnosticsExtensions, diagnostics),
      lwcConfigFile: parseLwcConfigFile(values.lwcConfigFile, diagnostics),
    },
    diagnostics,
  };
}

function parseApexNamespace(value: unknown, diagnostics: OptionDiagnostic[]): string | null {
  if (value === null) {
    return null;
  }
  const report = (messageText: string) => {
    diagnostics.push({ path: ["apexNamespace"], code: OptionDiagnosticCode.InvalidApexNamespace, messageText });
    return DEFAULT_OPTIONS.apexNamespace;
  };
  if (typeof value !== "string") {
    return report("'apexNamespace' must be a string, or null to declare Apex types globally.");
  }
  if (value === "") {
    return report("'apexNamespace' must not be empty. Use null to declare Apex types globally.");
  }
  for (const segment of value.split(".")) {
    if (!/^[A-Za-z_$][\w$]*$/.test(segment)) {
      return report(`'apexNamespace' must be an identifier or a dotted path of identifiers, but got '${value}'.`);
    }
    if (RESERVED_WORDS.has(segment)) {
      return report(`'apexNamespace' can't use the reserved word '${segment}'.`);
    }
  }
  return value;
}

function parseInaccessibleApexProperties(value: unknown, diagnostics: OptionDiagnostic[]): InaccessibleApexProperties {
  if (value === undefined) {
    return DEFAULT_OPTIONS.inaccessibleApexProperties;
  }
  if (!INACCESSIBLE_APEX_PROPERTIES.includes(value as InaccessibleApexProperties)) {
    diagnostics.push({
      path: ["inaccessibleApexProperties"],
      code: OptionDiagnosticCode.InvalidInaccessibleApexProperties,
      messageText:
        "'inaccessibleApexProperties' must be \"include as deprecated\", to declare Apex fields LWC can't read as deprecated, " +
        '"include", to declare them like other fields, or "exclude", to leave them out.',
    });
    return DEFAULT_OPTIONS.inaccessibleApexProperties;
  }
  return value as InaccessibleApexProperties;
}

function parseRespectForceIgnore(value: unknown, diagnostics: OptionDiagnostic[]): boolean {
  if (value === undefined) {
    return DEFAULT_OPTIONS.respectForceIgnore;
  }
  if (typeof value !== "boolean") {
    diagnostics.push({
      path: ["respectForceIgnore"],
      code: OptionDiagnosticCode.InvalidRespectForceIgnore,
      messageText:
        "'respectForceIgnore' must be true, to leave out files the project's .forceignore denies, or false, to map them like other files.",
    });
    return DEFAULT_OPTIONS.respectForceIgnore;
  }
  return value;
}

function parseSuppressDiagnosticsExtensions(value: unknown, diagnostics: OptionDiagnostic[]): readonly string[] {
  if (value === undefined) {
    return DEFAULT_OPTIONS.suppressDiagnosticsExtensions;
  }
  if (!Array.isArray(value)) {
    diagnostics.push({
      path: ["suppressDiagnosticsExtensions"],
      code: OptionDiagnosticCode.InvalidSuppressDiagnosticsExtensions,
      messageText: "'suppressDiagnosticsExtensions' must be an array of file extensions, such as \".cls\".",
    });
    return DEFAULT_OPTIONS.suppressDiagnosticsExtensions;
  }
  const extensions = new Set<string>();
  value.forEach((item: unknown, index) => {
    if (typeof item === "string" && /^\.[^/\\]+$/.test(item)) {
      extensions.add(item.toLowerCase());
    } else {
      diagnostics.push({
        path: ["suppressDiagnosticsExtensions", index],
        code: OptionDiagnosticCode.InvalidSuppressDiagnosticsExtensions,
        messageText: 'File extensions must be strings that start with a dot, such as ".cls".',
      });
    }
  });
  return [...extensions];
}

function parseLwcConfigFile(value: unknown, diagnostics: OptionDiagnostic[]): LwcConfigFile {
  if (value === undefined) {
    return DEFAULT_OPTIONS.lwcConfigFile;
  }
  if (!LWC_CONFIG_FILES.includes(value as LwcConfigFile)) {
    diagnostics.push({
      path: ["lwcConfigFile"],
      code: OptionDiagnosticCode.InvalidLwcConfigFile,
      messageText: `'lwcConfigFile' must be one of: ${LWC_CONFIG_FILES.map((file) => `"${file}"`).join(", ")}.`,
    });
    return DEFAULT_OPTIONS.lwcConfigFile;
  }
  return value as LwcConfigFile;
}

function parseDisabledMetadataTypes(value: unknown, diagnostics: OptionDiagnostic[]): ReadonlySet<MetadataType> {
  if (value === undefined) {
    return DEFAULT_OPTIONS.disabledMetadataTypes;
  }
  if (!Array.isArray(value)) {
    diagnostics.push({
      path: ["disabledMetadataTypes"],
      code: OptionDiagnosticCode.InvalidDisabledMetadataTypes,
      messageText: "'disabledMetadataTypes' must be an array of metadata type names.",
    });
    return DEFAULT_OPTIONS.disabledMetadataTypes;
  }
  const disabled = new Set<MetadataType>();
  value.forEach((item: unknown, index) => {
    const path = ["disabledMetadataTypes", index];
    if (typeof item !== "string") {
      diagnostics.push({
        path,
        code: OptionDiagnosticCode.InvalidDisabledMetadataTypes,
        messageText: "Metadata type names must be strings.",
      });
    } else if (isSupportedType(item)) {
      disabled.add(item);
    } else {
      const differentCase = METADATA_TYPES.find((type) => type.toLowerCase() === item.toLowerCase());
      diagnostics.push({
        path,
        code: OptionDiagnosticCode.UnknownMetadataType,
        messageText:
          differentCase === undefined
            ? `'${item}' is not a metadata type this mapper converts. Expected one of: ${METADATA_TYPES.join(", ")}.`
            : `Metadata type names are case-sensitive. Did you mean '${differentCase}'?`,
      });
    }
  });
  return disabled;
}

export function isSupportedType(type: string): type is MetadataType {
  return (METADATA_TYPES as readonly string[]).includes(type);
}
