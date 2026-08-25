# Single-image Auto Edit in the Develop view

## Context
Batch Auto-Edit (CULL tab) edits every filtered photo. In the EDIT (Develop) view a photo can be Reverted, but there is no way to re-run Auto Edit on just that photo. Add a one-click "✨ Auto Edit" in the top-right badge spot (where "AI · scene" + Revert appear once edited), using the saved AI Profile with no dialog. **User approved:** top-bar placement, no-dialog config.

## Approach
The Python `auto_edit` command already accepts `photo_ids: [id]` — reuse it. Only missing piece: after the run, the frontend needs the new settings for that photo (batch flow reloads the whole project; we won't). Add a tiny `get_edit_settings` JSON-RPC command (catalog function already exists).

## Changes

### 1. Python — `python-backend/sidecar.py`
Add handler `get_edit_settings` (params: `photo_id`) → returns `catalog.get_edit_settings(photo_id)` (may be null). Register alongside `set_edit_settings`/`delete_edit_settings` (~line 335). `catalog.get_edit_settings` exists at `catalog.py:459`.

### 2. Frontend RPC — `src/lib/sidecar.ts`
- `export function getEditSettings(photoId: number): Promise<EditSettings | null>` calling `get_edit_settings`.
- Browser-mock branch: return the mock's stored settings or null (mirror existing mock `set_edit_settings` handling near `:366`).

### 3. `src/App.tsx`
New `handleAutoEditSingle(entry)` (next to `handleRevertEdit`, ~line 146):
1. `const profile = await getAiProfile()` (`sidecar.ts:1023`); `const status = await personalModelStatus()` (`sidecar.ts:982`).
2. `await autoEdit({ projectId, photoIds: [entry.id], scenePresets: profile.config.scenePresets, normalizeExposure: profile.config.normalizeExposure, skipEdited: false, usePersonalModel: status.usable && profile.config.usePersonalModel })` — match param shape used in `AutoEditDialog.tsx:56-95` (read it during implementation for the exact config fields/merge with preset overrides).
3. `const settings = await getEditSettings(entry.id)`; if non-null, set `editSettingsMap[entry.path] = settings`, seed undo history the same way `persistEditSettings`/history seeding does (~`App.tsx:224`), and clear any pending debounce timer for that path (same cleanup as `handleRevertEdit:154-157`).
4. Errors: surface via existing error pattern (console + no state change); keep button re-enabled.
Pass `onAutoEditSingle` down to `EditTab`.

### 4. `src/components/edit/EditTab.tsx` (~line 309)
In the badge block: when `!currentSettings.aiEdited` and prop present, render a "✨ Auto Edit" pill in the same `absolute top-4 right-4` spot (violet, same styling family as the AI badge). While running show "Auto-editing…" with disabled state (local `busy` flag). When `aiEdited`, existing badge + Revert render unchanged.

## Not changing
- Batch dialog, revert flow, XMP export, catalog schema — untouched.
- No new dialog; profile defaults must already exist (`getAiProfile` returns defaults if never saved — verify; if it can fail, fall back to default `AiProfileConfig`).

## Verification (Tier 1)
- `npm run build` (tsc) clean.
- Live: `npm run tauri dev` → open a project → open an unedited/reverted photo in EDIT → click Auto Edit → badge flips to "AI · <scene>", sliders show computed values, Revert works again; check the button also works after a Revert on the same photo. Browser mock: `npm run dev`, same flow with fake data.
