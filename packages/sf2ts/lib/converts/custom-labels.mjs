/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { parseString } from "xml2js";
import { PositionAwareTextBuilder } from "../util.mjs";

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

  const builder = new PositionAwareTextBuilder();
  for (let label of labels.CustomLabels.labels) {
    const labelName = label.fullName[0];
    const namePosStart =
      component.content.indexOf(`<fullName>${labelName}`) + `<fullName>`.length;
    const namePosEnd = namePosStart + labelName.length;

    builder.addText(`declare module `);
    builder.addText(
      `"@salesforce/label/c.${labelName}"`,
      namePosStart,
      namePosEnd
    );
    builder.addText(
      ` {
  /**
   * @description ${label.shortDescription}
   */
  const `
    );
    builder.addText(`lbl${label.fullName}`, namePosStart, namePosEnd);
    builder.addText(
      ` = '${label.value}';
  export default lbl${label.fullName};
}
`
    );
  }
  return {
    declarationContent: builder.build(),
    mapData: builder.getMappings(),
    ...component,
  };
}
