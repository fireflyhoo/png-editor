/* =========================================================================
 * PNG / JPEG 区域删除工具  ·  纯前端 Canvas 实现
 * 选区：矩形 / 椭圆 / 套索  →  删除：透明 / 纯色 / 内容感知修复
 * ========================================================================= */
'use strict';

/* ----------------------------- 全局状态 ----------------------------- */
const state = {
  img: null,                 // 原图 HTMLImageElement
  imgW: 0, imgH: 0,
  scale: 1,                  // 显示缩放
  offsetX: 0, offsetY: 0,    // 平移（相对 flex 居中后的位移，px）
  tool: 'rect',              // rect | ellipse | lasso
  mode: 'transparent',      // transparent | color | inpaint
  cropMode: false,          // 裁剪模式（选区外暗化预览）
  fillColor: '#ffffff',
  selection: null,          // {type, bbox:{x,y,w,h}} | {type:'lasso', points:[{x,y}]}
  lassoDrawing: false,      // 套索进行中
  history: [],              // ImageData 快照（撤销）
  redo: [],                 // 重做栈
  hasImage: false,
};

/* ----------------------------- 元素引用 ----------------------------- */
const $ = (id) => document.getElementById(id);
const stage = $('stage');
const canvasWrap = $('canvasWrap');
const mainCanvas = $('mainCanvas');
const overlayCanvas = $('overlayCanvas');
const mainCtx = mainCanvas.getContext('2d', { willReadFrequently: true });
const overlayCtx = overlayCanvas.getContext('2d');
const emptyState = $('emptyState');

const fileInput = $('fileInput');
const zoomLabel = $('zoomLabel');
const statusImg = $('statusImg');
const statusSel = $('statusSel');
const statusTip = $('statusTip');

/* ----------------------------- 工具函数 ----------------------------- */
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// 屏幕坐标 → 图片坐标
function toImageCoords(clientX, clientY) {
  const rect = mainCanvas.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width * state.imgW;
  const y = (clientY - rect.top) / rect.height * state.imgH;
  return { x, y };
}

// 把画布像素分辨率与显示尺寸同步到当前 scale
function syncCanvasSize() {
  if (!state.hasImage) return;
  // ⚠️ 给 canvas.width/height 赋值会清空画布内容，仅在像素尺寸变化时才重设。
  // 否则每次缩放/平移都会把已绘制的图片擦掉。
  if (mainCanvas.width !== state.imgW || mainCanvas.height !== state.imgH) {
    mainCanvas.width = state.imgW;
    mainCanvas.height = state.imgH;
    overlayCanvas.width = state.imgW;
    overlayCanvas.height = state.imgH;
  }
  const dw = Math.round(state.imgW * state.scale);
  const dh = Math.round(state.imgH * state.scale);
  mainCanvas.style.width = dw + 'px';
  mainCanvas.style.height = dh + 'px';
  overlayCanvas.style.width = dw + 'px';
  overlayCanvas.style.height = dh + 'px';
  canvasWrap.style.transform = `translate(${state.offsetX}px, ${state.offsetY}px)`;
  zoomLabel.textContent = Math.round(state.scale * 100) + '%';
}

// 适应窗口
function fitToScreen() {
  if (!state.hasImage) return;
  const pad = 48;
  const sw = stage.clientWidth - pad;
  const sh = stage.clientHeight - pad;
  state.scale = clamp(Math.min(sw / state.imgW, sh / state.imgH), 0.05, 16);
  state.offsetX = 0;
  state.offsetY = 0;
  syncCanvasSize();
}

