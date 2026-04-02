import type { Browser, Page, CDPSession } from 'playwright';
import { chromium } from 'playwright';
import { getElectronConfig, setElectronConfig, type EmbedType } from './config.js';
import { getCdpUrlFromApp, getFocusedTargetInfo, getTargetInfoForWebContents } from './targets.js';
import { isElectronMainProcess } from './runtime.js';
import { ensureHeadlessWebContents } from './headless.js';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const debugLog = (...args: unknown[]) => {
  if (process.env.MCP_ELECTRON_DEBUG === 'true') {
    console.error(...args);
  }
};

let electronBrowser: Browser | undefined;
let electronPage: Page | undefined;
let electronTargetId: string | undefined;
let electronCdpUrl: string | undefined;

interface BridgeStatus {
  cdpUrl?: string;
  targetId?: string;
  iframeSelector?: string;
  iframeType?: string;
}

function normalizeEmbedType(value?: string): EmbedType | undefined {
  if (value === 'iframe' || value === 'webview' || value === 'webcontentsview') return value;
  return undefined;
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.request(parsed, { method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function resolveTargetFromBridge(bridgeUrl: string): Promise<BridgeStatus> {
  const statusUrl = bridgeUrl.endsWith('/') ? `${bridgeUrl}status` : `${bridgeUrl}/status`;
  return await fetchJson(statusUrl) as BridgeStatus;
}

async function resolveElectronTarget(): Promise<{ cdpUrl: string; targetId: string }> {
  const config = getElectronConfig();
  debugLog('[ElectronConnection] resolveElectronTarget called');
  debugLog('[ElectronConnection] config:', JSON.stringify({
    mode: config.mode,
    cdpUrl: config.cdpUrl,
    targetId: config.targetId,
    bridgeUrl: config.bridgeUrl,
    iframeSelector: config.iframeSelector,
    iframeType: config.iframeType
  }));
  debugLog('[ElectronConnection] isElectronMainProcess:', isElectronMainProcess());

  if (isElectronMainProcess()) {
    const cdpUrl = config.cdpUrl ?? getCdpUrlFromApp();
    const focused = config.mode === 'headless' && config.headlessTarget === 'electron'
      ? await getTargetInfoForWebContents(await ensureHeadlessWebContents())
      : await getFocusedTargetInfo();

    if (!cdpUrl) {
      throw new Error('Electron CDP URL is unavailable. Set ELECTRON_CDP_URL or enable remote debugging with app.commandLine.appendSwitch.' );
    }
    if (!focused?.targetId) {
      throw new Error('Electron targetId is unavailable. Ensure a BrowserWindow is available (focused or headless) and remote debugging is enabled.');
    }

    return { cdpUrl, targetId: focused.targetId };
  }

  let cdpUrl = config.cdpUrl;
  let targetId = config.targetId;

  const needsBridge = (!cdpUrl || !targetId || (!config.iframeSelector && !config.iframeType)) && config.bridgeUrl;
  debugLog('[ElectronConnection] needsBridge:', needsBridge, 'bridgeUrl:', config.bridgeUrl);
  
  if (needsBridge && config.bridgeUrl) {
    debugLog('[ElectronConnection] Fetching bridge status from:', config.bridgeUrl);
    const bridge = await resolveTargetFromBridge(config.bridgeUrl);
    debugLog('[ElectronConnection] Bridge status:', bridge);

    if (!cdpUrl) {
      cdpUrl = bridge.cdpUrl;
    }

    // If targetId isn't explicitly configured, always use the bridge value
    if (!config.targetId) {
      targetId = bridge.targetId ?? targetId;
    } else {
      targetId = config.targetId;
    }

    const bridgeIframeType = normalizeEmbedType(bridge.iframeType) ?? (bridge.iframeSelector ? 'iframe' : undefined);
    const nextConfig = {
      ...config,
      cdpUrl: cdpUrl ?? config.cdpUrl,
      iframeSelector: config.iframeSelector ?? bridge.iframeSelector,
      iframeType: config.iframeType ?? bridgeIframeType
    };

    if (
      nextConfig.cdpUrl !== config.cdpUrl ||
      nextConfig.iframeSelector !== config.iframeSelector ||
      nextConfig.iframeType !== config.iframeType
    ) {
      setElectronConfig(nextConfig);
    }
  }

  if (!cdpUrl) {
    throw new Error('Electron CDP URL is missing. Provide --electron-cdp-url or ELECTRON_CDP_URL.');
  }
  if (!targetId) {
    throw new Error('Electron targetId is missing. Provide --electron-target-id or ELECTRON_TARGET_ID, or use the Electron bridge.');
  }

  debugLog('[ElectronConnection] Resolved target:', { cdpUrl, targetId });
  return { cdpUrl, targetId };
}

async function findPageByTargetId(browser: Browser, targetId: string): Promise<Page | undefined> {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      let session: CDPSession | undefined;
      try {
        session = await context.newCDPSession(page);
        const info = await session.send('Target.getTargetInfo');
        const resolved = (info as { targetInfo?: { targetId?: string } })?.targetInfo?.targetId;
        if (resolved === targetId) {
          return page;
        }
      } catch (error) {
        // Ignore lookup errors and continue.
      } finally {
        if (session) {
          try {
            await session.detach();
          } catch (error) {
            // Ignore detach failures.
          }
        }
      }
    }
  }

  return undefined;
}

export async function ensureElectronBrowser(): Promise<{ browser: Browser; page: Page; targetId: string }> {
  const { cdpUrl, targetId } = await resolveElectronTarget();

  if (electronBrowser && electronBrowser.isConnected() && electronCdpUrl === cdpUrl) {
    if (electronTargetId === targetId && electronPage && !electronPage.isClosed()) {
      return { browser: electronBrowser, page: electronPage, targetId };
    }

    const page = await findPageByTargetId(electronBrowser, targetId);
    if (page) {
      electronPage = page;
      electronTargetId = targetId;
      return { browser: electronBrowser, page, targetId };
    }
  }

  if (electronBrowser) {
    try {
      await electronBrowser.close();
    } catch (error) {
      // Ignore disconnect failures.
    }
  }

  electronBrowser = await chromium.connectOverCDP(cdpUrl);
  electronCdpUrl = cdpUrl;

  const page = await findPageByTargetId(electronBrowser, targetId);
  if (!page) {
    throw new Error(`Unable to find Electron targetId ${targetId} via CDP. Ensure the target is visible and remote debugging is enabled.`);
  }

  electronPage = page;
  electronTargetId = targetId;
  return { browser: electronBrowser, page, targetId };
}

export function resetElectronBrowserState(): void {
  electronBrowser = undefined;
  electronPage = undefined;
  electronTargetId = undefined;
  electronCdpUrl = undefined;
}
