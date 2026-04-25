const RESTRICTED_PROTOCOLS = [
  'about:',
  'chrome-extension:',
  'chrome:',
  'chrome-search:',
  'devtools:',
  'edge:',
  'view-source:',
];

function getTabUrl(tab) {
  return tab.pendingUrl || tab.url || '';
}

function isRestrictedUrl(url) {
  if (!url) {
    return true;
  }

  return RESTRICTED_PROTOCOLS.some((protocol) => url.startsWith(protocol));
}

function toTabSummary(tab) {
  const url = getTabUrl(tab);
  const restricted = isRestrictedUrl(url);

  return {
    description: url,
    favicon: tab.favIconUrl,
    id: String(tab.id),
    meta: tab.active ? 'Active' : restricted ? 'Restricted' : undefined,
    name: tab.title || url || 'New Tab',
    title: tab.title,
    type: 'tab',
    url,
  };
}

function extractPageContext() {
  const canonical = document.querySelector('link[rel="canonical"]')?.href || undefined;
  const referrer = document.referrer || undefined;
  const metaDescription =
    document.querySelector('meta[name="description"]')?.getAttribute('content') || undefined;
  const links = Array.from(
    new Set(
      Array.from(document.querySelectorAll('a[href]'))
        .map((anchor) => anchor.href)
        .filter(Boolean),
    ),
  );

  return {
    description: metaDescription,
    navigationInfo: {
      canonical,
      links,
      referrer,
    },
    pageContent: (document.documentElement?.innerText || document.body?.innerText || '').trim(),
  };
}

async function readTabContext(tab) {
  const summary = toTabSummary(tab);

  if (!tab.id || !summary.url || isRestrictedUrl(summary.url)) {
    return summary;
  }

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      func: extractPageContext,
      target: { tabId: tab.id },
    });

    return {
      ...summary,
      description: result?.description || summary.description,
      navigationInfo: result?.navigationInfo,
      pageContent: result?.pageContent,
    };
  } catch (error) {
    return {
      ...summary,
      meta: summary.meta || 'Restricted',
    };
  }
}

async function getTabsWithContext() {
  const tabs = await chrome.tabs.query({});
  const normalTabs = tabs.filter((tab) => tab.id && (tab.title || tab.url || tab.pendingUrl));
  const results = await Promise.all(normalTabs.map((tab) => readTabContext(tab)));

  return results.sort((left, right) => {
    const leftActive = left.meta === 'Active' ? 1 : 0;
    const rightActive = right.meta === 'Active' ? 1 : 0;
    return rightActive - leftActive;
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      if (message?.type === 'PING') {
        sendResponse({ ok: true, payload: { version: 1 } });
        return;
      }

      if (message?.type === 'GET_TABS') {
        const tabs = await getTabsWithContext();
        sendResponse({ ok: true, payload: tabs });
        return;
      }

      sendResponse({ error: 'Unsupported bridge message.', ok: false });
    } catch (error) {
      sendResponse({
        error: error instanceof Error ? error.message : 'Unknown bridge failure.',
        ok: false,
      });
    }
  })();

  return true;
});