/* ----------------------------- 图片载入 ----------------------------- */
function loadImageFromFile(file) {
  if (!file || !/image\/(png|jpeg|jpg)/.test(file.type)) {
    alert('请选择 PNG 或 JPEG 图片');
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { applyLoadedImage(img); URL.revokeObjectURL(url); };
  img.onerror = () => { alert('图片载入失败'); URL.revokeObjectURL(url); };
  img.src = url;
}

// 应用一张已加载的图片（统一入口：文件选择 / 拖拽 / URL 参数）
function applyLoadedImage(img) {
  state.img = img;
  state.imgW = img.naturalWidth;
  state.imgH = img.naturalHeight;
  state.hasImage = true;
  state.history = [];
  state.redo = [];
  state.selection = null;
  state.offsetX = 0;
  state.offsetY = 0;
  canvasWrap.classList.add('active');
  emptyState.style.display = 'none';
  mainCanvas.classList.add('transparent-bg');
  // ⚠️ 顺序很关键：先确定显示尺寸（可能重置画布），再清干净，最后绘制
  fitToScreen();
  mainCtx.clearRect(0, 0, state.imgW, state.imgH);
  mainCtx.drawImage(img, 0, 0);
  updateOverlay();
  updateStatus();
  updateUndoRedo();
}

fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) loadImageFromFile(e.target.files[0]);
  fileInput.value = '';
});

// 拖拽载入
['dragenter', 'dragover'].forEach(ev =>
  stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev =>
  stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.remove('dragover'); }));
stage.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) loadImageFromFile(f);
});

/* ----------------------------- 缩放 / 平移 ----------------------------- */
function zoomAt(clientX, clientY, newScale) {
  newScale = clamp(newScale, 0.05, 16);
  const stageRect = stage.getBoundingClientRect();
  const stageCx = stageRect.left + stageRect.width / 2;
  const stageCy = stageRect.top + stageRect.height / 2;
  const mouseInStageX = clientX - stageCx;
  const mouseInStageY = clientY - stageCy;
  // 鼠标处的图片坐标（保证缩放前后该点屏幕位置不变）
  const imgX = (mouseInStageX - state.offsetX + state.imgW * state.scale / 2) / state.scale;
  const imgY = (mouseInStageY - state.offsetY + state.imgH * state.scale / 2) / state.scale;
  state.scale = newScale;
  state.offsetX = mouseInStageX - state.imgW * newScale / 2 + imgX * newScale;
  state.offsetY = mouseInStageY - state.imgH * newScale / 2 + imgY * newScale;
  syncCanvasSize();
}

stage.addEventListener('wheel', (e) => {
  if (!state.hasImage) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  zoomAt(e.clientX, e.clientY, state.scale * factor);
}, { passive: false });

$('btnZoomIn').onclick = () => zoomAt(stage.getBoundingClientRect().left + stage.clientWidth/2,
  stage.getBoundingClientRect().top + stage.clientHeight/2, state.scale * 1.2);
$('btnZoomOut').onclick = () => zoomAt(stage.getBoundingClientRect().left + stage.clientWidth/2,
  stage.getBoundingClientRect().top + stage.clientHeight/2, state.scale / 1.2);
$('btnFit').onclick = fitToScreen;

/* ----------------------------- 选区：手柄与命中 ----------------------------- */
const HANDLE_KEYS = ['tl', 't', 'tr', 'l', 'r', 'bl', 'b', 'br'];

function getHandles(bbox) {
  const { x, y, w, h } = bbox;
  return {
    tl: { x, y }, t: { x: x + w / 2, y }, tr: { x: x + w, y },
    l: { x, y: y + h / 2 }, r: { x: x + w, y: y + h / 2 },
    bl: { x, y: y + h }, b: { x: x + w / 2, y: y + h },
    br: { x: x + w, y: y + h },
  };
}

function hitHandle(imgX, imgY) {
  if (!state.selection || state.selection.type === 'lasso') return null;
  const handles = getHandles(state.selection.bbox);
  const r = 9 / state.scale;
  for (const k of HANDLE_KEYS) {
    const h = handles[k];
    if (Math.abs(imgX - h.x) <= r && Math.abs(imgY - h.y) <= r) return k;
  }
  return null;
}

