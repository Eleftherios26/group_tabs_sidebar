Privacy Policy – Group Tabs Sidebar

Last updated: June 7, 2026

Data collection and usage
The Group Tabs Sidebar extension does not collect, store, or transmit any personal data or browsing data outside of your local Firefox profile.
All functionality runs exclusively on your device:
    • Open tabs (titles, URLs, favicons) are read only to group and display them in the sidebar.
    • Website icons (favicons) are stored locally in the browser's IndexedDB, together with their average colour, so that they can be displayed instantly without any external server requests.
    • Hiding/showing tabs is performed through the official Firefox API (tabs.hide / tabs.show).
    • Domain order, collapse state, and other preferences are saved locally in browser.storage.local and never leave your computer.

Permissions
The extension requests the following permissions in order to function:
    • tabs: To read and manage open tabs (activate, close, hide).
    • storage: To store domain order, sidebar state, and other preferences locally.
    • tabHide: To hide and show tabs in the tab strip.
    • alarms: To periodically check for missing tabs and to check for extension updates.
    • notifications: To display a one-time notification when the extension is updated to a new version.
    • host_permissions:
        ◦ https://addons.mozilla.org/api/v5/addons/addon/group-tabs-sidebar/* – to automatically check whether a newer version of the extension is available.
No external service is used for favicon retrieval. All favicons originate from the pages you visit and are stored locally. The update check communicates only with the official Mozilla API (over HTTPS) and contains no personal information, browsing history, or user-identifiable data. No data is ever sent to external servers or shared with third parties.
