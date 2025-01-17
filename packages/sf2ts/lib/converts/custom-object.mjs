/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { parseString } from "xml2js";

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
  const dec = `declare module '@salesforce/schema/${objectName}' {
  /**
   * @description ${obj.CustomObject.description}
   */
  const ${objectName}: {
      objectApiName: '${objectName}';
  }
  export default ${objectName};
}`;
  return { declarationContent: dec, mapData: [], ...component };
}
