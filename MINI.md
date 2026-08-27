# MINI.md

This file provides guidance to MiniCode when working with code in this repository.

## Detected stack
- Languages: TypeScript.
- Frameworks: none detected from the supported starter markers.

## Verification
- Run the JS/TS checks from `package.json` before shipping changes (`npm test`, `npm run lint`, `npm run build`).

## Repository shape
- `src/` contains source files that should stay consistent with generated guidance and tests.

## Working agreement
- Prefer small, reviewable changes and keep generated bootstrap files aligned with actual repo workflows.
- Keep shared defaults in `~/.mini-code/settings.json`; reserve `.mini-code/settings.local.json` for project-local overrides.
- Do not overwrite existing `MINI.md` content automatically; update it intentionally when repo workflows change.
