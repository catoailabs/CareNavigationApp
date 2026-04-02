import { ToolHandler, ToolContext, ToolResponse, createErrorResponse, createSuccessResponse } from '../common/types.js';
import { getElectronConfig } from '../../electron/config.js';
import { getElectronModule, isElectronMainProcess } from '../../electron/runtime.js';
import { getElectronApiIndex, searchElectronApi, findElectronApiEntry } from './data.js';
import { getHandle, listHandles, releaseHandle, storeHandle } from './handles.js';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const apiIndex = getElectronApiIndex();

function ensureElectronAvailable(): any {
  if (!isElectronMainProcess()) {
    throw new Error('Electron APIs require the MCP server to run in the Electron main process.');
  }
  const electron = getElectronModule();
  if (!electron) {
    throw new Error('Electron module is not available in this runtime.');
  }
  return electron;
}

function validatePath(path: string, allowAllApis: boolean): void {
  if (allowAllApis) return;
  const root = path.split('.')[0];
  if (!apiIndex.modules.has(root) && !apiIndex.classes.has(root)) {
    throw new Error(`Electron API root not recognized: ${root}`);
  }
}

function resolvePath(path: string): { parent: any; key: string; value: any } {
  const electron = ensureElectronAvailable();
  const segments = path.split('.').filter(Boolean);
  let current = electron;

  for (let i = 0; i < segments.length - 1; i++) {
    if (current == null) break;
    current = current[segments[i]];
  }

  const key = segments[segments.length - 1];
  const value = current ? current[key] : undefined;
  return { parent: current, key, value };
}

function isPlainObject(value: any): boolean {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serializeValue(value: any): any {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item));
  }

  if (isPlainObject(value)) {
    const result: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = serializeValue(entry);
    }
    return result;
  }

  const handleId = storeHandle(value, value?.constructor?.name);
  return { handleId, type: value?.constructor?.name ?? 'Object' };
}

export class ElectronApiCallTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    const config = getElectronConfig();

    try {
      validatePath(args.path, config.allowAllApis);
      const { parent, key, value } = resolvePath(args.path);

      if (typeof value !== 'function') {
        if (args.args && args.args.length) {
          return createErrorResponse(`Electron API path is not callable: ${args.path}`);
        }
        return createSuccessResponse(JSON.stringify({ value: serializeValue(value) }, null, 2));
      }

      const result = await value.apply(parent, args.args ?? []);
      return createSuccessResponse(JSON.stringify({ value: serializeValue(result) }, null, 2));
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}

export class ElectronApiGetTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    const config = getElectronConfig();

    try {
      validatePath(args.path, config.allowAllApis);
      const { value } = resolvePath(args.path);
      return createSuccessResponse(JSON.stringify({ value: serializeValue(value) }, null, 2));
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}

export class ElectronApiSetTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    const config = getElectronConfig();

    try {
      validatePath(args.path, config.allowAllApis);
      const { parent, key } = resolvePath(args.path);
      if (!parent) {
        return createErrorResponse(`Unable to resolve Electron API path: ${args.path}`);
      }
      parent[key] = args.value;
      return createSuccessResponse(`Set ${args.path}`);
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}

export class ElectronHandleCallTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    try {
      const entry = getHandle(args.handleId);
      if (!entry) {
        return createErrorResponse(`Unknown handleId: ${args.handleId}`);
      }

      const target = entry.value;
      const method = target?.[args.method];
      if (typeof method !== 'function') {
        return createErrorResponse(`Method not found on handle ${args.handleId}: ${args.method}`);
      }

      const result = await method.apply(target, args.args ?? []);
      return createSuccessResponse(JSON.stringify({ value: serializeValue(result) }, null, 2));
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}

export class ElectronHandleGetTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    const entry = getHandle(args.handleId);
    if (!entry) {
      return createErrorResponse(`Unknown handleId: ${args.handleId}`);
    }

    const value = entry.value?.[args.property];
    return createSuccessResponse(JSON.stringify({ value: serializeValue(value) }, null, 2));
  }
}

export class ElectronHandleSetTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    const entry = getHandle(args.handleId);
    if (!entry) {
      return createErrorResponse(`Unknown handleId: ${args.handleId}`);
    }

    entry.value[args.property] = args.value;
    return createSuccessResponse(`Set ${args.property} on handle ${args.handleId}`);
  }
}

export class ElectronHandleReleaseTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    const removed = releaseHandle(args.handleId);
    if (!removed) {
      return createErrorResponse(`Unknown handleId: ${args.handleId}`);
    }
    return createSuccessResponse(`Released handle ${args.handleId}`);
  }
}

export class ElectronHandleListTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return createSuccessResponse(JSON.stringify({ handles: listHandles() }, null, 2));
  }
}

export class ElectronApiSearchTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    const results = searchElectronApi(args.query, args.limit ?? 10);
    return createSuccessResponse(JSON.stringify({ results }, null, 2));
  }
}

export class ElectronApiDescribeTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    const entry = findElectronApiEntry(args.name);
    if (!entry) {
      return createErrorResponse(`Electron API entry not found: ${args.name}`);
    }
    return createSuccessResponse(JSON.stringify(entry, null, 2));
  }
}

export class ElectronEvalMainTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    const config = getElectronConfig();
    if (!config.allowUnsafeEval) {
      return createErrorResponse('Main-process eval is disabled. Enable ELECTRON_ALLOW_UNSAFE_EVAL to proceed.');
    }

    try {
      const electron = ensureElectronAvailable();
      const require = createRequire(import.meta.url);
      const sandbox = {
        console,
        require,
        process,
        electron,
        Buffer,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval
      };

      const result = vm.runInNewContext(args.code, sandbox, { timeout: args.timeoutMs ?? 5000 });
      const resolved = result instanceof Promise ? await result : result;
      return createSuccessResponse(JSON.stringify({ value: serializeValue(resolved) }, null, 2));
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}
