'use strict';
const API_BASE = window.API_BASE || '';

// ═══════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════
const S = {
  sets:         [],   // [{sid,name,assigned_char,waveform,markers,duration_ms}]
  master_chars: [],
  master_lines: [],
  currentIdx:   -1,
  pxPerMs:      0.15,
  scrollMs:     0,
  playhead_ms:  0,
  isPlaying:    false,
  pendingSets:        {},   // {name → {assigned_char, markers, duration_ms}} — restored from project file
  pendingSelectedChar: '',  // プロジェクト復元時に選択するキャラ名
  mobChars:           new Set(),   // モブフラグが立っているキャラ名
};

function curSet()      { return S.currentIdx >= 0 ? S.sets[S.currentIdx] : null; }
function curSid()      { const s = curSet(); return s ? s.sid : null; }
function curDuration() { const s = curSet(); return s ? s.duration_ms : 0; }
function curWaveform() { const s = curSet(); return s ? s.waveform : []; }
function curMarkers()  { const s = curSet(); return s ? s.markers : []; }

// Script lines for current set (ordered subset of master matching assigned_char)
function curScriptLines() {
  const s = curSet();
  if (!s || !s.assigned_char) return [];
  const lines = [];
  S.master_chars.forEach((c, i) => {
    if (c === s.assigned_char) lines.push(S.master_lines[i]);
  });
  return lines;
}

// ═══════════════════════════════════════════════════════
//  DOM refs
// ═══════════════════════════════════════════════════════
const IDS = [
  'btn-open-proj','btn-save-proj',
  'btn-script','btn-equal','btn-detect','btn-undo',
  'btn-play','btn-stop',
  'btn-zoom-in','btn-zoom-out','zoom-label',
  'btn-add-file','file-input','script-file-input','file-list','char-tbody',
  'silence-threshold','silence-db-label',
  'seg-header-cv','waveform-canvas','ruler-canvas',
  'scrollbar-wrap','scrollbar-track','scrollbar-thumb',
  'drop-zone-overlay','status-info','playhead-time',
  'script-method-overlay','btn-script-file','btn-script-clip','btn-script-method-cancel',
  'script-overlay','script-textarea','btn-script-cancel','btn-script-ok',
  'proj-input','audio-el','btn-reorder',
  'char-rename-overlay','char-rename-input','btn-char-rename-cancel','btn-char-rename-ok',
];
const D = {};
IDS.forEach(id => { D[id.replace(/-/g,'_')] = document.getElementById(id); });

const wCv   = D.waveform_canvas;
const rCv   = D.ruler_canvas;
const shCv  = D.seg_header_cv;
const wCtx  = wCv.getContext('2d');
const rCtx  = rCv.getContext('2d');
const shCtx = shCv.getContext('2d');

// ═══════════════════════════════════════════════════════
//  Colors
// ═══════════════════════════════════════════════════════
const CLR = {
  bg:        '#0d0f1a',
  wave:      '#4a5a99',
  center:    '#1e2440',
  marker:    '#ff3355',
  playhead:  '#00ccee',
  rulerFg:   '#50567a',
  rulerLine: '#1c1f32',
};
const CHAR_PALETTE = [
  '#8ab0e8','#88e0aa','#cc88ee','#ccb866','#e88888',
  '#88cce0','#e0aa88','#aae088','#e8a8cc','#b8d8f8',
];
function charColor(char) {
  const uniq = [...new Set(S.master_chars.filter(c => c))];
  const i = uniq.indexOf(char);
  return CHAR_PALETTE[i >= 0 ? i % CHAR_PALETTE.length : 0];
}

// ═══════════════════════════════════════════════════════
//  Coordinate helpers
// ═══════════════════════════════════════════════════════
const ms2px   = ms => (ms - S.scrollMs) * S.pxPerMs;
const px2ms   = px => px / S.pxPerMs + S.scrollMs;
const totalPx = ()  => curDuration() * S.pxPerMs;

function clampScroll() {
  const max = Math.max(0, curDuration() - wCv.width / S.pxPerMs);
  S.scrollMs = Math.max(0, Math.min(S.scrollMs, max));
}

