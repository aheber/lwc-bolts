/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { parseString } from "xml2js";

/**
 *
 * @param {Component} component
 * @returns {ConvertedComponent}
 */
export function CustomLabels(component) {
  // generate d.ts
  /** @type {any} */
  let labels;
  parseString(component.content, (error, result) => {
    if (error) {
      throw error;
    }
    labels = result;
  });
  if (!Array.isArray(labels.CustomLabels.labels)) {
    labels.CustomLabels.labels = [labels.CustomLabels.labels];
  }
  let dec = "";
  for (let label of labels.CustomLabels.labels) {
    dec += `declare module "@salesforce/label/c.${label.fullName}" {
  /**
   * @description ${label.shortDescription}
   */
  const lbl${label.fullName} = '${label.value}';
  export default lbl${label.fullName};
}
`;
  }
  return { declarationContent: dec, mapData: [], ...component };
}
