export type AutomationMode = 'playwright' | 'electron' | 'headless';
export type EmbedType = 'iframe' | 'webview' | 'webcontentsview';
export type HeadlessTarget = 'playwright' | 'electron';

export interface ElectronConfig {
  mode: AutomationMode;
  cdpUrl?: string;
  targetId?: string;
  bridgeUrl?: string;
  iframeSelector?: string;
  iframeType?: EmbedType;
  headlessTarget?: HeadlessTarget;
  allowUnsafeEval: boolean;
  allowAllApis: boolean;
  allowDestructiveCdp: boolean;
}

let currentConfig: ElectronConfig = {
  mode: 'playwright',
  allowUnsafeEval: false,
  allowAllApis: false,
  allowDestructiveCdp: false
};

export function setElectronConfig(config: ElectronConfig): void {
  currentConfig = config;
}

export function getElectronConfig(): ElectronConfig {
  return currentConfig;
}

function parseBoolean(value?: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  return undefined;
}

function normalizeMode(value?: string): AutomationMode | undefined {
  if (!value) return undefined;
  if (value === 'playwright' || value === 'electron' || value === 'headless') return value;
  return undefined;
}

function normalizeEmbedType(value?: string): EmbedType | undefined {
  if (!value) return undefined;
  if (value === 'iframe' || value === 'webview' || value === 'webcontentsview') return value;
  return undefined;
}

function normalizeHeadlessTarget(value?: string): HeadlessTarget | undefined {
  if (!value) return undefined;
  if (value === 'playwright' || value === 'electron') return value;
  return undefined;
}

export function loadElectronConfig(overrides: Partial<ElectronConfig> = {}): ElectronConfig {
  const env = process.env;

  const envMode = normalizeMode(env.ELECTRON_MCP_MODE);
  const envCdpUrl = env.ELECTRON_CDP_URL;
  const envTargetId = env.ELECTRON_TARGET_ID;
  const envBridgeUrl = env.ELECTRON_BRIDGE_URL;
  const envIframeSelector = env.ELECTRON_IFRAME_SELECTOR;
  const envIframeType = normalizeEmbedType(env.ELECTRON_IFRAME_TYPE);
  const envHeadlessTarget = normalizeHeadlessTarget(env.ELECTRON_HEADLESS_TARGET);
  const envAllowUnsafeEval = parseBoolean(env.ELECTRON_ALLOW_UNSAFE_EVAL);
  const envAllowAllApis = parseBoolean(env.ELECTRON_ALLOW_ALL_APIS);
  const envAllowDestructiveCdp = parseBoolean(env.ELECTRON_ALLOW_DESTRUCTIVE_CDP);

  const modeFromInputs = normalizeMode(overrides.mode) || envMode;
  const mode = modeFromInputs
    ?? (overrides.cdpUrl || envCdpUrl || overrides.bridgeUrl || envBridgeUrl ? 'electron' : 'playwright');

  const iframeSelector = overrides.iframeSelector ?? envIframeSelector;
  const iframeType = normalizeEmbedType(overrides.iframeType) ?? envIframeType ?? (iframeSelector ? 'iframe' : undefined);
  const headlessTarget =
    normalizeHeadlessTarget(overrides.headlessTarget)
    ?? envHeadlessTarget
    ?? ((mode === 'headless' && (overrides.cdpUrl || envCdpUrl || overrides.bridgeUrl || envBridgeUrl)) ? 'electron' : 'playwright');

  return {
    mode,
    cdpUrl: overrides.cdpUrl ?? envCdpUrl,
    targetId: overrides.targetId ?? envTargetId,
    bridgeUrl: overrides.bridgeUrl ?? envBridgeUrl,
    iframeSelector,
    iframeType,
    headlessTarget,
    allowUnsafeEval: overrides.allowUnsafeEval ?? envAllowUnsafeEval ?? false,
    allowAllApis: overrides.allowAllApis ?? envAllowAllApis ?? false,
    allowDestructiveCdp: overrides.allowDestructiveCdp ?? envAllowDestructiveCdp ?? false
  };
}
