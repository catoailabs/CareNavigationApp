import { useState, useEffect } from 'react';
import { WebPreview, WebPreviewNavigation, WebPreviewUrl, WebPreviewBody } from '@/components/ai-elements/web-preview';
import type { ChromeTab } from '@/services/tabService';

export const CDPBrowserViewer = () => {
  const [cdpUrl, setCdpUrl] = useState<string | null>(null);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let isCancelled = false;
    
    const fetchTabs = async () => {
      try {
        const res = await fetch('/api/chrome-tabs');
        if (res.ok) {
          const tabs: ChromeTab[] = await res.json();
          const pageTab = tabs.find(t => t.type === 'page' && t.devtoolsFrontendUrl);
          if (pageTab && pageTab.devtoolsFrontendUrl) {
            // Found the tab, construct the direct devtools URL
            const fullUrl = `http://localhost:9222${pageTab.devtoolsFrontendUrl}`;
            setCdpUrl(fullUrl);
            return;
          }
        }
      } catch {
        // Ignore fetch errors while agent starts up
      }

      if (!isCancelled) {
        timeoutId = setTimeout(() => {
          void fetchTabs();
        }, 1000);
      }
    };

    void fetchTabs();

    return () => {
      isCancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  return (
    <WebPreview defaultUrl={cdpUrl || "Connecting to CDP..."}>
      <WebPreviewNavigation><WebPreviewUrl /></WebPreviewNavigation>
      {cdpUrl ? (
        <WebPreviewBody src={cdpUrl} />
      ) : (
        <div className="flex items-center justify-center h-full text-muted-foreground font-mono text-sm border-t bg-muted/20">
          <div className="flex flex-col items-center gap-2">
            <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
            <span>Resolving active browser tab...</span>
          </div>
        </div>
      )}
    </WebPreview>
  );
};
