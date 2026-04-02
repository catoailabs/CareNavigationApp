import { ToolHandler, ToolContext, ToolResponse, createErrorResponse, createSuccessResponse } from '../common/types.js';
import { getFocusedWebContents } from '../../electron/targets.js';

async function withFocusedWebContents(): Promise<any> {
  const webContents = await getFocusedWebContents();
  if (!webContents) {
    throw new Error('No focused Electron WebContents found.');
  }
  return webContents;
}

export class ElectronDevToolsOpenTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    try {
      const webContents = await withFocusedWebContents();
      webContents.openDevTools(args.options ?? {});
      return createSuccessResponse('Opened Electron DevTools.');
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}

export class ElectronDevToolsCloseTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    try {
      const webContents = await withFocusedWebContents();
      webContents.closeDevTools();
      return createSuccessResponse('Closed Electron DevTools.');
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}

export class ElectronDevToolsToggleTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    try {
      const webContents = await withFocusedWebContents();
      webContents.toggleDevTools();
      return createSuccessResponse('Toggled Electron DevTools.');
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}

export class ElectronDevToolsInspectTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    try {
      const webContents = await withFocusedWebContents();
      webContents.inspectElement(args.x, args.y);
      return createSuccessResponse(`Inspecting element at ${args.x}, ${args.y}.`);
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}
