/**
 * Org-wide settings shared by every app.
 */
public with sharing class CommonSettings {
    /**
     * Settings exposed to Lightning components.
     */
    public class Settings {
        @AuraEnabled public String currencyCode;
        @AuraEnabled public Integer pageSize;
        @AuraEnabled public Boolean featuresEnabled;
    }

    /**
     * Returns the settings for the running user.
     * @param appName the app asking for its settings
     */
    @AuraEnabled(cacheable=true)
    public static Settings getSettings(String appName) {
        Settings s = new Settings();
        s.currencyCode = 'USD';
        s.pageSize = 25;
        s.featuresEnabled = true;
        return s;
    }

    @AuraEnabled(cacheable=true)
    public static Map<String, String> getFeatureFlags() {
        return new Map<String, String>();
    }
}