function isInsideSelection(imgX, imgY) {
  const s = state.selection;
  if (!s) return false;
  if (s.type === 'lasso') {
    if (!s.points || s.points.length < 3) return false;
    overlayCtx.beginPath();
    overlayCtx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) overlayCtx.lineTo(s.points[i].x, s.points[i].y);
    overlayCtx.closePath();
    return overlayCtx.isPointInPath(imgX, imgY);
  }
  const { x, y, w, h } = s.bbox;
  if (s.type === 'ellipse') {
    const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
    if (rx <= 0 || ry <= 0) return false;
    const dx = (imgX - cx) / rx, dy = (imgY - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }
  return imgX >= x && imgX <= x + w && imgY >= y && imgY <= y + h;
}

function applyResize(handle, mx, my, bbox) {
  let left = bbox.x, top = bbox.y, right = bbox.x + bbox.w, bottom = bbox.y + bbox.h;
  if (handle.includes('l')) left = mx;
  if (handle.includes('r')) right = mx;
  if (handle.includes('t')) top = my;
  if (handle.includes('b')) bottom = my;
  const nx = Math.min(left, right), nw = Math.abs(right - left);
  const ny = Math.min(top, bottom), nh = Math.abs(bottom - top);
  return { x: nx, y: ny, w: Math.max(nw, 2), h: Math.max(nh, 2) };
}

/* ----------------------------- 鼠标交互 ----------------------------- */
let drag = null; // {mode:'new'|'move'|'resize'|'pan'|'lasso', ...}

canvasWrap.addEventListener('mousedown', (e) => {
  if (!state.hasImage) return;
  e.preventDefault();
  const { x, y } = toImageCoords(e.clientX, e.clientY);

  // 已有选区时的命中优先级：手柄 > 选区内部 > 空白处平移/新建
  const hk = hitHandle(x, y);
  if (state.selection && hk) {
    drag = { mode: 'resize', handle: hk, startBbox: { ...state.selection.bbox } };
    return;
  }
  if (state.selection && isInsideSelection(x, y)) {
    if (state.selection.type === 'lasso') {
      drag = { mode: 'move', lastX: x, lastY: y };
    } else {
      drag = { mode: 'move', lastX: x, lastY: y, startBbox: { ...state.selection.bbox } };
    }
    return;
  }

  // 空白处：新建选区 或 平移
  if (e.button === 1 || e.altKey) { // 中键/Alt 平移
    drag = { mode: 'pan', startX: e.clientX, startY: e.clientY, oX: state.offsetX, oY: state.offsetY };
    return;
  }

  if (state.tool === 'lasso') {
    state.lassoDrawing = true;
    state.selection = { type: 'lasso', points: [{ x, y }] };
    drag = { mode: 'lasso' };
  } else {
    state.selection = { type: state.tool, bbox: { x, y, w: 0, h: 0 } };
    drag = { mode: 'new', startX: x, startY: y };
  }
  updateOverlay();
  updateStatus();
});

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const { x, y } = toImageCoords(e.clientX, e.clientY);

  if (drag.mode === 'pan') {
    state.offsetX = drag.oX + (e.clientX - drag.startX);
    state.offsetY = drag.oY + (e.clientY - drag.startY);
    syncCanvasSize();
    return;
  }
  if (drag.mode === 'new') {
    const x0 = Math.min(drag.startX, x), y0 = Math.min(drag.startY, y);
    state.selection.bbox = { x: x0, y: y0, w: Math.abs(x - drag.startX), h: Math.abs(y - drag.startY) };
  } else if (drag.mode === 'resize') {
    state.selection.bbox = applyResize(drag.handle, x, y, drag.startBbox);
  } else if (drag.mode === 'move') {
    if (state.selection.type === 'lasso') {
      const dx = x - drag.lastX, dy = y - drag.lastY;
      state.selection.points = state.selection.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
      drag.lastX = x; drag.lastY = y;
    } else {
      const dx = x - drag.lastX, dy = y - drag.lastY;
      state.selection.bbox = {
        x: drag.startBbox.x + dx, y: drag.startBbox.y + dy,
        w: drag.startBbox.w, h: drag.startBbox.h,
      };
      drag.lastX = x; drag.lastY = y;
    }
  } else if (drag.mode === 'lasso') {
    const pts = state.selection.points;
    const last = pts[pts.length - 1];
    if (Math.hypot(x - last.x, y - last.y) > 2 / state.scale) pts.push({ x, y });
  }
  updateOverlay();
  updateStatus();
});