function clip(text, maxW, ctx) {
  if (!text || maxW < 8) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t.length ? t + '…' : '';
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ═══════════════════════════════════════════════════════
//  Draw
// ═══════════════════════════════════════════════════════
function redraw() { drawSegHeader(); drawRuler(); drawWave(); }

// 境界 b 1つ分の無音範囲を計算して返す ({startMs, endMs, boundary})
function computeSilenceForBoundary(waveform, n, dur, boundaries, b, thr) {
  const ranges = [];
  const bMs  = boundaries[b];
  const bi   = Math.round(bMs / dur * (n - 1));
  const prev = b > 0                    ? Math.round(boundaries[b-1] / dur * (n-1)) : 0;
  const next = b < boundaries.length-1  ? Math.round(boundaries[b+1] / dur * (n-1)) : n-1;

  if (b > 0) {
    let li = bi;
    while (li > prev && waveform[li] < thr) li--;
    if (li < bi) ranges.push({ startMs: li / (n-1) * dur, endMs: bMs, boundary: b });
  }
  if (b < boundaries.length - 1) {
    let ri = bi;
    while (ri < next && waveform[ri] < thr) ri++;
    if (ri > bi) ranges.push({ startMs: bMs, endMs: ri / (n-1) * dur, boundary: b });
  }
  return ranges;
}

// 全境界を再計算して curSet().silences を更新
function updateSilences() {
  const s = curSet();
  if (!s || !s.waveform.length) return;
  const thr = Math.pow(10, parseInt(D.silence_threshold.value) / 20);
  const boundaries = [0, ...s.markers, s.duration_ms];
  s.silences = boundaries.flatMap((_, b) =>
    computeSilenceForBoundary(s.waveform, s.waveform.length, s.duration_ms, boundaries, b, thr)
  );
}

// 境界 b (= markerIdx+1) の無音範囲だけ差し替える
function updateSilencesForBoundary(b) {
  const s = curSet();
  if (!s || !s.waveform.length || !s.silences) return;
  const thr = Math.pow(10, parseInt(D.silence_threshold.value) / 20);
  const boundaries = [0, ...s.markers, s.duration_ms];
  s.silences = [
    ...s.silences.filter(r => r.boundary !== b),
    ...computeSilenceForBoundary(s.waveform, s.waveform.length, s.duration_ms, boundaries, b, thr),
  ];
}

function drawSegHeader() {
  const W = shCv.width, H = shCv.height;
  shCtx.fillStyle = '#090b14';
  shCtx.fillRect(0, 0, W, H);
  if (!curSet()) return;

  const markers   = curMarkers();
  const lines     = curScriptLines();
  const positions = [0, ...markers, curDuration()];
  const s   = curSet();
  const col = s.assigned_char ? charColor(s.assigned_char) : '#3a3d5a';

  positions.slice(0, -1).forEach((seg_s, i) => {
    const seg_e = positions[i + 1];
    const x1 = ms2px(seg_s), x2 = ms2px(seg_e);
    if (x2 < 0 || x1 > W) return;
    const cx1 = Math.max(x1, 0), cx2 = Math.min(x2, W), w = cx2 - cx1;

    shCtx.fillStyle   = col + '33';
    shCtx.fillRect(cx1, 2, cx2 - cx1, H - 4);
    shCtx.strokeStyle = col + '66';
    shCtx.lineWidth   = 1;
    shCtx.strokeRect(cx1, 2, cx2 - cx1, H - 4);

    if (w < 12) return;
    const lx = cx1 + 5, maxW = w - 10;
    shCtx.font      = 'bold 11px sans-serif';
    shCtx.fillStyle = col;
    shCtx.fillText(`${i + 1}.`, lx, 17);
    if (lines[i] && maxW > 20) {
      shCtx.font      = '10px sans-serif';
      shCtx.fillStyle = '#8898c8';
      shCtx.fillText(clip(lines[i], maxW, shCtx), lx, 32);
    }
    shCtx.font      = '9px monospace';
    shCtx.fillStyle = '#404868';
    shCtx.fillText(((seg_e - seg_s) / 1000).toFixed(2) + 's', lx, H - 6);
  });
}

function drawRuler() {
  const W = rCv.width, H = rCv.height;
  rCtx.fillStyle = '#090b14';
  rCtx.fillRect(0, 0, W, H);
  if (!curDuration()) return;

  const pxPerSec = S.pxPerMs * 1000;
  let step = 1;
  if      (pxPerSec <  15) step = 60;
  else if (pxPerSec <  30) step = 30;
  else if (pxPerSec <  60) step = 10;
  else if (pxPerSec < 120) step = 5;
  else if (pxPerSec < 260) step = 2;
  const stepMs = step * 1000;
  const startT = Math.floor(S.scrollMs / stepMs) * stepMs;

  rCtx.fillStyle   = CLR.rulerFg;
  rCtx.font        = '10px monospace';
  rCtx.strokeStyle = CLR.rulerLine;
  rCtx.lineWidth   = 1;
  for (let t = startT; t <= S.scrollMs + W / S.pxPerMs + stepMs; t += stepMs) {
    const x = ms2px(t);
    if (x > W + 2) break;
    if (x < -40)   continue;
    rCtx.beginPath(); rCtx.moveTo(x, H - 5); rCtx.lineTo(x, H); rCtx.stroke();
    const sec = t / 1000;
    const lbl = sec >= 60
      ? `${Math.floor(sec/60)}:${String(Math.floor(sec%60)).padStart(2,'0')}`
      : `${sec.toFixed(0)}s`;
    rCtx.fillText(lbl, x + 3, H - 7);
  }
  const phx = ms2px(S.playhead_ms);
  if (phx >= 0 && phx <= W) { rCtx.fillStyle = CLR.playhead; rCtx.fillRect(phx - 1, 0, 2, H); }
}

function drawWave() {
  const W = wCv.width, H = wCv.height;
  wCtx.fillStyle = CLR.bg;
  wCtx.fillRect(0, 0, W, H);
  const waveform = curWaveform(), dur = curDuration();
  if (!waveform.length || !dur) return;

  const midY = H / 2, halfH = H / 2 - 14, n = waveform.length;
  const visEnd = S.scrollMs + W / S.pxPerMs;
  const i0 = Math.max(0,     Math.floor(S.scrollMs / dur * n) - 1);
  const i1 = Math.min(n - 1, Math.ceil (visEnd      / dur * n) + 1);

  if (i1 > i0) {
    const top = [], bot = [];
    for (let i = i0; i <= i1; i++) {
      const x = ms2px(i / n * dur), v = waveform[i];
      top.push([x, midY - v * halfH]); bot.unshift([x, midY + v * halfH]);
    }
    const pts = [...top, ...bot];
    wCtx.beginPath(); wCtx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) wCtx.lineTo(pts[i][0], pts[i][1]);
    wCtx.closePath(); wCtx.fillStyle = CLR.wave; wCtx.fill();
  }

  wCtx.strokeStyle = CLR.center; wCtx.lineWidth = 1;
  wCtx.setLineDash([4, 10]);
  wCtx.beginPath(); wCtx.moveTo(0, midY); wCtx.lineTo(W, midY); wCtx.stroke();
  wCtx.setLineDash([]);

  // segment tints
  const positions = [0, ...curMarkers(), dur];
  const s = curSet(), col = s?.assigned_char ? charColor(s.assigned_char) : '';
  for (let i = 0; i < positions.length - 1; i++) {
    const x1 = ms2px(positions[i]), x2 = ms2px(positions[i + 1]);
    if (x2 < 0 || x1 > W || !col) continue;
    wCtx.fillStyle = col + '18';
    wCtx.fillRect(Math.max(x1,0), 0, Math.min(x2,W) - Math.max(x1,0), H);
  }

  // silence overlays (削除対象の無音区間を強調表示 + ドラッグハンドル)
  if (document.getElementById('show-silence').checked) {
    const silRanges = curSet()?.silences ?? [];
    silRanges.forEach(({startMs, endMs}) => {
      const x1 = ms2px(startMs), x2 = ms2px(endMs);
      if (x2 < 0 || x1 > W) return;
      // 塗り
      wCtx.fillStyle = '#ff335530';
      wCtx.fillRect(Math.max(x1,0), 0, Math.min(x2,W)-Math.max(x1,0), H);
      // 境界点線
      wCtx.strokeStyle = '#ff335588'; wCtx.lineWidth = 1;
      wCtx.setLineDash([3,3]);
      if (x1 >= 0 && x1 <= W) { wCtx.beginPath(); wCtx.moveTo(x1,0); wCtx.lineTo(x1,H); wCtx.stroke(); }
      if (x2 >= 0 && x2 <= W) { wCtx.beginPath(); wCtx.moveTo(x2,0); wCtx.lineTo(x2,H); wCtx.stroke(); }
      wCtx.setLineDash([]);
      // ドラッグハンドル (◇ shape at mid-height)
      wCtx.fillStyle = '#ff3355cc';
      const my = H / 2;
      for (const hx of [x1, x2]) {
        if (hx < -10 || hx > W + 10) continue;
        wCtx.beginPath();
        wCtx.moveTo(hx, my-7); wCtx.lineTo(hx+5, my);
        wCtx.lineTo(hx, my+7); wCtx.lineTo(hx-5, my);
        wCtx.closePath(); wCtx.fill();
      }
    });
  }

  // markers
  curMarkers().forEach(ms => {
    const x = ms2px(ms);
    if (x < -4 || x > W + 4) return;
    wCtx.strokeStyle = CLR.marker; wCtx.lineWidth = 2;
    wCtx.beginPath(); wCtx.moveTo(x, 0); wCtx.lineTo(x, H); wCtx.stroke();
    wCtx.fillStyle = CLR.marker;
    wCtx.beginPath();
    wCtx.moveTo(x-7,0); wCtx.lineTo(x+7,0); wCtx.lineTo(x,11);
    wCtx.closePath(); wCtx.fill();
  });

  // playhead
  const phx = ms2px(S.playhead_ms);
  if (phx >= -1 && phx <= W + 1) {
    wCtx.strokeStyle = CLR.playhead; wCtx.lineWidth = 2;
    wCtx.beginPath(); wCtx.moveTo(phx, 0); wCtx.lineTo(phx, H); wCtx.stroke();
    wCtx.fillStyle = CLR.playhead;
    wCtx.beginPath();
    wCtx.moveTo(phx-7,H); wCtx.lineTo(phx+7,H); wCtx.lineTo(phx,H-11);
    wCtx.closePath(); wCtx.fill();
  }
}

