import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { codegenTools } from './tools/codegen';

export function createToolDefinitions() {
  return [
    // Codegen tools
    {
      name: "start_codegen_session",
      description: "Start a new code generation session to record Playwright actions",
      inputSchema: {
        type: "object",
        properties: {
          options: {
            type: "object",
            description: "Code generation options",
            properties: {
              outputPath: { 
                type: "string", 
                description: "Directory path where generated tests will be saved (use absolute path)" 
              },
              testNamePrefix: { 
                type: "string", 
                description: "Prefix to use for generated test names (default: 'GeneratedTest')" 
              },
              includeComments: { 
                type: "boolean", 
                description: "Whether to include descriptive comments in generated tests" 
              }
            },
            required: ["outputPath"]
          }
        },
        required: ["options"]
      }
    },
    {
      name: "end_codegen_session",
      description: "End a code generation session and generate the test file",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { 
            type: "string", 
            description: "ID of the session to end" 
          }
        },
        required: ["sessionId"]
      }
    },
    {
      name: "get_codegen_session",
      description: "Get information about a code generation session",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { 
            type: "string", 
            description: "ID of the session to retrieve" 
          }
        },
        required: ["sessionId"]
      }
    },
    {
      name: "clear_codegen_session",
      description: "Clear a code generation session without generating a test",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { 
            type: "string", 
            description: "ID of the session to clear" 
          }
        },
        required: ["sessionId"]
      }
    },
    {
      name: "playwright_navigate",
      description: "Navigate to a URL",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to navigate to the website specified" },
          browserType: { type: "string", description: "Browser type to use (chromium, firefox, webkit). Defaults to chromium", enum: ["chromium", "firefox", "webkit"] },
          width: { type: "number", description: "Viewport width in pixels (default: 1280)" },
          height: { type: "number", description: "Viewport height in pixels (default: 720)" },
          timeout: { type: "number", description: "Navigation timeout in milliseconds" },
          waitUntil: { type: "string", description: "Navigation wait condition" },
          headless: { type: "boolean", description: "Run browser in headless mode (default: false)" }
        },
        required: ["url"],
      },
    },
    {
      name: "playwright_screenshot",
      description: "Take a screenshot of the current page or a specific element",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name for the screenshot" },
          selector: { type: "string", description: "CSS selector for element to screenshot" },
          width: { type: "number", description: "Width in pixels (default: 800)" },
          height: { type: "number", description: "Height in pixels (default: 600)" },
          type: { type: "string", description: "Image format: jpeg or png (default: jpeg)", enum: ["jpeg", "png"] },
          quality: { type: "number", description: "JPEG quality 0-100 (default: 45 when type=jpeg)" },
          storeBase64: { type: "boolean", description: "Store screenshot in base64 format (default: true)" },
          fullPage: { type: "boolean", description: "Store screenshot of the entire page (default: false)" },
          savePng: { type: "boolean", description: "Save screenshot as PNG file (default: false)" },
          downloadsDir: { type: "string", description: "Custom downloads directory path (default: user's Downloads folder)" },
        },
        required: ["name"],
      },
    },
    {
      name: "playwright_click",
      description: "Click an element on the page",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for the element to click" },
        },
        required: ["selector"],
      },
    },
    {
      name: "playwright_iframe_click",
      description: "Click an element in an iframe on the page",
      inputSchema: {
        type: "object",
        properties: {
          iframeSelector: { type: "string", description: "CSS selector for the iframe containing the element to click" },
          selector: { type: "string", description: "CSS selector for the element to click" },
        },
        required: ["iframeSelector", "selector"],
      },
    },
    {
      name: "playwright_iframe_fill",
      description: "Fill an element in an iframe on the page",
      inputSchema: {
        type: "object",
        properties: {
          iframeSelector: { type: "string", description: "CSS selector for the iframe containing the element to fill" },
          selector: { type: "string", description: "CSS selector for the element to fill" },
          value: { type: "string", description: "Value to fill" },
        },
        required: ["iframeSelector", "selector", "value"],
      },
    },
    {
      name: "playwright_fill",
      description: "fill out an input field",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for input field" },
          value: { type: "string", description: "Value to fill" },
        },
        required: ["selector", "value"],
      },
    },
    {
      name: "playwright_select",
      description: "Select an element on the page with Select tag",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for element to select" },
          value: { type: "string", description: "Value to select" },
        },
        required: ["selector", "value"],
      },
    },
    {
      name: "playwright_hover",
      description: "Hover an element on the page",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for element to hover" },
        },
        required: ["selector"],
      },
    },
    {
      name: "playwright_upload_file",
      description: "Upload a file to an input[type='file'] element on the page",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for the file input element" },
          filePath: { type: "string", description: "Absolute path to the file to upload" }
        },
        required: ["selector", "filePath"],
      },
    },
    {
      name: "playwright_evaluate",
      description: "Execute JavaScript in the browser console",
      inputSchema: {
        type: "object",
        properties: {
          script: { type: "string", description: "JavaScript code to execute" },
        },
        required: ["script"],
      },
    },
    {
      name: "playwright_console_logs",
      description: "Retrieve console logs from the browser with filtering options",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "Type of logs to retrieve (all, error, warning, log, info, debug, exception)",
            enum: ["all", "error", "warning", "log", "info", "debug", "exception"]
          },
          search: {
            type: "string",
            description: "Text to search for in logs (handles text with square brackets)"
          },
          limit: {
            type: "number",
            description: "Maximum number of logs to return"
          },
          clear: {
            type: "boolean",
            description: "Whether to clear logs after retrieval (default: false)"
          }
        },
        required: [],
      },
    },
    {
      name: "playwright_resize",
      description: "Resize the browser viewport using manual dimensions or device presets. Supports 143+ device presets including iPhone, iPad, Android devices, and desktop browsers with proper user-agent and touch emulation.",
      inputSchema: {
        type: "object",
        properties: {
          device: { 
            type: "string", 
            description: "Device preset name (e.g., 'iPhone 13', 'iPad Pro 11', 'Pixel 7', 'Galaxy S24', 'Desktop Chrome'). Automatically configures viewport, user-agent, and device capabilities. Use playwright.devices to see all available devices." 
          },
          width: { 
            type: "number", 
            description: "Viewport width in pixels (for manual resize without device preset)" 
          },
          height: { 
            type: "number", 
            description: "Viewport height in pixels (for manual resize without device preset)" 
          },
          orientation: {
            type: "string",
            description: "Device orientation: 'portrait' or 'landscape' (only applies when using device preset)",
            enum: ["portrait", "landscape"]
          }
        },
        required: [],
      },
    },
    {
      name: "playwright_close",
      description: "Close the browser and release all resources",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "playwright_get",
      description: "Perform an HTTP GET request",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to perform GET operation" },
          token: { type: "string", description: "Bearer token for authorization" },
          headers: { 
            type: "object", 
            description: "Additional headers to include in the request",
            additionalProperties: { type: "string" }
          }
        },
        required: ["url"],
      },
    },
    {
      name: "playwright_post",
      description: "Perform an HTTP POST request",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to perform POST operation" },
          value: { type: "string", description: "Data to post in the body" },
          token: { type: "string", description: "Bearer token for authorization" },
          headers: { 
            type: "object", 
            description: "Additional headers to include in the request",
            additionalProperties: { type: "string" }
          }
        },
        required: ["url", "value"],
      },
    },
    {
      name: "playwright_put",
      description: "Perform an HTTP PUT request",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to perform PUT operation" },
          value: { type: "string", description: "Data to PUT in the body" },
          token: { type: "string", description: "Bearer token for authorization" },
          headers: { 
            type: "object", 
            description: "Additional headers to include in the request",
            additionalProperties: { type: "string" }
          }
        },
        required: ["url", "value"],
      },
    },
    {
      name: "playwright_patch",
      description: "Perform an HTTP PATCH request",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to perform PATCH operation" },
          value: { type: "string", description: "Data to PATCH in the body" },
          token: { type: "string", description: "Bearer token for authorization" },
          headers: { 
            type: "object", 
            description: "Additional headers to include in the request",
            additionalProperties: { type: "string" }
          }
        },
        required: ["url", "value"],
      },
    },
    {
      name: "playwright_delete",
      description: "Perform an HTTP DELETE request",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to perform DELETE operation" },
          token: { type: "string", description: "Bearer token for authorization" },
          headers: { 
            type: "object", 
            description: "Additional headers to include in the request",
            additionalProperties: { type: "string" }
          }
        },
        required: ["url"],
      },
    },
    {
      name: "playwright_expect_response",
      description: "Ask Playwright to start waiting for a HTTP response. This tool initiates the wait operation but does not wait for its completion.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Unique & arbitrary identifier to be used for retrieving this response later with `Playwright_assert_response`." },
          url: { type: "string", description: "URL pattern to match in the response." }
        },
        required: ["id", "url"],
      },
    },
    {
      name: "playwright_assert_response",
      description: "Wait for and validate a previously initiated HTTP response wait operation.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Identifier of the HTTP response initially expected using `Playwright_expect_response`." },
          value: { type: "string", description: "Data to expect in the body of the HTTP response. If provided, the assertion will fail if this value is not found in the response body." }
        },
        required: ["id"],
      },
    },
    {
      name: "playwright_custom_user_agent",
      description: "Set a custom User Agent for the browser",
      inputSchema: {
        type: "object",
        properties: {
          userAgent: { type: "string", description: "Custom User Agent for the Playwright browser instance" }
        },
        required: ["userAgent"],
      },
    },
    {
      name: "playwright_get_visible_text",
      description: "Get the visible text content of the current page",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "playwright_get_visible_html",
      description: "Get the HTML content of the current page. By default, all <script> tags are removed from the output unless removeScripts is explicitly set to false.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector to limit the HTML to a specific container" },
          removeScripts: { type: "boolean", description: "Remove all script tags from the HTML (default: true)" },
          removeComments: { type: "boolean", description: "Remove all HTML comments (default: false)" },
          removeStyles: { type: "boolean", description: "Remove all style tags from the HTML (default: false)" },
          removeMeta: { type: "boolean", description: "Remove all meta tags from the HTML (default: false)" },
          cleanHtml: { type: "boolean", description: "Perform comprehensive HTML cleaning (default: false)" },
          minify: { type: "boolean", description: "Minify the HTML output (default: false)" },
          maxLength: { type: "number", description: "Maximum number of characters to return (default: 20000)" }
        },
        required: [],
      },
    },
    {
      name: "playwright_go_back",
      description: "Navigate back in browser history",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "playwright_go_forward",
      description: "Navigate forward in browser history",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "playwright_drag",
      description: "Drag an element to a target location",
      inputSchema: {
        type: "object",
        properties: {
          sourceSelector: { type: "string", description: "CSS selector for the element to drag" },
          targetSelector: { type: "string", description: "CSS selector for the target location" }
        },
        required: ["sourceSelector", "targetSelector"],
      },
    },
    {
      name: "playwright_press_key",
      description: "Press a keyboard key",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key to press (e.g. 'Enter', 'ArrowDown', 'a')" },
          selector: { type: "string", description: "Optional CSS selector to focus before pressing key" }
        },
        required: ["key"],
      },
    },
    {
      name: "playwright_save_as_pdf",
      description: "Save the current page as a PDF file",
      inputSchema: {
        type: "object",
        properties: {
          outputPath: { type: "string", description: "Directory path where PDF will be saved" },
          filename: { type: "string", description: "Name of the PDF file (default: page.pdf)" },
          format: { type: "string", description: "Page format (e.g. 'A4', 'Letter')" },
          printBackground: { type: "boolean", description: "Whether to print background graphics" },
          margin: {
            type: "object",
            description: "Page margins",
            properties: {
              top: { type: "string" },
              right: { type: "string" },
              bottom: { type: "string" },
              left: { type: "string" }
            }
          }
        },
        required: ["outputPath"],
      },
    },
    {
      name: "playwright_click_and_switch_tab",
      description: "Click a link and switch to the newly opened tab",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for the link to click" },
        },
        required: ["selector"],
      },
    },
    {
      name: "electron_status",
      description: "Show current Electron automation status and configuration",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "electron_api_call",
      description: "Call a documented Electron API path (module/class static method)",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Electron API path, e.g. app.getPath or BrowserWindow.getFocusedWindow" },
          args: { type: "array", description: "Arguments for the call", items: {} }
        },
        required: ["path"],
      },
    },
    {
      name: "electron_api_get",
      description: "Get a documented Electron API property",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Electron API property path, e.g. app.name" }
        },
        required: ["path"],
      },
    },
    {
      name: "electron_api_set",
      description: "Set a documented Electron API property",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Electron API property path, e.g. app.name" },
          value: { description: "Value to assign" }
        },
        required: ["path", "value"],
      },
    },
    {
      name: "electron_api_search",
      description: "Search the Electron API reference for modules/classes",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Maximum results (default 10)" }
        },
        required: ["query"],
      },
    },
    {
      name: "electron_api_describe",
      description: "Describe an Electron API entry by name (module/class)",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Electron API entry name, e.g. app or BrowserWindow" }
        },
        required: ["name"],
      },
    },
    {
      name: "electron_handle_call",
      description: "Call a method on a previously returned Electron object handle",
      inputSchema: {
        type: "object",
        properties: {
          handleId: { type: "string", description: "Handle ID from a prior call" },
          method: { type: "string", description: "Method name to invoke" },
          args: { type: "array", description: "Arguments for the call", items: {} }
        },
        required: ["handleId", "method"],
      },
    },
    {
      name: "electron_handle_get",
      description: "Get a property from a previously returned Electron object handle",
      inputSchema: {
        type: "object",
        properties: {
          handleId: { type: "string", description: "Handle ID from a prior call" },
          property: { type: "string", description: "Property name to read" }
        },
        required: ["handleId", "property"],
      },
    },
    {
      name: "electron_handle_set",
      description: "Set a property on a previously returned Electron object handle",
      inputSchema: {
        type: "object",
        properties: {
          handleId: { type: "string", description: "Handle ID from a prior call" },
          property: { type: "string", description: "Property name to set" },
          value: { description: "Value to assign" }
        },
        required: ["handleId", "property", "value"],
      },
    },
    {
      name: "electron_handle_release",
      description: "Release a previously returned Electron object handle",
      inputSchema: {
        type: "object",
        properties: {
          handleId: { type: "string", description: "Handle ID to release" }
        },
        required: ["handleId"],
      },
    },
    {
      name: "electron_handle_list",
      description: "List currently stored Electron object handles",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "electron_eval_main",
      description: "Evaluate JavaScript in the Electron main process (unsafe, gated)",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript code to evaluate" },
          timeoutMs: { type: "number", description: "Execution timeout in ms (default 5000)" }
        },
        required: ["code"],
      },
    },
    {
      name: "electron_cdp_send",
      description: "Send a raw Chrome DevTools Protocol command to the active target",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", description: "CDP method name (e.g. Page.captureScreenshot)" },
          params: { type: "object", description: "CDP method parameters" }
        },
        required: ["method"],
      },
    },
    {
      name: "electron_cdp_domains",
      description: "List available Chrome DevTools Protocol domains",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "electron_cdp_search",
      description: "Search Chrome DevTools Protocol commands/events",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Maximum results (default 10)" }
        },
        required: ["query"],
      },
    },
    {
      name: "electron_devtools_open",
      description: "Open DevTools for the focused Electron WebContents",
      inputSchema: {
        type: "object",
        properties: {
          options: { type: "object", description: "DevTools options passed to webContents.openDevTools" }
        },
        required: [],
      },
    },
    {
      name: "electron_devtools_close",
      description: "Close DevTools for the focused Electron WebContents",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "electron_devtools_toggle",
      description: "Toggle DevTools for the focused Electron WebContents",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "electron_devtools_inspect",
      description: "Inspect element at coordinates in the focused Electron WebContents",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate" },
          y: { type: "number", description: "Y coordinate" }
        },
        required: ["x", "y"],
      },
    },
    {
      name: "electron_embed_browser",
      description: "Load a URL into a configured in-app iframe/webview/WebContentsView",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to load into the embedded browser" },
          bounds: {
            type: "object",
            description: "Bounds for WebContentsView embedding",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" }
            }
          }
        },
        required: ["url"],
      },
    },
  ] as const satisfies Tool[];
}