window.addEventListener('mouseup', () => {
  if (!drag) return;
  if (drag.mode === 'lasso') {
    state.lassoDrawing = false;
    if (state.selection && state.selection.points.length < 3) state.selection = null;
  }
  if (drag.mode === 'new' && state.selection) {
    const b = state.selection.bbox;
    if (b.w < 2 || b.h < 2) state.selection = null; // 误点
  }
  drag = null;
  updateOverlay();
  updateStatus();
});

// 空白处（画布外）拖拽平移
stage.addEventListener('mousedown', (e) => {
  if (!state.hasImage || drag) return;
  if (e.target === mainCanvas || e.target === overlayCanvas) return; // 画布内交给 wrap
  if (state.selection) {
    const { x, y } = toImageCoords(e.clientX, e.clientY);
    if (isInsideSelection(x, y)) return;
  }
  drag = { mode: 'pan', startX: e.clientX, startY: e.clientY, oX: state.offsetX, oY: state.offsetY };
});

/* ----------------------------- Overlay 绘制 ----------------------------- */
// 在当前 ctx 上描绘当前选区闭合路径（供 clip / 遮罩挖洞 / 描边复用）
function traceSelectionPath(ctx) {
  const s = state.selection;
  ctx.beginPath();
  if (s.type === 'lasso') {
    const pts = s.points;
    if (!pts || !pts.length) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  } else if (s.type === 'ellipse') {
    const { x, y, w, h } = s.bbox;
    ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
  } else {
    const { x, y, w, h } = s.bbox;
    ctx.rect(x, y, w, h);
  }
}

// 在裁切局部坐标系（origin 偏移 ox,oy）描绘选区路径，供 applyCrop 的 clip 使用
function traceSelectionPathLocal(ctx, ox, oy) {
  const s = state.selection;
  ctx.beginPath();
  if (s.type === 'lasso') {
    const pts = s.points;
    ctx.moveTo(pts[0].x - ox, pts[0].y - oy);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x - ox, pts[i].y - oy);
    ctx.closePath();
  } else if (s.type === 'ellipse') {
    const { x, y, w, h } = s.bbox;
    ctx.ellipse(x + w / 2 - ox, y + h / 2 - oy, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
  }
}

function drawHandles() {
  const s = state.selection;
  const handles = getHandles(s.bbox);
  const hs = 4 / state.scale;
  overlayCtx.fillStyle = '#ffffff';
  overlayCtx.strokeStyle = '#4f7cff';
  overlayCtx.lineWidth = 1.2 / state.scale;
  for (const k of HANDLE_KEYS) {
    const hpt = handles[k];
    overlayCtx.beginPath();
    overlayCtx.rect(hpt.x - hs, hpt.y - hs, hs * 2, hs * 2);
    overlayCtx.fill();
    overlayCtx.stroke();
  }
}

