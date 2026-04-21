'use strict';
const API_BASE = window.API_BASE || '';

// ═══════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════
const LABEL_W  = 140;
const HEADER_H = 80;
const ROW_H    = 80;
const MIN_COL_W = 80;
const BASE_PPM  = 0.10;

const CHAR_PALETTE = [
  '#8ab0e8','#88e0aa','#cc88ee','#ccb866','#e88888',
  '#88cce0','#e0aa88','#aae088','#e8a8cc','#b8d8f8',
];

// ═══════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════
const P = {
  sets: [],        // [{sid,name,assigned_char,waveform,markers,duration_ms}]
  master_chars: [],
  master_lines: [],
  slots: [],
  char_rows: [],
  totalW: 1,
  pid: null,
  pxPerMs: BASE_PPM,
  scrollMs: 0,
  scrollY: 0,
  playhead_ms: 0,
  isPlaying: false,
  playSlotIdx: 0,
  playStartT: 0,
  playStartMs: 0,
  playAfter: null,
  rafId: null,
  gapMs: 0,
  seekPositions: [],
  seekTotalMs: 0,
  mobChars: new Set(),
};

// ═══════════════════════════════════════════════════════
//  DOM refs
// ═══════════════════════════════════════════════════════
const IDS = [
  'btn-play','btn-stop',
  'btn-zoom-in','btn-zoom-out','gap-chk','status-label',
  'btn-export-audio','btn-export-srt',
  'grid-area','upper-row','name-placeholder',
  'upper-scroll-wrap','upper-cv',
  'hdivider','lower-row',
  'name-cv','lower-scroll-wrap','lower-cv',
  'hbar-wrap','hbar-placeholder','hbar-track','hbar-thumb',
  'file-input','audio-el',
  'char-prompt-overlay','char-prompt-input','btn-char-cancel','btn-char-ok',
  'export-progress-overlay','export-progress-msg',
];
const D = {};
IDS.forEach(id => { D[id.replace(/-/g,'_')] = document.getElementById(id); });

const upperCv  = D.upper_cv;
const lowerCv  = D.lower_cv;
const nameCv   = D.name_cv;
const upperCtx = upperCv.getContext('2d');
const lowerCtx = lowerCv.getContext('2d');
const nameCtx  = nameCv.getContext('2d');

// per-set audio element cache
const audioEls = {};

// ═══════════════════════════════════════════════════════
//  Color helpers
// ═══════════════════════════════════════════════════════
function charColor(char) {
  const uniq = [];
  P.master_chars.forEach(c => { if (c && !uniq.includes(c)) uniq.push(c); });
  const i = uniq.indexOf(char);
  return CHAR_PALETTE[i >= 0 ? i % CHAR_PALETTE.length : 0];
}

// ═══════════════════════════════════════════════════════
//  Layout computation (client-side)
// ═══════════════════════════════════════════════════════
function computeLayout() {
  const charToSet = {};
  P.sets.forEach((s, si) => { if (s.assigned_char) charToSet[s.assigned_char] = si; });

  const charCounter = {};
  const slots = [];
  let x = 0;

  P.master_lines.forEach((line, i) => {
    const char = P.master_chars[i];
    const si   = charToSet[char];
    let provider = null, seg_s = 0, seg_e = 0, dur = 0;

    if (si !== undefined) {
      const s   = P.sets[si];
      const pos = [0, ...[...s.markers].sort((a,b) => a-b), s.duration_ms];
      const idx = charCounter[char] || 0;
      if (idx < pos.length - 1) {
        seg_s = pos[idx]; seg_e = pos[idx+1];
        // boundaries配列は [0, m0, m1, ..., duration_ms] なので
        // pos[idx] = boundaries[idx]、pos[idx+1] = boundaries[idx+1]
        const sils = s.silences || [];
        // head: boundary idx の右側無音 (pos[idx]から始まる無音)
        const h = sils.find(r => r.boundary === idx && r.startMs >= pos[idx] - 1);
        if (h) seg_s = h.endMs;
        // tail: boundary idx+1 の左側無音 (pos[idx+1]で終わる無音)
        const t = sils.find(r => r.boundary === idx + 1 && r.endMs <= pos[idx+1] + 1);
        if (t) seg_e = t.startMs;
        dur = Math.max(0, seg_e - seg_s);
        provider = si;
      }
      charCounter[char] = (charCounter[char] || 0) + 1;
    }

    const w = Math.max(MIN_COL_W, dur * P.pxPerMs);
    slots.push({ idx: i, char, line, provider, seg_s, seg_e, duration_ms: dur, x, width: w });
    x += w + 2;
  });

  P.slots  = slots;
  P.totalW = Math.max(x, 1);

  const seen = [];
  P.master_chars.forEach(c => { if (c && !seen.includes(c)) seen.push(c); });
  P.char_rows = seen.map(c => ({ char: c, set_idx: charToSet[c] }));

  buildSeekPositions();
}