// ═══════════════════════════════════════════════════════
//  Resize
// ═══════════════════════════════════════════════════════
const BASE_PPM = 0.15;

function resize() {
  const rp = document.getElementById('right-pane');
  const W  = rp.clientWidth;
  const shH = 80, rulerH = 24, sbH = 14, statusH = 26;
  const wH  = Math.max(60, rp.clientHeight - shH - rulerH - sbH - statusH);
  shCv.width = W; shCv.height = shH;
  wCv.width  = W; wCv.height  = wH;
  rCv.width  = W; rCv.height  = rulerH;
  clampScroll(); redraw(); updateScrollbar();
}
new ResizeObserver(resize).observe(document.getElementById('right-pane'));

// ═══════════════════════════════════════════════════════
//  Left pane: character table
// ═══════════════════════════════════════════════════════
function renderCharTable() {
  const tbody = D.char_tbody;
  tbody.innerHTML = '';

  const charCounts = {};
  S.master_chars.forEach(c => { if (c) charCounts[c] = (charCounts[c] || 0) + 1; });

  const charToSet = {};
  S.sets.forEach((s, si) => { if (s.assigned_char) charToSet[s.assigned_char] = si; });

  [...new Set(S.master_chars.filter(c => c))].forEach(char => {
    const si  = charToSet[char];
    const col = charColor(char);

    const tr  = document.createElement('tr');
    if (S.currentIdx !== -1 && S.currentIdx === si) tr.classList.add('active-char');

    // キャラ名セル
    const td1 = document.createElement('td');
    td1.style.color  = col;
    td1.style.cursor = 'pointer';
    td1.title        = 'クリック: 選択 / ダブルクリック: 名前を変更';
    td1.textContent  = char;
    if (si !== undefined) td1.addEventListener('click', () => selectSet(si));
    td1.addEventListener('dblclick', e => { e.stopPropagation(); renameChar(char); });

    // 行数セル
    const td2 = document.createElement('td');
    td2.textContent = charCounts[char] || 0;

    // モブ チェックボックス
    const td3 = document.createElement('td');
    td3.style.textAlign = 'center';
    const chk = document.createElement('input');
    chk.type    = 'checkbox';
    chk.checked = S.mobChars.has(char);
    chk.title   = 'モブキャラとしてマーク';
    chk.addEventListener('change', () => {
      if (chk.checked) S.mobChars.add(char);
      else             S.mobChars.delete(char);
    });
    td3.appendChild(chk);

    // 割り当て音声 (select)
    const td4 = document.createElement('td');
    const sel = document.createElement('select');
    sel.className = 'char-audio-sel';
    sel.innerHTML  = '<option value="">（未割り当て）</option>' +
      S.sets.map((s, i) =>
        `<option value="${i}"${i === si ? ' selected' : ''}>${esc(s.name)}</option>`
      ).join('');
    sel.addEventListener('change', () => {
      const newIdx = sel.value === '' ? -1 : parseInt(sel.value);
      assignAudioToChar(char, newIdx);
    });
    td4.appendChild(sel);

    tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4);
    tbody.appendChild(tr);
  });
}

