/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { parseString } from "xml2js";

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
  pathParts?.pop(); // discard `fields`
  const objectName = pathParts.pop();
  const dec = `declare module '@salesforce/schema/${objectName}.${fieldName}' {
  /**
   * @description ${field.CustomField.inlineHelpText}
   * @description ${field.CustomField.description}
   */
  const ${fieldName}: {
    fieldApiName: '${fieldName}';
    objectApiName: '${objectName}';
  }
  export default ${fieldName};
}`;
  return { declarationContent: dec, mapData: [], ...component };
}
