import { ToolHandler, ToolContext, ToolResponse, createErrorResponse, createSuccessResponse } from '../common/types.js';
import { getElectronConfig } from '../../electron/config.js';
import { listCdpDomains, searchCdp } from './data.js';

const DESTRUCTIVE_DOMAINS = new Set([
  'Storage',
  'Network',
  'CacheStorage',
  'IndexedDB',
  'DOMStorage',
  'ServiceWorker'
]);

const DESTRUCTIVE_KEYWORDS = ['clear', 'delete', 'remove', 'unregister', 'dispose'];

function isDestructiveCdpMethod(method: string): boolean {
  const [domain, command] = method.split('.');
  if (!domain || !command) return false;
  if (!DESTRUCTIVE_DOMAINS.has(domain)) return false;
  const lowered = command.toLowerCase();
  return DESTRUCTIVE_KEYWORDS.some((keyword) => lowered.includes(keyword));
}

export class ElectronCdpSendTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    if (!context.page) {
      return createErrorResponse('Browser page not initialized.');
    }

    try {
      const config = getElectronConfig();
      if (!config.allowDestructiveCdp && isDestructiveCdpMethod(args.method)) {
        return createErrorResponse('Blocked potentially destructive CDP command. Enable ELECTRON_ALLOW_DESTRUCTIVE_CDP to proceed.');
      }
      const session = await context.page.context().newCDPSession(context.page);
      const result = await session.send(args.method, args.params ?? {});
      await session.detach().catch(() => {});
      return createSuccessResponse(JSON.stringify({ result }, null, 2));
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}

export class ElectronCdpDomainsTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    const domains = listCdpDomains();
    return createSuccessResponse(JSON.stringify({ domains }, null, 2));
  }
}

export class ElectronCdpSearchTool implements ToolHandler {
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    const results = searchCdp(args.query, args.limit ?? 10);
    return createSuccessResponse(JSON.stringify({ results }, null, 2));
  }
}