// ── キャラ名変更ダイアログ ──────────────────────────────
let _charRenameResolve = null;

function _charRenameClose(result) {
  D.char_rename_overlay.classList.add('hidden');
  if (_charRenameResolve) { _charRenameResolve(result); _charRenameResolve = null; }
}

D.btn_char_rename_ok.addEventListener('click', () => {
  _charRenameClose(D.char_rename_input.value.trim() || null);
});
D.btn_char_rename_cancel.addEventListener('click', () => _charRenameClose(null));
D.char_rename_input.addEventListener('keydown', e => {
  if (e.key === 'Enter')  D.btn_char_rename_ok.click();
  if (e.key === 'Escape') _charRenameClose(null);
});

async function renameChar(oldName) {
  D.char_rename_input.value = oldName;
  D.char_rename_overlay.classList.remove('hidden');
  setTimeout(() => { D.char_rename_input.focus(); D.char_rename_input.select(); }, 50);
  const newName = await new Promise(resolve => { _charRenameResolve = resolve; });
  if (!newName || newName === oldName) return;

  // master_chars を置換
  S.master_chars = S.master_chars.map(c => c === oldName ? newName : c);

  // sets の assigned_char を更新してサーバーへ反映
  S.sets.forEach(s => {
    if (s.assigned_char === oldName) {
      s.assigned_char = newName;
      fetch(`${API_BASE}/api/sessions/${s.sid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigned_char: newName }),
      });
    }
  });

  updateAll();
}

// 割り当て変更: char ← sets[newSetIdx]
function assignAudioToChar(charName, newSetIdx) {
  // このキャラの現在の割り当てを解除
  S.sets.forEach(s => { if (s.assigned_char === charName) s.assigned_char = ''; });

  if (newSetIdx >= 0 && newSetIdx < S.sets.length) {
    S.sets[newSetIdx].assigned_char = charName;
    fetch(`${API_BASE}/api/sessions/${S.sets[newSetIdx].sid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigned_char: charName }),
    });
    selectSet(newSetIdx);
  } else {
    updateAll();
  }
}

// ═══════════════════════════════════════════════════════
//  Left pane: file list
// ═══════════════════════════════════════════════════════
function renderFileList() {
  D.file_list.innerHTML = '';
  S.sets.forEach((s, idx) => {
    const col  = s.assigned_char ? charColor(s.assigned_char) : '#5a6080';
    const segs = s.markers.length + 1;
    const dur  = (s.duration_ms / 1000).toFixed(1);
    const div  = document.createElement('div');
    div.className = 'file-item' + (idx === S.currentIdx ? ' active' : '');
    div.innerHTML =
      `<span class="fi-name">${esc(s.name)}</span>` +
      `<span class="fi-char" style="color:${col}">${esc(s.assigned_char || '（未割り当て）')}</span>` +
      `<span class="fi-info">${dur}s · ${segs}seg</span>` +
      `<button class="fi-remove" title="削除">✕</button>`;
    div.addEventListener('click', e => {
      if (e.target.classList.contains('fi-remove')) return;
      selectSet(idx);
    });
    div.querySelector('.fi-remove').addEventListener('click', e => {
      e.stopPropagation(); removeSet(idx);
    });
    D.file_list.appendChild(div);
  });
}

function removeSet(idx) {
  S.sets.splice(idx, 1);
  if (S.currentIdx === idx) {
    S.currentIdx = S.sets.length > 0 ? Math.min(idx, S.sets.length - 1) : -1;
  } else if (S.currentIdx > idx) {
    S.currentIdx--;
  }
  updateAll();
  if (!curSet()) { D.drop_zone_overlay.classList.remove('hidden'); setEnabled(false); }
}

// ═══════════════════════════════════════════════════════
//  Set selection
// ═══════════════════════════════════════════════════════
function selectSet(idx) {
  if (idx < 0 || idx >= S.sets.length) return;
  S.currentIdx  = idx;
  S.scrollMs    = 0;
  S.playhead_ms = 0;
  const s = curSet();
  D.audio_el.src = `${API_BASE}/api/sessions/${s.sid}/audio`;
  D.drop_zone_overlay.classList.add('hidden');
  S.pxPerMs = Math.min(BASE_PPM, (wCv.width * 0.95) / Math.max(1, s.duration_ms));
  D.zoom_label.textContent = `×${(S.pxPerMs / BASE_PPM).toFixed(1)}`;
  setEnabled(true);
  if (!s.silences) updateSilences();  // 初回のみ自動計算
  updateAll();
}

function updateAll() {
  renderCharTable();
  renderFileList();
  clampScroll();
  redraw();
  updateScrollbar();
  updateStatusBar();
  updatePlayheadTime();
}

// ═══════════════════════════════════════════════════════
//  Undo
// ═══════════════════════════════════════════════════════
const _undoStack = [], _redoStack = [];

function pushUndo() {
  if (!curSet()) return;
  const s = curSet();
  _undoStack.push({
    idx:      S.currentIdx,
    markers:  [...s.markers],
    silences: s.silences ? s.silences.map(r => ({...r})) : null,
  });
  _redoStack.length = 0;
  if (_undoStack.length > 50) _undoStack.shift();
  D.btn_undo.disabled = false;
}

function doUndo() {
  if (!_undoStack.length) return;
  const s = curSet();
  _redoStack.push({
    idx:      S.currentIdx,
    markers:  s ? [...s.markers] : [],
    silences: s?.silences ? s.silences.map(r => ({...r})) : null,
  });
  const snap = _undoStack.pop();
  S.currentIdx = snap.idx;
  const cs = curSet();
  if (cs) {
    cs.markers  = snap.markers;
    cs.silences = snap.silences;  // 再計算不要: スナップショットを復元
  }
  D.btn_undo.disabled = _undoStack.length === 0;
  saveMarkers(); updateAll();
}