function buildSeekPositions() {
  P.seekPositions = [];
  let cum = 0;
  P.slots.forEach(slot => {
    P.seekPositions.push(cum);
    cum += slot.duration_ms + P.gapMs;
  });
  P.seekTotalMs = cum;
}

// ═══════════════════════════════════════════════════════
//  Canvas drawing
// ═══════════════════════════════════════════════════════
function clip(text, maxW, ctx) {
  if (!text || maxW < 8) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t.length ? t + '…' : '';
}

function drawAll() {
  drawUpper();
  drawNames();
  drawLower();
  updateHbar();
}

// upper canvas: script column headers
function drawUpper() {
  const W = upperCv.width, H = upperCv.height;
  upperCtx.fillStyle = '#0d0f1a';
  upperCtx.fillRect(0, 0, W, H);

  P.slots.forEach(slot => {
    const x1 = slot.x - P.scrollMs - 0;  // scrollMs here is actually scrollPx
    // convert: scrollMs stores scroll in ms, convert to px
    const sx = slot.x - P.scrollMs * P.pxPerMs;  // NO - scrollMs is ms
    // let's define helper:
    const px = slotX(slot);
    const w  = slot.width;
    if (px + w < 0 || px > W) return;

    const col = slot.char ? charColor(slot.char) : '#3a3d5a';

    // background rect
    upperCtx.fillStyle = col + '44';
    upperCtx.fillRect(px, 2, w - 2, H - 4);

    upperCtx.strokeStyle = col + '88';
    upperCtx.lineWidth = 1;
    upperCtx.strokeRect(px, 2, w - 2, H - 4);

    const lx = px + 4, maxW = w - 8;
    if (maxW < 4) return;

    if (slot.char) {
      upperCtx.font      = 'bold 11px sans-serif';
      upperCtx.fillStyle = col;
      upperCtx.fillText(clip(slot.char, maxW, upperCtx), lx, 18);
    }
    if (slot.line) {
      upperCtx.font      = '10px sans-serif';
      upperCtx.fillStyle = '#8898c8';
      upperCtx.fillText(clip(slot.line, maxW, upperCtx), lx, 32);
    }
    const durTxt = (slot.duration_ms / 1000).toFixed(2) + 's';
    upperCtx.font      = '9px monospace';
    upperCtx.fillStyle = '#505878';
    upperCtx.fillText(durTxt, lx, 46);
  });
}

// Convert slot x (ms-based layout x in px) to canvas x accounting for scroll
function slotX(slot) {
  return slot.x - P.scrollMs * P.pxPerMs;
}