function updateOverlay() {
  overlayCtx.clearRect(0, 0, state.imgW, state.imgH);
  const s = state.selection;
  if (!s) return;
  const lw = 2 / state.scale;

  // 裁剪预览：选区外暗化，选区内透出原图
  if (state.cropMode) {
    overlayCtx.save();
    overlayCtx.fillStyle = 'rgba(15, 18, 25, 0.5)';
    overlayCtx.fillRect(0, 0, state.imgW, state.imgH);
    overlayCtx.globalCompositeOperation = 'destination-out';
    traceSelectionPath(overlayCtx);
    overlayCtx.fill();
    overlayCtx.restore();

    overlayCtx.save();
    overlayCtx.lineWidth = lw;
    overlayCtx.strokeStyle = '#ffffff';
    traceSelectionPath(overlayCtx);
    overlayCtx.stroke();
    overlayCtx.restore();

    if (s.type !== 'lasso') drawHandles();
    return;
  }

  overlayCtx.save();
  overlayCtx.lineWidth = lw;
  overlayCtx.strokeStyle = '#4f7cff';
  overlayCtx.fillStyle = 'rgba(79,124,255,0.12)';

  if (s.type === 'lasso') {
    if (s.points && s.points.length) {
      overlayCtx.beginPath();
      overlayCtx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) overlayCtx.lineTo(s.points[i].x, s.points[i].y);
      if (!state.lassoDrawing) overlayCtx.closePath();
      overlayCtx.fill();
      overlayCtx.stroke();
    }
  } else {
    const { x, y, w, h } = s.bbox;
    if (s.type === 'ellipse') {
      overlayCtx.beginPath();
      overlayCtx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
      overlayCtx.fill();
      overlayCtx.stroke();
    } else {
      overlayCtx.fillRect(x, y, w, h);
      overlayCtx.strokeRect(x, y, w, h);
    }
    drawHandles();
  }
  overlayCtx.restore();
}

/* ----------------------------- 删除操作 ----------------------------- */
function buildMask() {
  const { imgW: W, imgH: H } = state;
  const N = W * H;
  const mask = new Uint8Array(N);
  const s = state.selection;
  if (!s) return mask;
  if (s.type === 'lasso') {
    if (!s.points || s.points.length < 3) return mask;
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const octx = off.getContext('2d');
    octx.beginPath();
    octx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) octx.lineTo(s.points[i].x, s.points[i].y);
    octx.closePath();
    octx.fill();
    const a = octx.getImageData(0, 0, W, H).data;
    for (let i = 0; i < N; i++) if (a[i * 4 + 3] > 0) mask[i] = 1;
  } else {
    const { x, y, w, h } = s.bbox;
    const x0 = clamp(Math.floor(x), 0, W - 1), x1 = clamp(Math.ceil(x + w), 1, W);
    const y0 = clamp(Math.floor(y), 0, H - 1), y1 = clamp(Math.ceil(y + h), 1, H);
    if (s.type === 'ellipse') {
      const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const dx = (px + 0.5 - cx) / rx, dy = (py + 0.5 - cy) / ry;
          if (dx * dx + dy * dy <= 1) mask[py * W + px] = 1;
        }
      }
    } else {
      for (let py = y0; py < y1; py++)
        for (let px = x0; px < x1; px++) mask[py * W + px] = 1;
    }
  }
  return mask;
}

// 内容感知修复：基于距离顺序（FMM 简化）从边界向内扩散
function inpaint(imgData, mask) {
  const W = state.imgW, H = state.imgH, N = W * H;
  const data = imgData.data;
  const INF = 0xffffffff;
  const dist = new Uint32Array(N);
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;

  // 8 邻偏移（严格不含中心）
  const NB = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];
  const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
  const DY = [-1, -1, -1, 0, 0, 1, 1, 1];

  for (let i = 0; i < N; i++) dist[i] = mask[i] ? INF : 0;

  // 多源种子：unknown 且邻接 known
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i] === 0) continue;
      let seed = false;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k], ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (mask[i + NB[k]] === 0) { seed = true; break; }
      }
      if (seed) { dist[i] = 1; queue[qt++] = i; }
    }
  }

  // BFS 扩散距离
  while (qh < qt) {
    const i = queue[qh++];
    const d = dist[i];
    const x = i % W, y = (i / W) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k], ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = i + NB[k];
      if (mask[n] === 1 && dist[n] === INF) { dist[n] = d + 1; queue[qt++] = n; }
    }
  }

  // 按距离升序填充
  let maxD = 0;
  for (let i = 0; i < N; i++) if (dist[i] !== INF && dist[i] > maxD) maxD = dist[i];
  const buckets = [];
  for (let d = 0; d <= maxD; d++) buckets.push([]);
  for (let i = 0; i < N; i++) if (mask[i] === 1 && dist[i] !== INF) buckets[dist[i]].push(i);

  const diagW = 0.6;
  const weights = [diagW, 1, diagW, 1, 1, diagW, 1, diagW];
  for (let d = 1; d <= maxD; d++) {
    const list = buckets[d];
    for (let li = 0; li < list.length; li++) {
      const i = list[li];
      const x = i % W, y = (i / W) | 0;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k], ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = i + NB[k];
        if (mask[n] === 1 && dist[n] >= d) continue; // 未知且未填充
        if (data[n * 4 + 3] < 8) continue;            // 跳过透明邻居
        // 原始已知像素权重更高，已填充像素降权，减少多层均值导致的过度平滑
        const w = weights[k] * (mask[n] === 0 ? 1 : 0.5);
        r += data[n * 4] * w; g += data[n * 4 + 1] * w;
        b += data[n * 4 + 2] * w; a += data[n * 4 + 3] * w;
        wsum += w;
      }
      if (wsum > 0) {
        const p = i * 4;
        data[p] = r / wsum; data[p + 1] = g / wsum;
        data[p + 2] = b / wsum; data[p + 3] = a / wsum;
      }
    }
  }
}

