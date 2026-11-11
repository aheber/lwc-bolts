
## Localization

The extension's text is ready for translation:

- Messages, buttons and menus are in `src/messages.ts`, each a `vscode.l10n.t` call. `npm run l10n:export` extracts them to `l10n/bundle.l10n.json`. A translation goes beside it as `l10n/bundle.l10n.<locale>.json` (for example `bundle.l10n.de.json`).
- The manifest's text (command titles, setting descriptions) is in `package.nls.json`. A translation goes beside it as `package.nls.<locale>.json`.

The tests check that `l10n/bundle.l10n.json` matches the source and `package.nls.json` matches the manifest's `%placeholders%`. Reasons `@lwc-bolts/project-setup` gives for not setting a project up are worded by that package, and stay in English.


## Development

The extension is an npm workspace in the lwc-bolts monorepo. Run `npm install` at the repo root, then `npm run build:extension` here to build a `.vsix`. Packaging copies the compiled extension into a staging directory and installs its dependencies there from the npm registry, so the `.vsix` ships the published `@lwc-bolts` packages (the content mapper and the packages it and the extension use), not the workspace copies. A change to one of those packages reaches the extension only once it is published. To test unpublished changes, `npm run build:extension:local` builds and packs the workspace packages and installs those instead, writing `lwc-bolts-vscode-<version>-local.vsix`; it is for testing only and can't be published. `vsce` can't package the hoisted workspace dependencies directly. The extension is an ES module (`"type": "module"`), which VS Code supports from 1.100. Editors built on older VS Code versions, or that lack its support for them, can't activate it. `npm test` compiles the extension, then tests the content mapper registration against a stub `vscode` API, and the auto-import rewrites against TypeScript 7.1's language server, with the content mapper run from source. The tests load a fresh copy of the compiled extension for each test with `module.registerHooks`, as VS Code's extension host provides `vscode` to ES modules (see `test/loadExtension.mjs`).