"""
catalog.py — SQLite catalog for projects, photos, edit settings, thumbnails.

Single source of truth for all persistence. The DB lives in the OS app-data
directory (platformdirs), NOT in the scanned photo folders.

All SQL lives in this module only. Thread-safe: one connection per thread
(threading.local), WAL journal mode.
"""

import json
import os
import shutil
import sqlite3
import threading
import time

from platformdirs import user_data_dir

APP_NAME = "PhotoOrganizer"
APP_AUTHOR = "yossibr"

SCHEMA_VERSION = 2

_local = threading.local()
_data_dir_override = None  # for tests


def data_dir() -> str:
    d = _data_dir_override or user_data_dir(APP_NAME, APP_AUTHOR)
    os.makedirs(d, exist_ok=True)
    return d


def thumbs_dir() -> str:
    d = os.path.join(data_dir(), "thumbs")
    os.makedirs(d, exist_ok=True)
    return d


def _db_path() -> str:
    return os.path.join(data_dir(), "catalog.db")


def _conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None or getattr(_local, "db_path", None) != _db_path():
        conn = sqlite3.connect(_db_path(), timeout=5.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")
        _ensure_schema(conn)
        _local.conn = conn
        _local.db_path = _db_path()
    return conn


def _ensure_schema(conn: sqlite3.Connection):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        created_at REAL NOT NULL,
        last_opened_at REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS photos (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        path TEXT NOT NULL,
        mtime REAL NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        category TEXT NOT NULL DEFAULT 'clean',
        all_labels TEXT NOT NULL DEFAULT '[]',
        scores TEXT NOT NULL DEFAULT '{}',
        star_rating INTEGER NOT NULL DEFAULT 0,
        rating_source TEXT NOT NULL DEFAULT '',
        analyzed_at REAL,
        capture_time REAL,
        embedding BLOB,
        aesthetic_score REAL,
        face_quality REAL,
        combined_score REAL,
        stack_id INTEGER,
        is_stack_top INTEGER NOT NULL DEFAULT 0,
        flag TEXT,
        UNIQUE(project_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_photos_project ON photos(project_id);

    CREATE TABLE IF NOT EXISTS face_results (
        id INTEGER PRIMARY KEY,
        photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
        bbox TEXT NOT NULL,
        sharpness REAL,
        ear REAL,
        eyes_open INTEGER,
        smile REAL
    );
    CREATE INDEX IF NOT EXISTS idx_faces_photo ON face_results(photo_id);

    CREATE TABLE IF NOT EXISTS edit_settings (
        photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
        settings TEXT NOT NULL,
        updated_at REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS training_samples (
        id INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL UNIQUE,
        features BLOB NOT NULL,
        targets BLOB NOT NULL,
        mask BLOB NOT NULL,
        created_at REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_profiles (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        config TEXT NOT NULL,
        model_path TEXT,
        created_at REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS presets (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        settings TEXT NOT NULL,
        created_at REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thumb_cache (
        photo_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        file TEXT NOT NULL,
        src_mtime REAL NOT NULL DEFAULT 0,
        created_at REAL NOT NULL,
        PRIMARY KEY(photo_path, size)
    );
    """)
    cur = conn.execute("SELECT version FROM schema_version")
    row = cur.fetchone()
    if row is None:
        conn.execute("INSERT INTO schema_version (version) VALUES (?)", (SCHEMA_VERSION,))
    elif row["version"] < 2:
        # v1 -> v2: culling columns added to photos
        for ddl in (
            "ALTER TABLE photos ADD COLUMN rating_source TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE photos ADD COLUMN capture_time REAL",
            "ALTER TABLE photos ADD COLUMN embedding BLOB",
            "ALTER TABLE photos ADD COLUMN aesthetic_score REAL",
            "ALTER TABLE photos ADD COLUMN face_quality REAL",
            "ALTER TABLE photos ADD COLUMN combined_score REAL",
            "ALTER TABLE photos ADD COLUMN stack_id INTEGER",
            "ALTER TABLE photos ADD COLUMN is_stack_top INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE photos ADD COLUMN flag TEXT",
        ):
            try:
                conn.execute(ddl)
            except sqlite3.OperationalError:
                pass  # column already exists
        conn.execute("UPDATE schema_version SET version = ?", (SCHEMA_VERSION,))
    conn.commit()


def _project_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "folder": row["folder"],
        "createdAt": row["created_at"],
        "lastOpenedAt": row["last_opened_at"],
    }


# --- Projects ---------------------------------------------------------------

def get_or_create_project(name: str, folder: str) -> dict:
    folder = os.path.normpath(folder)
    conn = _conn()
    row = conn.execute("SELECT * FROM projects WHERE folder = ?", (folder,)).fetchone()
    if row:
        touch_project(row["id"])
        return _project_dict(conn.execute("SELECT * FROM projects WHERE id = ?", (row["id"],)).fetchone())
    now = time.time()
    cur = conn.execute(
        "INSERT INTO projects (name, folder, created_at, last_opened_at) VALUES (?, ?, ?, ?)",
        (name, folder, now, now),
    )
    conn.commit()
    return _project_dict(conn.execute("SELECT * FROM projects WHERE id = ?", (cur.lastrowid,)).fetchone())


def get_project(project_id: int) -> dict | None:
    row = _conn().execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return _project_dict(row) if row else None


def list_projects() -> list[dict]:
    rows = _conn().execute("SELECT * FROM projects ORDER BY last_opened_at DESC").fetchall()
    return [_project_dict(r) for r in rows]


def touch_project(project_id: int):
    conn = _conn()
    conn.execute("UPDATE projects SET last_opened_at = ? WHERE id = ?", (time.time(), project_id))
    conn.commit()


def delete_project(project_id: int):
    conn = _conn()
    conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))  # cascades
    conn.commit()


# --- Photos -----------------------------------------------------------------

def upsert_photos(project_id: int, files: list[dict]):
    """files: [{filename, path, mtime, size}]. Inserts new rows; updates
    mtime/size on existing rows (analysis is NOT reset here — needs_analysis
    compares stored mtime/size against analyzed_at)."""
    conn = _conn()
    for f in files:
        conn.execute(
            """INSERT INTO photos (project_id, filename, path, mtime, size)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(project_id, path) DO UPDATE SET
                 mtime = excluded.mtime,
                 size = excluded.size,
                 analyzed_at = CASE
                   WHEN photos.mtime != excluded.mtime OR photos.size != excluded.size
                   THEN NULL ELSE photos.analyzed_at END""",
            (project_id, f["filename"], os.path.normpath(f["path"]), f.get("mtime", 0), f.get("size", 0)),
        )
    conn.commit()


def get_photos(project_id: int) -> list[dict]:
    """Returns PhotoEntry-shaped dicts (frontend contract) sorted by filename."""
    rows = _conn().execute(
        "SELECT * FROM photos WHERE project_id = ? ORDER BY filename", (project_id,)
    ).fetchall()
    entries = []
    for r in rows:
        scores = json.loads(r["scores"] or "{}")
        entries.append({
            "id": r["id"],
            "filename": r["filename"],
            "path": r["path"],
            "category": r["category"],
            "allLabels": json.loads(r["all_labels"] or "[]"),
            "scores": {
                "brightness": scores.get("brightness", 0),
                "blur": scores.get("blur", 0),
                "ear": scores.get("ear"),
                "aesthetic": r["aesthetic_score"],
                "faceQuality": r["face_quality"],
                "combined": r["combined_score"],
            },
            "starRating": r["star_rating"],
            "ratingSource": r["rating_source"],
            "stackId": r["stack_id"],
            "isStackTop": bool(r["is_stack_top"]),
            "flag": r["flag"],
        })
    return entries


def needs_analysis(project_id: int, path: str, mtime: float, size: int) -> bool:
    row = _conn().execute(
        "SELECT analyzed_at, mtime, size FROM photos WHERE project_id = ? AND path = ?",
        (project_id, os.path.normpath(path)),
    ).fetchone()
    if row is None or row["analyzed_at"] is None:
        return True
    return not (abs(row["mtime"] - mtime) < 1e-6 and row["size"] == size)


def set_analysis(project_id: int, filename: str, category: str, all_labels: list, scores: dict):
    conn = _conn()
    conn.execute(
        """UPDATE photos SET category = ?, all_labels = ?, scores = ?, analyzed_at = ?
           WHERE project_id = ? AND filename = ?""",
        (category, json.dumps(all_labels), json.dumps(scores), time.time(), project_id, filename),
    )
    conn.commit()


def mark_analyzed_clean(project_id: int, filename: str):
    """Photo analyzed, no problems found."""
    set_analysis(project_id, filename, "clean", [], {})


def set_analysis_scores_only(project_id: int, filename: str, scores: dict):
    """Store scores for a clean photo."""
    set_analysis(project_id, filename, "clean", [], scores)


def clear_analysis(project_id: int) -> int:
    conn = _conn()
    cur = conn.execute(
        """UPDATE photos SET category = 'clean', all_labels = '[]', scores = '{}', analyzed_at = NULL
           WHERE project_id = ? AND (category != 'clean' OR analyzed_at IS NOT NULL)""",
        (project_id,),
    )
    conn.commit()
    return cur.rowcount


def set_rating(project_id: int, filename: str, stars: int):
    """User-set rating — never overwritten by auto ratings."""
    conn = _conn()
    conn.execute(
        "UPDATE photos SET star_rating = ?, rating_source = 'user' WHERE project_id = ? AND filename = ?",
        (stars, project_id, filename),
    )
    conn.commit()


def set_auto_ratings(ratings: dict):
    """{photo_id: stars} — applied only where the user hasn't rated."""
    conn = _conn()
    for photo_id, stars in ratings.items():
        conn.execute(
            "UPDATE photos SET star_rating = ?, rating_source = 'auto' "
            "WHERE id = ? AND rating_source != 'user'",
            (stars, photo_id),
        )
    conn.commit()


def set_flag(project_id: int, filename: str, flag):
    """flag: 'pick' | 'reject' | None"""
    conn = _conn()
    conn.execute(
        "UPDATE photos SET flag = ? WHERE project_id = ? AND filename = ?",
        (flag, project_id, filename),
    )
    conn.commit()


def set_extra_analysis(photo_id: int, capture_time=None, embedding: bytes = None,
                       aesthetic: float = None, face_quality: float = None,
                       combined: float = None):
    conn = _conn()
    sets, vals = [], []
    for col, v in (("capture_time", capture_time), ("embedding", embedding),
                   ("aesthetic_score", aesthetic), ("face_quality", face_quality),
                   ("combined_score", combined)):
        if v is not None:
            sets.append(f"{col} = ?")
            vals.append(v)
    if not sets:
        return
    vals.append(photo_id)
    conn.execute(f"UPDATE photos SET {', '.join(sets)} WHERE id = ?", vals)
    conn.commit()


def get_culling_rows(project_id: int) -> list[dict]:
    """Rows needed for stacking/scoring: id, filename, times, vectors, scores."""
    rows = _conn().execute(
        """SELECT id, filename, path, mtime, capture_time, embedding,
                  aesthetic_score, face_quality, category, scores
           FROM photos WHERE project_id = ? ORDER BY filename""",
        (project_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def apply_stacks(project_id: int, stack_map: dict):
    """stack_map: {photo_id: (stack_id | None, is_top)} — applied to ALL photos
    in the project (photos absent from the map get their stack cleared)."""
    conn = _conn()
    conn.execute(
        "UPDATE photos SET stack_id = NULL, is_stack_top = 0 WHERE project_id = ?",
        (project_id,),
    )
    for photo_id, (stack_id, is_top) in stack_map.items():
        conn.execute(
            "UPDATE photos SET stack_id = ?, is_stack_top = ? WHERE id = ?",
            (stack_id, 1 if is_top else 0, photo_id),
        )
    conn.commit()


def set_face_results(photo_id: int, faces: list):
    """faces: [{bbox: [x,y,w,h], sharpness, ear, eyes_open, smile}]"""
    conn = _conn()
    conn.execute("DELETE FROM face_results WHERE photo_id = ?", (photo_id,))
    for f in faces:
        conn.execute(
            "INSERT INTO face_results (photo_id, bbox, sharpness, ear, eyes_open, smile) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (photo_id, json.dumps(f.get("bbox")), f.get("sharpness"), f.get("ear"),
             1 if f.get("eyes_open") else 0, f.get("smile")),
        )
    conn.commit()


def get_face_results(photo_id: int) -> list[dict]:
    rows = _conn().execute(
        "SELECT * FROM face_results WHERE photo_id = ?", (photo_id,)
    ).fetchall()
    return [
        {"bbox": json.loads(r["bbox"]) if r["bbox"] else None,
         "sharpness": r["sharpness"], "ear": r["ear"],
         "eyesOpen": bool(r["eyes_open"]), "smile": r["smile"]}
        for r in rows
    ]


def get_photo_id(project_id: int, filename: str):
    row = _conn().execute(
        "SELECT id FROM photos WHERE project_id = ? AND filename = ?",
        (project_id, filename),
    ).fetchone()
    return row["id"] if row else None


def set_category(project_id: int, filename: str, category: str):
    conn = _conn()
    conn.execute(
        "UPDATE photos SET category = ? WHERE project_id = ? AND filename = ?",
        (category, project_id, filename),
    )
    conn.commit()


def get_photo(photo_id: int) -> dict | None:
    row = _conn().execute("SELECT * FROM photos WHERE id = ?", (photo_id,)).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "filename": row["filename"],
        "path": row["path"],
    }


# --- Edit settings ----------------------------------------------------------

def set_edit_settings(photo_id: int, settings: dict):
    conn = _conn()
    conn.execute(
        """INSERT INTO edit_settings (photo_id, settings, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(photo_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at""",
        (photo_id, json.dumps(settings), time.time()),
    )
    conn.commit()


def get_edit_settings(photo_id: int) -> dict | None:
    row = _conn().execute(
        "SELECT settings FROM edit_settings WHERE photo_id = ?", (photo_id,)
    ).fetchone()
    return json.loads(row["settings"]) if row else None


def delete_edit_settings(photo_id: int):
    conn = _conn()
    conn.execute("DELETE FROM edit_settings WHERE photo_id = ?", (photo_id,))
    conn.commit()


def add_training_sample(source_path: str, features: bytes, targets: bytes, mask: bytes):
    conn = _conn()
    conn.execute(
        """INSERT INTO training_samples (source_path, features, targets, mask, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(source_path) DO UPDATE SET
             features = excluded.features, targets = excluded.targets,
             mask = excluded.mask, created_at = excluded.created_at""",
        (os.path.normpath(source_path), features, targets, mask, time.time()),
    )
    conn.commit()


def get_training_samples() -> list[dict]:
    rows = _conn().execute("SELECT * FROM training_samples ORDER BY id").fetchall()
    return [dict(r) for r in rows]


def count_training_samples() -> int:
    return _conn().execute("SELECT COUNT(*) AS n FROM training_samples").fetchone()["n"]


def clear_training_samples():
    conn = _conn()
    conn.execute("DELETE FROM training_samples")
    conn.commit()


def set_ai_profile_model(model_path: str):
    conn = _conn()
    # Ensure the row exists, then set the model path
    conn.execute(
        """INSERT INTO ai_profiles (id, name, config, created_at) VALUES (1, 'Default', '{}', ?)
           ON CONFLICT(id) DO NOTHING""",
        (time.time(),),
    )
    conn.execute("UPDATE ai_profiles SET model_path = ? WHERE id = 1", (model_path,))
    conn.commit()


def get_ai_profile_model() -> str | None:
    row = _conn().execute("SELECT model_path FROM ai_profiles WHERE id = 1").fetchone()
    return row["model_path"] if row else None


def get_ai_profile() -> dict | None:
    """The default (single, id=1) AI profile config, or None."""
    row = _conn().execute("SELECT * FROM ai_profiles WHERE id = 1").fetchone()
    if row is None:
        return None
    return {"id": row["id"], "name": row["name"], "config": json.loads(row["config"])}


def save_ai_profile(config: dict, name: str = "Default"):
    conn = _conn()
    conn.execute(
        """INSERT INTO ai_profiles (id, name, config, created_at) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config""",
        (name, json.dumps(config), time.time()),
    )
    conn.commit()


def get_edit_settings_map(project_id: int) -> dict:
    """Returns {photo_path: settings_dict} for the frontend editSettingsMap."""
    rows = _conn().execute(
        """SELECT p.path, e.settings FROM edit_settings e
           JOIN photos p ON p.id = e.photo_id WHERE p.project_id = ?""",
        (project_id,),
    ).fetchall()
    return {r["path"]: json.loads(r["settings"]) for r in rows}


# --- Presets ------------------------------------------------------------------

def save_preset(name: str, settings: dict) -> dict:
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO presets (name, settings, created_at) VALUES (?, ?, ?)",
        (name, json.dumps(settings), time.time()),
    )
    conn.commit()
    return {"id": cur.lastrowid, "name": name, "settings": settings}


def list_presets() -> list[dict]:
    rows = _conn().execute("SELECT * FROM presets ORDER BY name").fetchall()
    return [
        {"id": r["id"], "name": r["name"], "settings": json.loads(r["settings"])}
        for r in rows
    ]


def delete_preset(preset_id: int):
    conn = _conn()
    conn.execute("DELETE FROM presets WHERE id = ?", (preset_id,))
    conn.commit()


# --- Thumbnail cache index ---------------------------------------------------

def get_cached_thumb(photo_path: str, size: int) -> dict | None:
    row = _conn().execute(
        "SELECT file, src_mtime FROM thumb_cache WHERE photo_path = ? AND size = ?",
        (os.path.normpath(photo_path), size),
    ).fetchone()
    return {"file": row["file"], "src_mtime": row["src_mtime"]} if row else None


def put_cached_thumb(photo_path: str, size: int, file: str, src_mtime: float):
    conn = _conn()
    conn.execute(
        """INSERT INTO thumb_cache (photo_path, size, file, src_mtime, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(photo_path, size) DO UPDATE SET
             file = excluded.file, src_mtime = excluded.src_mtime, created_at = excluded.created_at""",
        (os.path.normpath(photo_path), size, file, src_mtime, time.time()),
    )
    conn.commit()


# --- Legacy JSON import -------------------------------------------------------

def import_legacy_json(project_id: int, folder: str) -> dict:
    """Import _classifications.json + _ratings.json into the DB, then rename
    them to *.bak. Photos must already be upserted (call after upsert_photos),
    or rows are created on the fly for files present in the JSON."""
    imported = {"classifications": 0, "ratings": 0}
    conn = _conn()

    class_path = os.path.join(folder, "_classifications.json")
    if os.path.exists(class_path):
        with open(class_path, "r", encoding="utf-8") as f:
            classifications = json.load(f)
        for fname, cls in classifications.items():
            fpath = os.path.normpath(os.path.join(folder, fname))
            conn.execute(
                """INSERT INTO photos (project_id, filename, path) VALUES (?, ?, ?)
                   ON CONFLICT(project_id, path) DO NOTHING""",
                (project_id, fname, fpath),
            )
            conn.execute(
                """UPDATE photos SET category = ?, all_labels = ?, scores = ?, analyzed_at = ?
                   WHERE project_id = ? AND filename = ?""",
                (cls.get("primary_category", "clean"), json.dumps(cls.get("all_labels", [])),
                 json.dumps(cls.get("scores", {})), time.time(), project_id, fname),
            )
            imported["classifications"] += 1
        conn.commit()
        shutil.move(class_path, class_path + ".bak")

    ratings_path = os.path.join(folder, "_ratings.json")
    if os.path.exists(ratings_path):
        with open(ratings_path, "r", encoding="utf-8") as f:
            ratings = json.load(f)
        for fname, stars in ratings.items():
            fpath = os.path.normpath(os.path.join(folder, fname))
            conn.execute(
                """INSERT INTO photos (project_id, filename, path) VALUES (?, ?, ?)
                   ON CONFLICT(project_id, path) DO NOTHING""",
                (project_id, fname, fpath),
            )
            conn.execute(
                "UPDATE photos SET star_rating = ? WHERE project_id = ? AND filename = ?",
                (stars, project_id, fname),
            )
            imported["ratings"] += 1
        conn.commit()
        shutil.move(ratings_path, ratings_path + ".bak")

    return imported


# --- Smoke test ---------------------------------------------------------------

if __name__ == "__main__":
    import tempfile

    _data_dir_override = tempfile.mkdtemp(prefix="catalog_test_")
    print(f"Test data dir: {_data_dir_override}")

    p = get_or_create_project("Test", r"C:\fake\folder")
    assert p["id"] == 1, p
    p2 = get_or_create_project("Test again", r"C:\fake\folder")
    assert p2["id"] == p["id"], "same folder must return same project"
    assert len(list_projects()) == 1

    upsert_photos(p["id"], [
        {"filename": "a.jpg", "path": r"C:\fake\folder\a.jpg", "mtime": 100.0, "size": 10},
        {"filename": "b.nef", "path": r"C:\fake\folder\b.nef", "mtime": 200.0, "size": 20},
    ])
    photos = get_photos(p["id"])
    assert len(photos) == 2 and photos[0]["id"] > 0

    assert needs_analysis(p["id"], r"C:\fake\folder\a.jpg", 100.0, 10)
    set_analysis(p["id"], "a.jpg", "_blurry", ["_blurry"], {"blur": 12.3, "brightness": 90})
    assert not needs_analysis(p["id"], r"C:\fake\folder\a.jpg", 100.0, 10)
    assert needs_analysis(p["id"], r"C:\fake\folder\a.jpg", 101.0, 10), "mtime change must re-analyze"

    # mtime change on upsert resets analyzed_at
    upsert_photos(p["id"], [{"filename": "a.jpg", "path": r"C:\fake\folder\a.jpg", "mtime": 101.0, "size": 10}])
    assert needs_analysis(p["id"], r"C:\fake\folder\a.jpg", 101.0, 10)

    set_rating(p["id"], "a.jpg", 4)
    set_category(p["id"], "a.jpg", "clean")
    photos = get_photos(p["id"])
    a = next(x for x in photos if x["filename"] == "a.jpg")
    assert a["starRating"] == 4 and a["category"] == "clean"

    set_edit_settings(a["id"], {"exposure": 1.5, "contrast": 10})
    m = get_edit_settings_map(p["id"])
    assert m[a["path"]]["exposure"] == 1.5

    put_cached_thumb(a["path"], 300, "abc.jpg", 100.0)
    c = get_cached_thumb(a["path"], 300)
    assert c["file"] == "abc.jpg"

    set_analysis(p["id"], "a.jpg", "_dark", ["_dark"], {"brightness": 30})
    assert clear_analysis(p["id"]) >= 1
    photos = get_photos(p["id"])
    assert all(x["category"] == "clean" for x in photos)

    # legacy import
    legacy_dir = tempfile.mkdtemp(prefix="legacy_")
    with open(os.path.join(legacy_dir, "_classifications.json"), "w", encoding="utf-8") as f:
        json.dump({"x.jpg": {"primary_category": "_dark", "all_labels": ["_dark"], "scores": {"brightness": 20}}}, f)
    with open(os.path.join(legacy_dir, "_ratings.json"), "w", encoding="utf-8") as f:
        json.dump({"x.jpg": 5}, f)
    lp = get_or_create_project("Legacy", legacy_dir)
    result = import_legacy_json(lp["id"], legacy_dir)
    assert result == {"classifications": 1, "ratings": 1}, result
    assert os.path.exists(os.path.join(legacy_dir, "_classifications.json.bak"))
    lphotos = get_photos(lp["id"])
    assert lphotos[0]["category"] == "_dark" and lphotos[0]["starRating"] == 5

    delete_project(p["id"])
    assert len(list_projects()) == 1  # only legacy left

    print("catalog.py smoke test: ALL PASSED")