// 指定した境界インデックス群のみ無音範囲を差し替える
function updateSilencesForBoundaries(bs) {
  const s = curSet();
  if (!s || !s.waveform.length || !s.silences) return;
  const thr = Math.pow(10, parseInt(D.silence_threshold.value) / 20);
  const boundaries = [0, ...s.markers, s.duration_ms];
  s.silences = [
    ...s.silences.filter(r => !bs.includes(r.boundary)),
    ...bs.flatMap(b => (b >= 0 && b < boundaries.length)
      ? computeSilenceForBoundary(s.waveform, s.waveform.length, s.duration_ms, boundaries, b, thr)
      : []),
  ];
}

D.btn_undo.addEventListener('click', doUndo);

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); D.btn_play.click(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); doUndo(); }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') { e.preventDefault(); D.btn_save_proj.click(); }
});

// ═══════════════════════════════════════════════════════
//  Marker interaction
// ═══════════════════════════════════════════════════════
let drag = null;
const HIT_PX = 10;

function hitMarker(px) {
  let best = -1, bestD = 9999;
  curMarkers().forEach((ms, i) => {
    const d = Math.abs(ms2px(ms) - px);
    if (d < HIT_PX && d < bestD) { bestD = d; best = i; }
  });
  return best;
}
function nearPlayhead(px) { return Math.abs(ms2px(S.playhead_ms) - px) <= 8; }

// 無音エッジのヒット検出: {rangeIdx, side:'start'|'end'} or null
function hitSilenceEdge(px) {
  if (!document.getElementById('show-silence').checked) return null;
  const sils = curSet()?.silences;
  if (!sils) return null;
  for (let i = 0; i < sils.length; i++) {
    if (Math.abs(ms2px(sils[i].startMs) - px) <= HIT_PX) return { rangeIdx: i, side: 'start' };
    if (Math.abs(ms2px(sils[i].endMs)   - px) <= HIT_PX) return { rangeIdx: i, side: 'end' };
  }
  return null;
}

wCv.addEventListener('mousedown', e => {
  if (!curSet() || e.button !== 0) return;
  const hi = hitMarker(e.offsetX);
  if (hi >= 0) {
    drag = { type: 'marker', idx: hi };
    wCv.style.cursor = 'ew-resize';
  } else if (nearPlayhead(e.offsetX)) {
    // 再生中はシーク操作で停止
    if (S.isPlaying) {
      D.audio_el.pause(); S.isPlaying = false;
      D.btn_play.textContent = '▶ 再生';
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    }
    drag = { type: 'playhead' };
    wCv.style.cursor = 'ew-resize';
  } else {
    const se = hitSilenceEdge(e.offsetX);
    if (se) {
      drag = { type: 'silence', rangeIdx: se.rangeIdx, side: se.side };
      wCv.style.cursor = 'ew-resize';
    } else {
      // 再生中はクリックで停止
      if (S.isPlaying) {
        D.audio_el.pause(); S.isPlaying = false;
        D.btn_play.textContent = '▶ 再生';
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      }
      drag = { type: 'pending', startX: e.offsetX, moved: false };
    }
  }
});

wCv.addEventListener('mousemove', e => {
  if (!curSet()) return;
  if (drag?.type === 'marker') {
    curMarkers()[drag.idx] = Math.max(0, Math.min(px2ms(e.offsetX), curDuration()));
    updateSilencesForBoundary(drag.idx + 1);  // 触った境界のみ再計算
    redraw(); return;
  }
  if (drag?.type === 'playhead') {
    S.playhead_ms = Math.max(0, Math.min(px2ms(e.offsetX), curDuration()));
    D.audio_el.currentTime = S.playhead_ms / 1000;
    updatePlayheadTime(); redraw(); return;
  }
  if (drag?.type === 'silence') {
    const sil = curSet().silences[drag.rangeIdx];
    const ms  = Math.max(0, Math.min(px2ms(e.offsetX), curDuration()));
    if (drag.side === 'start') sil.startMs = Math.min(ms, sil.endMs - 10);
    else                       sil.endMs   = Math.max(ms, sil.startMs + 10);
    redraw(); return;
  }
  if (drag?.type === 'pending' && Math.abs(e.offsetX - drag.startX) > 4) drag.moved = true;
  const hasSilHit = hitSilenceEdge(e.offsetX) !== null;
  wCv.style.cursor = (hitMarker(e.offsetX) >= 0 || nearPlayhead(e.offsetX) || hasSilHit) ? 'ew-resize' : 'crosshair';
});

wCv.addEventListener('mouseup', e => {
  if (e.button !== 0) return;
  if (drag?.type === 'pending' && !drag.moved) {
    pushUndo();
    const m = curMarkers();
    const msAdded = Math.max(0, Math.min(px2ms(e.offsetX), curDuration()));
    m.push(msAdded);
    m.sort((a,b) => a-b);
    // 挿入位置の境界のみ追加 (既存boundary >= b はインデックスシフト)
    const b = m.indexOf(msAdded) + 1;
    const s = curSet();
    if (s?.silences) {
      s.silences = s.silences.map(r => r.boundary >= b ? {...r, boundary: r.boundary + 1} : r);
      updateSilencesForBoundaries([b]);
    }
    saveMarkers(); updateStatusBar(); redraw();
  } else if (drag?.type === 'marker') {
    curMarkers().sort((a,b) => a-b); saveMarkers(); redraw();  // silencesはドラッグ中に更新済み
  }
  // silence drag 終了: 範囲を正規化
  if (drag?.type === 'silence') {
    const sils = curSet()?.silences;
    if (sils) sils.sort((a,b) => a.startMs - b.startMs);
    redraw();
  }
  drag = null;
  const hasSilHit = hitSilenceEdge(e.offsetX) !== null;
  wCv.style.cursor = (hitMarker(e.offsetX) >= 0 || nearPlayhead(e.offsetX) || hasSilHit) ? 'ew-resize' : 'crosshair';
});

