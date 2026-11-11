# @lwc-bolts/sf2ts

`sf2ts` transforms Salesforce Metadata content into TypeScript compatible content so it can be written to a file or proxied on file reads for editors and language servers.

```js
import { convert, MetadataType } from "@lwc-bolts/sf2ts";

const [{ text, mapData, diagnostics }] = await convert([{ path, type: MetadataType.ApexClass, content }]);
```

Each converted file has its TypeScript `text` & `mapData` pairing pieces of it with the content they came from (UTF-16 offsets), and any `diagnostics`. If `convert` is unable to successfully process a file then that file gets empty `text` and a `ConversionFailed` diagnostic covering it. A file that declares nothing of use to LWCs, such as an Apex interface, has empty `text` and no diagnostics.

`convert` is async and each metadata type's converter lazy loads on its first conversion. This means you only ever load what you used, nothing extra.


# Metadata Conversion Details

## Lightning Web Component

### LWC Metadata

A bundle's `<name>.js-meta.xml` declares the `c/<name>` module components import each other through. It re-exports the component's module by type. This makes it possible to keep TypeScript aware of the aliased import name without needing to write them disk in the `jsconfig.json`'s `paths`:

```ts
declare module "c/myComponent" {
  const myComponent: typeof import("./myComponent.js");
  export = myComponent;
}
```

### LWC Template

A `LightningComponentBundle`'s templates (its `.html` files) convert to TypeScript that checks against the component's JavaScript and other components it references in the markup (`<c-component-name>`).

```ts
import { bundleApiVersion, convert, defaultExportName, MetadataType } from "@lwc-bolts/sf2ts";

const [{ text, mapData, diagnostics }] = await convert([
  {
    path: "/project/force-app/lwc/orders/views/compact.html",
    type: MetadataType.LightningComponentBundle,
    content,
    // how it imports the bundle's component, from a subfolder here (by default, ./<bundleName>.js)
    componentModule: "../orders.js",
    // the bundle's name, which its slots are declared under (by default, the template's folder's name)
    bundleName: "orders",
    // the API version it's parsed at (by default, the template compiler's latest)
    apiVersion: await bundleApiVersion(ordersJsMetaXml),
    // whether the bundle has other templates, which make every lwc:ref optional
    alternateTemplates: true,
  },
  {
    path: "/project/force-app/lwc/orders/orders.js-meta.xml",
    type: MetadataType.LightningComponentBundle,
    content: ordersJsMetaXml,
    // names the c/orders module's export (by default, the bundle's name)
    defaultExportName: await defaultExportName(ordersJs),
  },
]);
```

`text` contains TypeScript module text that imports the bundle's component (`componentModule`, `../orders.js` here), unlike metadata's global declarations. Its default export is the compiled template, named after the file (`compactTemplate` here), so the component can import it for `render()`. `diagnostics` include the LWC template compiler's errors, as `TemplateError`s. `bundleApiVersion` and `defaultExportName` are provided by the caller (we expose utility methods to help capture them from related files). Each template's output declares its own slots so they can be checked by containing components. Templates are parsed with `@lwc/template-compiler`, base component definitions come from [`@lwc-bolts/lightning-base-components`](../lightning-base-components).

## Custom Label

Importing a Custom Label named `MyLabel`:
```javascript
import lblMyLabel from "@salesforce/label/c.MyLabel";
```

A label's value is the label in the user's language. We show the default language as the first line of its documentation when hovering.

Custom Labels are supported in both the combined `CustomLabels` and the decomposed `CustomLabel` file formats.

## Custom Permission

Importing a Custom Permission named `TestPerm`
```javascript
import hasTestPerm from "@salesforce/customPermission/TestPerm";
```

A custom permission's value is `true` when the user has the permission and `undefined` when they don't.

## Static Resource

Importing a Static Resource named `bolt`:
```javascript
import bolt from "@salesforce/resourceUrl/bolt";
```

Static Resources import as URL strings.

## Content Asset

Importing a Content Asset named `bolt`:
```javascript
import bolt from "@salesforce/contentAssetUrl/bolt";
```

Content Assets import as URL strings.

## Lightning Message Channels