function deleteSelection() {
  if (!state.hasImage) { alert('请先打开图片'); return; }
  if (!state.selection) { alert('请先选择要删除的区域'); return; }
  const mask = buildMask();
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  if (count === 0) { alert('选区为空'); return; }

  pushHistory();
  const imgData = mainCtx.getImageData(0, 0, state.imgW, state.imgH);
  const data = imgData.data;

  if (state.mode === 'transparent') {
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) { const p = i * 4; data[p + 3] = 0; }
    }
  } else if (state.mode === 'color') {
    const c = hexToRgb(state.fillColor);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) { const p = i * 4; data[p] = c.r; data[p + 1] = c.g; data[p + 2] = c.b; data[p + 3] = 255; }
    }
  } else if (state.mode === 'inpaint') {
    // 检查是否存在已知不透明区域可供采样
    let known = 0;
    for (let i = 0; i < mask.length; i++) if (!mask[i] && data[i * 4 + 3] > 8) known++;
    if (known === 0) { alert('修复模式需要选区外有可见内容作为采样源'); state.history.pop(); return; }
    inpaint(imgData, mask);
  }

  mainCtx.putImageData(imgData, 0, 0);
  state.selection = null;
  updateOverlay();
  updateStatus();
  updateUndoRedo();
}

/* ----------------------------- 裁剪操作 ----------------------------- */
function applyCrop() {
  if (!state.hasImage) { alert('请先打开图片'); return; }
  const s = state.selection;
  if (!s) { alert('请先选择要保留的裁剪区域'); return; }

  // 计算选区像素边界框（整数）
  let sx, sy, cw, ch;
  if (s.type === 'lasso') {
    if (!s.points || s.points.length < 3) { alert('套索选区无效'); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of s.points) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    sx = Math.floor(clamp(minX, 0, state.imgW)); sy = Math.floor(clamp(minY, 0, state.imgH));
    const ex = Math.ceil(clamp(maxX, 0, state.imgW)); const ey = Math.ceil(clamp(maxY, 0, state.imgH));
    cw = ex - sx; ch = ey - sy;
  } else {
    const b = s.bbox;
    const x0 = Math.min(b.x, b.x + b.w), y0 = Math.min(b.y, b.y + b.h);
    const x1 = Math.max(b.x, b.x + b.w), y1 = Math.max(b.y, b.y + b.h);
    sx = Math.floor(clamp(x0, 0, state.imgW)); sy = Math.floor(clamp(y0, 0, state.imgH));
    const ex = Math.ceil(clamp(x1, 0, state.imgW)); const ey = Math.ceil(clamp(y1, 0, state.imgH));
    cw = ex - sx; ch = ey - sy;
  }
  if (cw <= 0 || ch <= 0) { alert('裁剪区域无效'); return; }

  pushHistory();

  // 提取选区内容到临时画布
  const tmp = document.createElement('canvas');
  tmp.width = cw; tmp.height = ch;
  const tctx = tmp.getContext('2d');
  if (s.type === 'rect') {
    // 矩形：硬裁切，无透明边
    tctx.drawImage(mainCanvas, sx, sy, cw, ch, 0, 0, cw, ch);
  } else {
    // 椭圆 / 套索：clip 保留形状，形状外透明
    tctx.save();
    traceSelectionPathLocal(tctx, sx, sy);
    tctx.clip();
    tctx.drawImage(mainCanvas, sx, sy, cw, ch, 0, 0, cw, ch);
    tctx.restore();
  }

  // 应用：更新尺寸并绘制
  state.imgW = cw;
  state.imgH = ch;
  state.cropMode = false;
  $('btnCrop').classList.remove('active');
  state.selection = null;
  fitToScreen();
  mainCtx.clearRect(0, 0, cw, ch);
  mainCtx.drawImage(tmp, 0, 0);
  updateOverlay();
  updateStatus();
  updateUndoRedo();
}

