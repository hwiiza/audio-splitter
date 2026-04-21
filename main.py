#!/usr/bin/env python3
"""音声台本分割 Web — Phase 1 backend (FastAPI)"""

import asyncio, os, re, shutil, subprocess, tempfile, uuid, zipfile
from collections import defaultdict
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="音声台本分割 Web")

# ── CORS ──────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://hwiiza.github.io",   # GitHub Pages
        "http://localhost:8000",       # ローカル開発
        "http://127.0.0.1:8000",
        "http://localhost:5500",       # Live Server など
        "http://127.0.0.1:5500",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── session store (in-memory) ─────────────────────────────
_sessions: dict = {}
_WORK = Path(tempfile.gettempdir()) / "audio_web"
_WORK.mkdir(exist_ok=True)

# ── ffmpeg ────────────────────────────────────────────────
def _ffmpeg() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return "ffmpeg"

_FF = _ffmpeg()

def _load_audio(path: str):
    cmd = [_FF, "-i", path, "-ar", "22050", "-ac", "1", "-f", "f32le", "-"]
    r = subprocess.run(cmd, capture_output=True, stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + r.stderr.decode(errors="replace")[-200:])
    arr = np.frombuffer(r.stdout, dtype=np.float32).copy()
    dur = len(arr) / 22050 * 1000.0
    return arr, 22050, dur

def _make_waveform(arr: np.ndarray, n: int = 3000) -> list:
    if len(arr) == 0:
        return [0.0] * n
    peak = float(np.max(np.abs(arr))) or 1.0
    chunks = np.array_split(arr, n)
    return [float(np.max(np.abs(c))) / peak if len(c) else 0.0 for c in chunks]

def _parse_script(text: str):
    chars, lines = [], []
    for raw in text.strip().splitlines():
        raw = raw.strip()
        if not raw:
            continue
        parts = raw.split("\t", 1)
        if len(parts) == 2 and parts[0].strip():
            chars.append(parts[0].strip())
            lines.append(parts[1].strip())
        else:
            chars.append("")
            lines.append(raw)
    return chars, lines

# ── API ───────────────────────────────────────────────────
@app.post("/api/sessions")
async def create_session(file: UploadFile = File(...)):
    sid = str(uuid.uuid4())
    d = _WORK / sid
    d.mkdir()
    ext = Path(file.filename or "audio.mp3").suffix or ".mp3"
    audio_path = str(d / f"audio{ext}")
    with open(audio_path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    try:
        arr, sr, dur = await asyncio.to_thread(_load_audio, audio_path)
    except Exception as e:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, str(e))
    waveform = await asyncio.to_thread(_make_waveform, arr)
    _sessions[sid] = {
        "audio_path": audio_path,
        "duration_ms": dur,
        "waveform": waveform,
        "markers": [],
        "script_chars": [],
        "script_lines": [],
        "name": Path(file.filename or "audio").stem,
    }
    s = _sessions[sid]
    return {
        "sid": sid, "name": s["name"], "duration_ms": dur,
        "waveform": waveform, "markers": [],
        "script_chars": [], "script_lines": [],
    }

@app.get("/api/sessions/{sid}/audio")
async def get_audio(sid: str):
    if sid not in _sessions:
        raise HTTPException(404)
    return FileResponse(_sessions[sid]["audio_path"])

@app.get("/api/sessions/{sid}")
async def get_session(sid: str):
    if sid not in _sessions:
        raise HTTPException(404)
    s = _sessions[sid]
    return {k: s[k] for k in ("name","duration_ms","waveform","markers","script_chars","script_lines")}

class PatchBody(BaseModel):
    markers: Optional[list[float]] = None
    script_chars: Optional[list[str]] = None
    script_lines: Optional[list[str]] = None
    assigned_char: Optional[str] = None

@app.patch("/api/sessions/{sid}")
async def patch_session(sid: str, body: PatchBody):
    if sid not in _sessions:
        raise HTTPException(404)
    s = _sessions[sid]
    if body.markers is not None:
        s["markers"] = sorted(body.markers)
    if body.script_chars is not None:
        s["script_chars"] = body.script_chars
    if body.script_lines is not None:
        s["script_lines"] = body.script_lines
    if body.assigned_char is not None:
        s["assigned_char"] = body.assigned_char
    return {"ok": True}

class ParseScriptBody(BaseModel):
    text: str

class DetectSilenceBody(BaseModel):
    n_segments: int = 0
    threshold_ratio: float = 0.05

