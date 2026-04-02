# Playwright/Electron MCP Server

A Model Context Protocol server that combines Playwright automation with
Electron-native control. It can drive the user's current Electron UI via CDP,
run Electron API calls (when hosted in the main process), and optionally embed
an automation surface (iframe/webview) that the user can see.

## Capabilities (and how Electron APIs are integrated)

### 1) UI Automation (the user's current Electron window)
- Uses Chrome DevTools Protocol (CDP) to attach to the focused Electron
  `webContents`.
- The MCP connects via `--electron-bridge-url` and receives the active target
  ID automatically.
- Result: Playwright actions operate directly on the exact UI the user is
  looking at.

### 2) Electron API access (main process integration)
- When the MCP server runs inside Electron's main process, it can call
  Electron APIs directly.
- The MCP exposes Electron API tools (`electron_api_*`, `electron_handle_*`,
  `electron_eval_main`) that operate on the actual Electron module.
- This allows app-level control: windows, paths, dialogs, app state, native
  integrations, etc.
- These API calls are gated by flags (`--electron-allow-all-apis`,
  `--electron-allow-unsafe-eval`) and are OFF by default.

### 3) DevTools and low-level CDP control
- Tools like `electron_devtools_*` and `electron_cdp_send` allow deep
  inspection, diagnostics, and automation.
- Destructive CDP operations are blocked unless explicitly enabled
  (`--electron-allow-destructive-cdp`).

### 4) Embedded visible automation surface
- If your app exposes an iframe/webview, the MCP can target it using:
  `--electron-iframe-selector` + `--electron-iframe-type`.
- Result: agent actions are fully visible to the user.

### 5) Headless automation
- Use headless mode for background tasks with no UI shown:
  `--electron-mode headless --electron-headless-target electron`

## Agent connection (stdio) - required args

### UI (focused tab)
```json
{
  "command": "node",
  "args": [
    "/Users/timhunter/Library/Mobile Documents/com~apple~CloudDocs/ronbrowser/agent/tools/src/strands_tools/mcp/mcp-playwright/dist/index.js",
    "--electron-mode", "electron",
    "--electron-bridge-url", "http://127.0.0.1:9231"
  ]
}
```

### UI + iframe (visible automation inside app)
```json
{
  "command": "node",
  "args": [
    "/Users/timhunter/Library/Mobile Documents/com~apple~CloudDocs/ronbrowser/agent/tools/src/strands_tools/mcp/mcp-playwright/dist/index.js",
    "--electron-mode", "electron",
    "--electron-bridge-url", "http://127.0.0.1:9231",
    "--electron-iframe-selector", "<CSS_SELECTOR>",
    "--electron-iframe-type", "iframe"
  ]
}
```

### Headless (no visible UI)
```json
{
  "command": "node",
  "args": [
    "/Users/timhunter/Library/Mobile Documents/com~apple~CloudDocs/ronbrowser/agent/tools/src/strands_tools/mcp/mcp-playwright/dist/index.js",
    "--electron-mode", "headless",
    "--electron-headless-target", "electron",
    "--electron-bridge-url", "http://127.0.0.1:9231"
  ]
}
```

### Optional switches

- --electron-iframe-type webview|webcontentsview
- --electron-allow-unsafe-eval
- --electron-allow-all-apis
- --electron-allow-destructive-cdp (off by default; only enable if explicitly
  allowed)

## Tools (full list)

### Playwright browser tools

- playwright_navigate
- playwright_screenshot
- playwright_click
- playwright_iframe_click
- playwright_iframe_fill
- playwright_fill
- playwright_select
- playwright_hover
- playwright_upload_file
- playwright_evaluate
- playwright_console_logs
- playwright_resize
- playwright_close
- playwright_expect_response
- playwright_assert_response
- playwright_custom_user_agent
- playwright_get_visible_text
- playwright_get_visible_html
- playwright_go_back
- playwright_go_forward
- playwright_drag
- playwright_press_key
- playwright_save_as_pdf
- playwright_click_and_switch_tab

### Playwright API request tools

- playwright_get
- playwright_post
- playwright_put
- playwright_patch
- playwright_delete

### Codegen tools

- start_codegen_session
- end_codegen_session
- get_codegen_session
- clear_codegen_session

### Electron tools

- electron_status
- electron_api_call
- electron_api_get
- electron_api_set
- electron_api_search
- electron_api_describe
- electron_handle_call
- electron_handle_get
- electron_handle_set
- electron_handle_release
- electron_handle_list
- electron_eval_main
- electron_cdp_send
- electron_cdp_domains
- electron_cdp_search
- electron_devtools_open
- electron_devtools_close
- electron_devtools_toggle
- electron_devtools_inspect
- electron_embed_browser

## Security defaults

- Destructive CDP commands are blocked unless --electron-allow-destructive-cdp
  is set.
- Unsafe eval is blocked unless --electron-allow-unsafe-eval is set.
- Full Electron API access is blocked unless --electron-allow-all-apis is set.
- Keep CDP bound to localhost only.

## Acknowledgements

Huge thanks to the original Playwright MCP server authors and the Playwright
team (Microsoft). This server builds directly on their work and ecosystem.

If you want anything else, ask respectfully.
