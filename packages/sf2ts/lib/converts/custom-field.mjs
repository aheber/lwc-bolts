/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { parseString } from "xml2js";
import { PositionAwareTextBuilder } from "../util.mjs";

/**
 *
 * @param {Component} component
 * @returns {ConvertedComponent}
 */
export function CustomField(component) {
  // generate d.ts
  /** @type {any} */
  let field;
  parseString(component.content, (error, result) => {
    if (error) {
      throw error;
    }
    field = result;
  });
  const pathParts = component.path.split("/");
  const fieldName = pathParts.pop()?.split(".")[0];
  if (!fieldName) {
    throw new Error("Unable to resolve field name from file path");
  }
  pathParts?.pop(); // discard `fields`
  const objectName = pathParts.pop();

  const namePosStart =
    component.content.indexOf("<fullName>") + "<fullName>".length;
  const namePosEnd = namePosStart + fieldName.length;

  const builder = new PositionAwareTextBuilder();
  builder.addText(`declare module `);
  builder.addText(
    `"@salesforce/schema/${objectName}.${fieldName}"`,
    namePosStart,
    namePosEnd
  );
  builder.addText(
    ` {
  /**
   * @description ${field.CustomField.inlineHelpText}
   * @description ${field.CustomField.description}
   */
  const `
  );

  builder.addText(`${fieldName}`, namePosStart, namePosEnd);

  builder.addText(
    `: {
    fieldApiName: '${fieldName}';
    objectApiName: '${objectName}';
  }
  export default ${fieldName};
}`
  );
  return {
    declarationContent: builder.build(),
    mapData: builder.getMappings(),
    ...component,
  };
}
