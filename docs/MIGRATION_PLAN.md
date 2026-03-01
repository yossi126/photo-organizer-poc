# UI Framework Migration Plan — Photo Organizer

## Context

The current CustomTkinter GUI hits a hard performance wall at ~80 photos. The root cause is Tkinter itself: its geometry manager processes widget show/hide calls synchronously on the main thread, and `CTkScrollableFrame` triggers full canvas recalculations on every filter switch. These are fundamental Tkinter limitations — no amount of batching or caching can fix them. The goal is to move beyond POC to a production-quality app.

---

## Recommendation: **Tauri + React + TypeScript**

### Why Tauri + React

| Concern | Tauri + React | Electron + React | Qt (PySide6) | Web app (FastAPI) |
|---|---|---|---|---|
| **Photo grid perf (1000+ thumbs)** | Excellent — virtual scrolling via `react-virtuoso`, only ~20 DOM nodes at a time | Same (Chromium) | Good — `QListView` with model | Same (browser) |
| **Memory / bundle size** | ~5 MB (OS WebView) | ~150 MB (ships Chromium) | ~80 MB (Qt runtime) | N/A |
| **Python backend reuse** | 100% — sidecar process, JSON over stdin/stdout | Same | Native but heavy Qt bindings | API server |
| **Native feel** | Native file dialogs, tray, drag & drop, shortcuts | Good but heavier | Excellent | Poor |
| **Dev speed** | Fast — React + shadcn/ui + Tailwind | Same | Slower — verbose Python layouts | Fast |
| **Distribution** | Single `.msi` via `tauri build` | ~150 MB `.exe` | PyInstaller ~100 MB | Not distributable |

### Why NOT the others

