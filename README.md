# Nesti
### Simple notes. Powerful structure.

Nesti is a local-first Notepad × Notion-inspired knowledge app. This first build prioritizes the core experience from the supplied specification: fast local notes, unlimited hierarchy, rich editing, autosave, search, keyboard workflow, themes, and local revisions.

## Stack
- React + TypeScript + Vite
- IndexedDB via Dexie (one record per note; no single JSON blob)
- Tiptap for contentEditable rich text
- Local revision snapshots
- Minimal dependency footprint

## Run
```bash
npm install
npm run dev
```
Then open the Vite URL.

## Current implementation
- Per-note IndexedDB persistence
- Unlimited nested notes
- Drag/drop sidebar reparenting foundation
- Tiptap rich text editor
- Autosave on edit
- Revision snapshot before content changes
- Fast substring search over title/content/tags
- Command palette (Ctrl/Cmd+K)
- New note (Ctrl/Cmd+N)
- Light/dark theme toggle
- Archive flag and archive action
- Favorites/pinned data fields
- Markdown-compatible editor primitives via HTML/structured content

## Next hardening pass
1. Implement a dedicated Archive view + restore.
2. Replace the current drop callback with explicit `onReparent(draggedId,targetId)` and add cycle prevention.
3. Add true fuzzy search scoring/indexing.
4. Add Markdown import/export and JSON backup/restore.
5. Add slash-command menu.
6. Add backlinks and `[[Note]]` relation indexing.
7. Add revision history UI.
8. Add attachment/image storage.
