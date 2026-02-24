"""
gui.py — CustomTkinter GUI for the Photo Organizer.
"""

import threading
from tkinter import filedialog

import customtkinter as ctk

from organizer import scan_and_organize, SUBFOLDERS


# ---------------------------------------------------------------------------
# App window
# ---------------------------------------------------------------------------

class App(ctk.CTk):

    def __init__(self):
        super().__init__()

        self.title("Photo Organizer")
        self.geometry("640x520")
        self.resizable(False, False)
        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("blue")

        self._folder = ctk.StringVar()
        self._status = ctk.StringVar(value="Select a folder to get started.")
        self._scanning = False

        self._build_ui()

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------

    def _build_ui(self):
        # Title
        ctk.CTkLabel(
            self,
            text="Photo Organizer",
            font=ctk.CTkFont(size=22, weight="bold"),
        ).pack(pady=(20, 4))

        ctk.CTkLabel(
            self,
            text="Finds duplicates, dark, blurry, and eyes-closed photos.",
            font=ctk.CTkFont(size=13),
            text_color="gray70",
        ).pack(pady=(0, 16))

        # Folder picker row
        folder_frame = ctk.CTkFrame(self, fg_color="transparent")
        folder_frame.pack(fill="x", padx=24, pady=(0, 12))

        ctk.CTkEntry(
            folder_frame,
            textvariable=self._folder,
            placeholder_text="No folder selected…",
            height=36,
            font=ctk.CTkFont(size=13),
        ).pack(side="left", fill="x", expand=True, padx=(0, 8))

        ctk.CTkButton(
            folder_frame,
            text="Browse",
            width=90,
            height=36,
            command=self._pick_folder,
        ).pack(side="right")

        # Start button
        self._start_btn = ctk.CTkButton(
            self,
            text="Start Scan",
            height=42,
            font=ctk.CTkFont(size=15, weight="bold"),
            command=self._start,
        )
        self._start_btn.pack(padx=24, pady=(0, 16), fill="x")

        # Progress bar
        self._progress = ctk.CTkProgressBar(self, height=14)
        self._progress.set(0)
        self._progress.pack(padx=24, fill="x")

        # Status label
        ctk.CTkLabel(
            self,
            textvariable=self._status,
            font=ctk.CTkFont(size=12),
            text_color="gray70",
        ).pack(pady=(6, 8))

        # Separator label
        ctk.CTkLabel(
            self,
            text="Activity Log",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(anchor="w", padx=24)

        # Log textbox
        self._log = ctk.CTkTextbox(
            self,
            height=230,
            font=ctk.CTkFont(family="Consolas", size=12),
            state="disabled",
        )
        self._log.pack(padx=24, pady=(4, 16), fill="both", expand=True)

    # ------------------------------------------------------------------
    # Event handlers
    # ------------------------------------------------------------------

    def _pick_folder(self):
        path = filedialog.askdirectory(title="Select photo folder")
        if path:
            # Normalize to Windows-style path
            self._folder.set(path.replace("/", "\\"))
            self._log_clear()
            self._status.set("Ready. Press Start Scan.")
            self._progress.set(0)

    def _start(self):
        folder = self._folder.get().strip()
        if not folder:
            self._status.set("Please select a folder first.")
            return
        if self._scanning:
            return

        self._scanning = True
        self._start_btn.configure(state="disabled", text="Scanning…")
        self._progress.set(0)
        self._log_clear()
        self._log_write("Starting scan...\n")

        thread = threading.Thread(
            target=self._run_scan,
            args=(folder,),
            daemon=True,
        )
        thread.start()

    def _run_scan(self, folder: str):
        """Runs in background thread."""

        def on_progress(current, total, message):
            if total > 0:
                self._progress.set(current / total)
            self._status.set(message)
            # Only log file moves, not every "Checking: ..." line
            if any(sf.lstrip("_") in message.lower() for sf in SUBFOLDERS):
                self._log_write(f"  {message}\n")

        try:
            summary = scan_and_organize(folder, progress_callback=on_progress)
        except Exception as e:
            self._log_write(f"\nUnexpected error: {e}\n")
            self._finish_scan()
            return

        # Build results summary
        self._log_write("\n--- Scan Complete ---\n")
        total_moved = sum(v for k, v in summary.items() if k != "clean")
        for key, count in summary.items():
            label = key.replace("_", " ").strip().title()
            self._log_write(f"  {label:<18}: {count} file(s)\n")

        if total_moved == 0:
            self._log_write("\nNo problematic photos found. All photos look good!\n")
        else:
            self._log_write(f"\n{total_moved} file(s) moved into subfolders.\n")

        self._status.set("Scan complete.")
        self._progress.set(1.0)
        self._finish_scan()

    def _finish_scan(self):
        self._scanning = False
        self._start_btn.configure(state="normal", text="Start Scan")

    # ------------------------------------------------------------------
    # Log helpers (thread-safe via .after)
    # ------------------------------------------------------------------

    def _log_write(self, text: str):
        def _do():
            self._log.configure(state="normal")
            self._log.insert("end", text)
            self._log.see("end")
            self._log.configure(state="disabled")
        self.after(0, _do)

    def _log_clear(self):
        def _do():
            self._log.configure(state="normal")
            self._log.delete("1.0", "end")
            self._log.configure(state="disabled")
        self.after(0, _do)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run():
    app = App()
    app.mainloop()
