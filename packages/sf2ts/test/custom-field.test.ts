import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MetadataType, type Component } from "../src/index.ts";
import { convertOne, fieldFile, mappedText, typeCheck } from "./helpers.ts";

describe("Convert:CustomField", async () => {
  it("Transform Custom Field", async (t) => {
    const component: Component = {
      path: "objects/Test_Object__c/fields/Test_Checkbox__c.field-meta.xml",
      type: MetadataType.CustomField,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Test_Checkbox__c</fullName>
    <defaultValue>false</defaultValue>
    <description>Test field of type checkbox</description>
    <externalId>false</externalId>
    <inlineHelpText>Test it helptest</inlineHelpText>
    <label>Test Checkbox</label>
    <trackTrending>false</trackTrending>
    <type>Checkbox</type>
</CustomField>
`,
    };
    const convertedComp = await convertOne(component);
    t.assert.snapshot(convertedComp.text);

    assert.deepEqual(mappedText(convertedComp), [
      [`"@salesforce/schema/Test_Object__c.Test_Checkbox__c"`, "Test_Checkbox__c"],
      ["Test_Checkbox__c", "Test_Checkbox__c"],
      ["Test_Checkbox__c", "Test_Checkbox__c"],
      ["boolean", "Checkbox"],
    ]);
    assert.deepEqual(typeCheck([convertedComp.text]), []);
  });

  describe("Apex record types", () => {
    const field = fieldFile;
    const apexPart = (declaration: string) => declaration.slice(declaration.indexOf("declare namespace"));

    it("types fields as LWC receives them", async () => {
      const cases = [
        ["Currency", "number"],
        ["Number", "number"],
        ["Percent", "number"],
        ["Checkbox", "boolean"],
        ["Date", "string"],
        ["DateTime", "string"],
        ["Time", "string"],
        ["Picklist", "string"],
        ["MultiselectPicklist", "string"],
        ["LongTextArea", "string"],
        ["Email", "string"],
        ["AutoNumber", "string"],
      ];
      for (const [fieldType, tsType] of cases) {
        const converted = await convertOne(field("Thing__c", "Value__c", `<type>${fieldType}</type>`));
        assert.match(converted.text, new RegExp(`\\n    Value__c\\?: ${tsType};\\n`), fieldType);
      }
    });

    it("declares a lookup's related record and the parent's child relationship", async () => {
      const converted = await convertOne(
        field(
          "Sales_Order__c",
          "Account__c",
          `<label>Account</label>
    <referenceTo>Account</referenceTo>
    <relationshipLabel>Sales Orders</relationshipLabel>
    <relationshipName>Sales_Orders</relationshipName>
    <type>Lookup</type>`,
        ),
      );
      assert.equal(
        apexPart(converted.text),
        `declare namespace Apex {
  interface Sales_Order__c {
    Account__c?: string;
    Account__r?: Apex.Account;
  }
  interface Account {
    Sales_Orders__r?: Apex.Sales_Order__c[];
  }
  interface __lwcSObjects { "sales_order__c": Sales_Order__c; "account": Account; }
}
`,
      );
      assert.deepEqual(mappedText(converted).slice(2), [
        ["Account__c", "Account__c"],
        ["string", "Lookup"],
        ["Account__r", "Account__c"],
        ["Apex.Account", "Account"],
        ["Sales_Orders__r", "Sales_Orders"],
      ]);
      // the field declares the parent, so the reference resolves on its own
      assert.deepEqual(typeCheck([converted.text]), []);
    });

    it("declares an empty parent for a lookup without a relationship name", async () => {
      const converted = await convertOne(
        field("Line__c", "Order__c", `<referenceTo>Sales_Order__c</referenceTo><type>MasterDetail</type>`),
      );
      assert.match(converted.text, /Order__r\?: Apex\.Sales_Order__c;\n  \}\n  interface Sales_Order__c \{\}\n/);
      assert.deepEqual(typeCheck([converted.text]), []);
    });

    it("declares only the Id of a standard lookup", async () => {
      // standard relationships (AccountId -> Account) aren't named `__r`
      const converted = await convertOne(field("Contact", "AccountId", `<referenceTo>Account</referenceTo><type>Lookup</type>`));
      assert.equal(
        apexPart(converted.text),
        `declare namespace Apex {\n  interface Contact {\n    AccountId?: string;\n  }\n  interface __lwcSObjects { "contact": Contact; }\n}\n`,
      );
    });

    it("declares geolocation fields' latitude and longitude", async () => {
      const converted = await convertOne(field("Store__c", "Location__c", `<scale>6</scale><type>Location</type>`));
      assert.match(
        converted.text,
        /interface Store__c \{\n    Location__Latitude__s\?: number;\n    Location__Longitude__s\?: number;\n  \}/,
      );
    });

    it("declares roll-up summaries only when their type is known", async () => {
      const count = await convertOne(
        field("Sales_Order__c", "Line_Count__c", `<summaryOperation>count</summaryOperation><type>Summary</type>`),
      );
      assert.match(count.text, /Line_Count__c\?: number;/);
      const max = await convertOne(field("Sales_Order__c", "Latest__c", `<summaryOperation>max</summaryOperation><type>Summary</type>`));
      assert.doesNotMatch(max.text, /declare namespace/);
    });

    it("registers a self-lookup's object once", async () => {
      const converted = await convertOne(
        field(
          "Event__c",
          "Original__c",
          `<referenceTo>Event__c</referenceTo><relationshipName>Replays</relationshipName><type>Lookup</type>`,
        ),
      );
      assert.match(converted.text, /^  interface __lwcSObjects \{ "event__c": Event__c; \}$/m);
      assert.deepEqual(typeCheck([converted.text]), []);
    });

    it("leaves fields without a supported type out of the record type", async () => {
      // standard fields' metadata has no <type>
      const standard = await convertOne(field("Account", "Industry", `<trackHistory>false</trackHistory>`));
      assert.doesNotMatch(standard.text, /declare namespace/);
      const external = await convertOne(field("Thing__c", "Ext__c", `<type>ExternalLookup</type>`));
      assert.doesNotMatch(external.text, /declare namespace/);
      assert.deepEqual(typeCheck([standard.text, external.text]), []);
    });

    it("uses the apexNamespace option", async () => {
      const lookup = field(
        "Line__c",
        "Order__c",
        `<referenceTo>Sales_Order__c</referenceTo><relationshipName>Lines</relationshipName><type>Lookup</type>`,
      );
      const dotted = await convertOne(lookup, { apexNamespace: "Acme.Apex" });
      assert.match(
        dotted.text,
        /declare namespace Acme\.Apex \{\n  interface Line__c \{\n    Order__c\?: string;\n    Order__r\?: Acme\.Apex\.Sales_Order__c;/,
      );
      assert.match(dotted.text, /Lines__r\?: Acme\.Apex\.Line__c\[\];/);
      const global = await convertOne(lookup, { apexNamespace: null });
      assert.ok(
        global.text.endsWith(
          '}\ninterface Line__c {\n  Order__c?: string;\n  Order__r?: Sales_Order__c;\n}\ninterface Sales_Order__c {\n  Lines__r?: Line__c[];\n}\ninterface __lwcSObjects { "line__c": Line__c; "sales_order__c": Sales_Order__c; }\n',
        ),
        global.text,
      );
      assert.deepEqual(typeCheck([global.text]), []);
    });

    it("documents a field with only help text", async () => {
      const converted = await convertOne(field("Thing__c", "Notes__c", `<inlineHelpText>Shown on hover</inlineHelpText><type>Text</type>`));
      assert.match(converted.text, /  \/\*\*\n   \* @inlineHelpText Shown on hover\n   \*\/\n  const Notes__c/);
      assert.doesNotMatch(converted.text, /@description/);
    });
  });
});