function hexToRgb(hex) {
  const m = hex.replace('#', '');
  return { r: parseInt(m.slice(0, 2), 16), g: parseInt(m.slice(2, 4), 16), b: parseInt(m.slice(4, 6), 16) };
}

/* ----------------------------- 撤销 / 重做 ----------------------------- */
function pushHistory() {
  const snap = { data: mainCtx.getImageData(0, 0, state.imgW, state.imgH), w: state.imgW, h: state.imgH };
  state.history.push(snap);
  if (state.history.length > 25) state.history.shift();
  state.redo = [];
}
// 还原到带尺寸的快照（裁切会改变画布尺寸，必须一并恢复）
function restoreSnapshot(snap) {
  state.imgW = snap.w;
  state.imgH = snap.h;
  if (mainCanvas.width !== snap.w || mainCanvas.height !== snap.h) {
    mainCanvas.width = snap.w;
    mainCanvas.height = snap.h;
    overlayCanvas.width = snap.w;
    overlayCanvas.height = snap.h;
  }
  mainCtx.putImageData(snap.data, 0, 0);
  syncCanvasSize();
}
function undo() {
  if (!state.history.length) return;
  state.redo.push({ data: mainCtx.getImageData(0, 0, state.imgW, state.imgH), w: state.imgW, h: state.imgH });
  const snap = state.history.pop();
  restoreSnapshot(snap);
  state.selection = null;
  updateOverlay(); updateStatus(); updateUndoRedo();
}
function redo() {
  if (!state.redo.length) return;
  state.history.push({ data: mainCtx.getImageData(0, 0, state.imgW, state.imgH), w: state.imgW, h: state.imgH });
  const snap = state.redo.pop();
  restoreSnapshot(snap);
  state.selection = null;
  updateOverlay(); updateStatus(); updateUndoRedo();
}
function updateUndoRedo() {
  $('btnUndo').disabled = state.history.length === 0;
  $('btnRedo').disabled = state.redo.length === 0;
}

/* ----------------------------- 导出 ----------------------------- */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportPng() {
  if (!state.hasImage) return;
  mainCanvas.toBlob((b) => download(b, 'erased-' + Date.now() + '.png'), 'image/png');
}
function exportJpg() {
  if (!state.hasImage) return;
  // JPEG 不支持透明：垫白底
  const c = document.createElement('canvas');
  c.width = state.imgW; c.height = state.imgH;
  const cx = c.getContext('2d');
  cx.fillStyle = '#ffffff';
  cx.fillRect(0, 0, c.width, c.height);
  cx.drawImage(mainCanvas, 0, 0);
  c.toBlob((b) => download(b, 'erased-' + Date.now() + '.jpg'), 'image/jpeg', 0.92);
}