- **Electron**: Same rendering as Tauri, but 30x larger bundle. No advantage.
- **PySide6 (Qt)**: Solves perf, but verbose bindings, limited styling, dated look without heavy theming.
- **Web app (FastAPI + React)**: Great UI, but no desktop-native feel, no file dialogs, user must manage a server.
- **Flutter desktop**: New language (Dart), weaker image ecosystem, still maturing on desktop.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│                 Tauri Shell                   │
│  (Rust — thin wrapper, window management)    │
├──────────────────────────────────────────────┤
│           React + TypeScript UI              │
│  ┌──────────┬──────────┬──────────┐          │
│  │  IMPORT  │   CULL   │   EDIT   │          │
│  │   tab    │   tab    │   tab    │          │
│  └──────────┴──────────┴──────────┘          │
│  • Virtual grid (react-virtuoso)             │
│  • Tailwind CSS + shadcn/ui components       │
│  • Native-quality dark theme                 │
├──────────────────────────────────────────────┤
│          Tauri Sidecar (Python)              │
│  ┌──────────────────────────────────┐        │
│  │  organizer.py  +  detectors.py   │        │
│  │  (unchanged Python backend)      │        │
│  │  JSON-RPC over stdin/stdout      │        │
│  └──────────────────────────────────┘        │
└──────────────────────────────────────────────┘
```

### How the Python backend stays intact

Tauri's **sidecar** feature bundles a Python executable (via PyInstaller) alongside the app. The React frontend sends JSON commands to the Python process, which runs `scan_and_classify()` and `analyze_photo()` exactly as today. No Python code needs rewriting — just a thin JSON-RPC wrapper (~50 lines) around the existing functions.

### What solves the performance problem

- **`react-virtuoso`** renders only ~20 visible thumbnails — DOM nodes created/destroyed on scroll
- Filter switching is instant — just update the data array
- Thumbnail loading uses `<img>` with lazy loading — browser handles caching natively
- No canvas recalculation, no grid geometry manager, no widget trees

---

## Target Folder Structure

```
photo-organizer/
├── docs/                          # Documentation
│   ├── CHANGELOG.md
│   ├── PLAN.md
│   └── MIGRATION_PLAN.md          # This file
│
├── python-backend/                # Python sidecar (detection engine)
│   ├── organizer.py               # Scan loop (unchanged)
│   ├── detectors.py               # Detection functions (unchanged)
│   ├── sidecar.py                 # NEW — JSON-RPC wrapper for Tauri
│   ├── requirements.txt           # Python dependencies
│   └── build/                     # PyInstaller output
│       └── sidecar.exe
│
├── src/                           # React + TypeScript frontend
│   ├── main.tsx                   # React entry point
│   ├── App.tsx                    # Root component + routing
│   ├── types/
│   │   └── photo.ts               # PhotoEntry, PhotoReport, etc.
│   ├── hooks/
│   │   ├── useSidecar.ts          # Sidecar communication hook
│   │   ├── useScan.ts             # Scan progress & state
│   │   └── useThumbnails.ts       # Thumbnail loading & caching
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx
│   │   │   ├── TabBar.tsx
│   │   │   └── StatusBar.tsx
│   │   ├── home/
│   │   │   └── HomeScreen.tsx     # Folder picker + new/resume
│   │   ├── import/
│   │   │   ├── ImportTab.tsx       # Scan settings + progress
│   │   │   ├── ThresholdSlider.tsx
│   │   │   └── ActivityLog.tsx
│   │   ├── cull/
│   │   │   ├── CullTab.tsx         # Main grid view
│   │   │   ├── PhotoGrid.tsx       # Virtual thumbnail grid
│   │   │   ├── PhotoCell.tsx       # Single thumbnail card
│   │   │   ├── CategoryFilter.tsx
│   │   │   └── StarFilter.tsx
│   │   └── edit/
│   │       ├── EditTab.tsx         # Full photo editor view
│   │       ├── PhotoPreview.tsx
│   │       ├── ScoresPanel.tsx
│   │       └── RatingStars.tsx
│   └── lib/
│       ├── sidecar.ts             # Sidecar spawn + JSON-RPC protocol
│       └── constants.ts           # Categories, colors, thresholds
│
├── src-tauri/                     # Tauri (Rust) configuration
│   ├── Cargo.toml
│   ├── tauri.conf.json            # Window size, sidecar config, permissions
│   ├── src/
│   │   └── main.rs                # Tauri entry (minimal boilerplate)
│   └── binaries/                  # Bundled sidecar executables
│       └── sidecar-x86_64-pc-windows-msvc.exe
│
├── e2e/                           # Playwright end-to-end tests
│   ├── playwright.config.ts
│   ├── fixtures/
│   │   └── test-photos/           # Small set of test images
│   └── tests/
│       ├── home.spec.ts
│       ├── import.spec.ts
│       ├── cull-grid.spec.ts
│       ├── cull-filters.spec.ts
│       ├── edit.spec.ts
│       └── performance.spec.ts
│
├── legacy/                        # Old CustomTkinter code (archived)
│   ├── gui.py
│   └── main.py
│
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── vite.config.ts
├── CLAUDE.md
└── README.md
```

---

## Migration Phases

### Phase 1: Project Scaffold

**Work:**
- Run `npm create tauri-app` with React + TypeScript + Vite template
- Install Tailwind CSS + shadcn/ui + react-virtuoso
- Configure `tauri.conf.json` (window size 1200x800, title, sidecar path)
- Move existing Python files into `python-backend/`
- Move old GUI code into `legacy/`
- Set up `e2e/` folder with Playwright config

**Testing — Playwright:**
```typescript
// e2e/tests/home.spec.ts
test('app launches and shows home screen', async ({ page }) => {
  // Tauri app opens via webdriver
  await expect(page.getByText('Photo Organizer')).toBeVisible();
  await expect(page.getByRole('button', { name: /browse/i })).toBeVisible();
});
```

**Manual verification:**
- `npm run tauri dev` opens a native window with the React placeholder page
- No errors in console

---

### Phase 2: Python Sidecar

**Work:**
- Create `python-backend/sidecar.py` — JSON-RPC wrapper:
  - Reads `{"method": "scan", "params": {...}}` from stdin
  - Calls `scan_and_classify()` / `clear_classifications()`
  - Streams progress events as `{"event": "progress", "data": {...}}`
  - Writes JSON results to stdout
- Add `thumbnail` command: given a path + size, returns base64 JPEG thumbnail
- Create PyInstaller spec to bundle as `sidecar.exe`
- Configure Tauri sidecar in `tauri.conf.json`

**Testing — Playwright:**
```typescript
// e2e/tests/import.spec.ts
test('sidecar responds to scan command', async ({ page }) => {
  // Trigger scan via UI button
  await page.getByRole('button', { name: /start scan/i }).click();
  // Verify progress events arrive
  await expect(page.getByText(/Scanning for duplicates/)).toBeVisible({ timeout: 10000 });
});
```

**Manual verification:**
- Run sidecar standalone: `echo '{"method":"scan","params":{"path":"test-photos"}}' | python sidecar.py`
- Verify JSON output matches expected format
- Run from Tauri dev mode — sidecar spawns and responds

---

### Phase 3: Home Screen + Import Tab

**Work:**
- Build `HomeScreen.tsx` — folder picker via `@tauri-apps/plugin-dialog`, new scan / resume buttons
- Build `ImportTab.tsx` — 4 threshold sliders, dry run toggle, start scan button
- Build `ActivityLog.tsx` — scrollable log fed by sidecar progress events
- Wire progress bar to sidecar stream

**Testing — Playwright:**
```typescript
// e2e/tests/home.spec.ts
test('folder picker opens and selects folder', async ({ page }) => {
  await page.getByRole('button', { name: /browse/i }).click();
  // Mock dialog returns test-photos path
  await expect(page.getByRole('textbox')).toHaveValue(/test-photos/);
});

