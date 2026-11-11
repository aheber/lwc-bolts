// The resolution of Apex type references, rule by rule (see TypeResolver.resolve). These tests pin the
// exact output, registries' lookups included; conversions' tests check what the types resolve to.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TypeResolver, type ResolverOptions } from "../src/apex/resolution.ts";

const resolver = (options: Partial<ResolverOptions> = {}) =>
  new TypeResolver({
    namespace: "Apex",
    projectNamespace: undefined,
    packageNamespace: undefined,
    className: "Billing",
    isSobject: false,
    nestedTypes: new Map([["line", "Line"]]),
    ...options,
  });
const inPackage = { packageNamespace: "dlrs", className: "RollupController", nestedTypes: new Map([["result", "Result"]]) };
const lookup = (registry: string, key: string, otherwise: string) => `${registry} extends { "${key}": infer T } ? T : ${otherwise}`;
/** A reference's type: a lookup through registries without the parentheses it's written in, or the reference itself. */
const typeOf = (resolver: TypeResolver, parts: string[]) => {
  const reference = resolver.resolve(parts);
  return reference.startsWith("(") && reference.endsWith(")") ? reference.slice(1, -1) : reference;
};

describe("TypeResolver", () => {
  it("1. resolves names through the package's namespace to its types, and through the project's to its own", () => {
    const pkg = resolver(inPackage);
    assert.equal(typeOf(pkg, ["dlrs", "RollupSummary"]), lookup("Apex.dlrs.__lwcClasses", "rollupsummary", "unknown"));
    assert.equal(pkg.resolve(["DLRS", "RollupController", "Result"]), "Apex.dlrs.RollupController.Result");
    assert.equal(resolver({ projectNamespace: "acme" }).resolve(["ACME", "Invoices"]), "Apex.Invoices");
  });

  it("2. resolves the file's own types in their declared spelling", () => {
    assert.equal(resolver().resolve(["billing"]), "Apex.Billing");
    assert.equal(resolver().resolve(["Billing", "LINE"]), "Apex.Billing.Line");
    assert.equal(resolver().resolve(["line"]), "Apex.Billing.Line");
    assert.equal(resolver(inPackage).resolve(["result"]), "Apex.dlrs.RollupController.Result");
  });

  it("3. names custom objects with the namespace of the code they're in", () => {
    assert.equal(resolver().resolve(["Invoice__c"]), "Apex.Invoice__c");
    assert.equal(resolver({ projectNamespace: "acme" }).resolve(["Invoice__c"]), "Apex.acme__Invoice__c");
    assert.equal(resolver({ projectNamespace: "acme" }).resolve(["dlrs__Log__c"]), "Apex.dlrs__Log__c");
    // a package's copy may refer to an object without its definition
    assert.equal(typeOf(resolver(inPackage), ["Log__c"]), lookup("Apex.__lwcSObjects", "dlrs__log__c", "unknown"));
  });

  it("4. resolves names a library type has through the registries, in order", () => {
    assert.equal(
      typeOf(resolver(), ["Exception"]),
      lookup("Apex.__lwcClasses", "exception", lookup("Apex.__lwcSObjects", "exception", "Apex.System.Exception")),
    );
    // configured to look in System first: no SObject step
    assert.equal(typeOf(resolver(), ["address"]), lookup("Apex.__lwcClasses", "address", "Apex.System.Address"));
    // a package can't see the project's classes
    assert.equal(
      typeOf(resolver(inPackage), ["Exception"]),
      lookup("Apex.dlrs.__lwcClasses", "exception", lookup("Apex.__lwcSObjects", "exception", "Apex.System.Exception")),
    );
  });

  it("5. resolves library types through their namespace, System's primitives, and Schema's SObjects", () => {
    assert.equal(resolver().resolve(["System", "String"]), "string");
    assert.equal(resolver().resolve(["system", "exception"]), "Apex.System.Exception");
    assert.equal(resolver().resolve(["Schema", "DisplayType"]), 'Apex.Schema.__lwcEnums["DisplayType"]');
    assert.equal(resolver().resolve(["Schema", "Account"]), "Apex.Account");
    assert.equal(resolver({ projectNamespace: "acme" }).resolve(["Schema", "Invoice__c"]), "Apex.acme__Invoice__c");
    assert.equal(typeOf(resolver(inPackage), ["Schema", "Account"]), lookup("Apex.__lwcSObjects", "account", "unknown"));
  });

  it("6. references other names as written, and in a package through its registry", () => {
    assert.equal(resolver().resolve(["Account"]), "Apex.Account");
    assert.equal(resolver().resolve(["Invoices", "Item"]), "Apex.Invoices.Item");
    assert.equal(
      typeOf(resolver(inPackage), ["Account"]),
      lookup("Apex.dlrs.__lwcClasses", "account", lookup("Apex.__lwcSObjects", "account", "unknown")),
    );
    assert.equal(typeOf(resolver(inPackage), ["Scheduler", "Job"]), lookup("Apex.dlrs.__lwcClasses", "scheduler.job", "unknown"));
    assert.equal(typeOf(resolver(inPackage), ["acmesync", "SyncEvent"]), lookup("Apex.dlrs.__lwcClasses", "acmesync.syncevent", "unknown"));
  });

  it("writes a reference that looks through registries where it's used, in parentheses", () => {
    const file = resolver();
    const exception = `(${lookup("Apex.__lwcClasses", "exception", lookup("Apex.__lwcSObjects", "exception", "Apex.System.Exception"))})`;
    assert.equal(file.resolve(["Exception"]), exception);
    assert.equal(file.resolve(["exception"]), exception);
    assert.doesNotMatch(file.declarations("Billing", undefined), /__lwcRefs/);
  });

  it("writes a base class's reference once, as an alias in its file's own namespace, which an interface can extend", () => {
    const file = resolver();
    assert.equal(file.resolve(["Exception"], { base: true }), "Apex.__lwcRefs.Billing.exception");
    assert.equal(file.resolve(["exception"], { base: true }), "Apex.__lwcRefs.Billing.exception");
    const declarations = file.declarations("Billing", undefined);
    assert.equal(declarations.match(/type exception =/g)?.length, 1);
    assert.match(declarations, /^declare namespace Apex\.__lwcRefs\.Billing \{\n  type exception = Apex\.__lwcClasses/m);
    // a package's classes', SObject definitions', and without an Apex namespace
    assert.equal(resolver(inPackage).resolve(["Account"], { base: true }), "Apex.dlrs.__lwcRefs.RollupController.account");
    assert.equal(
      resolver({ className: "Account", isSobject: true }).resolve(["Assert"], { base: true }),
      "Apex.__lwcSObjectRefs.Account.assert",
    );
    assert.equal(resolver({ namespace: null }).resolve(["Exception"], { base: true }), "__lwcRefs.Billing.exception");
  });

  it("resolves a name nothing declares in a package's class to the fallback given, such as {} for a base class", () => {
    const file = resolver(inPackage);
    const field = file.resolve(["Base"]);
    const base = file.resolve(["Base"], { base: true });
    assert.notEqual(base, field);
    assert.equal(field, `(${lookup("Apex.dlrs.__lwcClasses", "base", lookup("Apex.__lwcSObjects", "base", "unknown"))})`);
    const declarations = file.declarations("RollupController", undefined);
    const typeOfAlias = (alias: string) => new RegExp(`^  type ${alias.split(".").at(-1)} = (.*);$`, "m").exec(declarations)?.[1];
    assert.equal(typeOfAlias(base), lookup("Apex.dlrs.__lwcClasses", "base", lookup("Apex.__lwcSObjects", "base", "{}")));
  });

  it("names an alias apart from TypeScript's types and reserved words", () => {
    const pkg = resolver(inPackage);
    assert.equal(pkg.resolve(["Number"], { base: true }), "Apex.dlrs.__lwcRefs.RollupController.number_");
    assert.equal(pkg.resolve(["Delete"], { base: true }), "Apex.dlrs.__lwcRefs.RollupController.delete_");
    assert.match(pkg.declarations("RollupController", undefined), /^  type number_ = /m);
  });

  it("declares types in the Apex namespace, a package's in it, or globally", () => {
    assert.equal(resolver().typesNamespace, "Apex");
    assert.equal(resolver(inPackage).typesNamespace, "Apex.dlrs");
    assert.equal(resolver({ ...inPackage, namespace: "Org.Apex" }).typesNamespace, "Org.Apex.dlrs");
    assert.equal(resolver({ ...inPackage, namespace: null }).typesNamespace, "dlrs");
    assert.equal(
      typeOf(resolver({ namespace: null }), ["Exception"]),
      lookup("__lwcClasses", "exception", lookup("__lwcSObjects", "exception", "System.Exception")),
    );
  });

  it("declares the registries and library types the references used, with their base classes", () => {
    const used = resolver();
    assert.equal(used.declarations("Billing", undefined), "");
    used.resolve(["DmlException"]);
    used.resolve(["Schema", "DisplayType"]);
    const declarations = used.declarations("Billing", undefined);
    assert.match(declarations, /^declare namespace Apex \{\n  interface __lwcClasses \{\}\n  interface __lwcSObjects \{\}\n/);
    assert.match(
      declarations,
      /^  namespace System \{\n    interface DmlException extends Apex\.System\.Exception \{\}\n    interface Exception \{\}\n  \}$/m,
    );
    assert.match(declarations, /^    interface __lwcEnums \{\n      DisplayType: "ADDRESS" \| /m);
    // the file's own type in a registry
    assert.match(resolver().declarations("Exception", "__lwcClasses"), /^  interface __lwcClasses \{ "exception": Exception; \}$/m);
  });
});