// lower canvas: character × slot grid with waveforms
function drawLower() {
  const W = lowerCv.width, H = lowerCv.height;
  lowerCtx.fillStyle = '#0d0f1a';
  lowerCtx.fillRect(0, 0, W, H);

  const nRows = P.char_rows.length;
  if (!nRows) return;

  P.char_rows.forEach((row, ri) => {
    const y1 = ri * ROW_H - P.scrollY;
    const y2 = y1 + ROW_H;
    if (y2 < 0 || y1 > H) return;

    const col = charColor(row.char);

    P.slots.forEach(slot => {
      const px = slotX(slot);
      const pw = slot.width;
      if (px + pw < 0 || px > W) return;

      const isProvider = (slot.provider !== null && slot.provider !== undefined && slot.provider === row.set_idx);

      if (isProvider) {
        // draw colored rect with mini waveform
        lowerCtx.fillStyle = col + '22';
        lowerCtx.fillRect(px, y1 + 1, pw - 2, ROW_H - 2);

        const s = P.sets[row.set_idx];
        if (s && s.waveform && s.duration_ms > 0) {
          drawWaveCell(lowerCtx, px, y1 + 1, px + pw - 2, y2 - 1,
            s.waveform, s.duration_ms, slot.seg_s, slot.seg_e, col);
        }
      } else if (slot.duration_ms > 0) {
        // silence placeholder
        lowerCtx.fillStyle = '#0a0a18';
        lowerCtx.fillRect(px, y1 + 1, pw - 2, ROW_H - 2);
        // center line
        lowerCtx.strokeStyle = '#252840';
        lowerCtx.lineWidth = 1;
        lowerCtx.setLineDash([4, 8]);
        lowerCtx.beginPath();
        lowerCtx.moveTo(px, (y1 + y2) / 2);
        lowerCtx.lineTo(px + pw - 2, (y1 + y2) / 2);
        lowerCtx.stroke();
        lowerCtx.setLineDash([]);
      }

      // slot separator
      lowerCtx.strokeStyle = '#252840';
      lowerCtx.lineWidth = 1;
      lowerCtx.setLineDash([]);
      lowerCtx.beginPath();
      lowerCtx.moveTo(px + pw - 1, y1);
      lowerCtx.lineTo(px + pw - 1, y2);
      lowerCtx.stroke();
    });

    // row separator
    lowerCtx.strokeStyle = '#1c1f32';
    lowerCtx.lineWidth = 1;
    lowerCtx.beginPath();
    lowerCtx.moveTo(0, y2);
    lowerCtx.lineTo(W, y2);
    lowerCtx.stroke();
  });

  // playhead
  drawPlayhead();
}

function drawPlayhead() {
  const W = lowerCv.width;
  // find playhead x from playhead_ms
  let phX = null;
  if (P.slots.length > 0 && P.seekPositions.length > 0) {
    for (let i = 0; i < P.slots.length; i++) {
      const slot  = P.slots[i];
      const start = P.seekPositions[i];
      const end   = start + slot.duration_ms + P.gapMs;
      if (P.playhead_ms <= end || i === P.slots.length - 1) {
        const within = Math.max(0, Math.min(P.playhead_ms - start, slot.duration_ms));
        const frac   = slot.duration_ms > 0 ? within / slot.duration_ms : 0;
        phX = slotX(slot) + frac * slot.width;
        break;
      }
    }
  }
  if (phX !== null && phX >= -1 && phX <= W + 1) {
    lowerCtx.strokeStyle = '#00ccee';
    lowerCtx.lineWidth   = 2;
    lowerCtx.beginPath();
    lowerCtx.moveTo(phX, 0);
    lowerCtx.lineTo(phX, lowerCv.height);
    lowerCtx.stroke();
  }
}

function drawWaveCell(ctx, x1, y1, x2, y2, waveform, duration_ms, seg_s, seg_e, color) {
  const n  = waveform.length;
  const i0 = Math.max(0,   Math.floor(seg_s / duration_ms * n));
  const i1 = Math.min(n-1, Math.ceil (seg_e / duration_ms * n));
  const W  = Math.max(1, x2 - x1), H = y2 - y1;
  const midY = (y1 + y2) / 2, halfH = H / 2 - 6;
  const seg  = waveform.slice(i0, i1 + 1);
  if (!seg.length) return;

  const nPts = Math.max(2, Math.floor(W));
  const top = [], bot = [];
  for (let i = 0; i < nPts; i++) {
    const si = Math.floor(i / nPts * seg.length);
    const v  = seg[Math.min(si, seg.length - 1)];
    const px = x1 + i;
    top.push([px, midY - v * halfH]);
    bot.unshift([px, midY + v * halfH]);
  }
  const pts = [...top, ...bot];
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  pts.slice(1).forEach(p => ctx.lineTo(p[0], p[1]));
  ctx.closePath();
  ctx.fillStyle = color + '88';
  ctx.fill();
}

// name canvas: character name labels
const CB_W = 14, CB_MARGIN = 8; // checkbox size and right margin

