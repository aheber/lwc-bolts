/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { parseString } from "xml2js";

/**
 *
 * @param {Component} component
 * @returns {ConvertedComponent}
 */
export function StaticResource(component) {
  // generate d.ts
  /** @type {any} */
  let resource;
  parseString(component.content, (error, result) => {
    if (error) {
      throw error;
    }
    resource = result;
  });
  const resourceName = component.path.split("/").pop()?.split(".")[0];
  const dec = `declare module "@salesforce/resourceUrl/${resourceName}" {
  /**
   * @description ${resource.StaticResource.description}
   * @access ${resource.StaticResource.cacheControl}
   */
  const ${resourceName}:string;
  export default ${resourceName};
}`;
  return { declarationContent: dec, mapData: [], ...component };
}
