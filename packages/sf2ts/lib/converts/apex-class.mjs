/** @import Parser from "web-tree-sitter" */
/** @import { Component, ConvertedComponent } from "../index.mjs" */
import { getApexParser } from "web-tree-sitter-sfapex";

// TOOD: Apex Continuation

/** @type { Parser } */
let prsr;

const getParserPromise = getApexParser().then((newParser) => {
  prsr = newParser;
});

/**
 *
 * @param {Component} comp
 * @returns {ConvertedComponent}
 */
export function ApexClass(comp) {
  // generate d.ts
  if (prsr === undefined) {
    /** @type { any } */
    const err = new Error("Apex parser not ready yet");
    err.waitFor = getParserPromise; // smuggle a "ready" signal out to the invoker
    throw err;
  }

  const [className, declarationContent, mappingContent] =
    buildDeclarationForApexFile(prsr, comp.path, comp.content, false);
  if (declarationContent === undefined) {
    throw new Error("Problem building declaration content");
  }

  return { ...comp, declarationContent: declarationContent, mapData: [] };
}

/**
 * @typedef DeltaPoint
 * @property {number} rowDelta
 * @property {number} column
 */

/**
 * @typedef MappingPos
 * @property {DeltaPoint} startPosition
 * @property {DeltaPoint} endPosition
 */

/**
 * @typedef Mapping
 * @property { MappingPos } dPos
 * @property { {startPosition: Parser.Point, endPosition: Parser.Point }?} sPos
 */

/** @type { Record<string, string> } */
const typeOverrides = {
  string: "string",
  datetime: "Date",
  decimal: "number",
  integer: "number",
  boolean: "boolean",
  id: "string",
};

/** @type { string[] } */
let localNestedClasses = [];
/** @type { string? } */
let outerClassName;

/**
 *
 * @param {Parser} parser
 * @param {string} relativeFilePath
 * @param {string} apexText
 * @param {boolean} isSobject
 * @returns { string[] }
 */
export function buildDeclarationForApexFile(
  parser,
  relativeFilePath,
  apexText,
  isSobject = false
) {
  try {
    const tree = parser.parse(apexText);
    // step into top-level class, if any
    // if outer-most thing isn't a class the leave
    const classes = tree.rootNode.descendantsOfType("class_declaration");

    if (classes.length === 0 || !classes[0]) {
      return []; // this isn't a class
    }

    // TODO: build mapping file
    const [className, declarationText, mappings] = processClass(
      classes[0],
      isSobject
    );
    const mappingText = getMapFile(className, relativeFilePath, mappings);
    localNestedClasses = [];
    outerClassName = null;
    return [className, declarationText, mappingText];
  } catch (error) {
    console.error(error);

    localNestedClasses = [];
    outerClassName = null;
    return [];
  }
}

/**
 *
 * @param {Parser.SyntaxNode} classNode
 * @param {boolean} isSobject
 * @returns { [string, string, Mapping[]] }
 */
function processClass(classNode, isSobject) {
  let className = classNode.childForFieldName("name")?.text ?? "";
  if (!outerClassName) {
    outerClassName = className;
  }
  let classBody = classNode.childForFieldName("body");
  /** @type {Mapping[]} */
  const mappings = [];
  /** @type {string[]} */
  let outputText = [];
  if (!classBody) {
    return [className, outputText.join(""), mappings];
  }

  const methodsToProcess = [];
  const fieldsToProcess = [];
  const classesToProcess = [];

  for (const cNode of classBody.children) {
    switch (cNode.type) {
      case "method_declaration":
        // gather methods because AuraEnabled methods create their own exports
        methodsToProcess.push(cNode);
        break;
      case "field_declaration":
        fieldsToProcess.push(cNode);
        break;
      case "class_declaration":
        classesToProcess.push(cNode);
        const innerNameNode = cNode.childForFieldName("name");
        if (innerNameNode) {
          // queue up nested class names so type resolution can use them
          localNestedClasses.push(innerNameNode.text);
        }
        break;
    }
  }
  if (fieldsToProcess.length > 0) {
    outputText.push(`declare interface ${className} {\n`);
    mappings.push({
      dPos: {
        startPosition: {
          rowDelta: 0,
          column: 0,
        },
        endPosition: {
          rowDelta: 0,
          column: 0,
        },
      },
      sPos: null,
    });
    for (let fNode of fieldsToProcess) {
      const [newOutputText, newMappings] = transformFieldDeclaration(
        fNode,
        isSobject
      );
      outputText.push(newOutputText);
      mappings.push(...newMappings);
    }
    outputText.push("}\n");
    mappings.push({
      dPos: {
        startPosition: {
          rowDelta: 1,
          column: 0,
        },
        endPosition: {
          rowDelta: 0,
          column: 0,
        },
      },
      sPos: null,
    });
  }

  if (classesToProcess.length > 0) {
    outputText.push(`declare namespace ${className} {\n`);
    mappings.push({
      dPos: {
        startPosition: {
          rowDelta: 2,
          column: 0,
        },
        endPosition: {
          rowDelta: 0,
          column: 0,
        },
      },
      sPos: null,
    });
    for (const cNode of classesToProcess) {
      const [className, newOutputText, newMappings] = processClass(
        cNode,
        isSobject
      );
      if (newOutputText.length > 0) {
        outputText.push("  " + newOutputText.replaceAll(/\n(.)/g, "\n  $1"));
        mappings.push(...newMappings);
      }
      // TODO: somehow queue up local classes for type resolution
    }

    outputText.push(`}\n`);
    mappings.push({
      dPos: {
        startPosition: {
          rowDelta: 2,
          column: 0,
        },
        endPosition: {
          rowDelta: 0,
          column: 0,
        },
      },
      sPos: null,
    });
  }

  for (const mNode of methodsToProcess) {
    const [newOutputText, newMappings] = transformMethodDeclaration(
      className,
      mNode
    );
    outputText.push(newOutputText);
    mappings.push(...newMappings);
  }
  return [className, outputText.join(""), mappings];
}

