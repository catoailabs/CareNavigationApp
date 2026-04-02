export * from './common/types.js';
export * from './browser/index.js';
export * from './api/index.js';
export * from './electron/index.js';

// Tool type constants
export const BROWSER_TOOLS = [
  "playwright_navigate",
  "playwright_screenshot",
  "playwright_click",
  "playwright_iframe_click",
  "playwright_iframe_fill",
  "playwright_fill",
  "playwright_select",
  "playwright_hover",
  "playwright_evaluate",
  "playwright_console_logs",
  "playwright_close",
  "playwright_get_visible_text",
  "playwright_get_visible_html"
];

export const API_TOOLS = [
  "playwright_get",
  "playwright_post",
  "playwright_put",
  "playwright_patch",
  "playwright_delete"
]; 

export const ELECTRON_TOOLS = [
  "electron_status",
  "electron_api_call",
  "electron_api_get",
  "electron_api_set",
  "electron_api_search",
  "electron_api_describe",
  "electron_handle_call",
  "electron_handle_get",
  "electron_handle_set",
  "electron_handle_release",
  "electron_handle_list",
  "electron_eval_main",
  "electron_cdp_send",
  "electron_cdp_domains",
  "electron_cdp_search",
  "electron_devtools_open",
  "electron_devtools_close",
  "electron_devtools_toggle",
  "electron_devtools_inspect",
  "electron_embed_browser"
];

export const ELECTRON_PAGE_TOOLS = [
  "electron_cdp_send",
  "electron_embed_browser"
];
