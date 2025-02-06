/** @import { MapPair } from "./index.mjs" */

/**
 * @typedef MapDelta
 * @property {number | null} sourcePos
 * @property {number} destDeltaPos
 */

/**
 *
 * @param {MapDelta[]} mappings
 */
export function getMappings(mappings) {
  // increase destination position as an aggregate
  /** @type {MapPair[]} */
  let filteredMappings = [];
  let lastDestPos = 0;
  mappings.forEach((m) => {
    m.destDeltaPos += lastDestPos;
    lastDestPos = m.destDeltaPos;
    if (m.sourcePos !== null) {
      filteredMappings.push({
        sourcePos: m.sourcePos,
        destPos: m.destDeltaPos,
      });
    }
  });
  return filteredMappings;
}

export class PositionAwareTextBuilder {
  /** @type {MapDelta[]} */
  mappings = [];
  /** @type {string[]} */
  textParts = [];

  lastTextLen = 0;

  /**
   *
   * @param {string} text
   * @param {number?} sourceStartPos
   * @param {number?} sourceEndPos
   */
  addText(text, sourceStartPos = null, sourceEndPos = null) {
    this.mappings.push({
      sourcePos: sourceStartPos,
      destDeltaPos: this.lastTextLen,
    });
    this.lastTextLen = text.length;
    if (sourceEndPos != null) {
      this.mappings.push({
        sourcePos: sourceEndPos,
        destDeltaPos: this.lastTextLen,
      });
      this.lastTextLen = 0;
    }
    this.textParts.push(text);
  }

  build() {
    return this.textParts.join("");
  }

  getMappings() {
    return getMappings(this.mappings);
  }
}