/* ----------------------------- 状态栏 / 杂项 ----------------------------- */
function updateStatus() {
  statusImg.textContent = state.hasImage
    ? `图片 ${state.imgW}×${state.imgH}` : '未载入图片';
  if (state.cropMode) {
    statusTip.textContent = '裁剪模式：调整选区后点「应用裁剪」或按 Enter（Esc 退出）';
  } else {
    statusTip.textContent = '提示：滚轮缩放，空白处拖拽平移';
  }
  if (!state.selection) { statusSel.textContent = '无选区'; updateApplyCropBtn(); return; }
  if (state.selection.type === 'lasso') {
    statusSel.textContent = `套索选区 · ${state.selection.points ? state.selection.points.length : 0} 点`;
  } else {
    const b = state.selection.bbox;
    statusSel.textContent = `${state.selection.type === 'ellipse' ? '椭圆' : '矩形'}选区 · ${Math.round(b.w)}×${Math.round(b.h)}`;
  }
  updateApplyCropBtn();
}

function updateApplyCropBtn() {
  $('btnApplyCrop').disabled = !(state.hasImage && state.selection);
}

/* ----------------------------- 事件绑定 ----------------------------- */
// 工具切换
document.querySelectorAll('.btn.tool').forEach(b =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.btn.tool').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.tool = b.dataset.tool;
    if (state.tool !== 'lasso' && state.selection && state.selection.type === 'lasso') {
      // 切换工具不清空选区，但套索转其他时保留为 lasso 直到重选；这里保持简单：不强制清空
    }
  }));

// 模式切换
document.querySelectorAll('.btn.mode').forEach(b =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.btn.mode').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.mode = b.dataset.mode;
  }));

$('fillColor').addEventListener('input', (e) => { state.fillColor = e.target.value; });

$('btnDelete').onclick = deleteSelection;
$('btnClearSel').onclick = () => { state.selection = null; updateOverlay(); updateStatus(); };

// 裁剪模式开关：进入后自动用全图矩形选区作为初始裁剪框
$('btnCrop').onclick = () => {
  if (!state.hasImage) { alert('请先打开图片'); return; }
  state.cropMode = !state.cropMode;
  $('btnCrop').classList.toggle('active', state.cropMode);
  if (state.cropMode && !state.selection) {
    state.selection = { type: 'rect', bbox: { x: 0, y: 0, w: state.imgW, h: state.imgH } };
  }
  updateOverlay();
  updateStatus();
};
$('btnApplyCrop').onclick = applyCrop;
$('btnClear').onclick = () => {
  if (!state.hasImage) return;
  if (!confirm('确定清空当前图片？')) return;
  state.hasImage = false;
  state.img = null;
  state.cropMode = false;
  $('btnCrop').classList.remove('active');
  canvasWrap.classList.remove('active');
  emptyState.style.display = 'flex';
  mainCanvas.classList.remove('transparent-bg');
  mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
  state.selection = null; state.history = []; state.redo = [];
  updateOverlay(); updateStatus(); updateUndoRedo();
};
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;
$('btnExportPng').onclick = exportPng;
$('btnExportJpg').onclick = exportJpg;

// 键盘快捷键
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Enter' && state.cropMode && state.selection) { e.preventDefault(); applyCrop(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection && !state.cropMode) { e.preventDefault(); deleteSelection(); }
  else if (e.key === 'Escape') {
    if (state.cropMode) { state.cropMode = false; $('btnCrop').classList.remove('active'); }
    state.selection = null; updateOverlay(); updateStatus();
  }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
});

// 窗口尺寸变化时若未平移则重新适应
window.addEventListener('resize', () => { if (state.hasImage && state.offsetX === 0 && state.offsetY === 0) fitToScreen(); });

// 支持 ?img=<url> 自动载入（示例 / 分享预览）
(function autoLoad() {
  const src = new URLSearchParams(location.search).get('img');
  if (!src) return;
  const img = new Image();
  img.onload = () => applyLoadedImage(img);
  img.onerror = () => console.warn('自动载入图片失败:', src);
  img.src = src;
})();

// 初始
updateOverlay();
updateStatus();
updateUndoRedo();
