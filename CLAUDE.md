# Photo Organizer

A desktop application that scans a folder of photos, detects problematic images (blurry, dark, overexposed, duplicates, eyes closed), and lets you review, rate, and reclassify them in a fast virtual-scrolling grid.

Built with **Tauri v2** (Rust shell) + **React + TypeScript** frontend + **Python sidecar** backend.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│                 Tauri Shell                   │
│  (Rust — window management, native APIs)     │
├──────────────────────────────────────────────┤
│           React + TypeScript UI              │
│  ┌──────────┬──────────┬──────────┐          │
│  │  IMPORT  │   CULL   │   EDIT   │          │
│  │   tab    │   tab    │   tab    │          │
│  └──────────┴──────────┴──────────┘          │
│  • Virtual grid (react-virtuoso)             │
│  • Tailwind CSS v4                           │
├──────────────────────────────────────────────┤
│          Tauri Sidecar (Python)              │
│  ┌──────────────────────────────────┐        │
│  │  organizer.py  +  detectors.py   │        │
│  │  JSON-RPC over stdin/stdout      │        │
│  └──────────────────────────────────┘        │
└──────────────────────────────────────────────┘
```

The React frontend communicates with the Python backend via a **sidecar process** — Tauri spawns `python sidecar.py` and sends JSON commands over stdin/stdout. The Python code (detection engine) runs unchanged.

When running in a regular browser (e.g., `npm run dev` without Tauri), the app falls back to a **mock mode** with fake photo data — useful for UI development and Playwright testing.

---

## Project structure

```
photo-organizer-poc/
├── src/                           # React + TypeScript frontend
│   ├── main.tsx                   # React entry point
│   ├── App.tsx                    # Root component, screen routing, state
│   ├── index.css                  # Tailwind CSS import + base styles
│   ├── types/
│   │   └── photo.ts               # PhotoEntry, Category, ScanProgress, etc.
│   ├── hooks/
│   │   ├── useSidecar.ts          # Starts sidecar on mount
│   │   ├── useScan.ts             # Scan progress & state management
│   │   └── useThumbnails.ts       # Thumbnail loading & caching
│   ├── components/
│   │   ├── home/HomeScreen.tsx    # Folder picker + New Scan / Resume
│   │   ├── import/ImportTab.tsx   # Threshold sliders, progress bar, log
│   │   ├── cull/CullTab.tsx       # Virtual thumbnail grid (react-virtuoso)
│   │   ├── cull/PhotoCell.tsx     # Single thumbnail card
│   │   ├── edit/EditTab.tsx       # Full photo view, scores, reclassify
│   │   ├── edit/RatingStars.tsx   # Clickable 5-star rating
│   │   └── layout/               # Sidebar, TabBar, StatusBar
│   └── lib/
│       ├── sidecar.ts             # Sidecar spawn, JSON-RPC, browser mock
│       └── constants.ts           # Categories, colors, thresholds
│
├── src-tauri/                     # Tauri (Rust) configuration
│   ├── Cargo.toml                 # Rust dependencies
│   ├── tauri.conf.json            # App config (window, sidecar, bundle)
│   ├── capabilities/default.json  # Permissions (dialog, shell, fs)
│   └── src/
│       ├── main.rs                # Tauri entry point
│       └── lib.rs                 # get_sidecar_config command + plugins
│
├── python-backend/                # Python sidecar (detection engine)
│   ├── sidecar.py                 # JSON-RPC wrapper for Tauri
│   ├── organizer.py               # Scan loop and classification logic
│   ├── detectors.py               # Detection functions (blur, dark, etc.)
│   ├── requirements.txt           # Python dependencies
│   ├── face_detection_yunet.onnx  # YuNet face detection model
│   └── face_landmarker.task       # MediaPipe face landmarker model
│
├── legacy/                        # Archived old CustomTkinter GUI
├── docs/                          # Documentation + screenshots
│
├── venv/                          # Python virtual environment (NOT committed)
├── package.json                   # Node dependencies and scripts
├── tsconfig.json                  # TypeScript config
├── vite.config.ts                 # Vite + Tailwind config
├── index.html                     # HTML entry point
└── .gitignore
```

---

## Tech stack

### Frontend

| Library | Purpose |
|---|---|
| React 19 + TypeScript | UI framework |
| Tailwind CSS v4 | Styling (dark theme) |
| react-virtuoso | Virtual scrolling grid (renders only visible thumbnails) |
| Vite 7 | Dev server + bundler |
| @tauri-apps/plugin-dialog | Native file/folder picker |
| @tauri-apps/plugin-shell | Sidecar process management |
| @tauri-apps/plugin-fs | File system access |

### Backend (Python sidecar)

| Library | Purpose |
|---|---|
| opencv-contrib-python | Blur, darkness, face/eye detection |
| imagehash | Perceptual hashing for duplicate detection |
| Pillow | Image loading (handles non-ASCII paths) |
| mediapipe | Face landmark detection (EAR) |
| onnxruntime | YuNet face detection inference |
| rawpy | RAW photo format support |
| numpy | Array operations |

### Desktop shell

| Tool | Purpose |
|---|---|
| Tauri v2 | Native window, system tray, file dialogs, sidecar |
| Rust | Tauri's backend runtime (thin wrapper) |

---

## Detection methods

**Duplicates** — dHash via `imagehash`. Two images with Hamming distance <= 5 are duplicates. First file alphabetically is kept.

**Dark photos** — Grayscale mean intensity. Default threshold: `mean < 85` (out of 255).

**Blurry photos** — Variance of the Laplacian operator. Default threshold: `variance < 50`.

**Overexposed** — Grayscale mean intensity. Default threshold: `mean > 220`.

**Eyes closed** — Face detection (YuNet/Haar) + eye aspect ratio (EAR). If EAR < 0.18, eyes are flagged as closed.

All thresholds are adjustable via the Import tab sliders.

---

## Prerequisites — what to install

Before cloning and running this project, you need these tools installed on your machine.

### 1. Node.js (v18 or higher)

Download from https://nodejs.org/ (LTS recommended).

Verify:
```bash
node --version    # v18+ required
npm --version     # comes with Node.js
```

### 2. Rust toolchain

Install via rustup: https://rustup.rs/

On Windows, run the installer and follow the prompts. Choose the default installation.

**Important:** After installing, restart your terminal so `cargo` is on PATH.

Verify:
```bash
rustc --version   # 1.70+ required
cargo --version
```

### 3. C++ Build Tools (Windows only)

Tauri's Rust compilation requires MSVC (Microsoft Visual C++ Build Tools).

**Option A — via winget (recommended):**
```bash
winget install Microsoft.VisualStudio.2022.BuildTools
```
Then open **Visual Studio Installer**, click **Modify** on Build Tools 2022, and check:
- "Desktop development with C++" workload

**Option B — via Visual Studio Installer:**
Download from https://visualstudio.microsoft.com/visual-cpp-build-tools/ and select the "Desktop development with C++" workload.

### 4. Python (v3.11 or higher)

Download from https://www.python.org/downloads/

During installation, check "Add Python to PATH".

Verify:
```bash
python --version   # 3.11+ required
pip --version
```

### 5. WebView2 (Windows only)

Most Windows 10/11 machines already have this. If Tauri fails to launch with a WebView error, install it from:
https://developer.microsoft.com/en-us/microsoft-edge/webview2/

---

## First-time setup (after cloning)

Run all commands from the **project root** (where `package.json` is).

### Step 1 — Clone and enter the folder

```bash
git clone <your-repo-url>
cd photo-organizer-poc
```

### Step 2 — Install Node dependencies

```bash
npm install
```

### Step 3 — Create the Python virtual environment

The venv must be at the **project root** (not inside `python-backend/`). The Tauri Rust backend looks for `venv/Scripts/python.exe` at the project root.

```bash
python -m venv venv
```

### Step 4 — Activate the venv and install Python dependencies

**Windows (PowerShell):**
```powershell
.\venv\Scripts\Activate.ps1
```

**Windows (Command Prompt):**
```cmd
venv\Scripts\activate
```

**Windows (Git Bash / WSL):**
```bash
source venv/Scripts/activate
```

**macOS / Linux:**
```bash
source venv/bin/activate
```

Then install packages:
```bash
pip install -r python-backend/requirements.txt
```

You should see `(venv)` in your prompt.

### Step 5 — Run the app

```bash
npm run tauri dev
```

First run compiles all Rust crates (~2-3 minutes). Subsequent runs are fast (~10 seconds). This launches the native desktop window with the React UI and Python sidecar.

---

## How to run locally (daily workflow)

Every time you want to run the app after initial setup:

**PowerShell:**
```powershell
cd photo-organizer-poc
.\venv\Scripts\Activate.ps1
npm run tauri dev
```

**Command Prompt / Git Bash:**
```bash
cd photo-organizer-poc
venv\Scripts\activate        # or: source venv/Scripts/activate
npm run tauri dev
```

That's it. The app opens a native window. Select a photo folder, click New Scan.

### Browser-only mode (no Tauri, for UI development)

```bash
npm run dev
```

Then open `http://localhost:1420` in your browser. The app runs in **mock mode** — all sidecar calls return fake data. Useful for UI work and Playwright testing.