@app.post("/api/parse-script")
async def parse_script_generic(body: ParseScriptBody):
    chars, lines = _parse_script(body.text)
    return {"script_chars": chars, "script_lines": lines}

@app.post("/api/sessions/{sid}/parse-script")
async def parse_script_ep(sid: str, body: ParseScriptBody):
    if sid not in _sessions:
        raise HTTPException(404)
    chars, lines = _parse_script(body.text)
    _sessions[sid]["script_chars"] = chars
    _sessions[sid]["script_lines"] = lines
    return {"script_chars": chars, "script_lines": lines}

@app.post("/api/sessions/{sid}/detect-silence")
async def detect_silence_ep(sid: str, body: DetectSilenceBody):
    if sid not in _sessions:
        raise HTTPException(404)
    s = _sessions[sid]
    audio_path = s["audio_path"]
    dur_ms = s["duration_ms"]
    n_segs = body.n_segments
    thr_ratio = body.threshold_ratio

    def _worker():
        arr, sr, _ = _load_audio(audio_path)
        win  = max(1, sr // 20)
        step = win // 2
        rms  = np.array([
            np.sqrt(np.mean(arr[i:i+win]**2))
            for i in range(0, max(1, len(arr) - win), step)
        ])
        peak = float(np.max(rms)) or 1.0
        thr  = peak * thr_ratio
        silent = rms < thr
        edges  = np.diff(silent.astype(int))
        starts = np.where(edges == 1)[0]
        ends   = np.where(edges == -1)[0]
        if len(starts) == 0 or len(ends) == 0:
            return []
        if starts[0] > ends[0]:
            ends = ends[1:]
        mn = min(len(starts), len(ends))
        starts, ends = starts[:mn], ends[:mn]
        mids = []
        for si, ei in zip(starts, ends):
            if (ei - si) * step / sr * 1000 >= 80:
                mids.append(float((si + ei) / 2 * step / sr * 1000))
        n_want = n_segs - 1
        if n_want > 0 and len(mids) > n_want:
            ideal = [dur_ms * i / n_segs for i in range(1, n_segs)]
            selected = []
            for target in ideal:
                closest = min(mids, key=lambda m: abs(m - target))
                selected.append(closest)
            mids = sorted(set(selected))
        elif n_want > 0:
            mids = mids[:n_want]
        return mids

    markers = await asyncio.to_thread(_worker)
    s["markers"] = sorted(markers)
    return {"markers": s["markers"], "count": len(markers)}

# ── Export helpers ───────────────────────────────────────
def _sanitize(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|\s]+', '_', name).strip('_') or "unnamed"

def _ms_to_srt(ms: float) -> str:
    """Standard SRT: HH:MM:SS,mmm"""
    t = round(ms)
    h, t = divmod(t, 3600000)
    m, t = divmod(t, 60000)
    s, ms_r = divmod(t, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms_r:03d}"

def _extract_segment(audio_path: str, start_ms: float, end_ms: float, out_path: str) -> bool:
    ss = start_ms / 1000
    to = end_ms   / 1000
    cmd = [
        _FF, "-y", "-i", audio_path,
        "-filter_complex",
        f"[0:a]atrim=start={ss:.6f}:end={to:.6f},asetpts=PTS-STARTPTS[a]",
        "-map", "[a]",
        "-ar", "44100", "-b:a", "192k",
        out_path,
    ]
    r = subprocess.run(cmd, capture_output=True, stdin=subprocess.DEVNULL)
    return r.returncode == 0

def _generate_silence(duration_ms: float, out_path: str, sr: int = 44100) -> bool:
    cmd = [
        _FF, "-y",
        "-f", "lavfi", "-i", f"anullsrc=r={sr}:cl=stereo",
        "-t", f"{duration_ms / 1000:.6f}",
        "-b:a", "192k",
        out_path,
    ]
    r = subprocess.run(cmd, capture_output=True, stdin=subprocess.DEVNULL)
    return r.returncode == 0

class ExportBody(BaseModel):
    add_gap: bool = False
    mob_chars: list[str] = []
    slots: Optional[list] = None   # フロントエンドから無音トリム済みスロットを受け取る

@app.post("/api/sessions/{sid}/export-segments")
async def export_segments(sid: str, body: ExportBody):
    if sid not in _sessions:
        raise HTTPException(404)
    s = _sessions[sid]
    positions = [0.0] + sorted(s["markers"]) + [s["duration_ms"]]
    gap_ms    = 800.0 if body.add_gap else 0.0

    out_dir = Path(s["audio_path"]).parent / "segs"
    out_dir.mkdir(exist_ok=True)

    exported = []
    for i in range(len(positions) - 1):
        seg_s, seg_e = positions[i], positions[i + 1]
        if seg_e - seg_s < 20:   # skip < 20ms
            continue
        char = s["script_chars"][i] if i < len(s["script_chars"]) else ""
        safe = _sanitize(char) if char else "segment"
        fname = f"{i+1:03d}_{safe}.mp3"
        out_path = str(out_dir / fname)
        ok = await asyncio.to_thread(_extract_segment,
                                     s["audio_path"], seg_s, seg_e, out_path)
        if ok:
            exported.append((fname, out_path))

    if not exported:
        raise HTTPException(400, "書き出せるセグメントがありません")

    zip_path = str(Path(s["audio_path"]).parent / "segments.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname, path in exported:
            zf.write(path, fname)

    return FileResponse(zip_path, filename="segments.zip",
                        media_type="application/zip")

@app.post("/api/sessions/{sid}/export-srt")
async def export_srt(sid: str, body: ExportBody):
    if sid not in _sessions:
        raise HTTPException(404)
    s = _sessions[sid]
    if not s["script_lines"]:
        raise HTTPException(400, "台本が設定されていません")

    positions  = [0.0] + sorted(s["markers"]) + [s["duration_ms"]]
    gap_ms     = 800.0 if body.add_gap else 0.0
    char_evts  = defaultdict(list)
    cum        = 0.0

    for i in range(len(positions) - 1):
        dur  = positions[i + 1] - positions[i]
        char = s["script_chars"][i] if i < len(s["script_chars"]) else ""
        line = s["script_lines"][i] if i < len(s["script_lines"]) else ""
        if char or line:
            char_evts[char or "unknown"].append(
                (cum, cum + dur + gap_ms, char, line))
        cum += dur + gap_ms

    if not char_evts:
        raise HTTPException(400, "書き出しデータがありません")

    out_dir = Path(s["audio_path"]).parent / "srt"
    out_dir.mkdir(exist_ok=True)
    written  = []

    for char, evts in char_evts.items():
        safe = _sanitize(char)

        # セリフ用
        fname = f"セリフ_{safe}.srt"
        rows  = []
        for idx, (st, en, ch, text) in enumerate(evts, 1):
            rows += [str(idx), f"{_ms_to_srt(st)} --> {_ms_to_srt(en)}",
                     f">> {ch}_セリフ: {text}", ""]
        with open(out_dir / fname, "w", encoding="utf-8") as f:
            f.write("\n".join(rows))
        written.append((fname, out_dir / fname))

        # キャラ名用
        fname2 = f"キャラ名_{safe}.srt"
        rows2  = []
        for idx, (st, en, ch, _) in enumerate(evts, 1):
            rows2 += [str(idx), f"{_ms_to_srt(st)} --> {_ms_to_srt(en)}",
                      f">> キャラ名: {ch}", ""]
        with open(out_dir / fname2, "w", encoding="utf-8") as f:
            f.write("\n".join(rows2))
        written.append((fname2, out_dir / fname2))

    zip_path = str(Path(s["audio_path"]).parent / "srt.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname, path in written:
            zf.write(str(path), fname)

    return FileResponse(zip_path, filename="srt.zip",
                        media_type="application/zip")

# ── Project management ───────────────────────────────────
_projects: dict = {}

class ProjectBody(BaseModel):
    set_ids: list[str]

@app.post("/api/projects")
async def create_project(body: ProjectBody):
    for sid in body.set_ids:
        if sid not in _sessions:
            raise HTTPException(404, f"session {sid} not found")
    pid = str(uuid.uuid4())
    _projects[pid] = {"pid": pid, "set_ids": list(body.set_ids), "master_chars": [], "master_lines": []}
    return {"pid": pid}

@app.patch("/api/projects/{pid}/master-script")
async def set_project_master(pid: str, body: ParseScriptBody):
    if pid not in _projects:
        raise HTTPException(404)
    chars, lines = _parse_script(body.text)
    _projects[pid]["master_chars"] = chars
    _projects[pid]["master_lines"] = lines
    return {"master_chars": chars, "master_lines": lines}

def _compute_layout(pid: str) -> dict:
    proj = _projects[pid]
    sets = [_sessions[sid] for sid in proj["set_ids"] if sid in _sessions]
    master_chars = proj["master_chars"]
    master_lines = proj["master_lines"]
    char_to_set = {}
    for si, s in enumerate(sets):
        ac = s.get("assigned_char", "")
        if ac:
            char_to_set[ac] = si
    char_counter = {}
    slots = []
    for i, (line, char) in enumerate(zip(master_lines, master_chars)):
        si = char_to_set.get(char)
        provider = None
        seg_s = seg_e = 0.0
        if si is not None:
            s = sets[si]
            seg_idx = char_counter.get(char, 0)
            markers = sorted(s.get("markers", []))
            positions = [0.0] + markers + [s["duration_ms"]]
            if seg_idx < len(positions) - 1:
                seg_s = positions[seg_idx]
                seg_e = positions[seg_idx + 1]
                provider = si
            char_counter[char] = char_counter.get(char, 0) + 1
        slots.append({"idx": i, "char": char, "line": line, "provider": provider,
                       "seg_s": seg_s, "seg_e": seg_e, "duration_ms": max(0.0, seg_e - seg_s)})
    seen = []
    for c in master_chars:
        if c and c not in seen:
            seen.append(c)
    char_rows = [{"char": c, "set_idx": char_to_set.get(c)} for c in seen]
    sets_info = [{"name": s["name"], "assigned_char": s.get("assigned_char",""),
                   "duration_ms": s["duration_ms"], "waveform": s["waveform"],
                   "markers": sorted(s.get("markers", []))} for s in sets]
    return {"slots": slots, "char_rows": char_rows, "sets": sets_info,
            "master_chars": master_chars, "master_lines": master_lines}

@app.get("/api/projects/{pid}/layout")
async def get_layout(pid: str):
    if pid not in _projects:
        raise HTTPException(404)
    return _compute_layout(pid)

def _export_char_single(audio_path: str, slots: list, char_si, gap_ms: float, out_path: str) -> bool:
    """
    1キャラクター分の音声を filter_complex 1回のffmpeg呼び出しで書き出す。
    セグメント数に関係なくffmpegは1回だけ実行されるため大幅に高速化される。
    """
    # 実音声スロットのインデックスを把握（asplit に必要）
    audio_idxs = [i for i, s in enumerate(slots)
                  if s.get("provider") == char_si and s.get("duration_ms", 0) > 10]
    n_audio = len(audio_idxs)
    audio_rank = {idx: k for k, idx in enumerate(audio_idxs)}

    filter_parts, ordered_labels = [], []

    # 入力音声ストリームを必要数に分割
    if n_audio == 1:
        filter_parts.append("[0:a]anull[_a0]")
    elif n_audio > 1:
        outs = "".join(f"[_a{k}]" for k in range(n_audio))
        filter_parts.append(f"[0:a]asplit={n_audio}{outs}")

    for i, slot in enumerate(slots):
        dur_ms = slot.get("duration_ms", 0)
        is_audio = (slot.get("provider") == char_si and dur_ms > 10)

        if is_audio:
            k = audio_rank[i]
            ss, to = slot["seg_s"] / 1000, slot["seg_e"] / 1000
            lbl = f"s{i}"
            filter_parts.append(
                f"[_a{k}]atrim=start={ss:.6f}:end={to:.6f},asetpts=PTS-STARTPTS[{lbl}]"
            )
            ordered_labels.append(f"[{lbl}]")
        elif dur_ms > 10:
            lbl = f"s{i}"
            filter_parts.append(
                f"aevalsrc=0:c=stereo:s=44100:d={dur_ms/1000:.6f}[{lbl}]"
            )
            ordered_labels.append(f"[{lbl}]")

        if gap_ms > 0:
            glbl = f"g{i}"
            filter_parts.append(
                f"aevalsrc=0:c=stereo:s=44100:d={gap_ms/1000:.6f}[{glbl}]"
            )
            ordered_labels.append(f"[{glbl}]")

    if not ordered_labels:
        return False

    n = len(ordered_labels)
    if n == 1:
        filter_parts.append(f"{ordered_labels[0]}anull[out]")
    else:
        filter_parts.append(f"{''.join(ordered_labels)}concat=n={n}:v=0:a=1[out]")

    fc = "; ".join(filter_parts)
    cmd = [_FF, "-y"]
    if n_audio > 0:
        cmd += ["-i", audio_path]
    cmd += ["-filter_complex", fc, "-map", "[out]", "-ar", "44100", "-b:a", "192k", out_path]

    r = subprocess.run(cmd, capture_output=True, stdin=subprocess.DEVNULL)
    return r.returncode == 0

@app.post("/api/projects/{pid}/export")
async def export_project_audio(pid: str, body: ExportBody):
    if pid not in _projects:
        raise HTTPException(404)
    layout = _compute_layout(pid)
    # フロントから無音トリム済みスロットが渡された場合はそちらを使う
    slots = body.slots if body.slots is not None else layout["slots"]
    char_rows = layout["char_rows"]
    if not slots:
        raise HTTPException(400, "マスター台本が設定されていません")
    proj = _projects[pid]
    sets = [_sessions[sid] for sid in proj["set_ids"] if sid in _sessions]
    gap_ms = 800.0 if body.add_gap else 0.0
    out_dir = _WORK / pid / "export"
    out_dir.mkdir(parents=True, exist_ok=True)
    final_files = []
    for row in char_rows:
        char = row["char"]
        si = row["set_idx"]
        if si is None:
            continue
        s = sets[si]
        safe = _sanitize(char)
        out_path = str(out_dir / f"{safe}.mp3")
        ok = await asyncio.to_thread(_export_char_single, s["audio_path"], slots, si, gap_ms, out_path)
        if ok:
            final_files.append((f"{safe}.mp3", out_path))
    if not final_files:
        raise HTTPException(400, "音声の結合に失敗しました")
    zip_path = str(_WORK / pid / "audio_export.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname, path in final_files:
            zf.write(path, fname)
    return FileResponse(zip_path, filename="audio_export.zip", media_type="application/zip")

@app.post("/api/projects/{pid}/export-srt")
async def export_project_srt(pid: str, body: ExportBody):
    if pid not in _projects:
        raise HTTPException(404)
    layout = _compute_layout(pid)
    # フロントから無音トリム済みスロットが渡された場合はそちらを使う
    slots = body.slots if body.slots is not None else layout["slots"]
    if not slots:
        raise HTTPException(400, "マスター台本が設定されていません")
    proj = _projects[pid]
    gap_ms = 800.0 if body.add_gap else 0.0
    char_evts: dict = defaultdict(list)
    cum = 0.0
    for slot in slots:
        dur_ms = slot["duration_ms"]
        if slot["provider"] is not None:
            char_evts[slot["char"]].append((cum, cum + dur_ms + gap_ms, slot["char"], slot["line"]))
        cum += dur_ms + gap_ms
    if not char_evts:
        raise HTTPException(400, "書き出しデータがありません")
    out_dir = _WORK / proj["pid"] / "srt"
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for char, evts in char_evts.items():
        safe     = _sanitize(char)
        is_mob   = char in body.mob_chars
        serifu_name = "モブ" if is_mob else char   # セリフファイルの発話者表記
        # セリフ_xxx.srt: モブ時は「モブ_セリフ」、通常は「キャラ名_セリフ」
        fname = f"セリフ_{safe}.srt"
        rows  = []
        for idx, (st, en, ch, text) in enumerate(evts, 1):
            rows += [str(idx), f"{_ms_to_srt(st)} --> {_ms_to_srt(en)}", f">> {serifu_name}_セリフ: {text}", ""]
        with open(out_dir / fname, "w", encoding="utf-8") as f:
            f.write("\n".join(rows))
        written.append((fname, out_dir / fname))
        # キャラ名_xxx.srt: モブでも実際のキャラ名をそのまま使用
        fname2 = f"キャラ名_{safe}.srt"
        rows2  = []
        for idx, (st, en, ch, _) in enumerate(evts, 1):
            rows2 += [str(idx), f"{_ms_to_srt(st)} --> {_ms_to_srt(en)}", f">> キャラ名: {char}", ""]
        with open(out_dir / fname2, "w", encoding="utf-8") as f:
            f.write("\n".join(rows2))
        written.append((fname2, out_dir / fname2))
    zip_path = str(_WORK / proj["pid"] / "srt_export.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname, path in written:
            zf.write(str(path), fname)
    return FileResponse(zip_path, filename="srt_export.zip", media_type="application/zip")

# reorder.html と reorder.js は常にno-cacheで配信 (キャッシュバスティング)
_NO_CACHE = {"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"}

@app.get("/reorder.html")
async def serve_reorder_html():
    return FileResponse("docs/reorder.html", headers=_NO_CACHE)

@app.get("/reorder.js")
async def serve_reorder_js():
    return FileResponse("docs/reorder.js", headers=_NO_CACHE)

# static files — must be mounted last
app.mount("/", StaticFiles(directory="docs", html=True), name="static")
