import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_OPTIONS, OptionDiagnosticCode, parseOptions } from "../src/options.ts";

/** Parses options and returns them with their diagnostics as `[path, code, message]`. */
function parse(raw: unknown) {
  const { options, diagnostics } = parseOptions(raw);
  return { options, diagnostics: diagnostics.map((d) => [d.path, d.code, d.messageText]) };
}

describe("parseOptions", () => {
  it("defaults to the Apex namespace with every metadata type enabled", () => {
    for (const raw of [undefined, null, {}]) {
      assert.deepEqual(parse(raw), { options: DEFAULT_OPTIONS, diagnostics: [] });
    }
    assert.equal(DEFAULT_OPTIONS.apexNamespace, "Apex");
    assert.equal(DEFAULT_OPTIONS.inaccessibleApexProperties, "include as deprecated");
    assert.equal(DEFAULT_OPTIONS.respectForceIgnore, true);
    assert.deepEqual(DEFAULT_OPTIONS.suppressDiagnosticsExtensions, [], "every diagnostic reported");
  });

  it("accepts a valid configuration", () => {
    const { options, diagnostics } = parse({
      apexNamespace: "Acme.$Apex_2",
      inaccessibleApexProperties: "include",
      disabledMetadataTypes: ["CustomPermission", "ContentAsset", "CustomPermission"],
      respectForceIgnore: false,
      suppressDiagnosticsExtensions: [".cls", ".CLS", ".Cls-Meta.xml"],
    });
    assert.deepEqual(diagnostics, []);
    assert.equal(options.respectForceIgnore, false);
    assert.deepEqual(options.suppressDiagnosticsExtensions, [".cls", ".cls-meta.xml"], "lowercased, without duplicates");
    assert.equal(options.apexNamespace, "Acme.$Apex_2");
    assert.equal(options.inaccessibleApexProperties, "include");
    assert.deepEqual([...options.disabledMetadataTypes], ["CustomPermission", "ContentAsset"]);
  });

  it("accepts a null namespace", () => {
    assert.deepEqual(parse({ apexNamespace: null }), {
      options: { ...DEFAULT_OPTIONS, apexNamespace: null },
      diagnostics: [],
    });
  });

  it("rejects a non-object", () => {
    for (const raw of ["Apex", 1, ["Apex"]]) {
      assert.deepEqual(parse(raw), {
        options: DEFAULT_OPTIONS,
        diagnostics: [[[], OptionDiagnosticCode.InvalidOptions, "Options must be an object."]],
      });
    }
  });

  it("reports unknown options", () => {
    assert.deepEqual(parse({ namespace: "X" }).diagnostics, [
      [
        ["namespace"],
        OptionDiagnosticCode.UnknownOption,
        "Unknown option 'namespace'. Expected one of: apexNamespace, inaccessibleApexProperties, disabledMetadataTypes, respectForceIgnore, suppressDiagnosticsExtensions, lwcConfigFile.",
      ],
    ]);
  });

  it("reports a respectForceIgnore that isn't a boolean and keeps the default", () => {
    for (const respectForceIgnore of ["false", 0, null, []]) {
      assert.deepEqual(
        parse({ respectForceIgnore }),
        {
          options: DEFAULT_OPTIONS,
          diagnostics: [
            [
              ["respectForceIgnore"],
              OptionDiagnosticCode.InvalidRespectForceIgnore,
              "'respectForceIgnore' must be true, to leave out files the project's .forceignore denies, or false, to map them like other files.",
            ],
          ],
        },
        JSON.stringify(respectForceIgnore),
      );
    }
  });

  it("reports a suppressDiagnosticsExtensions that isn't an array and keeps the default", () => {
    for (const suppressDiagnosticsExtensions of [".cls", true, null, {}]) {
      assert.deepEqual(
        parse({ suppressDiagnosticsExtensions }),
        {
          options: DEFAULT_OPTIONS,
          diagnostics: [
            [
              ["suppressDiagnosticsExtensions"],
              OptionDiagnosticCode.InvalidSuppressDiagnosticsExtensions,
              `'suppressDiagnosticsExtensions' must be an array of file extensions, such as ".cls".`,
            ],
          ],
        },
        JSON.stringify(suppressDiagnosticsExtensions),
      );
    }
  });

  it("reports suppressDiagnosticsExtensions entries that aren't extensions, and keeps the others", () => {
    const { options, diagnostics } = parse({ suppressDiagnosticsExtensions: ["cls", ".xml", 3, ".", "a/.b", ".html"] });
    assert.deepEqual(options.suppressDiagnosticsExtensions, [".xml", ".html"]);
    assert.deepEqual(
      diagnostics,
      [0, 2, 3, 4].map((index) => [
        ["suppressDiagnosticsExtensions", index],
        OptionDiagnosticCode.InvalidSuppressDiagnosticsExtensions,
        `File extensions must be strings that start with a dot, such as ".cls".`,
      ]),
    );
  });

  it("defaults lwcConfigFile to jsconfig.json, accepts tsconfig.json and reports anything else", () => {
    assert.equal(DEFAULT_OPTIONS.lwcConfigFile, "jsconfig.json");
    assert.deepEqual(parse({ lwcConfigFile: "tsconfig.json" }), {
      options: { ...DEFAULT_OPTIONS, lwcConfigFile: "tsconfig.json" },
      diagnostics: [],
    });
    for (const lwcConfigFile of ["tsconfig.base.json", "TSCONFIG.json", null, true]) {
      assert.deepEqual(
        parse({ lwcConfigFile }),
        {
          options: DEFAULT_OPTIONS,
          diagnostics: [
            [
              ["lwcConfigFile"],
              OptionDiagnosticCode.InvalidLwcConfigFile,
              `'lwcConfigFile' must be one of: "jsconfig.json", "tsconfig.json".`,
            ],
          ],
        },
        JSON.stringify(lwcConfigFile),
      );
    }
  });

  it("accepts each inaccessibleApexProperties value", () => {
    for (const inaccessibleApexProperties of ["include", "exclude", "include as deprecated"]) {
      assert.deepEqual(parse({ inaccessibleApexProperties }), {
        options: { ...DEFAULT_OPTIONS, inaccessibleApexProperties },
        diagnostics: [],
      });
    }
  });

  it("reports an inaccessibleApexProperties that isn't one of its values and keeps the default", () => {
    for (const inaccessibleApexProperties of [true, false, "Include", "deprecated", 0, null, []]) {
      assert.deepEqual(
        parse({ inaccessibleApexProperties }),
        {
          options: DEFAULT_OPTIONS,
          diagnostics: [
            [
              ["inaccessibleApexProperties"],
              OptionDiagnosticCode.InvalidInaccessibleApexProperties,
              "'inaccessibleApexProperties' must be \"include as deprecated\", to declare Apex fields LWC can't read as deprecated, " +
                '"include", to declare them like other fields, or "exclude", to leave them out.',
            ],
          ],
        },
        JSON.stringify(inaccessibleApexProperties),
      );
    }
  });

  it("reports invalid namespaces and keeps the default", () => {
    const cases: [unknown, string][] = [
      [42, "'apexNamespace' must be a string, or null to declare Apex types globally."],
      ["", "'apexNamespace' must not be empty. Use null to declare Apex types globally."],
      ["my-ns", "'apexNamespace' must be an identifier or a dotted path of identifiers, but got 'my-ns'."],
      ["Acme.", "'apexNamespace' must be an identifier or a dotted path of identifiers, but got 'Acme.'."],
      ["1Apex", "'apexNamespace' must be an identifier or a dotted path of identifiers, but got '1Apex'."],
      ["Acme.class", "'apexNamespace' can't use the reserved word 'class'."],
    ];
    for (const [apexNamespace, message] of cases) {
      assert.deepEqual(
        parse({ apexNamespace }),
        {
          options: DEFAULT_OPTIONS,
          diagnostics: [[["apexNamespace"], OptionDiagnosticCode.InvalidApexNamespace, message]],
        },
        String(apexNamespace),
      );
    }
  });

  it("reports a disabledMetadataTypes value that isn't an array", () => {
    assert.deepEqual(parse({ disabledMetadataTypes: "ApexClass" }), {
      options: DEFAULT_OPTIONS,
      diagnostics: [
        [
          ["disabledMetadataTypes"],
          OptionDiagnosticCode.InvalidDisabledMetadataTypes,
          "'disabledMetadataTypes' must be an array of metadata type names.",
        ],
      ],
    });
  });

  it("reports each invalid metadata type and keeps the valid ones", () => {
    const { options, diagnostics } = parse({ disabledMetadataTypes: ["apexclass", "Flow", null, "CustomLabels"] });
    assert.deepEqual([...options.disabledMetadataTypes], ["CustomLabels"]);
    assert.deepEqual(diagnostics, [
      [
        ["disabledMetadataTypes", 0],
        OptionDiagnosticCode.UnknownMetadataType,
        "Metadata type names are case-sensitive. Did you mean 'ApexClass'?",
      ],
      [
        ["disabledMetadataTypes", 1],
        OptionDiagnosticCode.UnknownMetadataType,
        "'Flow' is not a metadata type this mapper converts. Expected one of: ApexClass, ContentAsset, " +
          "CustomField, CustomLabel, CustomLabels, CustomObject, CustomPermission, LightningComponentBundle, " +
          "LightningMessageChannel, StaticResource.",
      ],
      [["disabledMetadataTypes", 2], OptionDiagnosticCode.InvalidDisabledMetadataTypes, "Metadata type names must be strings."],
    ]);
  });
});
