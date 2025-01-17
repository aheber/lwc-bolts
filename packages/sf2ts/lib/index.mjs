import * as converters from "./converts/_index.mjs";

// maybe there is a smarter way to do this
/** @type {Readonly<{[p in keyof converters]: p}>} */
export const MetadataType = Object.freeze(
  Object.keys(converters).reduce((/** @type {any} */ t, v) => {
    t[v] = v;
    return t;
  }, {})
);

/**
 * @typedef MapPair
 * @property {number} sourcePos
 * @property {number} destPos
 */

/**
 * @typedef Component
 * @property {string} path
 * @property {keyof converters} type
 * @property {string} content
 */

/**
 * @typedef { Component & {
 * declarationContent: string;
 * mapData: MapPair[]}} ConvertedComponent
 */

/**
 *
 * @param {Component[]} components
 * @returns {ConvertedComponent[]}
 */
export function convert(components) {
  /** @type {ConvertedComponent[]} */
  const convertedComponents = [];
  for (const c of components) {
    if (!converters[c.type]) {
      throw new Error(
        "Unsupported Metadata Type:" +
          c.type +
          ", must be one of " +
          Object.keys(converters)
      );
    }
    convertedComponents.push(converters[c.type](c));
  }
  return convertedComponents;
}
