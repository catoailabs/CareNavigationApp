import { ToolHandler, ToolContext, ToolResponse, createErrorResponse, createSuccessResponse } from '../common/types.js';
import { getElectronConfig } from '../../electron/config.js';
import { getElectronModule, isElectronMainProcess } from '../../electron/runtime.js';

export class ElectronEmbedBrowserTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    const config = getElectronConfig();

    if (!config.iframeSelector && config.iframeType !== 'webcontentsview') {
      return createErrorResponse('Embedded browser is not configured. Set ELECTRON_IFRAME_SELECTOR to enable it.');
    }

    const url = args.url as string;
    if (!url) {
      return createErrorResponse('Missing url for embedded browser.');
    }

    if (config.iframeType === 'webcontentsview') {
      if (!isElectronMainProcess()) {
        return createErrorResponse('WebContentsView embedding requires Electron main process.');
      }
      const electron = getElectronModule();
      if (!electron) {
        return createErrorResponse('Electron module not available.');
      }

      const bounds = args.bounds;
      if (!bounds) {
        return createErrorResponse('Missing bounds for WebContentsView embedding.');
      }

      const focusedWindow = electron.BrowserWindow.getFocusedWindow();
      if (!focusedWindow) {
        return createErrorResponse('No focused BrowserWindow found for embedding.');
      }

      const view = new electron.WebContentsView();
      focusedWindow.contentView.addChildView(view);
      view.setBounds(bounds);
      await view.webContents.loadURL(url);
      return createSuccessResponse('Embedded browser created via WebContentsView.');
    }

    if (!context.page) {
      return createErrorResponse('Browser page not initialized.');
    }

    const selector = config.iframeSelector;
    const embedType = config.iframeType ?? 'iframe';

    try {
      await context.page.evaluate(
        ({ selector, url, embedType }) => {
          const element = document.querySelector(selector as string);
          if (!element) {
            throw new Error(`Embed element not found: ${selector}`);
          }
          if (embedType === 'webview') {
            (element as any).setAttribute('src', url);
          } else {
            (element as any).setAttribute('src', url);
          }
        },
        { selector, url, embedType }
      );

      return createSuccessResponse(`Embedded ${embedType} navigated to ${url}`);
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}
