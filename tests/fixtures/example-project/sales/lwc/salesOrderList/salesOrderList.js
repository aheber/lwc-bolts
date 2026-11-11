// @ts-check
import { LightningElement, api, wire } from "lwc";
// typings from the Salesforce extensions (.sfdx/typings/lwc), for modules the mapper doesn't declare
// Only the imperative helpers: its wire adapters are typed as plain functions, which the real lwc
// types reject in @wire.
import { getFieldValue } from "lightning/uiRecordApi";
import { publish, MessageContext } from "lightning/messageService";

// Apex in this package
import getRecentOrders from "@salesforce/apex/SalesOrderController.getRecentOrders";
import methodWithReallyReallyReallyLongNameToSeeHowItFitsBecauseWeLikeIt from "@salesforce/apex/SalesOrderController.methodWithReallyReallyReallyLongNameToSeeHowItFitsBecauseWeLikeIt";
import saveOrder from "@salesforce/apex/SalesOrderController.saveOrder";
import getCustomers from "@salesforce/apex/SalesOrderController.getCustomers";
import getAccountOrders from "@salesforce/apex/SalesOrderController.getAccountOrders";
// Apex in the common package
import getSettings from "@salesforce/apex/CommonSettings.getSettings";
// schema in this package
import SALES_ORDER from "@salesforce/schema/Sales_Order__c";
import AMOUNT from "@salesforce/schema/Sales_Order__c.Amount__c";
import STATUS from "@salesforce/schema/Sales_Order__c.Status__c";
// a standard object's field, declared from the SObject definitions in .sfdx/tools/sobjects
import ACCOUNT_NAME from "@salesforce/schema/Account.Name";
// labels from the common package, alongside one from force-app
import lblSave from "@salesforce/label/c.Common_Save";
import lblCancel from "@salesforce/label/c.Common_Cancel";
import lblNoRecords from "@salesforce/label/c.Common_No_Records";
import lblAccount from "@salesforce/label/c.Account";
// custom permissions from this package and from force-app
import canApprove from "@salesforce/customPermission/ApproveOrders";
import hasTestPerm from "@salesforce/customPermission/TestPerm";
// content asset in this package, static resource in force-app
import salesLogo from "@salesforce/contentAssetUrl/salesLogo";
import bolt from "@salesforce/resourceUrl/bolt";
// message channels from the common package and from force-app
import TOAST_REQUESTED from "@salesforce/messageChannel/ToastRequested__c";
import RECORD_SELECTED from "@salesforce/messageChannel/RecordSelected__c";

// components from the common package and from force-app
import BaseCard from "c/baseCard";
import { formatCurrency, formatDate } from "c/formatUtils";
import { data } from "c/comp2";

export default class SalesOrderList extends LightningElement {
  /** @type {import("lightning/uiRecordApi").RecordRepresentation | undefined} */
  @api selectedRecord;

  /** @type {Object | undefined} */
  @wire(MessageContext)
  messageContext;

  /** @type {{ data?: Apex.SalesOrderDto[]; error?: unknown }} */
  @wire(getRecentOrders, { maxResults: 10 })
  orders = {};

  // SObjects come from the definitions in .sfdx/tools/sobjects
  /** @type {{ data?: Apex.Account[]; error?: unknown }} */
  @wire(getCustomers)
  customers = {};

  // Sales_Order__c is declared from its object and field XML, so it's typed before it's deployed
  /** @type {{ data?: Apex.Sales_Order__c[]; error?: unknown }} */
  @wire(getAccountOrders, { accountId: "$accountId" })
  accountOrders = {};

  /** @type {string} */
  @api accountId = "";

  /** @type {{ data?: Apex.CommonSettings.Settings; error?: unknown }} */
  @wire(getSettings, { appName: "sales" })
  settings = {};

  labels = { save: lblSave, cancel: lblCancel, noRecords: lblNoRecords, account: lblAccount };
  logoUrl = salesLogo;
  iconUrl = bolt;
  canApprove = canApprove || hasTestPerm;
  objectApiName = SALES_ORDER.objectApiName;
  fields = [AMOUNT.fieldApiName, STATUS.fieldApiName, ACCOUNT_NAME.fieldApiName];
  channels = [TOAST_REQUESTED, RECORD_SELECTED];
  cardTitle = new BaseCard().title;
  legacyKey = data.key1;
  myCount = 7;

  get selectedAmount() {
    // the mapper's schema modules satisfy the extensions' FieldId type
    return this.selectedRecord ? getFieldValue(this.selectedRecord, AMOUNT) : undefined;
  }

  notify() {
    if (this.messageContext) publish(this.messageContext, TOAST_REQUESTED, { title: lblSave, variant: "success" });
  }

  get customerNames() {
    return (this.customers.data ?? []).map((account) => ({
      name: account.Name ?? "",
      contacts: (account.Contacts ?? []).map((contact) => contact.Name),
    }));
  }

  get accountOrderRows() {
    return (this.accountOrders.data ?? []).map((order) => ({
      id: order.Id,
      customer: order.Account__r?.Name,
      amount: formatCurrency(order.Amount__c ?? 0),
      status: order.Status__c,
    }));
  }

  get customerOrderCounts() {
    // the lookup also adds the child relationship to Account
    return (this.customers.data ?? []).map((account) => account.Sales_Orders__r?.length ?? 0);
  }

  get hasOrders() {
    return (this.orders.data?.length ?? 0) > 0;
  }

  get rows() {
    const currencyCode = this.settings.data?.currencyCode;
    return (this.orders.data ?? []).map((order) => ({
      ...order,
      customer: order.account?.Name,
      formattedAmount: formatCurrency(order.amount ?? 0, currencyCode),
      formattedDate: order.closeDate ? formatDate(order.closeDate) : "",
    }));
  }

  async save() {
    const order = this.orders.data?.[0];
    if (order) {
      /** @type {string} */
      const id = await saveOrder({ order });
      return id;
    }
  }

  cardExpanded = true;

  /**
   * The template checks that this takes the event c-base-card dispatches.
   * @param {CustomEvent<{ expanded: boolean, title: string }>} event
   */
  handleCardToggle(event) {
    this.cardExpanded = event.detail.expanded;
  }

  focusSearch() {
    // this.refs is typed from the template's lwc:ref attributes
    this.refs?.search.focus();
    return [this.refs?.search.value, this.refs?.card.title, this.refs?.robot1.disabled];
  }


  /**
   * The template checks that this takes the event c-base-card dispatches.
   * @param {MouseEvent} event
   */
  handleClick(event){

  }
}
