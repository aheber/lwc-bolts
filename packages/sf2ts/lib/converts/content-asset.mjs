/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { parseString } from "xml2js";

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
  const dec = `declare module "@salesforce/contentAssetUrl/${asset.ContentAsset.masterLabel}" {
  var ${asset.ContentAsset.masterLabel}: string;
  export default ${asset.ContentAsset.masterLabel};
}`;
  return { declarationContent: dec, mapData: [], ...component };
}