function drawNames() {
  const W = nameCv.width, H = nameCv.height;
  nameCtx.fillStyle = '#13151f';
  nameCtx.fillRect(0, 0, W, H);

  P.char_rows.forEach((row, ri) => {
    const y1 = ri * ROW_H - P.scrollY;
    const y2 = y1 + ROW_H;
    if (y2 < 0 || y1 > H) return;

    const col    = charColor(row.char);
    const isMob  = P.mobChars.has(row.char);

    nameCtx.fillStyle = col + '22';
    nameCtx.fillRect(0, y1 + 1, W, ROW_H - 2);

    nameCtx.strokeStyle = col + '55';
    nameCtx.lineWidth = 1;
    nameCtx.strokeRect(0, y1 + 1, W - 1, ROW_H - 2);

    // mob checkbox (bottom-right of cell)
    const cbX = W - CB_MARGIN - CB_W;
    const cbY = y2 - 26;
    nameCtx.strokeStyle = isMob ? '#7744cc' : '#3a4060';
    nameCtx.lineWidth = 1;
    nameCtx.strokeRect(cbX, cbY, CB_W, CB_W);
    if (isMob) {
      nameCtx.fillStyle = '#7744cc';
      nameCtx.fillRect(cbX + 1, cbY + 1, CB_W - 2, CB_W - 2);
      nameCtx.fillStyle = '#fff';
      nameCtx.font = 'bold 10px sans-serif';
      nameCtx.fillText('✓', cbX + 2, cbY + 11);
    }
    nameCtx.font      = '9px sans-serif';
    nameCtx.fillStyle = isMob ? '#9966ee' : '#3a4060';
    nameCtx.fillText('モブ', cbX - 1, cbY - 2);

    nameCtx.font      = 'bold 12px sans-serif';
    nameCtx.fillStyle = col;
    nameCtx.fillText(clip(row.char, cbX - 14, nameCtx), 8, y1 + 22);

    if (row.set_idx !== undefined && P.sets[row.set_idx]) {
      nameCtx.font      = '10px sans-serif';
      nameCtx.fillStyle = '#5a6080';
      nameCtx.fillText(clip(P.sets[row.set_idx].name, cbX - 14, nameCtx), 8, y1 + 38);
    }
  });
}

// ═══════════════════════════════════════════════════════
//  Resize
// ═══════════════════════════════════════════════════════
function resize() {
  const gridW = D.grid_area.clientWidth;
  const gridH = D.grid_area.clientHeight;

  const cvW = Math.max(1, gridW - LABEL_W);
  const cvH = Math.max(1, gridH - HEADER_H - 2 - 14); // hdivider=2, hbar=14

  upperCv.width  = cvW;
  upperCv.height = HEADER_H;
  lowerCv.width  = cvW;
  lowerCv.height = cvH;
  nameCv.width   = LABEL_W;
  nameCv.height  = cvH;

  clampScroll();
  drawAll();
}

new ResizeObserver(resize).observe(D.grid_area);

// ═══════════════════════════════════════════════════════
//  Scroll helpers
// ═══════════════════════════════════════════════════════
function clampScroll() {
  const maxScrollPx = Math.max(0, P.totalW - lowerCv.width);
  const maxScrollMs = maxScrollPx / Math.max(0.001, P.pxPerMs);
  P.scrollMs = Math.max(0, Math.min(P.scrollMs, maxScrollMs));

  const nRows = P.char_rows.length;
  const maxScrollY = Math.max(0, nRows * ROW_H - lowerCv.height);
  P.scrollY = Math.max(0, Math.min(P.scrollY, maxScrollY));
}

function updateHbar() {
  if (!D.hbar_track) return;
  const trackW   = D.hbar_track.clientWidth;
  const totalPx  = P.totalW;
  const visW     = lowerCv.width;
  const ratio    = Math.min(1, visW / Math.max(1, totalPx));
  const thumbW   = Math.max(20, trackW * ratio);
  const scrollPx = P.scrollMs * P.pxPerMs;
  const maxPx    = Math.max(1, totalPx - visW);
  const left     = maxPx > 0 ? (trackW - thumbW) * Math.min(1, scrollPx / maxPx) : 0;
  D.hbar_thumb.style.width = thumbW + 'px';
  D.hbar_thumb.style.left  = left + 'px';
}