Importing a Lightning Message Channel named `RecordSelected__c`:
```javascript
import RecordSelected__c from "@salesforce/messageChannel/RecordSelected__c";
```

A `*.messageChannel-meta.xml` file declares `@salesforce/messageChannel/<Name>__c` or `@salesforce/messageChannel/c__<Name>__c`, which is the same channel. The imported value is the channel's ID, an opaque string for `lightning/messageService`. It's typed `string & { readonly __messageChannel: "<Name>__c" }`, is a branded type so you can discriminate should you have a need. The channel's label, description and message fields are listed in its documentation.

## Apex

### Class

Every Apex class is declared as an interface in the global `Apex` namespace, even a class without fields, and a class that extends another extends its interface, so it has the base class's fields. Nested classes, interfaces and enums are declared in a namespace named after their outer class. Namespaces merge across files, so a method in one class can return a class declared in another file. Because of the namespace, a class named `Response` or `File` doesn't merge with the DOM type of the same name.

An enum is declared as the union of its values' names, which is how Apex serializes them: `public enum Color { RED, GREEN }` becomes `type Color = "RED" | "GREEN"`. An interface is declared as an object type with any properties (`interface Shape extends Record<string, unknown> {}`), since its value is an instance of whichever class implements it.


### JSDoc Generation

ApexDoc comments (`/** ... */`) on classes, fields and `@AuraEnabled` methods become JSDoc on the generated interfaces, properties and module exports, so editors show them when hovering an import. A comment can go before a declaration or between its annotations and the rest of it. `@description` text joins the description and `@return` becomes `@returns`. Other tags, such as `@param`, `@example` and `@see`, are kept as written. Each `@param` description is also attached to its property in the method's parameter object, so it shows while filling in the call.

An `@AuraEnabled` method's module is documented with its Apex signature, before its ApexDoc, so hovering an import shows the method as Apex declares it as well as the type LWC calls it with. The signature is the return type, name and parameters, on one line, without annotations or modifiers (`List<SalesOrderDto> getRecentOrders(Integer maxResults)`).

```ts
declare namespace Apex {
  interface Outer {
    name?: string;
  }
  namespace Outer {
    interface Inner {}
  }
}
declare module "@salesforce/apex/Outer.get" {
  /**
   * ---
   * **Apex**
   *
   * ```apex
   * Inner get()
   * ```
   */
  const get: {
    (): Promise<Apex.Outer.Inner>;
  };
  export default get;
}
```

To use a different namespace prefix for the generated content, pass `apexNamespace` to `convert`. With `{ apexNamespace: null }`, classes are declared globally. That can create conflicts within the project. For instance, a class named `Response` merges with the DOM's `Response` type.


### @AuraEnabled Methods
Static `@AuraEnabled` methods are exported as `@salesforce/apex/...` modules for imperative calls, if that method is also `cacheable=true` then it is additionall configured to be comaptible with the `@wire` decorator.

### Properties
Properties declared on a class can be exposed for the LWC to interact with, such as when an Apex method returns a class. An LWC only receives the properties that are `@AuraEnabled`, `public` or `global`, and not `static`. By default the others are declared `@deprecated` but the LWC is still made aware so that the user can recognize and correct the problem. To leave them out entirely, pass `inaccessibleApexProperties: "exclude"` (for example; `await convert(components, { inaccessibleApexProperties: "exclude" })`). Trying to access one in the LWC is then an error. To declare them like any other field, without the `@deprecated`, pass `inaccessibleApexProperties: "include"`. The default is `"include as deprecated"`. (SObject fields, from files or Apex stubs, are always included and never deprecated)

### Continuation
A continuation method (`@AuraEnabled(continuation=true)`) returns a `Continuation` object, but the promise an LWC gets resolves to what its callback eventually returns. When the method names its callback with a string, as in `con.continuationMethod = 'processResponse'`, and the class has a method of that name, the `@salesforce/apexContinuation/...` module uses that method's return type. Otherwise, such as when the name is chosen at runtime or set to more than one value, it keeps the continuation method's declared return type.

### Apex -> Typescript Mappings

Types describe the JSON values that LWC receives:

