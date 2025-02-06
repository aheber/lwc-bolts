/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { parseString } from "xml2js";
import { PositionAwareTextBuilder } from "../util.mjs";

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
  const namePosStart =
    component.content.indexOf("<description>") + "<description>".length;
  const namePosEnd = component.content.indexOf("</description>");

  const builder = new PositionAwareTextBuilder();

  builder.addText("declare module ");

  builder.addText(
    `"@salesforce/resourceUrl/${resourceName}"`,
    namePosStart,
    namePosEnd
  );

  builder.addText(
    ` {
  /**
   * @description ${resource.StaticResource.description}
   * @access ${resource.StaticResource.cacheControl}
   */
  const `
  );

  builder.addText(`${resourceName}`, namePosStart, namePosEnd);

  builder.addText(
    `:string;
  export default ${resourceName};
}`
  );
  return {
    declarationContent: builder.build(),
    mapData: builder.getMappings(),
    ...component,
  };
}
