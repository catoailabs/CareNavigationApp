import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

interface ElectronApiEntry {
  name: string;
  description?: string;
  type?: string;
  methods?: Array<{ name: string; description?: string }>;
  properties?: Array<{ name: string; description?: string }>;
  staticMethods?: Array<{ name: string; description?: string }>;
  staticProperties?: Array<{ name: string; description?: string }>;
  instanceMethods?: Array<{ name: string; description?: string }>;
  instanceProperties?: Array<{ name: string; description?: string }>;
}

interface CdpDomain {
  domain: string;
  commands?: Array<{ name: string; description?: string }>;
  events?: Array<{ name: string; description?: string }>;
}

let electronApiCache: ElectronApiEntry[] | null = null;
let cdpBrowserCache: { domains: CdpDomain[] } | null = null;
let cdpJsCache: { domains: CdpDomain[] } | null = null;

function loadJson<T>(relativePath: string): T {
  const base = fileURLToPath(new URL('../..', import.meta.url));
  const fullPath = path.join(base, relativePath);
  const raw = fs.readFileSync(fullPath, 'utf-8');
  return JSON.parse(raw) as T;
}

export function getElectronApiData(): ElectronApiEntry[] {
  if (!electronApiCache) {
    electronApiCache = loadJson<ElectronApiEntry[]>('electron/data/electron-api.json');
  }
  return electronApiCache;
}

export function getCdpBrowserData(): { domains: CdpDomain[] } {
  if (!cdpBrowserCache) {
    cdpBrowserCache = loadJson<{ domains: CdpDomain[] }>('electron/data/cdp-browser-protocol.json');
  }
  return cdpBrowserCache;
}

export function getCdpJsData(): { domains: CdpDomain[] } {
  if (!cdpJsCache) {
    cdpJsCache = loadJson<{ domains: CdpDomain[] }>('electron/data/cdp-js-protocol.json');
  }
  return cdpJsCache;
}

export function searchElectronApi(query: string, limit = 10): Array<{ name: string; type?: string; description?: string }> {
  const q = query.toLowerCase();
  const results = getElectronApiData()
    .filter((entry) => entry.name.toLowerCase().includes(q) || entry.description?.toLowerCase().includes(q))
    .slice(0, limit)
    .map((entry) => ({ name: entry.name, type: entry.type, description: entry.description }));

  return results;
}

export function findElectronApiEntry(name: string): ElectronApiEntry | undefined {
  return getElectronApiData().find((entry) => entry.name === name);
}

export function searchCdp(query: string, limit = 10): Array<{ domain: string; name: string; kind: 'command' | 'event'; description?: string }> {
  const q = query.toLowerCase();
  const results: Array<{ domain: string; name: string; kind: 'command' | 'event'; description?: string }> = [];

  const addMatches = (domains: CdpDomain[]) => {
    for (const domain of domains) {
      for (const command of domain.commands ?? []) {
        const key = `${domain.domain}.${command.name}`.toLowerCase();
        if (key.includes(q) || command.description?.toLowerCase().includes(q)) {
          results.push({ domain: domain.domain, name: command.name, kind: 'command', description: command.description });
        }
      }
      for (const event of domain.events ?? []) {
        const key = `${domain.domain}.${event.name}`.toLowerCase();
        if (key.includes(q) || event.description?.toLowerCase().includes(q)) {
          results.push({ domain: domain.domain, name: event.name, kind: 'event', description: event.description });
        }
      }
    }
  };

  addMatches(getCdpBrowserData().domains);
  addMatches(getCdpJsData().domains);

  return results.slice(0, limit);
}

export function listCdpDomains(): string[] {
  const domains = new Set<string>();
  for (const domain of getCdpBrowserData().domains) {
    domains.add(domain.domain);
  }
  for (const domain of getCdpJsData().domains) {
    domains.add(domain.domain);
  }
  return Array.from(domains).sort();
}

export function getElectronApiIndex() {
  const modules = new Map<string, { methods: Set<string>; properties: Set<string> }>();
  const classes = new Map<string, {
    staticMethods: Set<string>;
    staticProperties: Set<string>;
    instanceMethods: Set<string>;
    instanceProperties: Set<string>;
  }>();

  for (const entry of getElectronApiData()) {
    if (entry.type === 'Module') {
      modules.set(entry.name, {
        methods: new Set((entry.methods ?? []).map((method) => method.name)),
        properties: new Set((entry.properties ?? []).map((prop) => prop.name))
      });
    }

    if (entry.type === 'Class') {
      classes.set(entry.name, {
        staticMethods: new Set((entry.staticMethods ?? []).map((method) => method.name)),
        staticProperties: new Set((entry.staticProperties ?? []).map((prop) => prop.name)),
        instanceMethods: new Set((entry.instanceMethods ?? []).map((method) => method.name)),
        instanceProperties: new Set((entry.instanceProperties ?? []).map((prop) => prop.name))
      });
    }
  }

  return { modules, classes };
}