// ═══════════════════════════════════════════════════════
//  Lower-cv: seek (click/drag) + cursor near playhead
// ═══════════════════════════════════════════════════════
function getPlayheadX() {
  if (!P.slots.length || !P.seekPositions.length) return null;
  for (let i = 0; i < P.slots.length; i++) {
    const slot  = P.slots[i];
    const start = P.seekPositions[i];
    const end   = start + slot.duration_ms + P.gapMs;
    if (P.playhead_ms <= end || i === P.slots.length - 1) {
      // 視覚位置は duration_ms を基準に計算（gapは視覚幅に含まれない）
      const within = Math.max(0, Math.min(P.playhead_ms - start, slot.duration_ms));
      const frac   = slot.duration_ms > 0 ? within / slot.duration_ms : 0;
      return slotX(slot) + frac * slot.width;
    }
  }
  return null;
}

function seekToCanvasX(cx) {
  const clickX = cx + P.scrollMs * P.pxPerMs;
  for (const slot of P.slots) {
    if (clickX >= slot.x && clickX < slot.x + slot.width) {
      const withinMs = (clickX - slot.x) / Math.max(1, slot.width) * slot.duration_ms;
      P.playSlotIdx = slot.idx;
      P.playhead_ms = (P.seekPositions[slot.idx] || 0) + withinMs;
      if (P.isPlaying) stopPlay();  // 再生中はシークで停止
      drawLower();
      return;
    }
  }
}

let lowerDrag = null;

lowerCv.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const phX = getPlayheadX();
  if (phX !== null && Math.abs(e.offsetX - phX) <= 8) {
    lowerDrag = 'playhead';
    lowerCv.style.cursor = 'ew-resize';
  } else {
    lowerDrag = 'seek';
    seekToCanvasX(e.offsetX);
  }
  e.preventDefault();
});

lowerCv.addEventListener('mousemove', e => {
  if (lowerDrag === 'playhead' || lowerDrag === 'seek') {
    seekToCanvasX(e.offsetX);
    lowerCv.style.cursor = 'ew-resize';
    return;
  }
  const phX = getPlayheadX();
  lowerCv.style.cursor = (phX !== null && Math.abs(e.offsetX - phX) <= 8) ? 'ew-resize' : 'default';
});

lowerCv.addEventListener('mouseup', () => { lowerDrag = null; });
lowerCv.addEventListener('mouseleave', () => { lowerDrag = null; });

// ═══════════════════════════════════════════════════════
//  Wheel / zoom
// ═══════════════════════════════════════════════════════
// ポインタ位置を基点にズームする共通関数
function zoomAtPointerX(mouseX, factor) {
  // ポインタ下のスロットと、そのスロット内の比率を記録
  const mouseAbsPx = P.scrollMs * P.pxPerMs + mouseX;
  let anchorSlotIdx = -1, anchorFrac = 0;
  for (const slot of P.slots) {
    if (mouseAbsPx >= slot.x && mouseAbsPx < slot.x + slot.width) {
      anchorSlotIdx = slot.idx;
      anchorFrac = (mouseAbsPx - slot.x) / slot.width;
      break;
    }
  }
  P.pxPerMs = Math.max(0.01, Math.min(P.pxPerMs * factor, 5.0));
  computeLayout();
  // ズーム後、同じスロットの同じ位置がポインタ下に来るよう scroll を調整
  if (anchorSlotIdx >= 0 && anchorSlotIdx < P.slots.length) {
    const s = P.slots[anchorSlotIdx];
    P.scrollMs = (s.x + anchorFrac * s.width - mouseX) / P.pxPerMs;
  }
}

D.lower_cv.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey) {
    zoomAtPointerX(e.offsetX, e.deltaY < 0 ? 1.2 : 1/1.2);
  } else if (e.shiftKey) {
    P.scrollMs += e.deltaY / P.pxPerMs * 0.4;
  } else {
    P.scrollY += e.deltaY * 0.5;
  }
  clampScroll();
  drawAll();
}, { passive: false });

D.upper_cv.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey) {
    zoomAtPointerX(e.offsetX, e.deltaY < 0 ? 1.2 : 1/1.2);
  } else {
    P.scrollMs += e.deltaY / P.pxPerMs * 0.4;
  }
  clampScroll();
  drawAll();
}, { passive: false });

D.btn_zoom_in.addEventListener('click', () => {
  P.pxPerMs = Math.min(P.pxPerMs * 1.5, 5.0);
  computeLayout(); clampScroll(); drawAll();
});
D.btn_zoom_out.addEventListener('click', () => {
  P.pxPerMs = Math.max(P.pxPerMs / 1.5, 0.01);
  computeLayout(); clampScroll(); drawAll();
});

