/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { parseString } from "xml2js";
import { PositionAwareTextBuilder } from "../util.mjs";

/**
 *
 * @param {Component} component
 * @returns {ConvertedComponent}
 */
export function CustomObject(component) {
  // generate d.ts
  /** @type {any} */
  let obj;
  parseString(component.content, (error, result) => {
    if (error) {
      throw error;
    }
    obj = result;
  });
  const objectName = component.path.split("/").pop()?.split(".")[0];
  if (!objectName) {
    throw new Error("Unable to find Object Name");
  }

  const namePos = component.content.indexOf("<label>") + "<label>".length;
  const namePosEnd = component.content.indexOf("</label>");

  const builder = new PositionAwareTextBuilder();
  builder.addText(`declare module `);
  builder.addText(`"@salesforce/schema/${objectName}"`, namePos, namePosEnd);
  builder.addText(
    ` {
  /**
   * @description ${obj.CustomObject.description}
   */
  const `
  );
  builder.addText(`${objectName}`, namePos, namePosEnd);
  builder.addText(
    `: {
      objectApiName: '${objectName}';
  }
  export default ${objectName};
}`
  );
  return {
    declarationContent: builder.build(),
    mapData: builder.getMappings(),
    ...component,
  };
}
