import type { ConversionContext } from "../context.ts";
import type { Component, ConversionOutput } from "../types.ts";
import { fileImportName, splitNamespace } from "../names.ts";
import { docParagraphs, docTag } from "../jsdoc.ts";
import { writeDefaultExportModule } from "../module-declaration.ts";
import { TextBuilder } from "../text-builder.ts";
import { parseMetadataXml } from "../xml.ts";

/**
 * Declares the `@salesforce/messageChannel/<Name>__c` module LWC imports a Lightning message channel
 * from. The imported value is an opaque string passed to `lightning/messageService`,
 * we also add a branded type naming the channel (the property doesn't exist at runtime) should you want to discriminate
 * one channel from another. A channel that isn't another namespace's can also be imported through the default namespace,
 * as `@salesforce/messageChannel/c__<Name>__c`, which is the same channel, with the same brand.
 */
export function LightningMessageChannel(component: Component, context: ConversionContext): ConversionOutput {
  const channel = parseMetadataXml(component.content, "LightningMessageChannel");
  // the project's own namespace is left out of imports; another's (an installed package's) is kept
  const channelName = `${fileImportName(component, context.projectNamespace)}__c`;
  const fieldLines = channel.childrenNamed("lightningMessageFields").flatMap((field) => {
    const name = field.childText("fieldName");
    if (name === undefined) {
      return [];
    }
    const fieldDescription = field.childText("description");
    return [`- \`${name}\`${fieldDescription === undefined ? "" : `: ${fieldDescription}`}`];
  });

  const doc = docParagraphs(
    channel.childText("masterLabel"),
    docTag("description", channel.childText("description")),
    fieldLines.length === 0 ? undefined : ["Message fields:", ...fieldLines],
  );
  const moduleNames = splitNamespace(channelName).namespace === undefined ? [channelName, `c__${channelName}`] : [channelName];

  const builder = new TextBuilder();
  for (const moduleName of moduleNames) {
    writeDefaultExportModule(builder, {
      name: `@salesforce/messageChannel/${moduleName}`,
      variable: channelName,
      type: `string & { readonly __messageChannel: ${JSON.stringify(channelName)} }`,
      doc,
      // go-to-definition lands on the label, or on the root element without one
      range: channel.child("masterLabel")?.contentRange ?? channel.nameRange,
    });
  }
  return builder.output();
}