// ═══════════════════════════════════════════════════════
//  Horizontal scrollbar drag
// ═══════════════════════════════════════════════════════
let hbDrag = null;
D.hbar_thumb.addEventListener('mousedown', e => {
  hbDrag = { startX: e.clientX, startScrollMs: P.scrollMs };
  e.preventDefault();
});
document.addEventListener('mousemove', e => {
  if (!hbDrag) return;
  const trackW  = D.hbar_track.clientWidth;
  const thumbW  = parseFloat(D.hbar_thumb.style.width) || 20;
  const maxPx   = Math.max(1, P.totalW - lowerCv.width);
  const dx      = (e.clientX - hbDrag.startX) / (trackW - thumbW) * maxPx;
  P.scrollMs    = Math.max(0, hbDrag.startScrollMs + dx / P.pxPerMs);
  clampScroll();
  drawAll();
});
document.addEventListener('mouseup', () => { hbDrag = null; });

D.hbar_track.addEventListener('click', e => {
  if (e.target === D.hbar_thumb) return;
  const trackW = D.hbar_track.clientWidth;
  const thumbW = parseFloat(D.hbar_thumb.style.width) || 20;
  const maxPx  = Math.max(1, P.totalW - lowerCv.width);
  const frac   = Math.max(0, Math.min((e.offsetX - thumbW/2) / (trackW - thumbW), 1));
  P.scrollMs   = frac * maxPx / P.pxPerMs;
  clampScroll();
  drawAll();
});

// ═══════════════════════════════════════════════════════
//  Playback
// ═══════════════════════════════════════════════════════
function startPlay() {
  if (P.slots.length === 0) return;
  P.gapMs = D.gap_chk.checked ? 800 : 0;
  buildSeekPositions();
  P.isPlaying = true;
  D.btn_play.textContent = '⏸ 一時停止';
  // シーク位置からのオフセットを正確に渡す
  const slotStartMs = P.seekPositions[P.playSlotIdx] || 0;
  const withinMs = Math.max(0, P.playhead_ms - slotStartMs);
  playSlot(P.playSlotIdx, withinMs);
  startRaf();
}

function stopPlay() {
  P.isPlaying = false;
  D.btn_play.textContent = '▶ 再生';
  if (P.playAfter) { clearTimeout(P.playAfter); P.playAfter = null; }
  if (P.rafId)     { cancelAnimationFrame(P.rafId); P.rafId = null; }
  // pause all audio elements
  Object.values(audioEls).forEach(el => { try { el.pause(); } catch(_) {} });
  drawLower();
}

function playSlot(idx, withinMs) {
  if (!P.isPlaying || idx >= P.slots.length) { stopPlay(); return; }

  // まず全音声を停止してから新しいスロットを再生
  Object.values(audioEls).forEach(el => { try { el.pause(); } catch(_) {} });

  P.playSlotIdx = idx;
  const slot = P.slots[idx];
  P.playStartMs = P.seekPositions[idx] || 0;
  P.playStartT  = performance.now() - withinMs;

  const si = slot.provider;
  if (si !== null && si !== undefined && slot.duration_ms > 0) {
    const s  = P.sets[si];
    let el   = audioEls[s.sid];
    if (!el) {
      el = new Audio(`/api/sessions/${s.sid}/audio`);
      audioEls[s.sid] = el;
    }
    el.currentTime = (slot.seg_s + withinMs) / 1000;
    el.play().catch(() => {});
  }

  const totalDur = Math.max(50, slot.duration_ms - withinMs + P.gapMs);
  P.playAfter    = setTimeout(() => playSlot(idx + 1, 0), totalDur);
}

