"""`browser` tool that attaches — over CDP — to the Chromium already running on
the agent's virtual desktop, so every action lands in the *same* window the user
watches live.

Why a subclass instead of the stock ``LocalChromiumBrowser``
------------------------------------------------------------
``LocalChromiumBrowser`` calls ``chromium.launch()``, which needs a Chromium
binary *and* an X server inside the agent container — neither of which the agent
image has (headless would defeat the whole "watch it live" purpose). The webtop
``agent-desktop`` container, on the other hand, already autostarts one long-lived
*visible* Chromium with CDP enabled. So we do what ``AgentCoreBrowser`` does for
Bedrock — subclass the stock ``Browser`` ABC and ``connect_over_cdp`` to that
existing browser. No local browser binary, no Xvfb, no launch.

Endpoint resolution
-------------------
Chromium binds remote debugging to loopback only and *ignores*
``--remote-debugging-address`` overrides, so the desktop container runs a tiny
TCP forwarder ``0.0.0.0:9223 -> 127.0.0.1:9222``. We connect to that forwarder.

Chromium's CDP HTTP endpoint validates the ``Host`` header: it accepts
``localhost`` and bare IPs but rejects arbitrary hostnames (e.g.
``agent-desktop``). Playwright derives the ``Host`` header from the endpoint URL,
so we resolve any non-loopback hostname to its IP before connecting.

Disconnect, don't close
-----------------------
For a CDP *connection*, Playwright's ``browser.close()`` only disconnects the
client — the desktop's Chromium process survives (empirically verified). So the
stock ``BrowserSession.close()`` path is safe and needs no override.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import socket
from urllib.parse import urlsplit, urlunsplit

from playwright.async_api import Browser as PlaywrightBrowser
from typing_extensions import override

from strands_tools.browser.browser import Browser

logger = logging.getLogger(__name__)

DEFAULT_CDP_URL = "http://localhost:9223"

# Hostnames that Chromium's CDP Host-header check accepts verbatim; anything else
# is resolved to an IP (which the check also accepts) before we connect.
_HOST_PASSTHROUGH = {"localhost", "127.0.0.1", "[::1]", "::1"}


def _resolve_endpoint(url: str) -> str:
    """Return ``url`` with its hostname replaced by an IP when necessary.

    ``localhost`` / loopback / already-an-IP hosts pass through unchanged.
    Any other hostname is resolved via DNS so Chromium's CDP ``Host`` header
    check (which rejects arbitrary hostnames) sees an accepted value.
    """
    parts = urlsplit(url)
    host = parts.hostname
    if not host or host in _HOST_PASSTHROUGH:
        return url

    # Already a literal IP address? Leave it alone.
    try:
        ipaddress.ip_address(host)
        return url
    except ValueError:
        pass

    try:
        resolved = socket.gethostbyname(host)
    except OSError as exc:
        logger.warning("could not resolve desktop CDP host '%s': %s", host, exc)
        return url

    netloc = resolved
    if parts.port:
        netloc = f"{resolved}:{parts.port}"
    logger.info("resolved desktop CDP host '%s' -> '%s'", host, resolved)
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


class DesktopCDPBrowser(Browser):
    """Attaches to the agent desktop's already-running Chromium over CDP.

    The endpoint defaults to ``http://localhost:9223`` and is overridable with
    the ``AGENT_DESKTOP_CDP_URL`` environment variable (e.g.
    ``http://agent-desktop:9223`` when the agent runs as a sibling container).
    """

    def __init__(self, cdp_url: str | None = None):
        super().__init__()
        self.cdp_url = cdp_url or os.getenv("AGENT_DESKTOP_CDP_URL", DEFAULT_CDP_URL)

    def start_platform(self) -> None:
        """No platform to launch — the desktop already runs Chromium."""
        pass

    def close_platform(self) -> None:
        """Nothing to tear down — the desktop owns the browser lifecycle."""
        pass

    async def create_browser_session(self) -> PlaywrightBrowser:
        """Connect over CDP to the desktop's running Chromium."""
        if not self._playwright:
            raise RuntimeError("Playwright not initialized")

        endpoint = _resolve_endpoint(self.cdp_url)
        logger.info("connecting to desktop browser over CDP: %s", endpoint)
        return await self._playwright.chromium.connect_over_cdp(endpoint_url=endpoint)

    @override
    async def _setup_session_from_browser(self, browser_or_context):
        """Reuse the desktop's live context/tab instead of creating fresh ones.

        A CDP connection to the running Chromium exposes its existing default
        context and open page(s). We drive the page the user is already looking
        at so actions are visible in the live desktop view. Only if the browser
        somehow has no context/page do we create them.
        """
        session_browser = browser_or_context

        if session_browser.contexts:
            session_context = session_browser.contexts[0]
        else:
            logger.warning("desktop CDP connection had no contexts; creating one")
            session_context = await session_browser.new_context(**self._default_context_options)

        if session_context.pages:
            session_page = session_context.pages[0]
        else:
            session_page = await session_context.new_page()

        return session_browser, session_context, session_page
