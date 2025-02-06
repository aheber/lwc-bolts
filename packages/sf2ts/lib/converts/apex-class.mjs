/** @import Parser from "web-tree-sitter" */
/** @import { Component, ConvertedComponent, MapPair } from "../index.mjs" */
import { getApexParser } from "web-tree-sitter-sfapex";
import { PositionAwareTextBuilder } from "../util.mjs";

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

  const [declarationContent, mappingContent] = buildDeclarationForApexFile(
    prsr,
    comp.content,
    false
  );
  if (declarationContent === undefined) {
    throw new Error("Problem building declaration content");
  }
  if (mappingContent === undefined) {
    throw new Error("Problem building declaration content mappings");
  }

  return {
    ...comp,
    declarationContent: declarationContent,
    mapData: mappingContent,
  };
}

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

// TODO: probably don't want this to be a global
let builder = new PositionAwareTextBuilder();

/**
 *
 * @param {Parser} parser
 * @param {string} apexText
 * @param {boolean} isSobject
 * @returns { [string, MapPair[]] | [] }
 */
export function buildDeclarationForApexFile(
  parser,
  apexText,
  isSobject = false
) {
  builder = new PositionAwareTextBuilder();
  try {
    const tree = parser.parse(apexText);
    // step into top-level class, if any
    // if outer-most thing isn't a class the leave
    const classes = tree.rootNode.descendantsOfType("class_declaration");

    if (classes.length === 0 || !classes[0]) {
      return []; // this isn't a class
    }

    processClass(classes[0], isSobject);
    localNestedClasses = [];
    outerClassName = null;
    return [builder.build(), builder.getMappings()];
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
 */
function processClass(classNode, isSobject) {
  const classNameNode = classNode.childForFieldName("name");
  if (!classNameNode) {
    throw new Error("Class Name Node not found");
  }
  let className = classNameNode?.text ?? "";
  if (!outerClassName) {
    outerClassName = className;
  }
  let classBody = classNode.childForFieldName("body");
  if (!classBody) {
    return;
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
    builder.addText("declare interface ");
    builder.addText(
      className,
      classNameNode.startIndex,
      classNameNode.endIndex
    );
    builder.addText(" {\n");
    for (let fNode of fieldsToProcess) {
      transformFieldDeclaration(fNode, isSobject);
    }
    builder.addText("}\n");
  }

  if (classesToProcess.length > 0) {
    builder.addText("declare namespace ");
    builder.addText(
      className,
      classNameNode.startIndex,
      classNameNode.endIndex
    );
    builder.addText(" {\n");
    for (const cNode of classesToProcess) {
      processClass(cNode, isSobject);
      // TODO: somehow queue up local classes for type resolution
    }

    builder.addText("}\n");
  }

  for (const mNode of methodsToProcess) {
    transformMethodDeclaration(classNameNode, mNode);
  }
}

/**
 *
 * @param {Parser.SyntaxNode} classNameNode
 * @param {Parser.SyntaxNode} methodNode
 */
function transformMethodDeclaration(classNameNode, methodNode) {
  const methodNameNode = methodNode.childForFieldName("name");
  if (!methodNameNode) {
    return;
  }
  const methodName = methodNameNode.text;
  const returnType = methodNode.childForFieldName("type");
  if (!returnType) {
    return;
  }
  const parameters = getMethodParameters(methodNode);

  const auraEnabledNode = getAuraEnabledAnnotation(methodNode);
  if (!auraEnabledNode) {
    // method doesn't hold the AuraEnabled Annotation
    return;
  }
  const isCacheableEnabled = getAuraEnabledIsCacheable(auraEnabledNode);
  const isContinuation = getAuraEnabledIsContinuation(auraEnabledNode);

  // TODO: continuation return type is actually the return type of the `continuationMethod` referenced in the Continuation object
  declarationString(
    classNameNode,
    methodNameNode,
    getType(returnType),
    parameters,
    isCacheableEnabled,
    isContinuation
  );
}

/**
 *
 * @param {Parser.SyntaxNode} node
 * @param {boolean} isSobject
 */
function transformFieldDeclaration(node, isSobject) {
  /** @type {string[]} */
  let deprecatedReasons = [];
  const modifiers = node.descendantsOfType("modifiers");

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
  /**
   * determine if AuraEnabled & public or global & not static
   * otherwise mark as deprecated with note (dynamic based on missing access component)
   * {property}: {getType({type})}?;
   */
  if (deprecatedReasons.length > 0) {
    builder.addText(
      `  /** @deprecated not exposed; property must be ${deprecatedReasons.join(
        ", "
      )} */\n`
    );
  }
  const nameNode = node
    .childForFieldName("declarator")
    ?.childForFieldName("name");
  builder.addText("  ");
  if (!nameNode) {
    throw new Error("Field doesn't have a name");
  }
  builder.addText(
    `${nameNode?.text ?? ""}`,
    nameNode.startIndex,
    nameNode.endIndex
  );
  builder.addText("?: ");
  const typeNode = node.childForFieldName("type");
  if (!typeNode) {
    throw new Error("Type node not found");
  }
  const typeText = getType(typeNode);
  builder.addText(typeText, typeNode.startIndex, typeNode.endIndex);
  builder.addText(";\n");
  const moreText = `;\n`;
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
 * @returns {boolean}
 */
function getAuraEnabledIsContinuation(node) {
  const args = node.childForFieldName("arguments");
  if (args) {
    for (const a of args.descendantsOfType("annotation_key_value")) {
      const k = a.childForFieldName("key");
      const v = a.childForFieldName("value");
      if (
        k &&
        v &&
        k.text.toLowerCase() === "continuation" &&
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
 * @param {Parser.SyntaxNode} classNameNode
 * @param {Parser.SyntaxNode} methodNameNode
 * @param {string} returnType
 * @param {Map<string, string>} params
 * @param {boolean} isCacheable
 * @param {boolean} isContinuation
 */
function declarationString(
  classNameNode,
  methodNameNode,
  returnType,
  params,
  isCacheable,
  isContinuation
) {
  builder.addText("declare module ");
  // if method has Containuation
  builder.addText(
    `"@salesforce/apex${isContinuation ? "Continuation" : ""}/${classNameNode.text}.${methodNameNode.text}"`,
    methodNameNode.startIndex,
    methodNameNode.endIndex
  );
  builder.addText(` {
  const `);
  builder.addText(
    methodNameNode.text,
    methodNameNode.startIndex,
    methodNameNode.endIndex
  );
  builder.addText(`: {
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
  export default ${methodNameNode.text};
}
`);
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