function startRaf() {
  if (P.rafId) cancelAnimationFrame(P.rafId);
  function tick() {
    if (!P.isPlaying) return;
    const elapsed = performance.now() - P.playStartT;
    P.playhead_ms = P.playStartMs + elapsed;

    // auto-scroll to keep playhead visible
    if (P.slots.length > 0 && P.playSlotIdx < P.slots.length) {
      const slot = P.slots[P.playSlotIdx];
      const phPx = slotX(slot);
      const W    = lowerCv.width;
      if (phPx > W * 0.80) {
        P.scrollMs += (phPx - W * 0.20) / P.pxPerMs;
        clampScroll();
        updateHbar();
      } else if (phPx < 0) {
        P.scrollMs = Math.max(0, slot.x / P.pxPerMs - W * 0.05 / P.pxPerMs);
        clampScroll();
        updateHbar();
      }
    }

    drawLower();
    // sync upper canvas playhead indicator (just redraw upper too — it's fast)
    drawUpper();
    P.rafId = requestAnimationFrame(tick);
  }
  P.rafId = requestAnimationFrame(tick);
}

D.btn_play.addEventListener('click', () => {
  if (P.isPlaying) {
    stopPlay();
  } else {
    if (P.playSlotIdx >= P.slots.length) P.playSlotIdx = 0;
    startPlay();
  }
});

D.btn_stop.addEventListener('click', () => {
  stopPlay();
  P.playhead_ms = 0;
  P.playSlotIdx = 0;
  drawLower();
});

document.addEventListener('keydown', e => {
  if (e.code === 'Space'
      && e.target.tagName !== 'TEXTAREA'
      && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    D.btn_play.click();
  }
});

// gap checkbox change
D.gap_chk.addEventListener('change', () => {
  P.gapMs = D.gap_chk.checked ? 800 : 0;
  buildSeekPositions();
});

// ═══════════════════════════════════════════════════════
//  Set management
// ═══════════════════════════════════════════════════════

async function doAddSet(file) {
  setStatus('読み込み中…');
  const fd = new FormData();
  fd.append('file', file);
  let data;
  try {
    const res = await fetch(API_BASE + '/api/sessions', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json().catch(() => ({detail:res.statusText}))).detail);
    data = await res.json();
  } catch(e) {
    alert('エラー: ' + e.message);
    setStatus('');
    return;
  }

  // prompt for character name
  const charName = await promptCharName();
  if (charName === null) { setStatus(''); return; }  // cancelled

  // save assigned_char to backend
  if (charName) {
    await fetch(`${API_BASE}/api/sessions/${data.sid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigned_char: charName }),
    });
  }

  P.sets.push({
    sid: data.sid,
    name: data.name,
    assigned_char: charName,
    waveform: data.waveform,
    markers: data.markers || [],
    duration_ms: data.duration_ms,
  });

  renderSetList();
  computeLayout();
  drawAll();
  updateStatus();
}

function removeSet(idx) {
  P.sets.splice(idx, 1);
  renderSetList();
  computeLayout();
  drawAll();
  updateStatus();
}

function renderSetList() { /* set panel removed */ }

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════════════
//  Name canvas interaction: mob toggle + rename
// ═══════════════════════════════════════════════════════
function rowAtY(y) {
  return Math.floor((y + P.scrollY) / ROW_H);
}

function isInCheckbox(e) {
  const W = nameCv.width;
  const ri = rowAtY(e.offsetY);
  if (ri < 0 || ri >= P.char_rows.length) return false;
  const y1  = ri * ROW_H - P.scrollY;
  const cbX = W - CB_MARGIN - CB_W;
  const cbY = y1 + ROW_H - 26;
  return (e.offsetX >= cbX - 4 && e.offsetX <= cbX + CB_W + 4 &&
          e.offsetY >= cbY - 14 && e.offsetY <= cbY + CB_W + 4);
}

nameCv.addEventListener('click', e => {
  if (!isInCheckbox(e)) return;
  const ri  = rowAtY(e.offsetY);
  const row = P.char_rows[ri];
  if (P.mobChars.has(row.char)) {
    P.mobChars.delete(row.char);
  } else {
    P.mobChars.add(row.char);
  }
  drawNames();
});

nameCv.addEventListener('dblclick', async e => {
  if (isInCheckbox(e)) return;
  const ri = rowAtY(e.offsetY);
  if (ri < 0 || ri >= P.char_rows.length) return;
  const row = P.char_rows[ri];

  const newName = await promptCharName(row.char);  // 現在の名前を初期値として渡す
  if (newName === null || newName.trim() === '' || newName.trim() === row.char) return;
  const trimmed = newName.trim();

  // update sets
  P.sets.forEach(s => {
    if (s.assigned_char === row.char) {
      s.assigned_char = trimmed;
      fetch(`${API_BASE}/api/sessions/${s.sid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigned_char: trimmed }),
      });
    }
  });

  // update master chars
  P.master_chars = P.master_chars.map(c => c === row.char ? trimmed : c);

  // migrate mob flag
  if (P.mobChars.has(row.char)) {
    P.mobChars.delete(row.char);
    P.mobChars.add(trimmed);
  }

  computeLayout();
  drawAll();
  renderSetList();
  updateStatus();
});

