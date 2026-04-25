# Provider Tab Bridge

Chrome extension bridge for the provider research composer.

## Automatic dev startup

1. Install Chromium once:

`brew install --cask chromium`

2. Start the project:

`npm run dev`

The dev wrapper will launch Chromium with this extension loaded and point it at the local app.

## Manual install in Google Chrome

Use this path if you want the bridge to read the tabs from your existing Google Chrome session instead of the auto-launched Chromium window.

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder:

`browser-extension/provider-tab-bridge`

## What it does

- Exposes the browser's open tabs to the provider research app running on `localhost`
- Extracts page text, canonical URL, referrer, and discovered links for each tab
- Falls back to the existing CDP bridge when the extension is not installed

## Permissions

- `tabs`: read tab titles, URLs, and favicons
- `scripting`: extract page text from open tabs
- `<all_urls>` host permission: required to read context across the user's open tabs

## Notes

- Chrome blocks script injection on restricted pages such as `chrome://` and extension pages. Those tabs still appear in the picker, but full text extraction is unavailable.
- Local `file://` tabs require Chrome's optional `Allow access to file URLs` toggle on the extension details page.