/**
 *
 * @param {string} className
 * @param {Parser.SyntaxNode} methodNode
 * @returns {[string, Mapping[]]}
 */
function transformMethodDeclaration(className, methodNode) {
  /** @type {Mapping[]} */
  const mappings = [];
  const methodNameNode = methodNode.childForFieldName("name");
  if (!methodNameNode) {
    return ["", mappings];
  }
  const methodName = methodNameNode.text;
  const returnType = methodNode.childForFieldName("type");
  if (!returnType) {
    return ["", mappings];
  }
  const parameters = getMethodParameters(methodNode);

  const auraEnabledNode = getAuraEnabledAnnotation(methodNode);
  if (!auraEnabledNode) {
    // method doesn't hold the AuraEnabled Annotation
    return ["", mappings];
  }
  const isCacheableEnabled = getAuraEnabledIsCacheable(auraEnabledNode);

  const [newOutputText, methodNameMapping] = declarationString(
    className,
    methodName,
    getType(returnType),
    parameters,
    isCacheableEnabled
  );
  const declarationParts = newOutputText.split("\n");
  methodNameMapping.rowDelta;

  mappings.push({
    dPos: {
      startPosition: methodNameMapping,
      endPosition: {
        rowDelta: methodNameMapping.rowDelta,
        column: methodNameMapping.column + methodName.length,
      },
    },
    sPos: {
      startPosition: methodNameNode.startPosition,
      endPosition: methodNameNode.endPosition,
    },
  });
  // add consumption of remaining lines
  mappings.push({
    dPos: {
      startPosition: {
        rowDelta: declarationParts.length - methodNameMapping.rowDelta,
        column: 0,
      },
      endPosition: {
        rowDelta: declarationParts.length - methodNameMapping.rowDelta,
        column: 0,
      },
    },
    sPos: null,
  });
  return [newOutputText, mappings];
}

/**
 *
 * @param {Parser.SyntaxNode} node
 * @param {boolean} isSobject
 * @returns {[string, Mapping[]]}
 */
function transformFieldDeclaration(node, isSobject) {
  /** @type {string[]} */
  let deprecatedReasons = [];
  let output = "";
  const modifiers = node.descendantsOfType("modifiers");
  /** @type {Mapping} */
  const mapping = {
    dPos: {
      startPosition: {
        rowDelta: 1,
        column: 2,
      },
      endPosition: {
        // TODO
        rowDelta: 0,
        column: 0,
      },
    },
    sPos: {
      startPosition: node.startPosition,
      endPosition: node.endPosition,
    },
  };

  if (modifiers.length === 0 || !modifiers[0]) {
    deprecatedReasons.push("public or global");
  } else {
    // initialize so the generated SObjects don't flag missing AuraEnabled
    let isAuraEnabled = isSobject;
    for (const aNode of modifiers[0].descendantsOfType("annotation")) {
      const aNameNode = aNode.childForFieldName("name");
      if (aNameNode && aNameNode.text.toLowerCase() === "auraenabled") {
        isAuraEnabled = true;
      }
    }
    if (!isAuraEnabled) {
      deprecatedReasons.push("@AuraEnabled");
    }

    let isAtLeastPublic = false;
    for (const mNode of modifiers[0].descendantsOfType("modifier")) {
      switch (mNode.text.toLowerCase()) {
        case "public":
        case "global":
          isAtLeastPublic = true;
          break;
        case "static":
          deprecatedReasons.push("non-static");
          break;
      }
    }
    if (!isAtLeastPublic) {
      deprecatedReasons.push("public or global");
    }
  }
  /** TODO:
   * determine if AuraEnabled & public or global & not static
   * otherwise mark as deprecated with note (dynamic based on missing access component)
   * {property}: {getType({type})}?;
   */
  if (deprecatedReasons.length > 0) {
    mapping.dPos.startPosition.rowDelta++;
    output += `  /** @deprecated not exposed; property must be ${deprecatedReasons.join(
      ", "
    )} */\n`;
  }
  output += `  ${
    node.childForFieldName("declarator")?.childForFieldName("name")?.text ?? ""
  }?: ${getType(node.childForFieldName("type"))};\n`;
  return [output, [mapping]];
}