test('scan runs and shows progress', async ({ page }) => {
  // Select folder, click start scan
  await page.getByRole('button', { name: /start scan/i }).click();
  await expect(page.getByRole('progressbar')).toBeVisible();
  await expect(page.getByText(/Done/)).toBeVisible({ timeout: 30000 });
});
```

---

### Phase 4: Cull Tab — Virtual Thumbnail Grid

**Work:**
- Build `PhotoGrid.tsx` using `react-virtuoso` `VirtuosoGrid`
- Build `PhotoCell.tsx` — thumbnail image, filename, star rating badge, category color
- Build `CategoryFilter.tsx` — 7 buttons with live count badges
- Build `StarFilter.tsx` — 6 rating filter buttons
- Thumbnail loading via Tauri `asset:` protocol or sidecar base64
- Double-click cell → navigate to Edit tab

**Testing — Playwright:**
```typescript
// e2e/tests/cull-grid.spec.ts
test('thumbnail grid renders with virtual scrolling', async ({ page }) => {
  // Load folder with 200+ photos
  const cells = page.locator('[data-testid="photo-cell"]');
  // Only ~20 cells should be in DOM despite 200+ photos
  await expect(cells).toHaveCount({ atMost: 30 });
});

// e2e/tests/cull-filters.spec.ts
test('category filter switches instantly', async ({ page }) => {
  const blurryButton = page.getByRole('button', { name: /blurry/i });
  const start = Date.now();
  await blurryButton.click();
  await expect(page.locator('[data-testid="photo-cell"]').first()).toBeVisible();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(200); // Must be under 200ms
});

// e2e/tests/performance.spec.ts
test('grid scrolls smoothly with 500+ photos', async ({ page }) => {
  // Scroll to bottom, verify no frame drops / janky behavior
  await page.evaluate(() => {
    document.querySelector('[data-testid="photo-grid"]')?.scrollTo(0, 99999);
  });
  await expect(page.locator('[data-testid="photo-cell"]').first()).toBeVisible();
});
```

---

### Phase 5: Edit Tab

**Work:**
- Build `EditTab.tsx` — large photo preview, left/right navigation
- Build `ScoresPanel.tsx` — brightness, blur, EAR scores with labels
- Build `RatingStars.tsx` — clickable 5-star rating, persists to `_ratings.json`
- Reclassify buttons (6 categories)
- Keyboard shortcuts: Left/Right arrows, Escape to return to Cull

**Testing — Playwright:**
```typescript
// e2e/tests/edit.spec.ts
test('edit view shows photo details and allows reclassify', async ({ page }) => {
  // Double-click a thumbnail in cull grid
  await page.locator('[data-testid="photo-cell"]').first().dblclick();
  await expect(page.getByText(/Brightness/)).toBeVisible();
  await expect(page.getByText(/Blur/)).toBeVisible();

  // Reclassify
  await page.getByRole('button', { name: /clean/i }).click();
  // Verify category updated
});

test('keyboard navigation works', async ({ page }) => {
  await page.keyboard.press('ArrowRight');
  // Verify next photo loaded
  await page.keyboard.press('Escape');
  // Verify back on cull grid
});
```

---

### Phase 6: Polish & Distribution

**Work:**
- Dark theme via Tailwind (`dark:` classes, consistent color palette)
- Right-click context menus on grid cells
- Drag & drop folder onto home screen
- Smooth transitions between tabs/views
- Package as `.msi` installer via `npm run tauri build`

**Testing — Playwright:**
```typescript
test('dark theme renders correctly', async ({ page }) => {
  // Visual regression: screenshot comparison
  await expect(page).toHaveScreenshot('cull-dark-theme.png', { maxDiffPixels: 100 });
});

test('full workflow: scan → filter → edit → rate', async ({ page }) => {
  // End-to-end happy path
  await page.getByRole('button', { name: /browse/i }).click();
  // ... select folder, scan, switch filter, open edit, rate, verify persistence
});
```

**Manual verification:**
- `npm run tauri build` produces `.msi` in `src-tauri/target/release/bundle/`
- Install on clean Windows machine — app launches, sidecar works
- Test with 500+ photo folder — grid scrolls smoothly, filters are instant

---

## Key Files — Migration Impact

| Current file | What happens |
|---|---|
| `organizer.py` | **Moved** to `python-backend/` — no code changes |
| `detectors.py` | **Moved** to `python-backend/` — no code changes |
| `gui.py` (1517 lines) | **Archived** to `legacy/` — replaced by React components |
| `main.py` | **Archived** to `legacy/` — replaced by Tauri entry |
| `requirements.txt` | **Moved** to `python-backend/` — kept for sidecar bundling |

## Prerequisites

- Node.js 18+
- Rust toolchain (for Tauri)
- Python 3.11+ with existing venv (for sidecar development)
- Playwright (`npm init playwright@latest`)
