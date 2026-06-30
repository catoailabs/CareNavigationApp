"""strands-google - Google API integration for Strands Agents.

This package provides comprehensive access to 200+ Google APIs including
Gmail, Drive, Calendar, YouTube, and more.

Main exports:
- use_google: Universal Google API access tool
- gmail_send: Easy email sending
- gmail_reply: Reply to emails

Note: the universal ``use_google`` tool and the gmail helpers physically live
under ``strands_tools.devops`` / ``strands_tools.omni_channel_comms``. They are
re-exported here for backwards compatibility. The desktop-only ``google_auth``
(InstalledAppFlow.run_local_server) is intentionally NOT exported because it is
not usable in a web/server context.
"""

from strands_tools.devops.use_google import use_google
from strands_tools.omni_channel_comms.gmail_helpers import gmail_send, gmail_reply

__version__ = "0.1.0"

__all__ = [
    "use_google",
    "gmail_send",
    "gmail_reply",
]
