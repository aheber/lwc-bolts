/**
 * A stub of the installed package's class: managed Apex is hidden, so a cache only has what it's given.
 * The class name is the package's; the methods are illustrative.
 */
global with sharing class RollupController {
    global class Result {
        @AuraEnabled global String message;
        @AuraEnabled global LookupRollupSummaryLog__c log;
        // the package's own class, referenced without its namespace
        @AuraEnabled global RollupSummary summary;
    }

    /** Recalculates the rollups of a record. */
    @AuraEnabled
    global static Result calculate(Id recordId) {
        return null;
    }

    /** Not global, so other namespaces can't import it. */
    @AuraEnabled
    public static String internalStatus() {
        return null;
    }
}