wCv.addEventListener('mouseleave', () => {
  if (drag?.type === 'marker') { curMarkers().sort((a,b)=>a-b); saveMarkers(); redraw(); }
  if (drag?.type === 'silence') redraw();
  drag = null;
});

wCv.addEventListener('contextmenu', e => {
  e.preventDefault(); if (!curSet()) return;
  const hi = hitMarker(e.offsetX);
  if (hi >= 0) {
    pushUndo();
    const b = hi + 1;
    const s = curSet();
    if (s?.silences) {
      // 削除境界のsilencesを除去し、それより後のインデックスをデクリメント
      s.silences = s.silences
        .filter(r => r.boundary !== b)
        .map(r => r.boundary > b ? {...r, boundary: r.boundary - 1} : r);
    }
    curMarkers().splice(hi, 1);
    saveMarkers(); updateStatusBar(); redraw();
  }
});

rCv.addEventListener('click', e => {
  if (!curSet()) return;
  if (S.isPlaying) {
    D.audio_el.pause(); S.isPlaying = false;
    D.btn_play.textContent = '▶ 再生';
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }
  S.playhead_ms = Math.max(0, Math.min(px2ms(e.offsetX), curDuration()));
  D.audio_el.currentTime = S.playhead_ms / 1000;
  updatePlayheadTime(); redraw();
});

shCv.addEventListener('click', e => {
  if (!curSet()) return;
  if (S.isPlaying) {
    D.audio_el.pause(); S.isPlaying = false;
    D.btn_play.textContent = '▶ 再生';
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }
  S.playhead_ms = Math.max(0, Math.min(px2ms(e.offsetX), curDuration()));
  D.audio_el.currentTime = S.playhead_ms / 1000;
  updatePlayheadTime(); redraw();
});

// ═══════════════════════════════════════════════════════
//  Zoom & scroll
// ═══════════════════════════════════════════════════════
function setZoom(factor, anchorPx) {
  if (anchorPx === undefined) anchorPx = wCv.width / 2;
  const anchorMs = px2ms(anchorPx);
  S.pxPerMs  = Math.max(0.005, Math.min(S.pxPerMs * factor, 10.0));
  S.scrollMs = anchorMs - anchorPx / S.pxPerMs;
  clampScroll();
  D.zoom_label.textContent = `×${(S.pxPerMs / BASE_PPM).toFixed(1)}`;
  redraw(); updateScrollbar();
}

D.btn_zoom_in .addEventListener('click', () => setZoom(1.5));
D.btn_zoom_out.addEventListener('click', () => setZoom(1 / 1.5));

[wCv, rCv, shCv].forEach(cv => {
  cv.addEventListener('wheel', e => {
    e.preventDefault(); if (!curSet()) return;
    if (e.ctrlKey) { setZoom(e.deltaY < 0 ? 1.2 : 1/1.2, e.offsetX); }
    else { S.scrollMs += e.deltaY / S.pxPerMs * 0.4; clampScroll(); redraw(); updateScrollbar(); }
  }, { passive: false });
});

// ═══════════════════════════════════════════════════════
//  Scrollbar
// ═══════════════════════════════════════════════════════
function updateScrollbar() {
  if (!curDuration()) return;
  const trackW    = D.scrollbar_track.clientWidth;
  const visRatio  = Math.min(1, wCv.width / Math.max(1, totalPx()));
  const thumbW    = Math.max(24, trackW * visRatio);
  const scrollMax = Math.max(1, curDuration() - wCv.width / S.pxPerMs);
  const thumbLeft = (trackW - thumbW) * Math.min(1, Math.max(0, S.scrollMs / scrollMax));
  D.scrollbar_thumb.style.width = thumbW + 'px';
  D.scrollbar_thumb.style.left  = thumbLeft + 'px';
}

let sbDrag = null;
D.scrollbar_thumb.addEventListener('mousedown', e => {
  sbDrag = { startX: e.clientX, startScroll: S.scrollMs };
  D.scrollbar_thumb.classList.add('grabbing'); e.preventDefault();
});
document.addEventListener('mousemove', e => {
  if (!sbDrag) return;
  const trackW = D.scrollbar_track.clientWidth;
  const thumbW = parseFloat(D.scrollbar_thumb.style.width) || 24;
  const scrollMax = Math.max(1, curDuration() - wCv.width / S.pxPerMs);
  S.scrollMs = Math.max(0, sbDrag.startScroll + (e.clientX - sbDrag.startX) / (trackW - thumbW) * scrollMax);
  clampScroll(); redraw(); updateScrollbar();
});
document.addEventListener('mouseup', () => {
  if (sbDrag) { D.scrollbar_thumb.classList.remove('grabbing'); sbDrag = null; }
});
D.scrollbar_track.addEventListener('click', e => {
  if (e.target === D.scrollbar_thumb) return;
  const trackW = D.scrollbar_track.clientWidth;
  const thumbW = parseFloat(D.scrollbar_thumb.style.width) || 24;
  const scrollMax = Math.max(1, curDuration() - wCv.width / S.pxPerMs);
  S.scrollMs = Math.max(0, Math.min((e.offsetX - thumbW/2) / (trackW - thumbW), 1)) * scrollMax;
  clampScroll(); redraw(); updateScrollbar();
});

// ═══════════════════════════════════════════════════════
//  Playback
// ═══════════════════════════════════════════════════════
let rafId = null;

