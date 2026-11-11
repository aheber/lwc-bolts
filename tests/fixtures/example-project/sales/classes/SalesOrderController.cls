/**
 * Reads and writes sales orders for the sales app.
 */
public with sharing class SalesOrderController {
    /**
     * Returns the most recent orders.
     * @param maxResults the number of orders to return
     */
    @AuraEnabled(cacheable=true)
    public static List<SalesOrderDto> getRecentOrders(Integer maxResults) {
        return new List<SalesOrderDto>();
    }
    /**
     * Returns the most recent orders.
     * @param longparamnamesforfunzies long param names for funzies
     * @param andLotsOfThem and lots of them
     * @param weirdLongTypesToo weird long types too
     */
    @AuraEnabled(cacheable=true)
    public static List<String> methodWithReallyReallyReallyLongNameToSeeHowItFitsBecauseWeLikeIt(Integer longparamnamesforfunzies, String andLotsOfThem, Map<List<String>, Map<Integer, String>> weirdLongTypesToo) {
        return new List<String>();
    }

    /**
     * Returns the accounts that have placed orders.
     */
    @AuraEnabled(cacheable=true)
    public static List<Account> getCustomers() {
        return [SELECT Id, Name, AnnualRevenue, (SELECT Id, Name FROM Contacts) FROM Account];
    }

    /**
     * Returns an account's orders.
     * @param accountId the account
     */
    @AuraEnabled(cacheable=true)
    public static List<Sales_Order__c> getAccountOrders(Id accountId) {
        return [
            SELECT Id, Name, Amount__c, Status__c, Close_Date__c, Account__r.Name
            FROM Sales_Order__c
            WHERE Account__c = :accountId
        ];
    }

    /**
     * Saves an order and returns its Id.
     * @param order the order to save
     */
    @AuraEnabled
    public static Id saveOrder(SalesOrderDto order) {
        return null;
    }
}
