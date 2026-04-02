#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createToolDefinitions } from "./tools.js";
import { setupRequestHandlers } from "./requestHandler.js";
import { Logger, RequestLoggingMiddleware } from "./logging/index.js";
import { MonitoringSystem } from "./monitoring/index.js";
import { startHttpServer } from "./http-server.js";
import { loadElectronConfig, setElectronConfig, type ElectronConfig } from "./electron/config.js";

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options: { port?: number; electron?: Partial<ElectronConfig> } = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      options.port = parseInt(args[i + 1], 10);
      if (isNaN(options.port) || options.port < 1 || options.port > 65535) {
        console.error('Error: --port must be a valid port number (1-65535)');
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--electron-cdp-url' && i + 1 < args.length) {
      options.electron = { ...(options.electron ?? {}), cdpUrl: args[i + 1] };
      i++;
    } else if (args[i] === '--electron-target-id' && i + 1 < args.length) {
      options.electron = { ...(options.electron ?? {}), targetId: args[i + 1] };
      i++;
    } else if (args[i] === '--electron-bridge-url' && i + 1 < args.length) {
      options.electron = { ...(options.electron ?? {}), bridgeUrl: args[i + 1] };
      i++;
    } else if (args[i] === '--electron-iframe-selector' && i + 1 < args.length) {
      options.electron = { ...(options.electron ?? {}), iframeSelector: args[i + 1] };
      i++;
    } else if (args[i] === '--electron-iframe-type' && i + 1 < args.length) {
      options.electron = { ...(options.electron ?? {}), iframeType: args[i + 1] as ElectronConfig['iframeType'] };
      i++;
    } else if (args[i] === '--electron-mode' && i + 1 < args.length) {
      options.electron = { ...(options.electron ?? {}), mode: args[i + 1] as ElectronConfig['mode'] };
      i++;
    } else if (args[i] === '--electron-allow-unsafe-eval') {
      options.electron = { ...(options.electron ?? {}), allowUnsafeEval: true };
    } else if (args[i] === '--electron-allow-all-apis') {
      options.electron = { ...(options.electron ?? {}), allowAllApis: true };
    } else if (args[i] === '--electron-allow-destructive-cdp') {
      options.electron = { ...(options.electron ?? {}), allowDestructiveCdp: true };
    } else if (args[i] === '--electron-headless-target' && i + 1 < args.length) {
      options.electron = { ...(options.electron ?? {}), headlessTarget: args[i + 1] as ElectronConfig['headlessTarget'] };
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.error(`
Playwright MCP Server

USAGE:
  playwright-mcp-server [OPTIONS]

OPTIONS:
  --port <number>    Run in HTTP mode on the specified port
  --electron-mode <playwright|electron|headless>
                     Set default automation mode (defaults to electron if Electron config is present)
  --electron-cdp-url <url>
                     CDP http or websocket endpoint for Electron's remote debugging
  --electron-target-id <id>
                     CDP targetId for the active Electron UI
  --electron-bridge-url <url>
                     HTTP bridge URL for Electron main-process metadata (optional)
  --electron-iframe-selector <selector>
                     CSS selector for an in-app iframe or webview container
  --electron-iframe-type <iframe|webview|webcontentsview>
                     Embed type for the in-app browser (defaults to iframe)
  --electron-allow-unsafe-eval
                     Allow main-process JavaScript evaluation (unsafe)
  --electron-allow-all-apis
                     Allow all Electron APIs without allowlist (unsafe)
  --electron-allow-destructive-cdp
                     Allow CDP commands that can clear or delete storage (unsafe)
  --electron-headless-target <electron|playwright>
                     Choose which engine to use for headless mode
  --help, -h         Show this help message

EXAMPLES:
  # Run in stdio mode (default)
  playwright-mcp-server

  # Run in HTTP mode on port 8931
  playwright-mcp-server --port 8931

HTTP MODE CONFIGURATION:
  When running with --port, configure your MCP client:
  
  {
    "mcpServers": {
      "playwright": {
        "url": "http://localhost:8931/mcp",
        "type": "http"
      }
    }
  }
`);
      process.exit(0);
    }
  }
  
  return options;
}

async function runServer() {
  const options = parseArgs();
  setElectronConfig(loadElectronConfig(options.electron));
  
  // If port is specified, run in HTTP mode
  if (options.port) {
    // Show immediate feedback
    process.stdout.write(`\n⏳ Initializing Playwright MCP Server on port ${options.port}...\n`);
    await startHttpServer(options.port);
    return;
  }
  
  // Otherwise, run in stdio mode (default)
  // Initialize logger for stdio mode (file only - no console output to avoid breaking stdio protocol)
  const logger = Logger.getInstance({
    level: 'info',
    format: 'json',
    outputs: ['file'], // File only - console would write to stdout and break stdio protocol
    filePath: `${process.env.HOME || '/tmp'}/playwright-mcp-server.log`, // Use home directory
    maxFileSize: 10485760,
    maxFiles: 5
  });
  const loggingMiddleware = new RequestLoggingMiddleware(logger);

  // Initialize monitoring system (disabled in stdio mode to avoid console output)
  const monitoringSystem = new MonitoringSystem({
    enabled: false, // Disabled in stdio mode - HTTP server output would break stdio protocol
    metricsInterval: 30000,
    healthCheckInterval: 60000,
    memoryThreshold: 80,
    responseTimeThreshold: 5000
  });

  const serverInfo = {
    name: "playwright-mcp",
    version: "1.0.11",
    capabilities: {
      resources: {},
      tools: {},
    }
  };

  const server = new Server(
    {
      name: serverInfo.name,
      version: serverInfo.version,
    },
    {
      capabilities: serverInfo.capabilities,
    }
  );

  // Log server startup
  loggingMiddleware.logServerStartup(serverInfo);

  // Create tool definitions
  const TOOLS = createToolDefinitions();

  // Setup request handlers
  setupRequestHandlers(server, TOOLS, monitoringSystem);

  // Start monitoring system
  try {
    await monitoringSystem.startMetricsCollection(3001);
    logger.info('Monitoring system started', { port: 3001 });
  } catch (error) {
    logger.warn('Failed to start monitoring HTTP server', { error: error instanceof Error ? error.message : String(error) });
  }

  // Graceful shutdown logic
  async function shutdown() {
    loggingMiddleware.logServerShutdown();
    logger.info('Shutdown signal received');
    
    try {
      await monitoringSystem.stopMetricsCollection();
      logger.info('Monitoring system stopped');
    } catch (error) {
      logger.error('Error stopping monitoring system', error instanceof Error ? error : new Error(String(error)));
    }
    
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', shutdown);
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception', err, {
      category: 'system',
      nodeVersion: process.version,
      platform: process.platform,
    });
  });

  // Create transport and connect
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  logger.info('MCP Server connected and ready', {
    transport: 'stdio',
    toolCount: TOOLS.length,
  });
}

runServer().catch(() => {
  process.exit(1);
});
