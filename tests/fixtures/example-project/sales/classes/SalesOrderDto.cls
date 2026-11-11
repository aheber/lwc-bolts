/**
 * A sales order as the UI sees it.
 */
public class SalesOrderDto {
    @AuraEnabled public Id recordId;
    @AuraEnabled public String name;
    @AuraEnabled public Decimal amount;
    @AuraEnabled public String status;
    @AuraEnabled public Date closeDate;
    /** The customer, an SObject declared from .sfdx/tools/sobjects */
    @AuraEnabled public Account account;
    @AuraEnabled public List<LineItem> lineItems;

    public class LineItem {
        @AuraEnabled public String product;
        @AuraEnabled public Integer quantity;
    }
}
