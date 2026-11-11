// A project with a namespace (sfdx-project.json's `namespace`). Inside it, LWC must import custom objects
// and fields without the namespace (it rejects them with it), while the imports' values and records name
// them with it, as a namespaced org showed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convert, MetadataType, type Component } from "../src/index.ts";
import { importName, recordName } from "../src/names.ts";
import { fieldFile, mappedText, objectFile, typeCheck } from "./helpers.ts";

const options = { projectNamespace: "acme" };

const object = (name: string) => objectFile(name);
const field = fieldFile;

describe("project namespace", () => {
  it("names custom objects and fields with the namespace, and leaves others alone", () => {
    assert.equal(recordName("Invoice__c", "acme"), "acme__Invoice__c");
    assert.equal(recordName("Lines__r", "acme"), "acme__Lines__r");
    assert.equal(recordName("Setting__mdt", "acme"), "acme__Setting__mdt");
    // standard names, another namespace's, and no namespace at all
    assert.equal(recordName("Account", "acme"), "Account");
    assert.equal(recordName("other__Invoice__c", "acme"), "other__Invoice__c");
    assert.equal(recordName("Invoice__c", undefined), "Invoice__c");
    assert.equal(importName("ACME__Invoice__c", "acme"), "Invoice__c");
    assert.equal(importName("other__Invoice__c", "acme"), "other__Invoice__c");
    assert.equal(importName("acme__Invoice__c", undefined), "acme__Invoice__c");
  });

  it("declares objects' modules by the names LWC imports, with the namespaced names as their values", async () => {
    const [converted] = await convert([object("Invoice__c")], options);
    assert.match(converted?.text ?? "", /^declare module "@salesforce\/schema\/Invoice__c" \{$/m);
    assert.match(converted?.text ?? "", /objectApiName: "acme__Invoice__c";/);
    assert.match(converted?.text ?? "", /^  interface acme__Invoice__c \{$/m);
    assert.deepEqual(mappedText(converted!).slice(0, 2), [
      ['"@salesforce/schema/Invoice__c"', "Invoice__c"],
      ["Invoice__c", "Invoice__c"],
    ]);
  });

  it("declares fields, lookups, child relationships and compound fields with the namespace", async () => {
    const [lookup, location, onStandard, otherNamespace] = await convert(
      [
        field(
          "Line__c",
          "Invoice__c",
          "<type>Lookup</type><referenceTo>Invoice__c</referenceTo><relationshipName>Lines</relationshipName>",
        ),
        field("Invoice__c", "Site__c", "<type>Location</type>"),
        field("Account", "Rating__c", "<type>Number</type>"),
        field("Account", "other__Score__c", "<type>Number</type>"),
      ],
      options,
    );
    const lookupText = lookup?.text ?? "";
    assert.match(lookupText, /^declare module "@salesforce\/schema\/Line__c\.Invoice__c" \{$/m);
    assert.match(lookupText, /fieldApiName: "acme__Invoice__c";\n    objectApiName: "acme__Line__c";/);
    assert.match(
      lookupText,
      /^  interface acme__Line__c \{\n[^]*?    acme__Invoice__c\?: string;\n[^]*?    acme__Invoice__r\?: Apex\.acme__Invoice__c;/m,
    );
    assert.match(lookupText, /^  interface acme__Invoice__c \{\n    acme__Lines__r\?: Apex\.acme__Line__c\[\];/m);
    assert.match(location?.text ?? "", /acme__Site__Latitude__s\?: number;/);
    assert.match(onStandard?.text ?? "", /fieldApiName: "acme__Rating__c";\n    objectApiName: "Account";/);
    assert.match(onStandard?.text ?? "", /^  interface Account \{\n[^]*?    acme__Rating__c\?: number;/m);
    assert.match(otherNamespace?.text ?? "", /^declare module "@salesforce\/schema\/Account\.other__Score__c" \{$/m);
    assert.match(otherNamespace?.text ?? "", /fieldApiName: "other__Score__c";/);
  });

  it("resolves Apex references through the namespace, and to custom objects with it", async () => {
    const [converted] = await convert(
      [
        {
          path: "force-app/classes/Billing.cls",
          type: MetadataType.ApexClass,
          content: `public class Billing {
    @AuraEnabled public acme.Invoices invoices;
    @AuraEnabled public Invoice__c invoice;
    @AuraEnabled public Schema.Invoice__c schemaInvoice;
    @AuraEnabled public acme__Invoice__c prefixedInvoice;
    @AuraEnabled public List<Account> accounts;
}`,
        },
      ],
      options,
    );
    const text = converted?.text ?? "";
    assert.match(text, /invoices\?: Apex\.Invoices;/);
    assert.match(text, /invoice\?: Apex\.acme__Invoice__c;/);
    assert.match(text, /schemaInvoice\?: Apex\.acme__Invoice__c;/);
    assert.match(text, /prefixedInvoice\?: Apex\.acme__Invoice__c;/);
    assert.match(text, /accounts\?: Apex\.Account\[\];/);
  });

  it("declares SObject definitions' schema modules by the names LWC imports", async () => {
    const [converted] = await convert(
      [
        {
          path: ".sfdx/tools/sobjects/customObjects/acme__Invoice__c.cls",
          type: MetadataType.ApexClass,
          isSobject: true,
          content: "global class acme__Invoice__c {\n    global Decimal acme__Amount__c;\n    global String Name;\n}",
        },
      ],
      options,
    );
    const text = converted?.text ?? "";
    assert.match(
      text,
      /^declare module "\*@salesforce\/schema\/Invoice__c" \{\n  const acme__Invoice__c: \{\n    objectApiName: "acme__Invoice__c";/m,
    );
    assert.match(
      text,
      /^declare module "\*@salesforce\/schema\/Invoice__c\.Amount__c" \{\n  const acme__Amount__c: \{\n    fieldApiName: "acme__Amount__c";\n    objectApiName: "acme__Invoice__c";/m,
    );
    assert.match(text, /^declare module "\*@salesforce\/schema\/Invoice__c\.Name" \{/m);
  });

  it("types an LWC's unprefixed imports and the namespaced records it gets", async () => {
    const converted = await convert(
      [
        object("Invoice__c"),
        field("Invoice__c", "Amount__c", "<type>Currency</type>"),
        {
          path: ".sfdx/tools/sobjects/customObjects/acme__Invoice__c.cls",
          type: MetadataType.ApexClass,
          isSobject: true,
          content: "global class acme__Invoice__c {\n    global Decimal acme__Amount__c;\n}",
        },
        {
          path: "force-app/classes/Invoices.cls",
          type: MetadataType.ApexClass,
          content: "public class Invoices {\n    @AuraEnabled(cacheable=true) public static List<Invoice__c> recent() { return null; }\n}",
        },
      ],
      options,
    );
    assert.deepEqual(
      converted.map((c) => c.diagnostics),
      converted.map(() => undefined),
    );
    assert.deepEqual(
      typeCheck(
        converted.map((c) => c.text),
        `import INVOICE from "@salesforce/schema/Invoice__c";
import AMOUNT from "@salesforce/schema/Invoice__c.Amount__c";
import recent from "@salesforce/apex/Invoices.recent";
const objectApiName: "acme__Invoice__c" = INVOICE.objectApiName;
const fieldApiName: "acme__Amount__c" = AMOUNT.fieldApiName;
const amount: number | undefined = (await recent())[0]?.acme__Amount__c;
// @ts-expect-error records name the field with the namespace
const unprefixed = (await recent())[0]?.Amount__c;
export { objectApiName, fieldApiName, amount, unprefixed };`,
      ),
      [],
    );
  });

  it("never declares the project's metadata under its namespace, which LWC rejects in imports", async () => {
    const converted = await convert(
      [
        object("Invoice__c"),
        field("Invoice__c", "Amount__c", "<type>Currency</type>"),
        {
          path: "force-app/classes/Invoices.cls",
          type: MetadataType.ApexClass,
          content: "public class Invoices {\n    @AuraEnabled public static String recent() { return null; }\n}",
        },
        {
          path: "force-app/labels/CustomLabels.labels-meta.xml",
          type: MetadataType.CustomLabels,
          content: "<CustomLabels><labels><fullName>Greeting</fullName><value>Hi</value></labels></CustomLabels>",
        },
        {
          path: "force-app/staticresources/logo.resource-meta.xml",
          type: MetadataType.StaticResource,
          content: "<StaticResource><cacheControl>Public</cacheControl></StaticResource>",
        },
        {
          path: "force-app/messageChannels/Changed.messageChannel-meta.xml",
          type: MetadataType.LightningMessageChannel,
          content: "<LightningMessageChannel><masterLabel>Changed</masterLabel></LightningMessageChannel>",
        },
        {
          path: "force-app/lwc/card/card.js-meta.xml",
          type: MetadataType.LightningComponentBundle,
          content: "<LightningComponentBundle/>",
        },
      ],
      options,
    );
    assert.deepEqual(
      typeCheck(
        converted.map((c) => c.text),
        `import INVOICE from "@salesforce/schema/Invoice__c";
import AMOUNT from "@salesforce/schema/Invoice__c.Amount__c";
import recent from "@salesforce/apex/Invoices.recent";
import GREETING from "@salesforce/label/c.Greeting";
import LOGO from "@salesforce/resourceUrl/logo";
import CHANGED from "@salesforce/messageChannel/Changed__c";
import CHANGED_DEFAULT from "@salesforce/messageChannel/c__Changed__c";
import Card from "c/card";
// @ts-expect-error LWC rejects the project's own namespace
import INVOICE_PREFIXED from "@salesforce/schema/acme__Invoice__c";
// @ts-expect-error
import AMOUNT_PREFIXED from "@salesforce/schema/acme__Invoice__c.acme__Amount__c";
// @ts-expect-error
import AMOUNT_MIXED from "@salesforce/schema/Invoice__c.acme__Amount__c";
// @ts-expect-error
import recentPrefixed from "@salesforce/apex/acme.Invoices.recent";
// @ts-expect-error
import GREETING_PREFIXED from "@salesforce/label/acme.Greeting";
// @ts-expect-error
import LOGO_PREFIXED from "@salesforce/resourceUrl/acme__logo";
// @ts-expect-error
import CHANGED_PREFIXED from "@salesforce/messageChannel/acme__Changed__c";
// @ts-expect-error
import CardPrefixed from "acme/card";
export { INVOICE, AMOUNT, recent, GREETING, LOGO, CHANGED, CHANGED_DEFAULT, Card, INVOICE_PREFIXED, AMOUNT_PREFIXED, AMOUNT_MIXED, recentPrefixed, GREETING_PREFIXED, LOGO_PREFIXED, CHANGED_PREFIXED, CardPrefixed };`,
        { "card.js": "export default class Card {}\n" },
      ),
      [],
    );
  });

  it("declares SObject definitions' project fields on standard objects by the names LWC imports", async () => {
    const [converted] = await convert(
      [
        {
          path: ".sfdx/tools/sobjects/standardObjects/Account.cls",
          type: MetadataType.ApexClass,
          isSobject: true,
          content:
            "global class Account {\n    global String Name;\n    global Decimal acme__Rating__c;\n    global Decimal other__Score__c;\n}",
        },
      ],
      options,
    );
    const text = converted?.text ?? "";
    assert.match(
      text,
      /^declare module "\*@salesforce\/schema\/Account\.Rating__c" \{\n  const acme__Rating__c: \{\n    fieldApiName: "acme__Rating__c";\n    objectApiName: "Account";/m,
    );
    assert.match(text, /^declare module "\*@salesforce\/schema\/Account\.other__Score__c" \{/m);
    assert.match(text, /^    acme__Rating__c\?: number;$/m);
  });

  it("matches the project's namespace in any case", async () => {
    const [objectFile, fieldFile, apex] = await convert(
      [
        {
          path: "force-app/objects/acme__Invoice__c/acme__Invoice__c.object-meta.xml",
          type: MetadataType.CustomObject,
          content: "<CustomObject><label>Invoice</label></CustomObject>",
        },
        field("ACME__Invoice__c", "ACME__Amount__c", "<type>Currency</type>"),
        {
          path: "force-app/classes/Billing.cls",
          type: MetadataType.ApexClass,
          content:
            "public class Billing {\n    @AuraEnabled public ACME.Invoices invoices;\n    @AuraEnabled public Acme__Invoice__c invoice;\n}",
        },
      ],
      { projectNamespace: "Acme" },
    );
    assert.match(objectFile?.text ?? "", /^declare module "@salesforce\/schema\/Invoice__c" \{$/m);
    assert.match(objectFile?.text ?? "", /objectApiName: "Acme__Invoice__c";/);
    assert.match(fieldFile?.text ?? "", /^declare module "@salesforce\/schema\/Invoice__c\.Amount__c" \{$/m);
    assert.match(apex?.text ?? "", /invoices\?: Apex\.Invoices;/);
    assert.match(apex?.text ?? "", /invoice\?: Apex\.Acme__Invoice__c;/);
  });

  it("declares a bundle named with the project's namespace as a c/ module", async () => {
    const [converted] = await convert(
      [
        {
          path: "force-app/lwc/acme__card/acme__card.js-meta.xml",
          type: MetadataType.LightningComponentBundle,
          content: "<LightningComponentBundle/>",
        },
      ],
      options,
    );
    assert.match(converted?.text ?? "", /^declare module "c\/card" \{\n  const card: typeof import\("\.\/acme__card\.js"\);/m);
  });

  it("treats an empty namespace as none", async () => {
    const [objectFile, label] = await convert(
      [
        object("Invoice__c"),
        {
          path: "force-app/labels/CustomLabels.labels-meta.xml",
          type: MetadataType.CustomLabels,
          content: "<CustomLabels><labels><fullName>Greeting</fullName><value>Hi</value></labels></CustomLabels>",
        },
      ],
      { projectNamespace: "" },
    );
    assert.match(objectFile?.text ?? "", /objectApiName: "Invoice__c";/);
    assert.match(objectFile?.text ?? "", /^  interface Invoice__c \{$/m);
    assert.match(label?.text ?? "", /^declare module "@salesforce\/label\/c\.Greeting" \{$/m);
  });
});
