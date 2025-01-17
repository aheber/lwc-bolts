// rollup.config.mjs
export default {
  input: "lib/index.mjs",
  output: {
    file: "lib-cjs/bundle.cjs",
    format: "cjs",
  },
  external: ["xml2js", "web-tree-sitter-sfapex"],
};
