# @lwc-bolts/sfdx-project

An SFDX project as the lwc-bolts tools see it:

- `findSfdxRoot(dir)` walks up to the folder with `sfdx-project.json`.
- `readPackageDirectories(root)` reads its `packageDirectories`, and `findLwcFolders(root, directories)` finds the `lwc` folders in them.
- `SfdxProject.load(root, { respectForceIgnore })` resolves a file's metadata type through `@salesforce/source-deploy-retrieve`, the way deploys and retrieves do (honoring `sfdx-project.json`, and `.forceignore` unless `respectForceIgnore` is `false`); finds a component's module by name, and lists a bundle's templates, as SDR resolves them; reads the SObject definitions and describes the Salesforce extensions write under `.sfdx/tools`; and exposes the project's `namespace` from `sfdx-project.json`. TypeScript projects in the same SFDX project share one instance per `respectForceIgnore` setting while its configuration (`sfdx-project.json`, `.forceignore` and the definitions' `typeNames.json`) is unchanged.

Private for now. The [content mapper](../typescript-content-mapper) and [project-setup](../project-setup) use it.
