"""
gui.py — CustomTkinter GUI for the Photo Organizer.

UI layout:
  Home screen — folder picker, detects existing projects
  Review screen — three tabs: IMPORT (scan) | CULL (grid) | EDIT (single photo)
"""

import concurrent.futures
import json
import os
import threading
import tkinter as tk
from dataclasses import dataclass, field
from tkinter import filedialog, messagebox
from typing import Optional

import customtkinter as ctk
from PIL import Image as PILImage, ImageOps

from organizer import (
    scan_and_classify,
    clear_classifications,
    SUBFOLDERS,
    IMAGE_EXTS,
    CLASSIFICATIONS_FILE,
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

RATINGS_FILE = "_ratings.json"

CATEGORY_LABELS = [
    ("all", "All Photos"),
    ("clean", "Clean"),
    ("_blurry", "Blurry"),
    ("_dark", "Dark"),
    ("_overexposed", "Overexposed"),
    ("_eyes_closed", "Eyes Closed"),
    ("_duplicates", "Duplicates"),
]

CATEGORY_COLORS = {
    "all": "#3b8ed0",
    "clean": "#2fa572",
    "_blurry": "#d97706",
    "_dark": "#6366f1",
    "_overexposed": "#ef4444",
    "_eyes_closed": "#ec4899",
    "_duplicates": "#8b5cf6",
}

STAR_FILLED = "\u2605"   # ★
STAR_EMPTY = "\u2606"    # ☆
STAR_COLOR = "#f5c518"


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class PhotoEntry:
    original_path: str
    current_path: str
    category: str
    all_labels: list = field(default_factory=list)
    scores: dict = field(default_factory=dict)
    star_rating: int = 0


class ReviewModel:

    def __init__(self, source_dir: str, classifications: dict):
        self.source_dir = source_dir
        self.entries: list[PhotoEntry] = []
        self._build_entries(classifications)
        self._load_ratings()

    def _build_entries(self, classifications: dict):
        for f in os.scandir(self.source_dir):
            if not f.is_file():
                continue
            ext = os.path.splitext(f.name)[1].lower()
            if ext not in IMAGE_EXTS:
                continue
            cl = classifications.get(f.name, {})
            category = cl.get("primary_category") or "clean"
            self.entries.append(PhotoEntry(
                original_path=f.path,
                current_path=f.path,
                category=category,
                all_labels=cl.get("all_labels", []),
                scores=cl.get("scores", {}),
            ))

    def _ratings_path(self) -> str:
        return os.path.join(self.source_dir, RATINGS_FILE)

    def _load_ratings(self):
        path = self._ratings_path()
        if not os.path.exists(path):
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            for entry in self.entries:
                basename = os.path.basename(entry.current_path)
                if basename in data:
                    entry.star_rating = data[basename]
        except Exception:
            pass

    def _save_ratings(self):
        data = {}
        for entry in self.entries:
            if entry.star_rating > 0:
                basename = os.path.basename(entry.current_path)
                data[basename] = entry.star_rating
        path = self._ratings_path()
        if data:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        elif os.path.exists(path):
            os.remove(path)

    def set_rating(self, entry: PhotoEntry, stars: int):
        entry.star_rating = stars
        self._save_ratings()

    def get_counts(self) -> dict:
        counts = {"all": len(self.entries), "clean": 0}
        for sf in SUBFOLDERS:
            counts[sf] = 0
        for e in self.entries:
            counts[e.category] = counts.get(e.category, 0) + 1
        return counts

    def get_filtered(self, category: str, min_stars: int = 0) -> list[PhotoEntry]:
        result = []
        for e in self.entries:
            if category != "all" and e.category != category:
                continue
            if e.star_rating < min_stars:
                continue
            result.append(e)
        return result

    def reclassify(self, entry: PhotoEntry, new_category: str):
        entry.category = new_category
        if new_category == "clean":
            entry.all_labels = []
        self.save_classifications()

    def save_classifications(self):
        data = {}
        for entry in self.entries:
            if entry.category != "clean":
                data[os.path.basename(entry.current_path)] = {
                    "primary_category": entry.category,
                    "all_labels": entry.all_labels if entry.all_labels else [entry.category],
                    "scores": entry.scores,
                }
        class_path = os.path.join(self.source_dir, CLASSIFICATIONS_FILE)
        if data:
            with open(class_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        elif os.path.exists(class_path):
            os.remove(class_path)


# ---------------------------------------------------------------------------
# Thumbnail loader — FIXED: separate queue-add from cancel
# ---------------------------------------------------------------------------

class ThumbnailLoader:
    THUMB_SIZE = (150, 150)

    def __init__(self, app_root: ctk.CTk):
        self._root = app_root
        self._cache: dict[str, ctk.CTkImage] = {}
        self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)
        self._pending: list[concurrent.futures.Future] = []
        self._generation = 0

    def load_entries(self, entries: list[PhotoEntry], callback):
        """Queue entries for thumbnail loading WITHOUT canceling in-flight loads."""
        gen = self._generation
        for entry in entries:
            if entry.current_path in self._cache:
                callback(entry, self._cache[entry.current_path])
            else:
                future = self._executor.submit(self._load_one, entry.current_path)
                future.add_done_callback(
                    lambda f, e=entry, g=gen: self._on_loaded(f, e, callback, g)
                )
                self._pending.append(future)

    def cancel_and_load(self, entries: list[PhotoEntry], callback):
        """Cancel all in-flight loads, then start a fresh batch."""
        self.cancel()
        self.load_entries(entries, callback)

    def load_single(self, path: str, size: tuple, callback):
        gen = self._generation
        future = self._executor.submit(self._load_at_size, path, size)
        future.add_done_callback(
            lambda f, g=gen: self._on_single_loaded(f, callback, g)
        )
        self._pending.append(future)

    def _load_one(self, path: str) -> PILImage.Image:
        pil_img = PILImage.open(path)
        pil_img = ImageOps.exif_transpose(pil_img)
        if pil_img.mode != "RGB":
            pil_img = pil_img.convert("RGB")
        pil_img.thumbnail(self.THUMB_SIZE, PILImage.BILINEAR)
        return pil_img

    def _load_at_size(self, path: str, size: tuple) -> PILImage.Image:
        pil_img = PILImage.open(path)
        pil_img = ImageOps.exif_transpose(pil_img)
        if pil_img.mode != "RGB":
            pil_img = pil_img.convert("RGB")
        pil_img.thumbnail(size, PILImage.BILINEAR)
        return pil_img

    def _on_loaded(self, future, entry: PhotoEntry, callback, gen: int):
        if future.cancelled() or gen != self._generation:
            return
        try:
            pil_img = future.result()
            ctk_img = ctk.CTkImage(
                light_image=pil_img, dark_image=pil_img,
                size=(pil_img.width, pil_img.height),
            )
            self._cache[entry.current_path] = ctk_img
            self._root.after(0, lambda: callback(entry, ctk_img))
        except Exception:
            pass

    def _on_single_loaded(self, future, callback, gen: int):
        if future.cancelled() or gen != self._generation:
            return
        try:
            pil_img = future.result()
            ctk_img = ctk.CTkImage(
                light_image=pil_img, dark_image=pil_img,
                size=(pil_img.width, pil_img.height),
            )
            self._root.after(0, lambda: callback(ctk_img))
        except Exception:
            pass

    def get_cached(self, path: str) -> Optional[ctk.CTkImage]:
        return self._cache.get(path)

    def invalidate(self, path: str):
        self._cache.pop(path, None)

    def cancel(self):
        self._generation += 1
        for f in self._pending:
            f.cancel()
        self._pending.clear()

    def shutdown(self):
        self.cancel()
        self._executor.shutdown(wait=False)


# ---------------------------------------------------------------------------
# Star rating widget helper
# ---------------------------------------------------------------------------

def create_star_row(parent, entry: PhotoEntry, model: ReviewModel,
                    on_change=None, size: int = 14):
    frame = ctk.CTkFrame(parent, fg_color="transparent", height=20)
    star_labels = []

    def _update_display():
        for i, lbl in enumerate(star_labels):
            if i < entry.star_rating:
                lbl.configure(text=STAR_FILLED, text_color=STAR_COLOR)
            else:
                lbl.configure(text=STAR_EMPTY, text_color="gray50")

    def _on_click(star_idx):
        if entry.star_rating == star_idx + 1:
            model.set_rating(entry, 0)
        else:
            model.set_rating(entry, star_idx + 1)
        _update_display()
        if on_change:
            on_change(entry)

    for i in range(5):
        lbl = ctk.CTkLabel(
            frame, text=STAR_EMPTY, width=size + 4,
            font=ctk.CTkFont(size=size), text_color="gray50",
            cursor="hand2",
        )
        lbl.pack(side="left", padx=0)
        lbl.bind("<Button-1>", lambda e, idx=i: _on_click(idx))
        star_labels.append(lbl)

    _update_display()
    return frame


# ---------------------------------------------------------------------------
# VirtualGrid — scrollable thumbnail grid with lazy thumbnail loading
# ---------------------------------------------------------------------------

class VirtualGrid(ctk.CTkFrame):
    """
    Thumbnail grid using CTkScrollableFrame with cell caching.

    Cells are created once per PhotoEntry and cached — filter switches just
    hide/show cells via grid_remove/grid instead of destroy+recreate.
    Thumbnails are loaded eagerly for all entries in the current filter
    so they're ready in the cache before the user scrolls to them.
    """

    CELL_W = 185
    CELL_H = 235
    BATCH_SIZE = 25  # cells to create per event-loop tick

    def __init__(self, parent, review_frame: "ReviewFrame"):
        super().__init__(parent, fg_color="gray10", corner_radius=0)
        self._review = review_frame
        self._visible_entries: list[PhotoEntry] = []
        # Cache: id(entry) → cell widget
        self._cell_cache: dict[int, ctk.CTkFrame] = {}
        # Cache: id(entry) → thumbnail label (for fast updates)
        self._img_label_cache: dict[int, ctk.CTkLabel] = {}
        # Paths already submitted to loader (avoid duplicates)
        self._thumb_requested: set[str] = set()
        self._columns = 4
        self._batch_id = 0  # incremented to cancel stale batch jobs

        self._scroll_frame = ctk.CTkScrollableFrame(
            self, fg_color="gray10", corner_radius=0,
        )
        self._scroll_frame.pack(fill="both", expand=True)

        self._inner_canvas = self._scroll_frame._parent_canvas

        self.bind("<Configure>", self._on_resize)

    def _on_resize(self, event):
        new_cols = max(1, event.width // (self.CELL_W + 12))
        if new_cols != self._columns:
            self._columns = new_cols
            self._relayout()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def set_entries(self, entries: list[PhotoEntry]):
        """Switch to a new filtered list. Cached cells appear instantly;
        new cells are created in small batches so the UI stays responsive.
        Thumbnails are requested eagerly for all entries so scrolling is smooth."""
        # Cancel any in-progress batch for a previous set_entries call
        self._batch_id += 1
        batch_id = self._batch_id

        # Hide all currently visible cells immediately
        for entry in self._visible_entries:
            cell = self._cell_cache.get(id(entry))
            if cell:
                try:
                    cell.grid_remove()
                except Exception:
                    pass

        self._visible_entries = list(entries)
        self._inner_canvas.yview_moveto(0)

        # Show already-cached cells right away (fast path)
        for i, entry in enumerate(entries):
            if id(entry) in self._cell_cache:
                row, col = divmod(i, self._columns)
                self._cell_cache[id(entry)].grid(
                    row=row, column=col, padx=4, pady=4, sticky="n"
                )

        # Eagerly request thumbnails for ALL entries so they're ready when scrolled to
        to_load = [e for e in entries if e.current_path not in self._thumb_requested]
        if to_load:
            for e in to_load:
                self._thumb_requested.add(e.current_path)
            self._review._thumb_loader.load_entries(to_load, self._review._on_thumb_ready)

        # Queue batch creation for uncached cells
        todo = [(i, e) for i, e in enumerate(entries) if id(e) not in self._cell_cache]
        if todo:
            self.after(0, lambda: self._create_batch(todo, batch_id, 0))

    def clear_all(self):
        """Destroy all cached cells (call when model is reloaded)."""
        self._batch_id += 1  # Cancel any pending batch
        for cell in self._cell_cache.values():
            try:
                cell.destroy()
            except Exception:
                pass
        self._cell_cache.clear()
        self._img_label_cache.clear()
        self._thumb_requested.clear()
        self._visible_entries.clear()

    def refresh_cell(self, entry: PhotoEntry):
        """Rebuild a single cell's content (e.g. after star rating change)."""
        cell = self._cell_cache.get(id(entry))
        if cell:
            for w in cell.winfo_children():
                w.destroy()
            self._img_label_cache.pop(id(entry), None)
            self._thumb_requested.discard(entry.current_path)
            self._populate_cell_content(cell, entry)

    # ------------------------------------------------------------------
    # Internal layout helpers
    # ------------------------------------------------------------------

    def _create_batch(self, todo: list, batch_id: int, start: int):
        """Create BATCH_SIZE cells, then schedule the next batch."""
        if batch_id != self._batch_id:
            return  # Superseded by a newer set_entries call
        end = min(start + self.BATCH_SIZE, len(todo))
        for i, entry in todo[start:end]:
            if id(entry) not in self._cell_cache:
                self._create_and_cache_cell(entry)
            row, col = divmod(i, self._columns)
            self._cell_cache[id(entry)].grid(
                row=row, column=col, padx=4, pady=4, sticky="n"
            )
        if end < len(todo):
            self.after(0, lambda: self._create_batch(todo, batch_id, end))

    def _relayout(self):
        """Re-position all visible cells (called on column-count change)."""
        self._batch_id += 1  # Cancel any pending batch
        for i, entry in enumerate(self._visible_entries):
            row, col = divmod(i, self._columns)
            cell = self._cell_cache.get(id(entry))
            if cell:
                cell.grid(row=row, column=col, padx=4, pady=4, sticky="n")

    def _create_and_cache_cell(self, entry: PhotoEntry) -> ctk.CTkFrame:
        cell = ctk.CTkFrame(
            self._scroll_frame, width=self.CELL_W, height=self.CELL_H,
            corner_radius=8, fg_color="gray17",
        )
        cell.grid_propagate(False)
        cell.pack_propagate(False)
        self._populate_cell_content(cell, entry)
        self._cell_cache[id(entry)] = cell
        return cell

    def _populate_cell_content(self, cell: ctk.CTkFrame, entry: PhotoEntry):
        # Thumbnail placeholder
        img_label = ctk.CTkLabel(
            cell, text="", width=150, height=150,
            fg_color="gray22", corner_radius=6,
        )
        img_label.pack(padx=10, pady=(8, 2))
        img_label._photo_entry = entry
        self._img_label_cache[id(entry)] = img_label

        # Show cached thumbnail immediately if available
        cached = self._review._thumb_loader.get_cached(entry.current_path)
        if cached:
            img_label.configure(image=cached)

        # Filename
        fname = os.path.basename(entry.current_path)
        if len(fname) > 24:
            fname = fname[:21] + "..."
        ctk.CTkLabel(
            cell, text=fname, font=ctk.CTkFont(size=10),
            text_color="gray60",
        ).pack(pady=(0, 1))

        # Star rating
        create_star_row(cell, entry, self._review.model, size=12).pack(pady=(0, 1))

        # Category badge
        cat_text = entry.category.replace("_", "").title() if entry.category != "clean" else "Clean"
        badge_color = CATEGORY_COLORS.get(entry.category, "gray30")
        ctk.CTkLabel(
            cell, text=cat_text, font=ctk.CTkFont(size=9),
            fg_color=badge_color, corner_radius=4,
            width=60, height=16, text_color="white",
        ).pack(pady=(0, 4))

        # Bindings
        cell.bind("<Button-3>", lambda e, ent=entry: self._review._show_context_menu(e, ent))
        img_label.bind("<Button-3>", lambda e, ent=entry: self._review._show_context_menu(e, ent))
        cell.bind("<Double-Button-1>", lambda e, ent=entry: self._review._open_edit_view(ent))
        img_label.bind("<Double-Button-1>", lambda e, ent=entry: self._review._open_edit_view(ent))



# ---------------------------------------------------------------------------
# ImportTab — scan settings + progress (embedded in review screen)
# ---------------------------------------------------------------------------

class ImportTab(ctk.CTkFrame):

    def __init__(self, parent, review_frame: "ReviewFrame"):
        super().__init__(parent, fg_color="transparent")
        self._review = review_frame
        self.app = review_frame.app
        self._scanning = False
        self._build_ui()

    def _build_ui(self):
        # Centered container
        container = ctk.CTkFrame(self, fg_color="transparent")
        container.pack(expand=True, fill="both", padx=40, pady=20)

        ctk.CTkLabel(
            container, text="Scan & Organize",
            font=ctk.CTkFont(size=20, weight="bold"),
        ).pack(pady=(10, 4))

        ctk.CTkLabel(
            container,
            text="Detect duplicates, dark, overexposed, blurry, and eyes-closed photos.",
            font=ctk.CTkFont(size=13), text_color="gray70",
        ).pack(pady=(0, 16))

        # Settings panel
        settings_frame = ctk.CTkFrame(container)
        settings_frame.pack(fill="x", pady=(0, 10))

        ctk.CTkLabel(
            settings_frame, text="Detection Settings",
            font=ctk.CTkFont(size=12, weight="bold"), text_color="gray70",
        ).pack(anchor="w", padx=12, pady=(8, 4))

        _hint = ctk.CTkFont(size=11)
        _hint_color = "gray55"

        # Blur slider
        blur_row = ctk.CTkFrame(settings_frame, fg_color="transparent")
        blur_row.pack(fill="x", padx=12, pady=(2, 0))
        ctk.CTkLabel(blur_row, text="Blur sensitivity:", width=130, anchor="w",
                     font=ctk.CTkFont(size=12)).pack(side="left")
        self._blur_val = ctk.CTkLabel(blur_row, text="50", width=35,
                                       font=ctk.CTkFont(size=12))
        self._blur_val.pack(side="right")
        self._blur_slider = ctk.CTkSlider(
            blur_row, from_=10, to=200, number_of_steps=190,
            command=lambda v: self._blur_val.configure(text=str(int(v)))
        )
        self._blur_slider.set(50)
        self._blur_slider.pack(side="left", fill="x", expand=True, padx=(8, 8))
        ctk.CTkLabel(settings_frame,
                     text="Lower = stricter, catches more blur.  Higher = only catches very blurry photos.",
                     font=_hint, text_color=_hint_color, wraplength=500, anchor="w",
                     ).pack(anchor="w", padx=16, pady=(0, 4))

        # Dark slider
        dark_row = ctk.CTkFrame(settings_frame, fg_color="transparent")
        dark_row.pack(fill="x", padx=12, pady=(2, 0))
        ctk.CTkLabel(dark_row, text="Dark threshold:", width=130, anchor="w",
                     font=ctk.CTkFont(size=12)).pack(side="left")
        self._dark_val = ctk.CTkLabel(dark_row, text="85", width=30,
                                       font=ctk.CTkFont(size=12))
        self._dark_val.pack(side="right")
        self._dark_slider = ctk.CTkSlider(
            dark_row, from_=30, to=150, number_of_steps=120,
            command=lambda v: self._dark_val.configure(text=str(int(v)))
        )
        self._dark_slider.set(85)
        self._dark_slider.pack(side="left", fill="x", expand=True, padx=(8, 8))
        ctk.CTkLabel(settings_frame,
                     text="Higher = more photos flagged as dark.  Lower = only catch very dark photos.",
                     font=_hint, text_color=_hint_color, wraplength=500, anchor="w",
                     ).pack(anchor="w", padx=16, pady=(0, 4))

        # Duplicate slider
        dup_row = ctk.CTkFrame(settings_frame, fg_color="transparent")
        dup_row.pack(fill="x", padx=12, pady=(2, 0))
        ctk.CTkLabel(dup_row, text="Duplicate tolerance:", width=130, anchor="w",
                     font=ctk.CTkFont(size=12)).pack(side="left")
        self._dup_val = ctk.CTkLabel(dup_row, text="5", width=30,
                                      font=ctk.CTkFont(size=12))
        self._dup_val.pack(side="right")
        self._dup_slider = ctk.CTkSlider(
            dup_row, from_=1, to=15, number_of_steps=14,
            command=lambda v: self._dup_val.configure(text=str(int(v)))
        )
        self._dup_slider.set(5)
        self._dup_slider.pack(side="left", fill="x", expand=True, padx=(8, 8))
        ctk.CTkLabel(settings_frame,
                     text="Higher = more photos considered duplicates.  Lower = only exact/near-exact copies.",
                     font=_hint, text_color=_hint_color, wraplength=500, anchor="w",
                     ).pack(anchor="w", padx=16, pady=(0, 8))

        # Dry run
        self._dry_run = ctk.BooleanVar(value=False)
        ctk.CTkCheckBox(
            container, text="Dry Run (preview only \u2014 don't save results)",
            variable=self._dry_run, font=ctk.CTkFont(size=12),
        ).pack(anchor="w", pady=(0, 10))

        # Buttons
        btn_row = ctk.CTkFrame(container, fg_color="transparent")
        btn_row.pack(fill="x", pady=(0, 10))

        self._start_btn = ctk.CTkButton(
            btn_row, text="Start Scan", height=42,
            font=ctk.CTkFont(size=15, weight="bold"),
            command=self._start,
        )
        self._start_btn.pack(side="left", fill="x", expand=True, padx=(0, 8))

        self._undo_btn = ctk.CTkButton(
            btn_row, text="Clear Classifications", width=160, height=42,
            font=ctk.CTkFont(size=13), fg_color="gray30", hover_color="gray40",
            command=self._undo,
        )
        self._undo_btn.pack(side="right")

        # Progress
        self._progress = ctk.CTkProgressBar(container, height=14)
        self._progress.set(0)
        self._progress.pack(fill="x")

        self._status_var = ctk.StringVar(value="Ready. Press Start Scan.")
        ctk.CTkLabel(
            container, textvariable=self._status_var,
            font=ctk.CTkFont(size=12), text_color="gray70",
        ).pack(pady=(6, 8))

        # Log
        ctk.CTkLabel(
            container, text="Activity Log",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(anchor="w")

        self._log = ctk.CTkTextbox(
            container, height=180,
            font=ctk.CTkFont(family="Consolas", size=12),
            state="disabled",
        )
        self._log.pack(fill="both", expand=True, pady=(4, 10))

    def _start(self):
        folder = self._review._source_dir
        if not folder:
            return
        if self._scanning:
            return

        self._scanning = True
        dry = self._dry_run.get()
        label = "Previewing\u2026" if dry else "Scanning\u2026"
        self._start_btn.configure(state="disabled", text=label)
        self._undo_btn.configure(state="disabled")
        self._progress.set(0)
        self._log_clear()
        self._log_write(f"{'[DRY RUN] ' if dry else ''}Starting scan on: {folder}\n")

        thresholds = {
            "blur": float(self._blur_slider.get()),
            "dark": int(self._dark_slider.get()),
            "duplicates": int(self._dup_slider.get()),
        }

        thread = threading.Thread(
            target=self._run_scan,
            args=(folder, thresholds, dry),
            daemon=True,
        )
        thread.start()

    def _run_scan(self, folder: str, thresholds: dict, dry_run: bool):
        def on_progress(current, total, message):
            if total > 0:
                self._progress.set(current / total)
            self._status_var.set(message)
            if any(sf.lstrip("_") in message.lower() for sf in SUBFOLDERS) \
                    or message.startswith("[Preview]"):
                self._log_write(f"  {message}\n")

        try:
            summary = scan_and_classify(
                folder,
                progress_callback=on_progress,
                thresholds=thresholds,
                dry_run=dry_run,
            )
        except Exception as e:
            self._log_write(f"\nUnexpected error: {e}\n")
            self._finish_scan()
            return

        prefix = "[DRY RUN] " if dry_run else ""
        self._log_write(f"\n--- {prefix}Scan Complete ---\n")
        total_flagged = sum(v for k, v in summary.items() if k != "clean")
        for key, count in summary.items():
            label = key.replace("_", " ").strip().title()
            self._log_write(f"  {label:<18}: {count} file(s)\n")

        if total_flagged == 0:
            self._log_write("\nNo problematic photos found. All photos look good!\n")
        elif dry_run:
            self._log_write(f"\n{total_flagged} file(s) would be classified (dry run).\n")
        else:
            self._log_write(f"\n{total_flagged} file(s) classified.\n")

        self._status_var.set("Scan complete.")
        self._progress.set(1.0)
        self._finish_scan()

        # Reload model and switch to CULL tab
        if not dry_run:
            self.app.after(800, lambda: self._review._reload_model_and_show_cull())

    def _undo(self):
        folder = self._review._source_dir
        if not folder:
            return

        self._undo_btn.configure(state="disabled")
        self._log_clear()
        self._log_write("Clearing classifications...\n")

        def do_clear():
            cleared, errors = clear_classifications(folder)
            if cleared > 0:
                self._log_write(f"  Cleared {cleared} classification(s).\n")
            for err in errors:
                self._log_write(f"  {err}\n")
            if not errors:
                self._log_write("\nDone. All photos reset to clean.\n")
            self._status_var.set("Classifications cleared." if not errors else "Nothing to clear.")
            self.app.after(0, lambda: self._undo_btn.configure(state="normal"))
            # Reload model
            self.app.after(200, lambda: self._review._reload_model_and_show_cull())

        threading.Thread(target=do_clear, daemon=True).start()

    def _finish_scan(self):
        self._scanning = False
        self.app.after(0, lambda: self._start_btn.configure(state="normal", text="Start Scan"))
        self.app.after(0, lambda: self._undo_btn.configure(state="normal"))

    def _log_write(self, text: str):
        def _do():
            self._log.configure(state="normal")
            self._log.insert("end", text)
            self._log.see("end")
            self._log.configure(state="disabled")
        self.app.after(0, _do)

    def _log_clear(self):
        def _do():
            self._log.configure(state="normal")
            self._log.delete("1.0", "end")
            self._log.configure(state="disabled")
        self.app.after(0, _do)


# ---------------------------------------------------------------------------
# EditView — Single photo view (EDIT tab)
# ---------------------------------------------------------------------------

class EditView(ctk.CTkFrame):

    PREVIEW_MAX = (1200, 900)

    def __init__(self, parent, review_frame: "ReviewFrame"):
        super().__init__(parent, fg_color="gray8")
        self._review = review_frame
        self._entries: list[PhotoEntry] = []
        self._current_idx = 0
        self._current_entry: Optional[PhotoEntry] = None
        self._current_preview_img = None  # Keep reference to prevent GC

        self._build_ui()

    def _build_ui(self):
        body = ctk.CTkFrame(self, fg_color="transparent")
        body.pack(fill="both", expand=True)

        # Preview area
        self._preview_area = ctk.CTkFrame(body, fg_color="gray8")
        self._preview_area.pack(side="left", fill="both", expand=True)

        self._preview_label = ctk.CTkLabel(
            self._preview_area, text="Select a photo",
            font=ctk.CTkFont(size=16), text_color="gray50",
        )
        self._preview_label.pack(expand=True)

        nav_left = ctk.CTkButton(
            self._preview_area, text="\u25C0", width=40, height=60,
            font=ctk.CTkFont(size=20), fg_color="gray20",
            hover_color="gray30", corner_radius=8,
            command=self._prev_photo,
        )
        nav_left.place(relx=0.01, rely=0.5, anchor="w")

        nav_right = ctk.CTkButton(
            self._preview_area, text="\u25B6", width=40, height=60,
            font=ctk.CTkFont(size=20), fg_color="gray20",
            hover_color="gray30", corner_radius=8,
            command=self._next_photo,
        )
        nav_right.place(relx=0.99, rely=0.5, anchor="e")

        # Info panel
        self._info_panel = ctk.CTkFrame(body, width=260, fg_color="gray12",
                                         corner_radius=0)
        self._info_panel.pack(side="right", fill="y")
        self._info_panel.pack_propagate(False)

        ctk.CTkLabel(
            self._info_panel, text="Photo Info",
            font=ctk.CTkFont(size=15, weight="bold"),
        ).pack(pady=(16, 12), padx=16, anchor="w")

        self._info_filename = ctk.CTkLabel(
            self._info_panel, text="", font=ctk.CTkFont(size=12),
            text_color="gray70", wraplength=230,
        )
        self._info_filename.pack(padx=16, anchor="w", pady=(0, 8))

        self._info_category_frame = ctk.CTkFrame(self._info_panel, fg_color="transparent")
        self._info_category_frame.pack(padx=16, anchor="w", pady=(0, 12))

        self._info_category = ctk.CTkLabel(
            self._info_category_frame, text="", font=ctk.CTkFont(size=11),
            corner_radius=4, width=80, height=22, text_color="white",
        )
        self._info_category.pack(side="left")

        ctk.CTkLabel(
            self._info_panel, text="Rating",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(padx=16, anchor="w", pady=(4, 4))

        self._star_frame_container = ctk.CTkFrame(self._info_panel, fg_color="transparent")
        self._star_frame_container.pack(padx=16, anchor="w", pady=(0, 12))

        ctk.CTkLabel(
            self._info_panel, text="Detection Scores",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(padx=16, anchor="w", pady=(4, 4))

        self._info_scores = ctk.CTkLabel(
            self._info_panel, text="", font=ctk.CTkFont(size=11, family="Consolas"),
            text_color="gray60", justify="left", anchor="w",
        )
        self._info_scores.pack(padx=16, anchor="w", pady=(0, 16))

        ctk.CTkLabel(
            self._info_panel, text="Reclassify",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(padx=16, anchor="w", pady=(4, 4))

        targets = [
            ("clean", "Clean"), ("_blurry", "Blurry"), ("_dark", "Dark"),
            ("_overexposed", "Overexposed"), ("_eyes_closed", "Eyes Closed"),
            ("_duplicates", "Duplicates"),
        ]
        for cat_key, cat_label in targets:
            ctk.CTkButton(
                self._info_panel, text=f"  Classify as {cat_label}",
                anchor="w", height=30, font=ctk.CTkFont(size=11),
                fg_color="transparent", hover_color="gray25",
                text_color="gray70",
                command=lambda k=cat_key: self._reclassify_current(k),
            ).pack(fill="x", padx=12, pady=1)

        # Bottom bar
        bottom = ctk.CTkFrame(self, height=36, corner_radius=0, fg_color="gray14")
        bottom.pack(fill="x", side="bottom")
        bottom.pack_propagate(False)

        self._position_label = ctk.CTkLabel(
            bottom, text="", font=ctk.CTkFont(size=12), text_color="gray60",
        )
        self._position_label.pack(pady=6)

    def set_entries(self, entries: list[PhotoEntry], start_entry: Optional[PhotoEntry] = None):
        self._entries = entries
        if start_entry and start_entry in entries:
            self._current_idx = entries.index(start_entry)
        else:
            self._current_idx = 0
        self._show_current()

    def _show_current(self):
        if not self._entries:
            self._preview_label.configure(text="No photos to display", image=None)
            self._info_filename.configure(text="")
            self._position_label.configure(text="")
            return

        self._current_idx = max(0, min(self._current_idx, len(self._entries) - 1))
        entry = self._entries[self._current_idx]
        self._current_entry = entry

        self._position_label.configure(
            text=f"{self._current_idx + 1} / {len(self._entries)}"
        )

        self._info_filename.configure(text=os.path.basename(entry.current_path))

        cat_text = entry.category.replace("_", "").title() if entry.category != "clean" else "Clean"
        badge_color = CATEGORY_COLORS.get(entry.category, "gray30")
        self._info_category.configure(text=cat_text, fg_color=badge_color)

        scores_text = ""
        if entry.scores:
            if "brightness" in entry.scores:
                scores_text += f"Brightness: {entry.scores['brightness']}\n"
            if "blur" in entry.scores:
                scores_text += f"Blur score: {entry.scores['blur']}\n"
            if "ear" in entry.scores and entry.scores["ear"] is not None:
                scores_text += f"Eye AR:     {entry.scores['ear']:.3f}\n"
        if entry.all_labels:
            scores_text += f"Labels:     {', '.join(entry.all_labels)}"
        if not scores_text:
            scores_text = "No detection data"
        self._info_scores.configure(text=scores_text)

        for w in self._star_frame_container.winfo_children():
            w.destroy()
        create_star_row(
            self._star_frame_container, entry, self._review.model,
            size=18,
        ).pack()

        self._preview_label.configure(text="Loading...", image=None)

        self._preview_area.update_idletasks()
        pw = max(400, self._preview_area.winfo_width() - 80)
        ph = max(300, self._preview_area.winfo_height() - 40)
        preview_size = (min(pw, self.PREVIEW_MAX[0]), min(ph, self.PREVIEW_MAX[1]))

        self._review._thumb_loader.load_single(
            entry.current_path, preview_size, self._on_preview_loaded
        )

    def _on_preview_loaded(self, ctk_img: ctk.CTkImage):
        self._current_preview_img = ctk_img  # Prevent garbage collection
        try:
            self._preview_label.configure(image=ctk_img, text="")
        except Exception:
            pass

    def _prev_photo(self):
        if self._current_idx > 0:
            self._current_idx -= 1
            self._show_current()

    def _next_photo(self):
        if self._current_idx < len(self._entries) - 1:
            self._current_idx += 1
            self._show_current()

    def _reclassify_current(self, new_category: str):
        if not self._current_entry:
            return
        if new_category == self._current_entry.category:
            return
        self._review.model.reclassify(self._current_entry, new_category)
        self._review._update_sidebar_counts()
        self._show_current()

    def handle_key(self, event):
        if event.keysym == "Left":
            self._prev_photo()
        elif event.keysym == "Right":
            self._next_photo()
        elif event.keysym == "Escape":
            self._review._show_tab("cull")


# ---------------------------------------------------------------------------
# ReviewFrame — main review screen with IMPORT / CULL / EDIT tabs
# ---------------------------------------------------------------------------

class ReviewFrame(ctk.CTkFrame):

    def __init__(self, parent, app: "App", source_dir: str, classifications: dict):
        super().__init__(parent, fg_color="transparent")
        self.app = app
        self._source_dir = source_dir
        self.model = ReviewModel(source_dir, classifications)
        self._current_filter = "all"
        self._min_stars = 0
        self._current_tab = "cull"
        self._thumb_loader = ThumbnailLoader(app)
        self._status_var = ctk.StringVar(value="")

        self._build_header()
        self._build_body()
        self._build_status_bar()

        self.app.bind("<Key>", self._on_key)

        self._apply_filter("all")

    def destroy(self):
        try:
            self.app.unbind("<Key>")
        except Exception:
            pass
        self._thumb_loader.shutdown()
        super().destroy()

    def _build_header(self):
        header = ctk.CTkFrame(self, height=50, corner_radius=0, fg_color="gray14")
        header.pack(fill="x")
        header.pack_propagate(False)

        ctk.CTkButton(
            header, text="\u2190  Home", width=100, height=34,
            font=ctk.CTkFont(size=12),
            fg_color="gray25", hover_color="gray35",
            command=self.app._show_home_screen,
        ).pack(side="left", padx=(12, 20), pady=8)

        self._tab_buttons: dict[str, ctk.CTkButton] = {}
        for tab_name, tab_label in [("import", "IMPORT"), ("cull", "CULL"), ("edit", "EDIT")]:
            is_active = tab_name == self._current_tab
            btn = ctk.CTkButton(
                header, text=tab_label, width=90, height=34,
                font=ctk.CTkFont(size=13, weight="bold"),
                fg_color="#3b8ed0" if is_active else "gray25",
                hover_color="#2d7ab8" if is_active else "gray35",
                command=lambda t=tab_name: self._show_tab(t),
            )
            btn.pack(side="left", padx=2, pady=8)
            self._tab_buttons[tab_name] = btn

        # Folder name on right
        folder_name = os.path.basename(self._source_dir)
        ctk.CTkLabel(
            header, text=folder_name,
            font=ctk.CTkFont(size=13), text_color="gray50",
        ).pack(side="right", padx=16)

    def _build_body(self):
        self._body = ctk.CTkFrame(self, fg_color="transparent")
        self._body.pack(fill="both", expand=True)

        self._build_sidebar(self._body)

        self._content_area = ctk.CTkFrame(self._body, fg_color="transparent")
        self._content_area.pack(side="left", fill="both", expand=True)

        self._grid = VirtualGrid(self._content_area, self)
        self._edit_view = EditView(self._content_area, self)
        self._import_tab = ImportTab(self._content_area, self)

        # Show cull by default
        self._grid.pack(fill="both", expand=True)

    def _build_sidebar(self, parent):
        self._sidebar = ctk.CTkFrame(parent, width=190, corner_radius=0, fg_color="gray12")
        self._sidebar.pack(side="left", fill="y")
        self._sidebar.pack_propagate(False)

        ctk.CTkLabel(
            self._sidebar, text="Categories",
            font=ctk.CTkFont(size=14, weight="bold"),
        ).pack(pady=(14, 8), padx=12, anchor="w")

        self._sidebar_buttons: dict[str, ctk.CTkButton] = {}
        counts = self.model.get_counts()

        for key, label in CATEGORY_LABELS:
            count = counts.get(key, 0)
            color = CATEGORY_COLORS.get(key, "gray30")
            btn = ctk.CTkButton(
                self._sidebar,
                text=f"  {label}  ({count})",
                anchor="w", height=34,
                font=ctk.CTkFont(size=12),
                fg_color=color if key == self._current_filter else "transparent",
                hover_color="gray25", text_color="white",
                command=lambda k=key: self._apply_filter(k),
            )
            btn.pack(fill="x", padx=8, pady=1)
            self._sidebar_buttons[key] = btn

        ctk.CTkFrame(self._sidebar, height=1, fg_color="gray25").pack(
            fill="x", padx=12, pady=(12, 8)
        )

        ctk.CTkLabel(
            self._sidebar, text="Star Rating",
            font=ctk.CTkFont(size=14, weight="bold"),
        ).pack(pady=(4, 8), padx=12, anchor="w")

        self._star_filter_buttons: dict[int, ctk.CTkButton] = {}
        star_options = [
            (0, "All ratings"),
            (1, STAR_FILLED + " 1+ stars"),
            (2, STAR_FILLED * 2 + " 2+ stars"),
            (3, STAR_FILLED * 3 + " 3+ stars"),
            (4, STAR_FILLED * 4 + " 4+ stars"),
            (5, STAR_FILLED * 5 + " only"),
        ]

        for min_s, label in star_options:
            btn = ctk.CTkButton(
                self._sidebar,
                text=f"  {label}",
                anchor="w", height=30,
                font=ctk.CTkFont(size=11),
                fg_color=STAR_COLOR if min_s == self._min_stars else "transparent",
                text_color="black" if min_s == self._min_stars else "gray70",
                hover_color="gray25",
                command=lambda s=min_s: self._set_star_filter(s),
            )
            btn.pack(fill="x", padx=8, pady=1)
            self._star_filter_buttons[min_s] = btn

    def _build_status_bar(self):
        status_bar = ctk.CTkFrame(self, height=30, corner_radius=0, fg_color="gray14")
        status_bar.pack(fill="x", side="bottom")
        status_bar.pack_propagate(False)

        ctk.CTkLabel(
            status_bar, textvariable=self._status_var,
            font=ctk.CTkFont(size=11), text_color="gray60",
        ).pack(side="left", padx=12, pady=4)

    # ------------------------------------------------------------------
    # Tab switching
    # ------------------------------------------------------------------

    def _show_tab(self, tab_name: str):
        self._current_tab = tab_name

        for name, btn in self._tab_buttons.items():
            if name == tab_name:
                btn.configure(fg_color="#3b8ed0", hover_color="#2d7ab8")
            else:
                btn.configure(fg_color="gray25", hover_color="gray35")

        # Hide all
        self._grid.pack_forget()
        self._edit_view.pack_forget()
        self._import_tab.pack_forget()

        # Show/hide sidebar based on tab
        if tab_name == "import":
            self._sidebar.pack_forget()
            self._import_tab.pack(fill="both", expand=True)
        else:
            # Re-pack sidebar if it was hidden
            if not self._sidebar.winfo_ismapped():
                self._content_area.pack_forget()
                self._sidebar.pack(side="left", fill="y")
                self._content_area.pack(side="left", fill="both", expand=True)

            if tab_name == "cull":
                self._grid.pack(fill="both", expand=True)
                self._apply_filter(self._current_filter)
            elif tab_name == "edit":
                self._edit_view.pack(fill="both", expand=True)
                entries = self.model.get_filtered(self._current_filter, self._min_stars)
                self._edit_view.set_entries(entries)

    def _open_edit_view(self, entry: PhotoEntry):
        self._current_tab = "edit"
        for name, btn in self._tab_buttons.items():
            btn.configure(
                fg_color="#3b8ed0" if name == "edit" else "gray25",
                hover_color="#2d7ab8" if name == "edit" else "gray35",
            )
        self._grid.pack_forget()
        self._import_tab.pack_forget()
        self._edit_view.pack(fill="both", expand=True)

        entries = self.model.get_filtered(self._current_filter, self._min_stars)
        self._edit_view.set_entries(entries, start_entry=entry)

    # ------------------------------------------------------------------
    # Model reload (after scan/undo)
    # ------------------------------------------------------------------

    def _reload_model_and_show_cull(self):
        """Reload the model from disk and refresh the CULL view."""
        class_path = os.path.join(self._source_dir, CLASSIFICATIONS_FILE)
        classifications = {}
        if os.path.exists(class_path):
            try:
                with open(class_path, "r", encoding="utf-8") as f:
                    classifications = json.load(f)
            except Exception:
                pass
        self.model = ReviewModel(self._source_dir, classifications)
        self._thumb_loader.cancel()
        self._grid.clear_all()  # Model changed — destroy stale cached cells
        self._update_sidebar_counts()
        self._show_tab("cull")

    # ------------------------------------------------------------------
    # Filtering
    # ------------------------------------------------------------------

    def _apply_filter(self, category: str):
        self._current_filter = category

        for key, btn in self._sidebar_buttons.items():
            color = CATEGORY_COLORS.get(key, "gray30")
            btn.configure(fg_color=color if key == category else "transparent")

        entries = self.model.get_filtered(category, self._min_stars)
        cat_label = dict(CATEGORY_LABELS).get(category, category)
        star_text = f" | {STAR_FILLED}{self._min_stars}+" if self._min_stars > 0 else ""
        self._status_var.set(f"Showing {len(entries)} photos \u2014 {cat_label}{star_text}")

        if self._current_tab == "cull":
            self._grid.set_entries(entries)
        elif self._current_tab == "edit":
            self._edit_view.set_entries(entries)

    def _set_star_filter(self, min_stars: int):
        self._min_stars = min_stars
        for s, btn in self._star_filter_buttons.items():
            if s == min_stars:
                btn.configure(fg_color=STAR_COLOR, text_color="black")
            else:
                btn.configure(fg_color="transparent", text_color="gray70")
        self._apply_filter(self._current_filter)

    def _update_sidebar_counts(self):
        counts = self.model.get_counts()
        for key, label in CATEGORY_LABELS:
            count = counts.get(key, 0)
            btn = self._sidebar_buttons.get(key)
            if btn:
                btn.configure(text=f"  {label}  ({count})")

    # ------------------------------------------------------------------
    # Thumbnail callback
    # ------------------------------------------------------------------

    def _on_thumb_ready(self, entry: PhotoEntry, ctk_img: ctk.CTkImage):
        lbl = self._grid._img_label_cache.get(id(entry))
        if lbl is not None:
            try:
                lbl.configure(image=ctk_img, text="")
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Context menu
    # ------------------------------------------------------------------

    def _show_context_menu(self, event, entry: PhotoEntry):
        menu = tk.Menu(
            self, tearoff=0,
            bg="#2b2b2b", fg="white",
            activebackground="#3b8ed0", activeforeground="white",
            font=("Segoe UI", 10),
        )

        targets = [
            ("clean", "Classify as Clean"), ("_blurry", "Classify as Blurry"),
            ("_dark", "Classify as Dark"), ("_overexposed", "Classify as Overexposed"),
            ("_eyes_closed", "Classify as Eyes Closed"), ("_duplicates", "Classify as Duplicates"),
        ]

        for cat_key, cat_label in targets:
            if cat_key == entry.category:
                continue
            menu.add_command(
                label=cat_label,
                command=lambda k=cat_key, e=entry: self._reclassify(e, k),
            )

        star_menu = tk.Menu(
            menu, tearoff=0, bg="#2b2b2b", fg="white",
            activebackground="#3b8ed0", activeforeground="white",
            font=("Segoe UI", 10),
        )
        for s in range(6):
            label = STAR_FILLED * s + STAR_EMPTY * (5 - s) if s > 0 else "No rating"
            star_menu.add_command(
                label=label,
                command=lambda stars=s, e=entry: self._set_entry_rating(e, stars),
            )
        menu.add_cascade(label="Set Rating", menu=star_menu)

        menu.tk_popup(event.x_root, event.y_root)

    def _reclassify(self, entry: PhotoEntry, new_category: str):
        self.model.reclassify(entry, new_category)
        self._update_sidebar_counts()
        self._apply_filter(self._current_filter)

    def _set_entry_rating(self, entry: PhotoEntry, stars: int):
        self.model.set_rating(entry, stars)
        if self._current_tab == "cull":
            self._grid.refresh_cell(entry)

    # ------------------------------------------------------------------
    # Keyboard
    # ------------------------------------------------------------------

    def _on_key(self, event):
        if self._current_tab == "edit":
            self._edit_view.handle_key(event)


# ---------------------------------------------------------------------------
# HomeScreen — folder picker + resume existing project
# ---------------------------------------------------------------------------

class HomeScreen(ctk.CTkFrame):

    def __init__(self, parent, app: "App"):
        super().__init__(parent, fg_color="transparent")
        self.app = app
        self._build_ui()

    def _build_ui(self):
        # Center everything
        center = ctk.CTkFrame(self, fg_color="transparent")
        center.pack(expand=True)

        ctk.CTkLabel(
            center, text="Photo Organizer",
            font=ctk.CTkFont(size=28, weight="bold"),
        ).pack(pady=(0, 6))

        ctk.CTkLabel(
            center,
            text="Finds duplicates, dark, overexposed, blurry, and eyes-closed photos.",
            font=ctk.CTkFont(size=14), text_color="gray60",
        ).pack(pady=(0, 30))

        # Folder picker
        folder_frame = ctk.CTkFrame(center, fg_color="transparent")
        folder_frame.pack(fill="x", padx=40, pady=(0, 10))

        ctk.CTkEntry(
            folder_frame, textvariable=self.app._folder,
            placeholder_text="No folder selected\u2026",
            height=40, font=ctk.CTkFont(size=14), width=350,
        ).pack(side="left", fill="x", expand=True, padx=(0, 10))

        ctk.CTkButton(
            folder_frame, text="Browse", width=100, height=40,
            font=ctk.CTkFont(size=14),
            command=self._pick_folder,
        ).pack(side="right")

        # Action buttons
        self._btn_frame = ctk.CTkFrame(center, fg_color="transparent")
        self._btn_frame.pack(fill="x", padx=40, pady=(10, 0))

        self._new_scan_btn = ctk.CTkButton(
            self._btn_frame, text="New Scan",
            height=50, width=220,
            font=ctk.CTkFont(size=16, weight="bold"),
            command=self._new_scan,
        )
        self._new_scan_btn.pack(side="left", padx=(0, 10))

        self._resume_btn = ctk.CTkButton(
            self._btn_frame, text="Resume Project",
            height=50, width=220,
            font=ctk.CTkFont(size=16, weight="bold"),
            fg_color="#2fa572", hover_color="#258a5c",
            command=self._resume_project,
        )
        # Hidden by default, shown when a project exists
        self._resume_btn.pack_forget()

        # Status message
        self._home_status = ctk.CTkLabel(
            center, text="", font=ctk.CTkFont(size=12), text_color="gray50",
        )
        self._home_status.pack(pady=(16, 0))

        # Check if current folder has a project
        self._check_existing_project()

    def _pick_folder(self):
        path = filedialog.askdirectory(title="Select photo folder")
        if path:
            self.app._folder.set(path.replace("/", "\\"))
            self._check_existing_project()

    def _check_existing_project(self):
        folder = self.app._folder.get().strip()
        if not folder or not os.path.isdir(folder):
            self._resume_btn.pack_forget()
            self._home_status.configure(text="")
            return

        class_path = os.path.join(folder, CLASSIFICATIONS_FILE)
        if os.path.exists(class_path):
            try:
                with open(class_path, "r", encoding="utf-8") as f:
                    classifications = json.load(f)
                count = len(classifications)
                self._home_status.configure(
                    text=f"Existing project found: {count} classified photo(s). You can resume or start a new scan."
                )
                self._resume_btn.pack(side="left", padx=(0, 10))
            except Exception:
                self._resume_btn.pack_forget()
                self._home_status.configure(text="")
        else:
            self._resume_btn.pack_forget()
            self._home_status.configure(text="No existing project. Click 'New Scan' to start.")

    def _new_scan(self):
        folder = self.app._folder.get().strip()
        if not folder or not os.path.isdir(folder):
            self._home_status.configure(text="Please select a valid folder first.")
            return
        # Open review screen on IMPORT tab
        class_path = os.path.join(folder, CLASSIFICATIONS_FILE)
        classifications = {}
        if os.path.exists(class_path):
            try:
                with open(class_path, "r", encoding="utf-8") as f:
                    classifications = json.load(f)
            except Exception:
                pass
        self.app._show_review_screen(folder, classifications, start_tab="import")

    def _resume_project(self):
        folder = self.app._folder.get().strip()
        if not folder:
            return
        class_path = os.path.join(folder, CLASSIFICATIONS_FILE)
        classifications = {}
        if os.path.exists(class_path):
            try:
                with open(class_path, "r", encoding="utf-8") as f:
                    classifications = json.load(f)
            except Exception:
                pass
        self.app._show_review_screen(folder, classifications, start_tab="cull")


# ---------------------------------------------------------------------------
# App window
# ---------------------------------------------------------------------------

class App(ctk.CTk):

    def __init__(self):
        super().__init__()

        self.title("Photo Organizer")
        self.geometry("660x500")
        self.resizable(False, False)
        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("blue")

        self._folder = ctk.StringVar()
        self._status = ctk.StringVar(value="")

        self._container = ctk.CTkFrame(self, fg_color="transparent")
        self._container.pack(fill="both", expand=True)

        self._home_screen: Optional[HomeScreen] = None
        self._review_frame: Optional[ReviewFrame] = None

        self._show_home_screen()

    def _show_home_screen(self):
        if self._review_frame:
            self._review_frame.destroy()
            self._review_frame = None
        self.geometry("660x500")
        self.resizable(False, False)
        self._home_screen = HomeScreen(self._container, app=self)
        self._home_screen.pack(fill="both", expand=True)

    def _show_review_screen(self, source_dir: str, classifications: dict, start_tab: str = "cull"):
        if self._home_screen:
            self._home_screen.destroy()
            self._home_screen = None
        self.geometry("1200x800")
        self.resizable(True, True)
        self.minsize(900, 600)
        self._review_frame = ReviewFrame(
            self._container, app=self,
            source_dir=source_dir, classifications=classifications,
        )
        self._review_frame.pack(fill="both", expand=True)
        if start_tab != "cull":
            self._review_frame._show_tab(start_tab)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run():
    app = App()
    app.mainloop()