| Apex | TypeScript |
| --- | --- |
| `String`, `Id` | `string` |
| `Date`, `Datetime`, `Time` | `string` (ISO-8601) |
| `Blob` | `string` (base64) |
| `Integer`, `Long`, `Decimal`, `Double` | `number` |
| `Boolean` | `boolean` |
| `List<T>`, `Set<T>`, `T[]` | `T[]` |
| `Map<K, V>` | `Record<string, V>` (JSON keys are strings) |
| `SObject` | `Record<string, unknown>` |
| `Object`, `Json` | `unknown` |
| A standard library type, such as `Exception` or `Schema.DisplayType` | `Apex.System.Exception`, `Apex.Schema.__lwcEnums["DisplayType"]` (see [Standard library types](#standard-library-types)) |
| Other class references | `Apex.<Name>` |

sf2ts converts one file at a time, so it can't resolve types declared elsewhere, such as SObjects. They are still referenced as `Apex.<Name>`. Object and field metadata declare SObjects (see [SObject record types](#sobject-record-types)), and so do the SObject definitions the Salesforce VS Code extensions generate (see below). For anything else, declare the types you need in the `Apex` namespace, for example `declare namespace Apex { interface Account { Name?: string } }`. Generic types other than `List`, `Set` and `Map` (such as `Iterable<String>`) are `unknown`, since their value is whichever class implements them, and so is a type reference that's incomplete in a class being edited.

# Namespaced Project

Namespaces are tricky for LWCs, for the most part Salesforce doesn't want you to reference your own namespace, on foreign packages. The generated types attempt to respect that, recognizing the difference between the project's namespace and the component's namespace.

In a project with a namespace (sfdx-project.json's `namespace`), pass it as `projectNamespace`: `await convert(components, { projectNamespace: "acme" })`. Inside a namespace, LWC must import its own metadata without the namespace (it rejects `@salesforce/schema/acme__Invoice__c` and `@salesforce/apex/acme.Invoices.recent`), but the org adds it when it compiles a component, so the values of schema imports and the records LWC get namespaced custom objects and fields with it:

- Modules keep the local LWC imports: `@salesforce/schema/Invoice__c.Amount__c`, `@salesforce/label/c.Name`, `@salesforce/apex/Invoices.recent`.
- Schema imports' values have the namespace: `{ fieldApiName: "acme__Amount__c"; objectApiName: "acme__Invoice__c" }`. Standard objects and fields (`Account`, `Name`), and another namespace's (`other__Score__c`), are left as they are.
- Record types are named with it, and so are their custom fields and relationships: `Apex.acme__Invoice__c` with `acme__Amount__c` and `acme__Account__r`. They merge with the SObject definitions of a namespaced org, which name them the same way, and whose schema modules take the names LWC imports.
- In Apex code, a reference through the namespace (`acme.Invoices`) is the project's type, and a custom object is its record type with or without the namespace (`Invoice__c` and `acme__Invoice__c` are both `Apex.acme__Invoice__c`).

## Installed packages

If Metadata of an installed managed package (not the namespace under development) is available locally it can be converted too. The resulting TypeScript text is named the way the Metadata API names foreign managed metadata: with the package's namespace (`dlrs__LookupRollupSummaryLog__c`, `dlrs__RollupController.cls`, a label `dlrs__fflib_error`):

| Metadata | Declared as |
| --- | --- |
| Objects and fields | `@salesforce/schema/dlrs__Log__c.dlrs__ErrorMessage__c`, and the project's own field on the package's object as `dlrs__Log__c.Notes__c` |
| Labels | `@salesforce/label/dlrs.fflib_error`, where the project's own are `c.<name>` |
| Static resources, custom permissions, message channels, content assets | `dlrs__Name` (`@salesforce/messageChannel/dlrs__Name__c`, without a `c__` form) |
| Apex classes | the class's types in the package's namespace, `Apex.dlrs.RollupController`, which the project's references `dlrs.RollupController` find; only its `global` `@AuraEnabled` methods, as `@salesforce/apex/dlrs.RollupController.<method>`, since other namespaces can't import the others |
| Components | `dlrs/manageRollups`, only when the bundle is exposed (`<isExposed>true</...>`), since other namespaces can't import it otherwise |

In a package's Apex, names resolve as they do in the package. A custom object is the package's (`LookupRollupSummaryLog__c` is `dlrs__LookupRollupSummaryLog__c`). A name is the package's class of that name when the copy has one (`RollupSummary` is `Apex.dlrs.RollupSummary`), and otherwise a library type or an SObject; a package can't see the project's classes. A dotted name (`RollupController.Result`) and one through the package's namespace (`dlrs.RollupSummary`, `dlrs.RollupController.Result`) are the package's types. Each of a package's classes registers itself and its nested types in its package's type-only registry (`Apex.dlrs.__lwcClasses`, keyed by lower-cased dotted name), which TypeScript checks. A type nothing in the copy declares, including another package's Apex, is `unknown` rather than an error, since a package's copied code isn't yours to fix. Managed Apex and components are compiled and hidden, so a copy only has what it's given, such as stubs of their signatures. A tag of another namespace's component in a template (`<dlrs-manage-rollups>`) isn't checked against it.

## Apex Standard library types

Apex code can use the types of the standard library's namespaces without naming the namespace: `Exception` is `System.Exception`. sf2ts knows the types of System and Schema. They're declared in namespaces of those names in the `Apex` namespace, in each file that uses them; declarations of the same type merge. A class becomes an empty interface, or one with any properties when its instances have some, since their JSON names aren't known exactly (`Address`). An interface has any properties, and an enum is the union of its values (`Apex.Schema.__lwcEnums["DisplayType"]`).

As in Apex, an unqualified name such as `Exception` is the project's own type of that name if it has one, which shadows the library's. Otherwise it's looked up in Schema (its describe types, then the project's SObjects), then System. `Address` and `Location` are looked up in System first, so they're the compound field types even in an org with the Address and Location objects, which Apex code calls `Schema.Address` and `Schema.Location`. A qualified name is always the library's (`System.Exception`), and a Schema name that isn't one of its types is an SObject (`Schema.Account` is `Apex.Account`).

Which of these a name is depends on the whole project, and sf2ts converts one file at a time. So a reference to a name the library has checks registries, interfaces each file adds its types to: `__lwcClasses` has the project's Apex types whose names the library has, and `__lwcSObjects` has every SObject. TypeScript then picks the project's type if the registries have one. Such a reference is a conditional type, written where it's used: `Apex.__lwcClasses extends { "exception": infer T } ? T : …`. Hovers and errors show the type it resolves to. A class's base class is the exception, since an interface can only extend a type by name: its reference is an alias in a namespace of the class's own, such as `Apex.__lwcRefs.MyException.exception` (`Apex.dlrs.__lwcRefs.<Class>` in an installed package). The resolution order is in `src/apex/resolution.ts`.

The namespaces, the order they're looked up in, the names looked up in a different order, and types the stubs leave out (such as `Exception` itself) are in `src/apex/library.config.ts`. The types are read from the Salesforce extensions' StandardApexLibrary stubs (`.sfdx/tools/<release>/StandardApexLibrary`) into `src/apex/library.generated.ts`. To add a namespace, list it in the config, then regenerate:

```sh
npm run generate:apex-library                            # the example project's newest release
npm run generate:apex-library -- path/to/StandardApexLibrary
```

## SObject

Besides its `@salesforce/schema/...` module, an object's `*.object-meta.xml` declares the object's record type in the Apex namespace, and each `*.field-meta.xml` adds its field to it. Interfaces merge across files, so together they describe the object as the project defines it:

```ts
declare namespace Apex {
  interface Sales_Order__c {
    Id?: string;
    Name?: string;
    // ...the other standard fields
  }
  interface User {}
}
declare namespace Apex {
  interface Sales_Order__c {
    /**
     * @description Total order amount
     */
    Amount__c?: number;
  }
}
```

- **Objects** declare their standard fields: `Id`, `Name`, `IsDeleted`, the created and last-modified fields, `SystemModstamp`, and `OwnerId` unless records are owned by their master-detail parent (`ControlledByParent` sharing). The owner itself (`Owner`, a user or a queue) is left to the SObject definitions the Salesforce extensions generate, which type it by its targets when the project has the object's describe, since a property declared in more than one file must have the same type. Custom metadata types (`__mdt`) and platform events (`__e`) declare their own standard fields. Standard objects only declare `Id`, because their fields vary. `CreatedBy` and `LastModifiedBy` are `Apex.User`, so object files also declare an empty `interface User {}` to make that reference resolve.
- **Fields** are typed as LWC receives them. `Checkbox` is `boolean`. `Currency`, `Number` and `Percent` are `number`. Dates, times, picklists, text and every other string-valued type are `string`. Formula fields use their result type.
- **Lookups and master-detail fields** declare the related record's Id (`Account__c?: string`) and the record (`Account__r?: Apex.Account`). They also add the child relationship to the parent (`interface Account { Sales_Orders__r?: Apex.Sales_Order__c[] }`), which also declares the parent, so the reference resolves even when nothing else declares `Account`. Standard lookups, such as `AccountId`, only declare the Id, because their relationships aren't named `__r`.
- **Geolocation fields** declare their latitude and longitude (`Location__Latitude__s`, `Location__Longitude__s`).
- **Fields whose type can't be known from their file are left out.** These include roll-up summaries other than `count` and `sum`, whose type depends on the summarized field, unsupported types such as `ExternalLookup`, and standard fields' metadata, which has no `<type>`.

The types match the ones the generated SObject definitions use, so an object declared both ways merges into one type. TypeScript requires a property declared in more than one place to have the same type (TS2717). The record types use the same [`apexNamespace`](#apex-types) as Apex classes.

### SObject Definitions from Org

**SFDX: Refresh SObject Definitions** in the Salesforce VS Code extensions writes each of the org's SObjects as an Apex class, in `.sfdx/tools/sobjects/standardObjects` and `.sfdx/tools/sobjects/customObjects`:

```apex
global class Account {
    global String Name;
    /* The account's annual revenue
    */
    global Decimal AnnualRevenue;
    global List<Contact> Contacts;

    global Account ()
    {
    }
}
```

Convert one as an `ApexClass` with `isSobject: true` on the component (an `ApexClassComponent`; options a type takes are only on its own component type), and it declares `Apex.Account` for other classes and components to use:

```js
await convert([{ path, type: MetadataType.ApexClass, content, isSobject: true }]);
```

The `isSobject` flag causes the following changes:

- Fields are exposed without `@AuraEnabled`, so none are marked `@deprecated`.
- Block comments (`/* ... */`), which the generator writes from field descriptions, document fields as ApexDoc would.
- No `@salesforce/apex/...` modules are declared. Instead, the object and the fields LWC can import get `@salesforce/schema/...` modules: scalar fields, lookups' Id fields and compound fields, but not child relationships or lookups' related records. They're declared as patterns with a leading `*` (`"*@salesforce/schema/Account.Name"`), which only match the exact import. TypeScript prefers an exact `declare module` over a pattern, so where an object or field file declares the same module, as for a standard field the project customizes, that one is used and the two don't conflict.
- A field without a type is skipped. The generator writes a few of these, such as `global  RecordId;` on `UriEvent`. This also applies to ordinary classes.

Fields are optional, as for any class, because a query only returns the fields it selects. Child relationships (`List<Contact> Contacts`) become arrays and lookups become the related SObject's type. Polymorphic lookups, such as Task's `What` and `Owner`, are declared as `SObject` in the definitions, which becomes `Record<string, unknown>`. Pass their targets as `polymorphicTargets`, by relationship name, to type them as one of their targets: with `{ What: ["Account", "Case"] }`, `What` is an `Apex.Account | Apex.Case`. A query that doesn't use `TYPEOF` returns the fields of the `Name` object for a polymorphic relationship, whatever its target, so when the `Name` object is declared too the type is `Apex.Name & (Apex.Account | Apex.Case)`. sf2ts doesn't need to know which objects are declared: every SObject adds itself to the SObjects' registry (`Apex.__lwcSObjects`), and the relationship's type is a conditional type that looks each target, and the `Name` object, up there. Until every target is declared, it stays `SObject`, so it never names an object that isn't. That keeps `What.Name` valid even though Case has no `Name` field, while a field only some targets have, such as `Industry`, is an error. Only fields declared as `SObject` in an SObject definition are typed this way. Compound fields such as `BillingAddress` are `Address` in the definitions, which is `System.Address` (see [Standard library types](#standard-library-types)), so any of their properties (`city`, `street`) can be read.
