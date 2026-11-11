import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apexLibrary, createApexLibrary, type LibraryTypes } from "../src/apex/library.ts";
import { APEX_LIBRARY_CONFIG, type ApexLibraryConfig } from "../src/apex/library.config.ts";
import { STANDARD_APEX_LIBRARY } from "../src/apex/library.generated.ts";

const TYPES: LibraryTypes = {
  Schema: { DescribeFieldResult: { kind: "class", open: true }, Shared: { kind: "class" } },
  System: { Exception: { kind: "class" }, Shared: { kind: "interface" }, Location: { kind: "class", open: true } },
  Database: { SaveResult: { kind: "class", open: true } },
};
const CONFIG: ApexLibraryConfig = {
  namespaces: [{ name: "Schema", sobjects: true }, { name: "System" }],
  resolutionOrder: {},
  additionalTypes: {},
};
const resolved = (library: ReturnType<typeof createApexLibrary>, name: string) =>
  library.resolve(name)?.map((step) => (step.kind === "type" ? `${step.ref.namespace}.${step.ref.name}` : `${step.namespace} SObjects`));

describe("Apex library", () => {
  it("looks unqualified names up in the configured namespaces, in order, with Schema's SObjects", () => {
    const library = createApexLibrary(TYPES, CONFIG);
    assert.deepEqual(resolved(library, "exception"), ["Schema SObjects", "System.Exception"]);
    assert.deepEqual(resolved(library, "DESCRIBEFIELDRESULT"), ["Schema.DescribeFieldResult"]);
    // in both: the first namespace's
    assert.deepEqual(resolved(library, "Shared"), ["Schema.Shared"]);
    // no library type: left to the project's types and SObjects
    assert.equal(library.resolve("Account"), undefined);
    // an unconfigured namespace's types aren't found
    assert.equal(library.resolve("SaveResult"), undefined);
    assert.equal(library.namespace("database"), undefined);
  });

  it("looks names up in their own order where one is configured", () => {
    const library = createApexLibrary(TYPES, {
      ...CONFIG,
      resolutionOrder: { shared: ["System", "Schema"], LOCATION: ["Unknown", "System"] },
    });
    assert.deepEqual(resolved(library, "Shared"), ["System.Shared"]);
    // an unconfigured namespace in the order is skipped, and Schema's SObjects aren't looked at
    assert.deepEqual(resolved(library, "location"), ["System.Location"]);
  });

  it("adds configured types, and namespaces as they're configured", () => {
    const library = createApexLibrary(TYPES, {
      namespaces: [...CONFIG.namespaces, { name: "Database" }],
      resolutionOrder: {},
      additionalTypes: { System: { AuraHandledException: { kind: "class", extends: "System.Exception" } } },
    });
    assert.deepEqual(library.type("system", "aurahandledexception"), {
      namespace: "System",
      name: "AuraHandledException",
      type: { kind: "class", extends: "System.Exception" },
    });
    assert.deepEqual(resolved(library, "saveresult"), ["Schema SObjects", "Database.SaveResult"]);
    assert.equal(library.namespace("DATABASE")?.name, "Database");
    assert.equal(library.hasTypeNamed("saveResult"), true);
    assert.equal(library.hasTypeNamed("Account"), false);
  });
});

describe("generated Apex library", () => {
  it("has every configured namespace", () => {
    for (const { name } of APEX_LIBRARY_CONFIG.namespaces) {
      assert.ok(Object.keys(STANDARD_APEX_LIBRARY[name] ?? {}).length > 0, name);
    }
  });

  it("extends only types it has", () => {
    for (const [namespace, types] of Object.entries(STANDARD_APEX_LIBRARY)) {
      for (const [name, type] of Object.entries(types)) {
        if (type.kind === "class" && type.extends !== undefined) {
          const [baseNamespace, baseName] = type.extends.split(".");
          assert.ok(apexLibrary.type(baseNamespace!, baseName!), `${namespace}.${name} extends ${type.extends}`);
        }
      }
    }
  });

  it("has System's exceptions, compound field types and Schema's describe types", () => {
    assert.equal(apexLibrary.type("System", "Exception")?.type.kind, "class");
    assert.deepEqual(apexLibrary.type("System", "DmlException")?.type, { kind: "class", extends: "System.Exception" });
    assert.deepEqual(apexLibrary.type("System", "Address")?.type, { kind: "class", extends: "System.Location", open: true });
    assert.equal(apexLibrary.type("System", "Comparable")?.type.kind, "interface");
    const displayType = apexLibrary.type("Schema", "DisplayType")?.type;
    assert.ok(displayType?.kind === "enum" && displayType.values.includes("PICKLIST"));
  });
});
