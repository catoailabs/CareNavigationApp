# CAT-10: Add GitHub Actions CI — Implementation Notes

## Problem

No CI configuration existed. TypeScript typechecks, linting, Python tests, and submodule integrity were all manual-only validation steps.

## Research Findings

### GitHub Actions Versions (as of April 2026)

| Action | Version | Notes |
|--------|---------|-------|
| `actions/checkout` | `@v6` | v6.0.2 — latest stable |
| `actions/setup-node` | `@v6` | v6.3.0 — supports Node 25 |
| `actions/setup-python` | `@v6` | v6.2.0 — supports Python 3.14 GA |

- **Node 25** is a Current release (not LTS). Node 24 "Krypton" is the LTS line.
- **Python 3.14** reached GA on Oct 7, 2025. No `allow-prereleases` flag needed.
- **`fail-fast`** is a `strategy.matrix` property only. Independent top-level jobs already run concurrently without cancelling siblings on failure. No configuration needed.

### Requirements Strategy

Two files serve different purposes:
- `requirements.txt` — full `pip freeze` snapshot (150 packages). Documents the complete working environment.
- `requirements-ci.txt` — curated 26-package subset for fast CI installs. CI workflow references this file.

Platform-specific packages (`appscript`, `pyobjc-*`, `rubicon-objc`) were removed from `requirements.txt` since CI runs on ubuntu-latest.

## Changes Made

### `.github/workflows/ci.yml`

Rewrote the single `verify` job into 3 independent parallel jobs:

1. **`web`** — Node 25: `npm ci` → `tsc --noEmit` → `lint` → `build`. No submodules needed (only TS source in `src/`).
2. **`python`** — Python 3.14: venv → `pip install -r requirements-ci.txt` → `unittest discover`. Checks out submodules defensively (tool catalog scanner may walk `tools/`).
3. **`submodules`** — Recursive checkout → verify initialization status → assert count = 7 → verify non-empty directories.

Added `push: branches: [main]` trigger alongside `pull_request`.

### `requirements.txt`

Generated from `.venv/bin/pip freeze`. 7 macOS-only packages removed for CI compatibility on ubuntu-latest.

### CI Badge

Added `![CI](https://github.com/catoailabs/CareNavigationApp/actions/workflows/ci.yml/badge.svg)` to both `README.md` and `CLAUDE.md`.

## Verification

All existing checks pass locally:

```
npx tsc --noEmit -p tsconfig.app.json  # ✓ exit 0
npm run lint                            # ✓ 0 errors, 23 warnings (all react-refresh)
./.venv/bin/python -m unittest discover -s tests -v  # ✓ 10 tests OK
```

## Remaining Work

- Configure required status checks in GitHub repo settings once a remote is pushed (manual step, documented in issue)
- Replace `OWNER/REPO` badge placeholder once remote is configured
