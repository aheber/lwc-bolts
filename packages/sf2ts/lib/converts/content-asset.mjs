/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { parseString } from "xml2js";
import { PositionAwareTextBuilder } from "../util.mjs";

/**
 *
 * @param {Component} component
 * @returns {ConvertedComponent}
 */
export function ContentAsset(component) {
  // generate d.ts
  /** @type {any} */
  let asset;
  parseString(component.content, (error, result) => {
    if (error) {
      throw error;
    }
    asset = result;
  });
  const label = asset.ContentAsset.masterLabel[0];
  const namePosStart =
    component.content.indexOf("<masterLabel>") + "<masterLabel>".length;
  const namePosEnd = namePosStart + label.length;

  const builder = new PositionAwareTextBuilder();

  builder.addText(`declare module `);
  builder.addText(
    `"@salesforce/contentAssetUrl/${label}"`,
    namePosStart,
    namePosEnd
  );
  builder.addText(
    ` {
  const `
  );
  builder.addText(label, namePosStart, namePosEnd);
  builder.addText(
    `: string;
  export default ${label};
}`
  );
  return {
    declarationContent: builder.build(),
    mapData: builder.getMappings(),
    ...component,
  };
}
