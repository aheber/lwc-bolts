import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MetadataType } from "../src/index.ts";
import { convertOne, mappedText, typeCheck } from "./helpers.ts";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<LightningMessageChannel xmlns="http://soap.sforce.com/2006/04/metadata">
    <masterLabel>Record Selected</masterLabel>
    <isExposed>true</isExposed>
    <description>Published when a record is selected.</description>
    <lightningMessageFields>
        <fieldName>recordId</fieldName>
        <description>The Id of the selected record</description>
    </lightningMessageFields>
    <lightningMessageFields>
        <fieldName>source</fieldName>
    </lightningMessageFields>
</LightningMessageChannel>
`;

describe("Convert:LightningMessageChannel", async () => {
  it("Declares the message channel module", async () => {
    const converted = await convertOne({
      path: "messageChannels/RecordSelected.messageChannel-meta.xml",
      type: MetadataType.LightningMessageChannel,
      content: SAMPLE,
    });
    assert.equal(
      converted.text,
      `declare module "@salesforce/messageChannel/RecordSelected__c" {
  /**
   * Record Selected
   *
   * @description Published when a record is selected.
   *
   * Message fields:
   * - \`recordId\`: The Id of the selected record
   * - \`source\`
   */
  const RecordSelected__c: string & { readonly __messageChannel: "RecordSelected__c" };
  export default RecordSelected__c;
}
declare module "@salesforce/messageChannel/c__RecordSelected__c" {
  /**
   * Record Selected
   *
   * @description Published when a record is selected.
   *
   * Message fields:
   * - \`recordId\`: The Id of the selected record
   * - \`source\`
   */
  const RecordSelected__c: string & { readonly __messageChannel: "RecordSelected__c" };
  export default RecordSelected__c;
}
`,
    );
    // go-to-definition lands on the channel's label, like custom permissions
    assert.deepEqual(mappedText(converted), [
      [`"@salesforce/messageChannel/RecordSelected__c"`, "Record Selected"],
      ["RecordSelected__c", "Record Selected"],
      [`"@salesforce/messageChannel/c__RecordSelected__c"`, "Record Selected"],
      ["RecordSelected__c", "Record Selected"],
    ]);
  });

  it("Makes both of a channel's imports the same channel", async () => {
    const selected = await convertOne({
      path: "messageChannels/RecordSelected.messageChannel-meta.xml",
      type: MetadataType.LightningMessageChannel,
      content: SAMPLE,
    });
    assert.deepEqual(
      typeCheck(
        [selected.text],
        `import PLAIN from "@salesforce/messageChannel/RecordSelected__c";
import DEFAULT_NAMESPACE from "@salesforce/messageChannel/c__RecordSelected__c";
declare function publish(channel: typeof PLAIN): void;
publish(PLAIN);
publish(DEFAULT_NAMESPACE);`,
      ),
      [],
    );
  });

  it("Declares another namespace's channel only through that namespace", async () => {
    const converted = await convertOne({
      path: "messageChannels/dlrs__RollupChanged.messageChannel-meta.xml",
      type: MetadataType.LightningMessageChannel,
      content: SAMPLE,
    });
    assert.deepEqual(
      [...converted.text.matchAll(/^declare module "([^"]+)"/gm)].map((match) => match[1]),
      ["@salesforce/messageChannel/dlrs__RollupChanged__c"],
    );
  });

  it("Keeps channels from being used for one another", async () => {
    const selected = await convertOne({
      path: "messageChannels/RecordSelected.messageChannel-meta.xml",
      type: MetadataType.LightningMessageChannel,
      content: SAMPLE,
    });
    const cleared = await convertOne({
      path: "messageChannels/Cleared.messageChannel-meta.xml",
      type: MetadataType.LightningMessageChannel,
      content: `<LightningMessageChannel xmlns="http://soap.sforce.com/2006/04/metadata"><masterLabel>Cleared</masterLabel></LightningMessageChannel>`,
    });
    assert.deepEqual(
      typeCheck(
        [selected.text, cleared.text],
        `import RECORD_SELECTED from "@salesforce/messageChannel/RecordSelected__c";
import CLEARED from "@salesforce/messageChannel/Cleared__c";
declare function publish(channel: typeof RECORD_SELECTED): void;
publish(RECORD_SELECTED);
// @ts-expect-error a different channel
publish(CLEARED);
// the value is the channel's ID, a string
const id: string = RECORD_SELECTED;
export { id };`,
      ),
      [],
    );
  });

  it("Omits missing documentation and maps a channel without a label to the root element", async (t) => {
    const converted = await convertOne({
      path: "messageChannels/Bare.messageChannel-meta.xml",
      type: MetadataType.LightningMessageChannel,
      content: `<LightningMessageChannel xmlns="http://soap.sforce.com/2006/04/metadata"><isExposed>false</isExposed></LightningMessageChannel>`,
    });
    t.assert.snapshot(converted.text);
    assert.deepEqual(mappedText(converted), [
      ['"@salesforce/messageChannel/Bare__c"', "LightningMessageChannel"],
      ["Bare__c", "LightningMessageChannel"],
      ['"@salesforce/messageChannel/c__Bare__c"', "LightningMessageChannel"],
      ["Bare__c", "LightningMessageChannel"],
    ]);
    assert.deepEqual(typeCheck([converted.text]), []);
  });

  it("Documents fields of a channel without a label or description", async () => {
    const converted = await convertOne({
      path: "messageChannels/Fields.messageChannel-meta.xml",
      type: MetadataType.LightningMessageChannel,
      content: `<LightningMessageChannel xmlns="http://soap.sforce.com/2006/04/metadata"><lightningMessageFields><fieldName>a</fieldName><description>A */ b</description></lightningMessageFields></LightningMessageChannel>`,
    });
    assert.match(converted.text, /^  \/\*\*\n   \* Message fields:\n   \* - `a`: A \*\\\/ b\n   \*\/\n/m);
    assert.deepEqual(typeCheck([converted.text]), []);
  });
});