function startLoop() {
  function tick() {
    S.playhead_ms = D.audio_el.currentTime * 1000;
    updatePlayheadTime();
    const px = ms2px(S.playhead_ms), W = wCv.width;
    if (px > W * 0.80) { S.scrollMs = S.playhead_ms - W * 0.20 / S.pxPerMs; clampScroll(); updateScrollbar(); }
    else if (px < 0)   { S.scrollMs = Math.max(0, S.playhead_ms - W * 0.05 / S.pxPerMs); clampScroll(); updateScrollbar(); }
    redraw();
    if (S.isPlaying) rafId = requestAnimationFrame(tick);
  }
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

D.btn_play.addEventListener('click', () => {
  if (!curSet()) return;
  if (S.isPlaying) {
    D.audio_el.pause(); S.isPlaying = false;
    D.btn_play.textContent = '▶ 再生';
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  } else {
    D.audio_el.currentTime = S.playhead_ms / 1000;
    D.audio_el.play(); S.isPlaying = true;
    D.btn_play.textContent = '⏸ 一時停止';
    startLoop();
  }
});

D.btn_stop.addEventListener('click', () => {
  D.audio_el.pause(); S.isPlaying = false;
  D.btn_play.textContent = '▶ 再生';
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  redraw();
});

D.audio_el.addEventListener('ended', () => {
  S.isPlaying = false; D.btn_play.textContent = '▶ 再生';
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
});

// ═══════════════════════════════════════════════════════
//  File upload (multiple files, no char prompt)
// ═══════════════════════════════════════════════════════
D.btn_add_file.addEventListener('click', () => D.file_input.click());
D.file_input.addEventListener('change', e => {
  const files = [...e.target.files];
  if (files.length) doUploadFiles(files);
  e.target.value = '';
});

document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const files = [...e.dataTransfer.files]
    .filter(f => /\.(mp3|wav|ogg|m4a|flac)$/i.test(f.name));
  if (files.length) doUploadFiles(files);
});
document.getElementById('drop-zone').addEventListener('click', () => D.file_input.click());

async function doUploadFiles(files) {
  for (const f of files) await doUpload(f);
}

async function doUpload(file) {
  updateStatusBar(`読み込み中: ${file.name}`);
  const fd = new FormData();
  fd.append('file', file);
  let data;
  try {
    const res = await fetch(API_BASE + '/api/sessions', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json().catch(()=>({detail:res.statusText}))).detail);
    data = await res.json();
  } catch(e) { alert(`エラー (${file.name}): ` + e.message); updateStatusBar(''); return; }

  // プロジェクト復元: ファイル名マッチ (stem / フルネーム 両方試みる)
  const fileStem = file.name.replace(/\.[^.]+$/, '');
  const pendingKey = Object.keys(S.pendingSets).find(
    k => k === data.name || k === fileStem || k === file.name
  );
  const pending = pendingKey ? S.pendingSets[pendingKey] : null;
  console.warn('[project restore] data.name=', data.name, 'fileStem=', fileStem,
              'pendingKeys=', Object.keys(S.pendingSets), 'matched=', pendingKey);

  const entry = {
    sid: data.sid, name: data.name,
    assigned_char: pending?.assigned_char || '',
    waveform: data.waveform,
    markers: pending?.markers ?? (data.markers || []),
    duration_ms: data.duration_ms,
    silences: pending?.silences ?? null,  // null = 選択時に自動計算
  };
  S.sets.push(entry);

  // バックエンドにも反映
  if (pending && entry.assigned_char) {
    fetch(`${API_BASE}/api/sessions/${data.sid}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markers: entry.markers, assigned_char: entry.assigned_char }),
    });
    delete S.pendingSets[pendingKey];
  }

  // 保存時と同じキャラが割り当てられたセットを優先して選択
  if (S.pendingSelectedChar && entry.assigned_char === S.pendingSelectedChar) {
    S.pendingSelectedChar = '';  // 一度マッチしたらクリア
    selectSet(S.sets.length - 1);
  } else if (S.currentIdx === -1) {
    selectSet(S.sets.length - 1);
  } else {
    updateAll();
  }
  updateStatusBar(`追加: ${file.name}${pending ? ' (プロジェクトから復元)' : ''}`);
}

// ═══════════════════════════════════════════════════════
//  Script: method selection dialog
// ═══════════════════════════════════════════════════════
D.btn_script.addEventListener('click', () => {
  D.script_method_overlay.classList.remove('hidden');
});

function closeMethodDialog() { D.script_method_overlay.classList.add('hidden'); }

D.btn_script_method_cancel.addEventListener('click', closeMethodDialog);
D.script_method_overlay.addEventListener('click', e => {
  if (e.target === D.script_method_overlay) closeMethodDialog();
});

// ── ファイルから開く ──────────────────────────────────
D.btn_script_file.addEventListener('click', () => {
  closeMethodDialog();
  D.script_file_input.click();
});
D.script_file_input.addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  e.target.value = '';
  const text = await f.text();
  applyScript(text);
});

// ── クリップボードから貼り付け ────────────────────────
D.btn_script_clip.addEventListener('click', () => {
  closeMethodDialog();
  // show textarea dialog (user pastes manually)
  D.script_textarea.value = S.master_lines.length
    ? S.master_chars.map((c,i) => c ? `${c}\t${S.master_lines[i]}` : S.master_lines[i]).join('\n')
    : '';
  D.script_overlay.classList.remove('hidden');
  setTimeout(() => D.script_textarea.focus(), 50);
});

D.btn_script_cancel.addEventListener('click', () => D.script_overlay.classList.add('hidden'));
D.script_overlay.addEventListener('click', e => {
  if (e.target === D.script_overlay) D.script_overlay.classList.add('hidden');
});
D.script_textarea.addEventListener('keydown', e => {
  if (e.key === 'Escape') D.script_overlay.classList.add('hidden');
});
D.btn_script_ok.addEventListener('click', () => {
  const text = D.script_textarea.value;
  D.script_overlay.classList.add('hidden');
  applyScript(text);
});

function applyScript(text) {
  if (!text.trim()) return;
  const chars = [], lines = [];
  text.split('\n').forEach(raw => {
    raw = raw.trim(); if (!raw) return;
    const parts = raw.split('\t');
    if (parts.length >= 2 && parts[0].trim()) {
      chars.push(parts[0].trim()); lines.push(parts.slice(1).join('\t').trim());
    } else { chars.push(''); lines.push(raw); }
  });
  S.master_chars = chars;
  S.master_lines = lines;
  updateAll();
}

// ═══════════════════════════════════════════════════════
//  Silence detection / Equal split
// ═══════════════════════════════════════════════════════
D.silence_threshold.addEventListener('input', () => {
  D.silence_db_label.textContent = D.silence_threshold.value + ' dB';
  updateSilences();
  redraw();
});
document.getElementById('show-silence').addEventListener('change', () => redraw());

D.btn_detect.addEventListener('click', async () => {
  if (!curSet()) return;
  D.btn_detect.disabled = true;
  updateStatusBar('🔍 無音検出中…');
  try {
    const n   = curScriptLines().length || 0;
    const thr = Math.pow(10, parseInt(D.silence_threshold.value) / 20);
    const res = await fetch(`${API_BASE}/api/sessions/${curSid()}/detect-silence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ n_segments: n, threshold_ratio: thr }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const d = await res.json();
    pushUndo(); curSet().markers = d.markers;
    updateSilences(); updateAll();
    updateStatusBar(`無音検出完了: ${d.count} 個のマーカーを配置`);
  } catch(e) { alert('無音検出エラー: ' + e.message); updateStatusBar(''); }
  D.btn_detect.disabled = !curSet();
});

