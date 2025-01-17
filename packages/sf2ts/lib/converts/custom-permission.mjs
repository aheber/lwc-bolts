/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { parseString } from "xml2js";

/**
 *
 * @param {Component} component
 * @returns {ConvertedComponent}
 */
export function CustomPermission(component) {
  // generate d.ts
  /** @type {any} */
  let perm;
  parseString(component.content, (error, result) => {
    if (error) {
      throw error;
    }
    perm = result;
  });
  const permName = component.path.split("/").pop()?.split(".")[0];
  const dec = `declare module "@salesforce/customPermission/${permName}" {
  /**
   * ${perm.CustomPermission.label}
   *
   * @description ${perm.CustomPermission.description}
   */
  const has${permName}:boolean;
  export default has${permName};
}`;
  return { declarationContent: dec, mapData: [], ...component };
}