// Browser-requiring tools for conditional browser launch
export const BROWSER_TOOLS = [
  "playwright_navigate",
  "playwright_screenshot",
  "playwright_click",
  "playwright_iframe_click",
  "playwright_iframe_fill",
  "playwright_fill",
  "playwright_select",
  "playwright_hover",
  "playwright_upload_file",
  "playwright_evaluate",
  "playwright_resize",
  "playwright_close",
  "playwright_expect_response",
  "playwright_assert_response",
  "playwright_custom_user_agent",
  "playwright_get_visible_text",
  "playwright_get_visible_html",
  "playwright_go_back",
  "playwright_go_forward",
  "playwright_drag",
  "playwright_press_key",
  "playwright_save_as_pdf",
  "playwright_click_and_switch_tab"
];

// API Request tools for conditional launch
export const API_TOOLS = [
  "playwright_get",
  "playwright_post",
  "playwright_put",
  "playwright_delete",
  "playwright_patch"
];

// Electron tools (some require a browser context)
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

// Codegen tools
export const CODEGEN_TOOLS = [
  'start_codegen_session',
  'end_codegen_session',
  'get_codegen_session',
  'clear_codegen_session'
];

// All available tools
export const tools = [
  ...BROWSER_TOOLS,
  ...API_TOOLS,
  ...ELECTRON_TOOLS,
  ...CODEGEN_TOOLS
];
