/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { parseString } from "xml2js";
import { PositionAwareTextBuilder } from "../util.mjs";
import { getDtsFromLabel } from "./custom-label.mjs";

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
    getDtsFromLabel(builder, component.content, label);
  }
  return {
    declarationContent: builder.build(),
    mapData: builder.getMappings(),
    ...component,
  };
}
