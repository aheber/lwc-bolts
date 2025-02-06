/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { parseString } from "xml2js";
import { PositionAwareTextBuilder } from "../util.mjs";

/**
 *
 * @param {Component} component
 * @returns {ConvertedComponent}
 */
export function CustomPermission(component) {
  /** @type {any} */
  let perm;
  parseString(component.content, (error, result) => {
    if (error) {
      throw error;
    }
    perm = result;
  });
  const permName = component.path.split("/").pop()?.split(".")[0];
  const namePosStart = component.content.indexOf("<label>") + "<label>".length;
  const namePosEnd = component.content.indexOf("</label>");

  const builder = new PositionAwareTextBuilder();
  builder.addText("declare module ");
  builder.addText(
    `"@salesforce/customPermission/${permName}"`,
    namePosStart,
    namePosEnd
  );

  builder.addText(
    ` {
  /**
   * ${perm.CustomPermission.label}
   *
   * @description ${perm.CustomPermission.description}
   */
  const `
  );
  builder.addText(`has${permName}`, namePosStart, namePosEnd);
  builder.addText(
    `:boolean;
  export default has${permName};
}`
  );
  return {
    declarationContent: builder.build(),
    mapData: builder.getMappings(),
    ...component,
  };
}
