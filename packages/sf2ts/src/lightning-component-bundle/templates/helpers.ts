// Utility types templates might use, which are dynamically added to each component that uses them

/**
 * Declarations the converted code can use, by the name each declares. A template's TypeScript declares
 * the ones it uses, after its code.
 */
export const TEMPLATE_HELPERS: Readonly<Record<string, string>> = {
  __lwcElement: `type __lwcElement<T extends string> = T extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[T] : HTMLElement;
`,
  __lwcSvgElement: `type __lwcSvgElement<T extends string> = T extends keyof SVGElementTagNameMap ? SVGElementTagNameMap[T] : SVGElement;
`,
  __lwcMathElement: `type __lwcMathElement<T extends string> = T extends keyof MathMLElementTagNameMap ? MathMLElementTagNameMap[T] : MathMLElement;
`,
  __lwcHostProperties: `type __lwcHostProperties = Partial<
  Pick<HTMLElement, "id" | "title" | "hidden" | "tabIndex" | "accessKey" | "dir" | "lang" | "draggable" | "spellcheck" | "autofocus">
> &
  Partial<ARIAMixin>;
`,
  __lwcProperties: `// \`constructor\` is a property of LightningElement, which an object literal's own constructor doesn't match
type __lwcProperties<T> = Partial<Omit<T, "constructor">>;
`,
  __lwcSlots: `declare global {
  /** The slots of the components whose templates are in the program, which each template adds its own to. */
  interface __LwcSlots {}
}
/** The slots of the component M (such as "c/baseCard"), or any slot when they aren't known. */
type __lwcSlots<M extends string, K = keyof __LwcSlots> = \`\${M} *\` extends keyof __LwcSlots
  ? string
  : M extends keyof __LwcSlots
    ? K extends \`\${M} \${infer S}\`
      ? S
      : never
    : string;
`,
};

/** Finds each helper's name as a whole word (`__lwcElement`, not `__lwcElements`). */
const HELPER_NAMES = new RegExp(`\\b(?:${Object.keys(TEMPLATE_HELPERS).join("|")})\\b`, "g");

/**
 * The declarations of the helpers `text` uses, in TEMPLATE_HELPERS' order, in one pass over it. Helpers
 * only use themselves, so the ones `text` names are all it needs.
 */
export function helperDeclarations(text: string): string {
  const used = new Set(text.match(HELPER_NAMES));
  return Object.keys(TEMPLATE_HELPERS)
    .filter((name) => used.has(name))
    .map((name) => TEMPLATE_HELPERS[name]!)
    .join("");
}