### Python backend standalone (for testing detection)

```bash
# Activate venv first, then:
python python-backend/detectors.py "C:\path\to\photo.jpg"
python python-backend/organizer.py "C:\path\to\folder"
```

---

## How to build a desktop installer (.exe / .msi)

**Run from the project root:**

```bash
npm run tauri build
```

Output is in `src-tauri/target/release/bundle/msi/` and `nsis/`.

**Important:** The installer does not include Python. For distribution, bundle the Python backend with PyInstaller:
```bash
cd python-backend
pip install pyinstaller
pyinstaller --onefile --name sidecar sidecar.py
```
Then copy `dist/sidecar.exe` to `src-tauri/binaries/sidecar-x86_64-pc-windows-msvc.exe` and update `tauri.conf.json`.

---

## npm scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start Vite dev server (browser-only, mock mode) |
| `npm run build` | Compile TypeScript + bundle React for production |
| `npm run preview` | Preview the production build locally |
| `npm run tauri dev` | Start full Tauri desktop app with hot reload |
| `npm run tauri build` | Build production installer (.msi / .exe) |

---

## Key files to know

| File | What it does |
|---|---|
| `src/App.tsx` | Root component — screen routing, global state, event handlers |
| `src/lib/sidecar.ts` | Sidecar communication — JSON-RPC protocol + browser mock mode |
| `src/components/cull/CullTab.tsx` | Virtual scrolling photo grid (main performance feature) |
| `src/components/edit/EditTab.tsx` | Full photo view with scores, rating, reclassify |
| `src/components/import/ImportTab.tsx` | Scan settings, threshold sliders, progress |
| `python-backend/sidecar.py` | JSON-RPC wrapper — bridges React to Python |
| `python-backend/organizer.py` | Scan loop, file classification logic |
| `python-backend/detectors.py` | All detection functions (blur, dark, duplicates, eyes) |
| `src-tauri/src/lib.rs` | Rust: get_sidecar_config command, plugin registration |
| `src-tauri/capabilities/default.json` | Tauri permissions (shell, dialog, fs access) |

