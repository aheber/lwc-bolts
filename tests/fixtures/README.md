# Test fixtures

Representative SFDX projects that the lwc-bolts packages test against. This folder isn't a package, and no package depends on it: tests find a project by its path relative to their own package (`../../../tests/fixtures/example-project`). The projects meant to be opened in VS Code have their own `package.json`, which installs the content mapper from this repo for that.

- `example-project` has three package directories (`force-app`, `common` and `sales`, which has a flat layout) with Apex, labels, objects and fields, static resources, content assets, custom permissions, message channels and components. It's set up for the content mapper as its README describes, and it's the project to open in VS Code to try the mapper: run `npm install` in it first (it installs the mapper from this repo, TypeScript 7.1 and the `lwc` types), then open the folder itself as the workspace.
- `decomposed-labels` decomposes its custom labels (`decomposeCustomLabelsBeta2`).
- `managed-packages` has no namespace and uses metadata of an installed managed package, `dlrs` (Declarative Lookup Rollup Summaries). The package's metadata is cached in `managed/dlrs`, outside the package directories so deploys leave it alone, named the way the Metadata API names managed metadata (`dlrs__…`): an object and its fields, labels, a static resource, a class, an exposed component and one that isn't. The object, fields, labels, resource and component names are the package's; the Apex and component bodies are stubs, since managed source is hidden. `force-app` adds the subscriber's own field to the package's object and a component that imports the package's metadata.

Tests copy a project before changing it.