D.btn_equal.addEventListener('click', () => {
  if (!curSet()) return;
  const n = curScriptLines().length;
  if (n < 2) { alert('台本を先に読み込んでください（2行以上必要）'); return; }
  pushUndo();
  curSet().markers = Array.from({length: n-1}, (_,i) => curDuration() * (i+1) / n);
  saveMarkers(); updateSilences(); updateAll();
});

// ═══════════════════════════════════════════════════════
//  (Export dialog removed — use 書き出し画面 instead)
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
//  Project save / open
// ═══════════════════════════════════════════════════════
// 書き出し画面を別タブで開く (現在の状態をlocalStorageで渡す)
D.btn_reorder.addEventListener('click', () => {
  const proj = {
    master_chars: S.master_chars,
    master_lines: S.master_lines,
    mob_chars:    [...S.mobChars],
    sets: S.sets.map(s => ({
      sid:           s.sid,
      name:          s.name,
      assigned_char: s.assigned_char,
      markers:       s.markers,
      silences:      s.silences ?? [],
      duration_ms:   s.duration_ms,
    })),
  };
  localStorage.setItem('audio_splitter_reorder', JSON.stringify(proj));
  window.open(`reorder.html?t=${Date.now()}`, '_blank');
});

D.btn_save_proj.addEventListener('click', () => {
  const proj = {
    version: 2,
    master_chars: S.master_chars,
    master_lines: S.master_lines,
    mob_chars:    [...S.mobChars],
    selected_char: curSet()?.assigned_char || '',
    sets: S.sets.map(s => ({
      name:          s.name,
      assigned_char: s.assigned_char,
      markers:       s.markers,
      duration_ms:   s.duration_ms,
      silences:      s.silences ?? [],
    })),
  };
  const blob = new Blob([JSON.stringify(proj, null, 2)], {type:'application/json'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'project.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

D.btn_open_proj.addEventListener('click', () => D.proj_input.click());
D.proj_input.addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const proj = JSON.parse(ev.target.result);
      // 台本を復元
      S.master_chars = proj.master_chars || [];
      S.master_lines = proj.master_lines || [];
      // モブフラグを復元
      S.mobChars = new Set(proj.mob_chars || []);
      // 選択キャラを復元予約
      S.pendingSelectedChar = proj.selected_char || '';
      // セット情報をペンディングに登録 (ファイル名 → メタデータ)
      S.pendingSets = {};
      const savedSets = proj.sets || [];
      savedSets.forEach(s => {
        if (s.name) S.pendingSets[s.name] = {
          assigned_char: s.assigned_char || '',
          markers:       s.markers       || [],
          duration_ms:   s.duration_ms   || 0,
          silences:      s.silences      || null,
        };
      });
      updateAll();
      const names = savedSets.map(s => s.name).filter(Boolean);
      const msg = names.length
        ? `プロジェクトを読み込みました。\n以下の音声ファイルを追加してください:\n${names.join('\n')}`
        : 'マスター台本を読み込みました。\n音声ファイルは「追加」ボタンで再度追加してください。';
      alert(msg);
    } catch(e) { alert('読み込みエラー: ' + e.message); }
  };
  reader.readAsText(f);
});

// ═══════════════════════════════════════════════════════
//  Status bar
// ═══════════════════════════════════════════════════════
function updatePlayheadTime() {
  const ms  = S.playhead_ms;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const s2  = sec % 60;
  const ms2 = Math.floor(ms % 1000 / 10);
  D.playhead_time.textContent =
    `${String(min).padStart(2,'0')}:${String(s2).padStart(2,'0')}.${String(ms2).padStart(2,'0')}`;
}

function updateStatusBar(msg) {
  if (msg !== undefined) { D.status_info.textContent = msg; return; }
  if (!curSet())         { D.status_info.textContent = ''; return; }
  const nMark = curMarkers().length;
  D.status_info.textContent =
    `分割マーカー ${nMark}個 → ${nMark+1}セグメント ／ 台本 ${S.master_lines.length}行 ｜ セット ${S.currentIdx+1}/${S.sets.length}`;
}

// ═══════════════════════════════════════════════════════
//  Enabled state
// ═══════════════════════════════════════════════════════
function setEnabled(on) {
  [D.btn_detect, D.btn_equal,
   D.btn_play,   D.btn_stop,  D.btn_zoom_in, D.btn_zoom_out]
    .forEach(b => { b.disabled = !on; });
  D.btn_undo.disabled = _undoStack.length === 0;
}

// ═══════════════════════════════════════════════════════
//  API: save markers
// ═══════════════════════════════════════════════════════
async function saveMarkers() {
  const sid = curSid(); if (!sid) return;
  await fetch(`${API_BASE}/api/sessions/${sid}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markers: curMarkers() }),
  });
}