---

## For Claude Code — automated project setup

If you are Claude Code and need to set up this project from scratch on a new machine, run these commands in order. All commands run from the project root.

### Prerequisites check

```bash
node --version    # must be v18+
cargo --version   # must be installed (Rust)
python --version  # must be v3.11+
```

If any are missing, see the Prerequisites section above.

### Full automated setup

```bash
# 1. Install Node dependencies
npm install

# 2. Create Python venv at project root (IMPORTANT: not inside python-backend/)
python -m venv venv

# 3. Activate and install Python packages
# On Windows PowerShell:
.\venv\Scripts\Activate.ps1
# On Windows cmd / Git Bash:
# venv\Scripts\activate  OR  source venv/Scripts/activate

pip install -r python-backend/requirements.txt

# 4. Verify everything works
npm run tauri dev
```

### Key technical notes for Claude

- The Python venv MUST be at the **project root** (`./venv/`), not inside `python-backend/`. The Rust `get_sidecar_config()` function in `src-tauri/src/lib.rs` searches for the venv at the project root first.
- The sidecar spawns `python sidecar.py` via Tauri's shell plugin. The Rust backend prepends the venv's Python directory to PATH so the correct interpreter is used.
- When running `npm run tauri dev`, Vite starts on port 1420 and the Rust shell opens a native window. The Python sidecar is spawned on-demand when the user triggers a scan.
- The Tauri shell scope in `src-tauri/capabilities/default.json` allows spawning `python` with any arguments via the `python-sidecar` scope name.
- `sidecar.py` uses line-buffered I/O (`buffering=1`) on both stdin and stdout to prevent pipe communication issues on Windows.
- If the `npm run tauri dev` fails with "cargo metadata not found", restart the terminal so `~/.cargo/bin` is on PATH.

---

## Known limitations

- **Python sidecar not auto-bundled** — the `.msi` build does not include Python. See the build section above.
- **HEIC files (iPhone)** — not supported by Pillow by default. Add `pillow-heif` to requirements if needed.
- **Non-ASCII paths** — handled via the PIL `_load()` wrapper in `detectors.py`. Do not use `cv2.imread()` directly.
- **Blur threshold is content-sensitive** — low-texture photos (solid backgrounds, night sky) may score low even if sharp.
- **Eyes-closed detection** — works best on front-facing, well-lit photos. Side profiles may produce false positives.
