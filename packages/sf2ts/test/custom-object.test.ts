import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convert, MetadataType, type Component } from "../src/index.ts";
import { convertOne, mappedText, objectFile, typeCheck } from "./helpers.ts";

describe("Convert:CustomObject", async () => {
  it("Transform Custom Object", async (t) => {
    let component: Component = {
      path: "objects/Test_Object__c.object-meta.xml",
      type: MetadataType.CustomObject,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <description>Object representing test data</description>
    <label>Test Object</label>
    <nameField>
        <label>Test Object Id</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>Test Objects</pluralLabel>
</CustomObject>
`,
    };
    const convertedComp = await convertOne(component);
    t.assert.snapshot(convertedComp.text);

    // go-to-definition on the record type lands on the label, as it does for the schema module
    assert.deepEqual(mappedText(convertedComp), [
      [`"@salesforce/schema/Test_Object__c"`, "Test Object"],
      ["Test_Object__c", "Test Object"],
      ["Test_Object__c", "Test Object"],
    ]);
    assert.deepEqual(typeCheck([convertedComp.text]), []);
  });

  it("Maps the declaration to the root element without a label", async () => {
    const converted = await convertOne({
      path: "objects/Thing__c/Thing__c.object-meta.xml",
      type: MetadataType.CustomObject,
      content: `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><deploymentStatus>Deployed</deploymentStatus></CustomObject>`,
    });
    assert.deepEqual(mappedText(converted), [
      ['"@salesforce/schema/Thing__c"', "CustomObject"],
      ["Thing__c", "CustomObject"],
      ["Thing__c", "CustomObject"],
    ]);
    assert.deepEqual(typeCheck([converted.text]), []);
  });

  describe("Apex record types", () => {
    const object = (objectName: string, body = "") => objectFile(objectName, body, "Thing");
    const recordType = (declaration: string) => declaration.slice(declaration.indexOf("declare namespace"));
    const fields = (declaration: string) => [...recordType(declaration).matchAll(/^    (\w+)\?/gm)].map((m) => m[1]);

    it("leaves the owner off children of master-detail relationships", async () => {
      const converted = await convertOne(object("Line__c", "<sharingModel>ControlledByParent</sharingModel>"));
      assert.ok(!fields(converted.text).includes("OwnerId"));
      assert.ok(!fields(converted.text).includes("Owner"));
    });

    it("declares the standard fields of custom metadata types and platform events", async () => {
      const metadataType = await convertOne(object("Setting__mdt"));
      assert.deepEqual(fields(metadataType.text), [
        "Id",
        "DeveloperName",
        "MasterLabel",
        "Label",
        "Language",
        "NamespacePrefix",
        "QualifiedApiName",
        "SystemModstamp",
      ]);
      assert.doesNotMatch(metadataType.text, /interface User/);
      const event = await convertOne(object("Order_Shipped__e"));
      assert.deepEqual(fields(event.text), ["ReplayId", "EventUuid", "CreatedById", "CreatedBy", "CreatedDate"]);
      assert.deepEqual(typeCheck([metadataType.text, event.text]), []);
    });

    it("declares only the Id of standard objects", async (t) => {
      const converted = await convertOne(object("Account"));
      t.assert.snapshot(recordType(converted.text));
    });

    it("uses the apexNamespace option", async () => {
      const dotted = await convertOne(object("Thing__c"), { apexNamespace: "Acme.Apex" });
      assert.match(dotted.text, /declare namespace Acme\.Apex \{\n  interface Thing__c \{/);
      assert.match(dotted.text, /CreatedBy\?: Acme\.Apex\.User;/);
      const global = await convertOne(object("Thing__c"), { apexNamespace: null });
      assert.match(global.text, /\n\}\ninterface Thing__c \{\n  Id\?: string;/);
      assert.match(global.text, /CreatedBy\?: User;/);
      assert.deepEqual(typeCheck([global.text]), []);
    });

    it("merges with its fields and the generated SObject definition", async () => {
      // the shape the Salesforce extensions generate once the object is deployed
      const definition = await convertOne({
        path: ".sfdx/tools/sobjects/customObjects/Thing__c.cls",
        type: MetadataType.ApexClass,
        isSobject: true,
        content: `global class Thing__c {
    global User CreatedBy;
    global Id CreatedById;
    global Datetime CreatedDate;
    global Id Id;
    global Boolean IsDeleted;
    global User LastModifiedBy;
    global Id LastModifiedById;
    global Datetime LastModifiedDate;
    global String Name;
    global SObject Owner;
    global Id OwnerId;
    global Datetime SystemModstamp;
    global Decimal Amount__c;
    global Account Account__r;
    global Id Account__c;
}`,
      });
      const amount = await convertOne({
        path: "objects/Thing__c/fields/Amount__c.field-meta.xml",
        type: MetadataType.CustomField,
        content: `<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Amount__c</fullName><type>Currency</type></CustomField>`,
      });
      const account = await convertOne({
        path: "objects/Thing__c/fields/Account__c.field-meta.xml",
        type: MetadataType.CustomField,
        content: `<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Account__c</fullName><referenceTo>Account</referenceTo><relationshipName>Things</relationshipName><type>Lookup</type></CustomField>`,
      });
      const declarations = [(await convertOne(object("Thing__c"))).text, amount.text, account.text, definition.text];
      // a property declared in more than one place must have the same type (TS2717)
      assert.deepEqual(
        typeCheck([
          ...declarations,
          `const thing: Apex.Thing__c = {};
export const name: string | undefined = thing.Name;
export const amount: number | undefined = thing.Amount__c;
export const things: Apex.Thing__c[] | undefined = thing.Account__r?.Things__r;
`,
        ]),
        [],
      );
    });

    it("leaves Owner to the generated SObject definition, which types it by its targets", async () => {
      // with the org's describe, the definition's Owner is one of its targets (a user or a queue)
      const definitions = await convert([
        {
          path: ".sfdx/tools/sobjects/customObjects/Thing__c.cls",
          type: MetadataType.ApexClass,
          isSobject: true,
          polymorphicTargets: { Owner: ["Group", "User"] },
          content:
            "global class Thing__c {\n    global Id Id;\n    global SObject Owner;\n    global Id OwnerId;\n    global User CreatedBy;\n}",
        },
        ...["Group", "User", "Name"].map((name) => ({
          path: `.sfdx/tools/sobjects/standardObjects/${name}.cls`,
          type: MetadataType.ApexClass,
          isSobject: true,
          content: `global class ${name} {\n    global String Name;\n}`,
        })),
      ]);
      const declarations = [(await convertOne(object("Thing__c"))).text, ...definitions.map((c) => c.text)];
      // a property declared in more than one place must have the same type (TS2717)
      assert.deepEqual(
        typeCheck([
          ...declarations,
          `const thing: Apex.Thing__c = {};
export const owner: string | undefined = thing.Owner?.Name;
export const ownerId: string | undefined = thing.OwnerId;
`,
        ]),
        [],
      );
    });
  });
});
