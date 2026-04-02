import { BrowserToolBase } from './base.js';
import { ToolContext, ToolResponse, createSuccessResponse, createErrorResponse } from '../common/types.js';
import { resetBrowserState } from '../../toolHandler.js';
import { getElectronConfig } from '../../electron/config.js';

/**
 * Tool for navigating to URLs
 * 
 * CRITICAL: In Electron mode, we MUST use the app's navigation API
 * (window.electron.browser.navigate) instead of page.goto().
 * Using page.goto() would navigate the shell page away, destroying the entire
 * React app UI including the chrome, tabs, and agent panel.
 */
export class NavigationTool extends BrowserToolBase {
  /**
   * Execute the navigation tool
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    // Check if browser is available
    if (!context.browser || !context.browser.isConnected()) {
      // If browser is not connected, we need to reset the state to force recreation
      resetBrowserState();
      return createErrorResponse(
        "Browser is not connected. The connection has been reset - please retry your navigation."
      );
    }

    // Check if page is available and not closed
    if (!context.page || context.page.isClosed()) {
      return createErrorResponse(
        "Page is not available or has been closed. Please retry your navigation."
      );
    }

    return this.safeExecute(context, async (page) => {
      try {
        const electronConfig = getElectronConfig();
        const isElectronMode = electronConfig.mode === 'electron' ||
          (electronConfig.mode === 'headless' && electronConfig.headlessTarget === 'electron');

        if (isElectronMode) {
          // CRITICAL: Use the Electron app's safe navigation API
          // This navigates via IPC to the main process which creates/updates
          // a WebContentsView for the website, keeping the React shell intact.
          const safeUrl = args.url.replace(/'/g, "\\'");
          
          // Check if the Electron API is available
          const hasElectronApi = await page.evaluate(() => {
            return typeof (window as any).electron?.browser?.navigate === 'function';
          });

          if (hasElectronApi) {
            const result = await page.evaluate(async (url: string) => {
              return await (window as any).electron.browser.navigate(url);
            }, args.url);

            if (result && result.success === false) {
              return createErrorResponse(`Navigation failed: ${result.error || 'Unknown error'}`);
            }

            // Wait for navigation to complete
            // The Electron app handles the actual navigation in a WebContentsView
            await new Promise(resolve => setTimeout(resolve, 500));

            return createSuccessResponse(`Navigated to ${args.url} via Electron App API`);
          } else {
            // Electron API not available - this is a critical error in Electron mode
            return createErrorResponse(
              "CRITICAL: Electron browser.navigate API is not available. " +
              "Cannot safely navigate without destroying the app shell. " +
              "Ensure the Electron preload script is properly configured."
            );
          }
        }

        // Standard Playwright navigation for non-Electron mode
        await page.goto(args.url, {
          timeout: args.timeout || 30000,
          waitUntil: args.waitUntil || "load"
        });
        
        return createSuccessResponse(`Navigated to ${args.url}`);
      } catch (error) {
        const errorMessage = (error as Error).message;
        
        // Check for common disconnection errors
        if (
          errorMessage.includes("Target page, context or browser has been closed") ||
          errorMessage.includes("Target closed") ||
          errorMessage.includes("Browser has been disconnected")
        ) {
          // Reset browser state to force recreation on next attempt
          resetBrowserState();
          return createErrorResponse(
            `Browser connection issue: ${errorMessage}. Connection has been reset - please retry your navigation.`
          );
        }
        
        // For other errors, return the standard error
        throw error;
      }
    });
  }
}

/**
 * Tool for closing the browser
 * 
 * CRITICAL: In Electron mode, we should NOT close the browser as that would
 * affect the Electron app. We only disconnect the CDP session.
 */
export class CloseBrowserTool extends BrowserToolBase {
  /**
   * Execute the close browser tool
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    const electronConfig = getElectronConfig();
    const isElectronMode = electronConfig.mode === 'electron' ||
      (electronConfig.mode === 'headless' && electronConfig.headlessTarget === 'electron');

    if (isElectronMode) {
      // In Electron mode, we only disconnect - never close the browser
      // Closing would terminate the Electron app!
      resetBrowserState();
      return createSuccessResponse("Disconnected from Electron browser (app remains running)");
    }

    if (context.browser) {
      try {
        // Check if browser is still connected
        if (context.browser.isConnected()) {
          await context.browser.close().catch(error => {
            console.error("Error while closing browser:", error);
          });
        } else {
          console.error("Browser already disconnected, cleaning up state");
        }
      } catch (error) {
        console.error("Error during browser close operation:", error);
        // Continue with resetting state even if close fails
      } finally {
        // Always reset the global browser and page references
        resetBrowserState();
      }
      
      return createSuccessResponse("Browser closed successfully");
    }
    
    return createSuccessResponse("No browser instance to close");
  }
}

/**
 * Tool for navigating back in browser history
 * 
 * CRITICAL: In Electron mode, we MUST use the app's goBack API
 * to navigate the WebContentsView's history, not the shell page.
 */
export class GoBackTool extends BrowserToolBase {
  /**
   * Execute the go back tool
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      const electronConfig = getElectronConfig();
      const isElectronMode = electronConfig.mode === 'electron' ||
        (electronConfig.mode === 'headless' && electronConfig.headlessTarget === 'electron');

      if (isElectronMode) {
        const hasElectronApi = await page.evaluate(() => {
          return typeof (window as any).electron?.browser?.goBack === 'function';
        });

        if (hasElectronApi) {
          const result = await page.evaluate(async () => {
            return await (window as any).electron.browser.goBack();
          });

          if (result && result.success === false) {
            return createErrorResponse(`Go back failed: ${result.error || 'Cannot go back'}`);
          }

          return createSuccessResponse("Navigated back in browser history via Electron App API");
        }
      }

      // Standard Playwright navigation for non-Electron mode
      await page.goBack();
      return createSuccessResponse("Navigated back in browser history");
    });
  }
}

/**
 * Tool for navigating forward in browser history
 * 
 * CRITICAL: In Electron mode, we MUST use the app's goForward API
 * to navigate the WebContentsView's history, not the shell page.
 */
export class GoForwardTool extends BrowserToolBase {
  /**
   * Execute the go forward tool
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      const electronConfig = getElectronConfig();
      const isElectronMode = electronConfig.mode === 'electron' ||
        (electronConfig.mode === 'headless' && electronConfig.headlessTarget === 'electron');

      if (isElectronMode) {
        const hasElectronApi = await page.evaluate(() => {
          return typeof (window as any).electron?.browser?.goForward === 'function';
        });

        if (hasElectronApi) {
          const result = await page.evaluate(async () => {
            return await (window as any).electron.browser.goForward();
          });

          if (result && result.success === false) {
            return createErrorResponse(`Go forward failed: ${result.error || 'Cannot go forward'}`);
          }

          return createSuccessResponse("Navigated forward in browser history via Electron App API");
        }
      }

      // Standard Playwright navigation for non-Electron mode
      await page.goForward();
      return createSuccessResponse("Navigated forward in browser history");
    });
  }
} 