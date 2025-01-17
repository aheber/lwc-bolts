The purpose of this library is to take Salesforce Metadata content and transpile it to TypeScript Declaration (d.ts format) content so it can be written to a file or proxied on file reads for editors and language servers.

This library does not engage with file systems and is not responsible for discovering or identifying available metadata.

Apex should include raw AuraEnabled, AuraEnabled + cacheable, classes with fields (fields not AuraEnabled should show as deprecated with a note), and Apex Continuations, should also carry forward ApexDoc text comments so it can be exposed on definitions.
