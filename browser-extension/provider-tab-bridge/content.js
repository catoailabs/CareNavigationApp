const PAGE_SOURCE = 'provider-tab-bridge-page';
const EXTENSION_SOURCE = 'provider-tab-bridge-extension';

window.addEventListener('message', (event) => {
  if (event.source !== window) {
    return;
  }

  const message = event.data;

  if (!message || message.source !== PAGE_SOURCE || typeof message.requestId !== 'string') {
    return;
  }

  chrome.runtime.sendMessage({ type: message.type }, (response) => {
    const runtimeError = chrome.runtime.lastError;

    window.postMessage(
      {
        error: runtimeError?.message || response?.error,
        ok: !runtimeError && Boolean(response?.ok),
        payload: response?.payload,
        requestId: message.requestId,
        source: EXTENSION_SOURCE,
      },
      window.location.origin,
    );
  });
});
