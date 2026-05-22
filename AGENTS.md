# AGENTS.md

Nebula is Starscape Orbit's local-first, Excalidraw-powered whiteboard shell and npm package.

## Architecture

- Drawing engine: `@excalidraw/excalidraw`, mounted by `src/nebula/NebulaExcalidrawShell.tsx`.
- App chrome: Starscape UI components plus Nebula CSS in `src/nebula/ui/NebulaShell.tsx` and `src/nebula/ui/NebulaShell.css`.
- Persistence: board/canvas-scoped local-first documents through `src/nebula/storage/localStorageSceneStore.ts`.
- Excalidraw interop and library behavior live under `src/nebula/excalidraw/`.
- Public API: `src/nebula/index.ts` must stay free of CSS side effects.
- Package styles: `src/nebula/style.ts` is the single style side-effect entry and builds to `@starlove/nebula/style.css`.

## Boundaries

- Keep the happy path local-first.
- Keep the Excalidraw canvas transparent so Nebula/Starscape backgrounds show through.
- If adding UI styles for package consumers, import them from `src/nebula/style.ts`; do not add CSS imports to exported API/component modules that generate `.d.ts` files.
- Prefer scoped Excalidraw skinning selectors. Avoid broad `label`, `button`, or global resets that affect host apps.

## Verification

- `pnpm run verify`
- `pnpm run build:lib`
- `npm_config_cache=/private/tmp/nebula-npm-cache npm pack --dry-run` if the user npm cache has permissions issues.

<!-- ORBIT:AGENTS-START -->
Git is canonical for code. `SKILL-ORBIT.md` is canonical for Orbit/kanban/ticket/card workflow.

When work mentions Orbit, kanban, board, lane, ticket, card, epic, blocker, claim, AI Ready, implementation fields, planning state, project memory, or handoff: read `SKILL-ORBIT.md` first and follow it.
Use Orbit API/MCP tools for tickets/cards; do not edit .orbit/board.db directly.
<!-- ORBIT:AGENTS-END -->