// ═══════════════════════════════════════════════════════
//  Character name prompt dialog
// ═══════════════════════════════════════════════════════
let _charResolve = null;

function promptCharName(initial = '') {
  return new Promise(resolve => {
    _charResolve = resolve;
    D.char_prompt_input.value = initial;
    D.char_prompt_overlay.classList.remove('hidden');
    setTimeout(() => { D.char_prompt_input.focus(); D.char_prompt_input.select(); }, 50);
  });
}

D.btn_char_ok.addEventListener('click', () => {
  const v = D.char_prompt_input.value.trim();
  D.char_prompt_overlay.classList.add('hidden');
  if (_charResolve) { _charResolve(v); _charResolve = null; }
});

D.btn_char_cancel.addEventListener('click', () => {
  D.char_prompt_overlay.classList.add('hidden');
  if (_charResolve) { _charResolve(null); _charResolve = null; }
});

D.char_prompt_input.addEventListener('keydown', e => {
  if (e.key === 'Enter') D.btn_char_ok.click();
  if (e.key === 'Escape') D.btn_char_cancel.click();
});


// ═══════════════════════════════════════════════════════
//  Export
// ═══════════════════════════════════════════════════════
async function ensureProject() {
  const res = await fetch(API_BASE + '/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ set_ids: P.sets.map(s => s.sid) }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({detail:res.statusText}))).detail);
  const d  = await res.json();
  P.pid    = d.pid;

  // send master script
  const text = P.master_chars.map((c, i) =>
    c ? `${c}\t${P.master_lines[i]}` : P.master_lines[i]
  ).join('\n');
  await fetch(`${API_BASE}/api/projects/${P.pid}/master-script`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return P.pid;
}

async function doExport(mode) {
  if (!P.slots.length) { alert('マスター台本を読み込んでください'); return; }
  if (!P.sets.length)  { alert('セットを追加してください'); return; }
  setExportBtnsEnabled(false);
  const msg = mode === 'srt' ? 'SRT書き出し中…' : '音声書き出し中…';
  D.export_progress_msg.textContent = msg;
  D.export_progress_overlay.classList.remove('hidden');
  setStatus(msg);
  try {
    const pid   = await ensureProject();
    const ep    = mode === 'srt' ? `${API_BASE}/api/projects/${pid}/export-srt` : `${API_BASE}/api/projects/${pid}/export`;
    const fname = mode === 'srt' ? 'srt_export.zip' : 'audio_export.zip';
    const res   = await fetch(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        add_gap:   D.gap_chk.checked,
        mob_chars: [...P.mobChars],
        slots:     P.slots,   // 無音トリム済みのseg_s/seg_eをそのまま送る
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({detail:res.statusText}))).detail);
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus('完了');
  } catch(e) {
    alert('エラー: ' + e.message);
    setStatus('エラー');
  }
  D.export_progress_overlay.classList.add('hidden');
  setExportBtnsEnabled(true);
}

D.btn_export_audio.addEventListener('click', () => doExport('audio'));
D.btn_export_srt.addEventListener  ('click', () => doExport('srt'));

function setExportBtnsEnabled(on) {
  D.btn_export_audio.disabled = !on;
  D.btn_export_srt.disabled   = !on;
}

// ═══════════════════════════════════════════════════════
//  Status
// ═══════════════════════════════════════════════════════
function setStatus(msg) {
  D.status_label.textContent = msg;
}

function updateStatus() {
  const nSets  = P.sets.length;
  const nLines = P.master_lines.length;
  const nMatch = P.slots.filter(s => s.provider !== null).length;
  if (nLines > 0) {
    setStatus(`セット ${nSets} / 台本 ${nLines} 行 / 一致 ${nMatch}`);
  } else if (nSets > 0) {
    setStatus(`セット ${nSets}`);
  } else {
    setStatus('');
  }
}

// ═══════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════
resize();
