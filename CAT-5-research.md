# CAT-5 Research: Rotate + cap `agent_server.log`

## Current State

- `agent.py:4` imports `logging` but NOT `logging.handlers`
- `agent.py:45` creates `logger = logging.getLogger(__name__)` with NO handlers attached
- `agent.py:13` defines `_PROJECT_ROOT = Path(__file__).resolve().parent`
- No `RotatingFileHandler`, no `FileHandler`, no `basicConfig()` anywhere in the codebase
- `agent_server.log` exists at project root (0 bytes) — no code currently writes to it
- `logs/` directory does NOT exist
- `.gitignore` already covers `logs` and `*.log`
- `CLAUDE.md:118` warns about unbounded log but the rotation was never implemented

## Fix — Minimal Changes

### 1. `agent.py` — Add import + configure function

**Add after line 4 (`import logging`):**
```python
import logging.handlers
```

**Insert between line 45 (`logger = ...`) and line 47 (`PROJECT_ROOT = ...`):**
```python
def _configure_file_logging() -> None:
    log_file = Path(os.getenv("LOG_FILE", str(_PROJECT_ROOT / "logs" / "agent_server.log")))
    log_file.parent.mkdir(parents=True, exist_ok=True)
    max_bytes = int(os.getenv("LOG_MAX_BYTES", str(50 * 1024 * 1024)))
    backup_count = int(os.getenv("LOG_BACKUP_COUNT", "5"))
    handler = logging.handlers.RotatingFileHandler(
        filename=str(log_file),
        maxBytes=max_bytes,
        backupCount=backup_count,
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

_configure_file_logging()
```

### 2. `tests/test_agent.py` — Add handler test

**Add `import logging.handlers` to imports (after line 3).**

**Add new test class before the `if __name__` block (before line 338):**
```python
class RotatingFileHandlerTests(unittest.TestCase):
    def test_logger_has_rotating_file_handler(self) -> None:
        handlers = [
            h for h in agent.logger.handlers
            if isinstance(h, logging.handlers.RotatingFileHandler)
        ]
        self.assertEqual(len(handlers), 1)
        self.assertEqual(handlers[0].maxBytes, 50 * 1024 * 1024)
        self.assertEqual(handlers[0].backupCount, 5)
```

### 3. `CLAUDE.md` — Update gotcha + add env vars to prerequisites

**Replace line 118** with updated text documenting the rotation is now in place.

**Add LOG_FILE, LOG_MAX_BYTES, LOG_BACKUP_COUNT to the Dev environment prerequisites section.**

## Types Validation

- `logging.handlers.RotatingFileHandler` — stdlib, no deps
- `maxBytes: int` — `50 * 1024 * 1024 = 52428800`
- `backupCount: int` — `5`
- `filename: str` — passed as `str(log_file)` from `Path`
- `Path.mkdir(parents=True, exist_ok=True)` — idempotent
- `os.getenv()` returns `str | None`, default handles the `None` case
- `int()` on string env var — correct usage

## What NOT to do

- Do NOT add structured logging (that's CAT-13)
- Do NOT change the `build_agent` function or its test contract
- Do NOT remove the existing `logger = logging.getLogger(__name__)` line
- Do NOT touch `server/agent_tooling.py`