/**
 *
 * @param {Parser.SyntaxNode} node
 * @returns {boolean}
 */
function getAuraEnabledIsCacheable(node) {
  const args = node.childForFieldName("arguments");
  if (args) {
    for (const a of args.descendantsOfType("annotation_key_value")) {
      const k = a.childForFieldName("key");
      const v = a.childForFieldName("value");
      if (
        k &&
        v &&
        k.text.toLowerCase() === "cacheable" &&
        v.text.toLowerCase() === "true"
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 *
 * @param {Parser.SyntaxNode} node
 * @returns {Parser.SyntaxNode | null}
 */
function getAuraEnabledAnnotation(node) {
  for (const m of node.descendantsOfType("modifiers")) {
    for (const a of m.descendantsOfType("annotation")) {
      if (a.childForFieldName("name")?.text.toLowerCase() === "auraenabled") {
        return a;
      }
    }
  }
  return null;
}

/**
 *
 * @param {Parser.SyntaxNode} node
 * @returns {Map<string, string>}
 */
function getMethodParameters(node) {
  const params = new Map();
  const parameters = node.childForFieldName("parameters");
  if (!parameters) {
    return params;
  }
  for (const p of parameters.namedChildren) {
    params.set(
      p.childForFieldName("name")?.text,
      getType(p.childForFieldName("type"))
    );
  }
  return params;
}

/**
 *
 * @param {string} className
 * @param {string} methodName
 * @param {string} returnType
 * @param {Map<string, string>} params
 * @param {boolean} isCacheable
 * @returns {[string, DeltaPoint]}
 */
function declarationString(
  className,
  methodName,
  returnType,
  params,
  isCacheable
) {
  let text = `declare module "@salesforce/apex/${className}.${methodName}" {
  const ${methodName}: {
    (${
      params.size === 0
        ? ""
        : `param: { ${Array.from(params.entries())
            .map(([name, type]) => `${name}: ${type}`)
            .join("; ")} }`
    }): Promise<${returnType}>;${
      // Apex can only be wired if it is cacheable
      // the adapter is the WireAdapterConstructor that the @wire decorator consumes
      !isCacheable
        ? ""
        : `
    adapter: import("lwc").WireAdapterConstructor<
      ${
        params.size === 0
          ? "never"
          : `{ ${Array.from(params.entries())
              .map(([name, type]) => `${name}: ${type}`)
              .join("; ")} }`
      },
      { error?: any; data?: ${returnType}; }
    >;`
    }
  };
  export default `;
  // analyze how much text we're adding before the method name
  const lines = text.split("\n");
  /** @type {DeltaPoint} */
  const m = {
    rowDelta: lines.length - 1,
    column: lines[lines.length - 1]?.length ?? 0,
  };
  // finish building
  text += `${methodName};
}
`;
  return [text, m];
}

/**
 *
 * @param {string} className
 * @param {string} relativeClassPath
 * @param {Mapping[]} mappings
 * @returns
 */
function getMapFile(className, relativeClassPath, mappings) {
  let mappingsString = "";
  let lastSourceRow = 0;
  let lastMethodColumnNum = 0;
  for (const m of mappings) {
    mappingsString += ";".repeat(m.dPos.startPosition.rowDelta);
    if (!m.sPos) {
      continue;
    }
    /**
     * Generated column
     * Original file this appeared in
     * Original line number relative to last given value in this field
     * Original column relative to last given value in this field
     */
    // const incrementalColumnCount =
    //   m.sPos.startPosition.column - lastMethodColumnNum;

    // mappingsString += `${encode(m.dPos.startPosition.column)}${encode(
    //   0
    // )}${encode(m.sPos.startPosition.row - lastSourceRow)}${encode(
    //   incrementalColumnCount
    // )}`;

    lastMethodColumnNum = m.sPos.startPosition.column;
    lastSourceRow = m.sPos.startPosition.row;
  }
  return JSON.stringify({
    version: 3,
    file: `${className}.d.ts`,
    sourceRoot: "",
    // TODO: not so badly hardcoded
    sources: [`../../../../../${relativeClassPath}`],
    names: [],
    mappings: mappingsString,
  });
}

/**
 *
 * @param {Parser.SyntaxNode | null} node
 * @returns {string}
 */
function getType(node) {
  if (!node) {
    return "";
  }
  // if generic type, see if it is a list or map
  switch (node.type) {
    case "generic_type":
      const genType = getType(node.namedChildren[0]);
      let typeNode = node.namedChildren[1];
      if (!typeNode) {
        return "";
      }
      switch (genType.toLowerCase()) {
        case "list":
          return getType(typeNode.namedChildren[0]) + "[]";
        case "map":
          return `Record<${getType(typeNode.namedChildren[0])}, ${getType(
            typeNode.namedChildren[1]
          )}>`;
        case "set":
          return `Set<${getType(typeNode.namedChildren[0])}>`;

        default:
          console.error("Unexpected generic type", genType);
      }
  }
  if (localNestedClasses.includes(node.text)) {
    return `${outerClassName}.${node.text}`;
  }
  return typeOverrides[node.text.toLowerCase()] ?? node.text;
}
