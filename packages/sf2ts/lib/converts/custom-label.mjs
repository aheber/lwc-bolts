/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { parseString } from "xml2js";
import { PositionAwareTextBuilder } from "../util.mjs";

/**
 *
 * @param {Component} component
 * @returns {ConvertedComponent}
 */
export function CustomLabel(component) {
  // generate d.ts
  /** @type {any} */
  let labels;
  parseString(component.content, (error, result) => {
    if (error) {
      throw error;
    }
    labels = result;
  });
  console.log(labels.CustomLabel);
  const builder = new PositionAwareTextBuilder();
  getDtsFromLabel(builder, component.content, labels.CustomLabel);
  return {
    declarationContent: builder.build(),
    mapData: builder.getMappings(),
    ...component,
  };
}

/**
 *
 * @param {PositionAwareTextBuilder} builder
 * @param {string} content
 * @param {any} label
 */
export function getDtsFromLabel(builder, content, label) {
  const labelName = label.fullName[0];
  const namePosStart =
    content.indexOf(`<fullName>${labelName}`) + `<fullName>`.length;
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
