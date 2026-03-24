const workspace = document.getElementById('node-window');
const stage = document.getElementById('game-window');
const ctx = stage.getContext('2d');
const grid = document.getElementById('grid');

const objects = [
  {
    id: 0,
    name: "AppController",
    type: "controller",
    media: [],
    code: [
      { id: 0, type: "start", location: {x: 0, y: 0}, content: "start", val_a: null, val_b: null, next_block_a: null, next_block_b: null, position: {x: 20, y: 20} },
    ]
  },
  {
    id: 1,
    name: "Object1",
    type: "object",
    media: [],
    code: [
        { id: 0, type: "start", location: {x: 0, y: 0}, content: "When Created", val_a: null, val_b: null, next_block_a: 1, next_block_b: null, position: {x: 20, y: 20} },
        { id: 1, type: "action", location: {x: 0, y: 0}, content: "move_xy", val_a: 5, val_b: 5, next_block_a: 2, next_block_b: null, position: {x: 20, y: 100} },
        { id: 2, type: "action", location: {x: 0, y: 0}, content: "move_xy", val_a: 10, val_b: 0, next_block_a: 3, next_block_b: null, position: {x: 20, y: 150} },
        { id: 3, type: "action", location: {x: 0, y: 0}, content: "move_xy", val_a: 15, val_b: -5, next_block_a: null, next_block_b: null, position: {x: 20, y: 200} }

    ]
  },
  {
    id: 2,
    name: "Object2",
    type: "object",
    media: [],
    code: []
  }
];

// Migrate legacy code links from next_block to next_block_a/next_block_b
function migrateCodeModel() {
    objects.forEach(o => {
        if (!Array.isArray(o.code)) return;
        o.code.forEach(b => {
            if (b && typeof b.next_block !== 'undefined') {
                b.next_block_a = (b.next_block === null || typeof b.next_block === 'undefined') ? null : b.next_block;
                b.next_block_b = (typeof b.next_block_b === 'undefined') ? null : b.next_block_b;
                delete b.next_block;
            } else {
                if (typeof b.next_block_a === 'undefined') b.next_block_a = null;
                if (typeof b.next_block_b === 'undefined') b.next_block_b = null;
            }
        });
    });
}

// Ensure all objects have a start block
function ensureStartBlocks() {
    objects.forEach(obj => {
        if (!Array.isArray(obj.code)) obj.code = [];
        const hasStartBlock = obj.code.some(block => block && block.type === 'start');
        if (!hasStartBlock) {
            const startBlock = {
                id: 0,
                type: "start",
                location: {x: 0, y: 0},
                content: obj.type === 'controller' ? "start" : "When Created",
                val_a: null,
                val_b: null,
                next_block_a: null,
                next_block_b: null,
                position: {x: 20, y: 20}
            };
            obj.code.unshift(startBlock);
        }
    });
}

migrateCodeModel();
ensureStartBlocks();
// Fast lookup for objects by id to avoid repeated Array.find in hot paths
let objectById = {};
function rebuildObjectIndex() {
    objectById = {};
    objects.forEach(obj => { if (obj) objectById[obj.id] = obj; });
}
rebuildObjectIndex();
// Fast lookup for code blocks by id per template, plus precomputed start-next pc
let codeMapByTemplateId = {};
let startNextPcByTemplateId = {};
function rebuildCodeMaps() {
    codeMapByTemplateId = {};
    startNextPcByTemplateId = {};
    objects.forEach(obj => {
        if (!obj) return;
        const code = Array.isArray(obj.code) ? obj.code : [];
        const map = {};
        for (let i = 0; i < code.length; i++) {
            const b = code[i];
            if (b && typeof b.id !== 'undefined') map[b.id] = b;
        }
        codeMapByTemplateId[obj.id] = map;
        const start = code.find(b => b && b.type === 'start');
        startNextPcByTemplateId[obj.id] = start && typeof start.next_block_a === 'number' ? start.next_block_a : null;
    });
}
rebuildCodeMaps();
// Ensure a default public variable 'i' exists on the AppController
function ensureDefaultPublicVariableI() {
    try {
        const app = objects.find(o => o.type === 'controller' || o.name === 'AppController');
        if (!app) return;
        if (!Array.isArray(app.variables)) app.variables = [];
        if (!app.variables.includes('i')) app.variables.push('i');
    } catch (_) {}
}
ensureDefaultPublicVariableI();

// Silence existing debug logs while allowing explicit print() block to log
const __ORIG_CONSOLE__ = { log: console.log.bind(console), warn: console.warn.bind(console) };
console.log = function(){};
console.warn = function(){};

// Variables
let selected_object = 0;
let touchOffsetX = 0;
let touchOffsetY = 0;
let dragStartX = 0;
let dragStartY = 0;
/** Multi-block drag: null or array of { el, baseX, baseY } */
let dragBlockGroup = null;
/** Before threshold crossed: { entries, clientX, clientY } */
let pendingDragGroup = null;
const CODE_DRAG_THRESHOLD_PX = 4;
/** Selected code block ids (numeric) for the active object’s graph */
let selectedCodeBlockIds = new Set();
let codeSelectionOwnerId = null;
/** Last copied code payload for paste when clipboard is unavailable */
let codeBlocksClipboard = null;
/** Marquee rectangle selection state */
let marqueeSelectState = null;

// Tab system variables
let activeTab = 'code'; // Default to code tab
const tabs = ['images', 'code', 'sound', 'threed'];

// ===== Runtime/Play State =====
let isPlaying = false;
let runtimePositions = {}; // world coords centered at (0,0): { [objectId]: { x, y, rot, scale, alpha, spritePath, layer } }
let runtimeExecState = {}; // per object execution state
let runtimeVariables = {}; // per instance variables: { [instanceId]: { [name]: any } }
let runtimeGlobalVariables = {}; // shared public variables across all instances: { [name]: any }
/** Shallow copy of globals after controller(s) run; non-controller instances read this for synced frame */
let frameGlobalReadSnapshot = null;

function syncFrameGlobalReadSnapshotAfterPublicWrite(varName) {
    if (frameGlobalReadSnapshot == null) return;
    const v = runtimeGlobalVariables[varName];
    if (typeof v === 'number') frameGlobalReadSnapshot[varName] = v;
    else if (Array.isArray(v)) frameGlobalReadSnapshot[varName] = v;
}
let lastCreatedVariable = null; // { name: string, isPrivate: boolean }
let lastCreatedVariableByObject = {}; // { [objectId: number]: { name: string, isPrivate: true } }
let lastCreatedArrayVariable = null; // { name: string, isPrivate: boolean }
let lastCreatedArrayVariableByObject = {}; // { [objectId: number]: { name: string, isPrivate: true } }
let lastCreatedPublicVariable = null; // { name: string, isPrivate: false }
let playLoopHandle = null;
let playStartTime = 0;
let lastFrameTime = 0;
// Cooperative scheduler controls to prevent any single instance from stalling the frame
const MAX_STEPS_PER_OBJECT = 16;        // quantum per instance per frame
const MAX_TOTAL_STEPS_PER_FRAME = 5000; // hard cap across all instances per frame
const TIME_BUDGET_MS = 6;               // soft time budget per instance (inner loop); do not cap the whole frame here or other instances starve
// Outer repeat continuation must not use `steps` — action blocks never increment `steps` (only non-actions do).
const MAX_REPEAT_OUTER_PASSES = Math.max(MAX_TOTAL_STEPS_PER_FRAME, 50000);
let rrInstanceStartIndex = 0;
// Mouse and keyboard state for input blocks
// Optional filter: when set to an array of instanceIds, interpreter will only step those instances
let __stepOnlyInstanceIds = null;
const runtimeMouse = { x: 0, y: 0 };
let runtimeMousePressed = false;
const runtimeKeys = {};
// Runtime instances are the only things that "exist" in the game world while playing
// Each instance references a template object in `objects` by templateId
let runtimeInstances = []; // { instanceId, templateId }
let nextInstanceId = 1;
let instancesPendingRemoval = new Set();
// Pool freed instance ids per template to reduce GC/alloc churn when cloning/deleting many instances
let freeInstancesByTemplate = {};

/** When set (from loaded project), game-window buffer size; display size still follows the stage panel (CSS). */
let projectStageWidth = null;
let projectStageHeight = null;

function updateRuntimeMouseFromClient(canvas, clientX, clientY) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const sx = canvas.width / Math.max(1e-6, rect.width);
    const sy = canvas.height / Math.max(1e-6, rect.height);
    runtimeMouse.x = Math.round((localX - rect.width / 2) * sx);
    runtimeMouse.y = Math.round((rect.height / 2 - localY) * sy);
}

// Track mouse relative to game window center
const gameCanvas = document.getElementById('game-window');
if (gameCanvas) {
    gameCanvas.addEventListener('mousemove', (e) => {
        updateRuntimeMouseFromClient(gameCanvas, e.clientX, e.clientY);
    });
    // Also use Pointer Events to ensure pointer updates are received during keyboard input
    gameCanvas.addEventListener('pointermove', (e) => {
        updateRuntimeMouseFromClient(gameCanvas, e.clientX, e.clientY);
    }, { passive: true });
    gameCanvas.addEventListener('pointerdown', () => { runtimeMousePressed = true; });
    gameCanvas.addEventListener('pointerup', () => { runtimeMousePressed = false; });
    gameCanvas.addEventListener('mousedown', () => { runtimeMousePressed = true; });
    gameCanvas.addEventListener('mouseup', () => { runtimeMousePressed = false; });
    gameCanvas.addEventListener('mouseleave', () => { runtimeMousePressed = false; });
}
// Ensure mouse release anywhere clears pressed
window.addEventListener('mouseup', () => { runtimeMousePressed = false; });
// Track key pressed state (normalize Space key)
function normalizeKeyName(k) {
    if (k === ' ' || k === 'Spacebar') return 'Space';
    return k;
}
document.addEventListener('keydown', (e) => {
    const k = normalizeKeyName(e.key);
    if (isPlaying && k === 'Space') {
        const t = e.target;
        const tag = t && t.tagName ? String(t.tagName).toLowerCase() : '';
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !(t && t.isContentEditable)) {
            e.preventDefault();
        }
    }
    runtimeKeys[k] = true;
}, true);
document.addEventListener('keyup', (e) => { const k = normalizeKeyName(e.key); runtimeKeys[k] = false; });
// Cache images by URL so we don't reload every frame
const imageCache = {};
function getCanvasCenter() {
    const canvas = document.getElementById('game-window');
    const rect = canvas.getBoundingClientRect();
    return { x: rect.width / 2, y: rect.height / 2 };
}
function worldToCanvas(x, y, canvas) {
    const cx = canvas.width / 2 + x;
    const cy = canvas.height / 2 - y;
    return { x: cx, y: cy };
}

let touchingScratchCanvas = null;
let __touchFrameSerial = 0;
const __colorScratchCache = { serial: -1, excludeId: null, w: 0, h: 0, fingerprint: 0 };

/** Hash of other instances' poses + paths; used to reuse the off-screen color-touch layer when unchanged. */
function touchingWorldFingerprint(inst, canvas) {
    let h = (canvas.width << 16) ^ canvas.height;
    for (let i = 0; i < runtimeInstances.length; i++) {
        const o = runtimeInstances[i];
        if (o.instanceId === inst.instanceId) continue;
        const p = runtimePositions[o.instanceId] || {};
        const x = typeof p.x === 'number' ? p.x : 0;
        const y = typeof p.y === 'number' ? p.y : 0;
        const rot = typeof p.rot === 'number' ? p.rot : 0;
        const ly = typeof p.layer === 'number' ? p.layer : 0;
        const sc = typeof p.scale === 'number' ? p.scale : 1;
        const al = typeof p.alpha === 'number' ? p.alpha : 1;
        const sp = p.spritePath != null ? String(p.spritePath) : '';
        h = Math.imul(h, 0x9e3779b9) + o.instanceId;
        h = Math.imul(h, 0x9e3779b9) + (x * 1000 | 0);
        h = Math.imul(h, 0x9e3779b9) + (y * 1000 | 0);
        h = Math.imul(h, 0x9e3779b9) + (rot * 1000 | 0);
        h = Math.imul(h, 0x9e3779b9) + ly;
        h = Math.imul(h, 0x9e3779b9) + (sc * 1000 | 0);
        h = Math.imul(h, 0x9e3779b9) + (al * 1000 | 0);
        for (let j = 0; j < sp.length; j++) h = Math.imul(h, 31) + sp.charCodeAt(j);
    }
    return h | 0;
}
const spriteImageDataForTouching = {};

function getSpriteImageDataForAlpha(path) {
    const cached = spriteImageDataForTouching[path];
    if (cached) return cached;
    const img = imageCache[path];
    if (!img || !img.complete || img._broken || !(img.naturalWidth > 0)) return null;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    try { ctx.drawImage(img, 0, 0); } catch (_) { return null; }
    let data;
    try { data = ctx.getImageData(0, 0, c.width, c.height).data; } catch (_) { return null; }
    const rec = { data, width: c.width, height: c.height };
    spriteImageDataForTouching[path] = rec;
    return rec;
}

function spriteAlphaAtPath(path, x, y) {
    const g = getSpriteImageDataForAlpha(path);
    if (!g) return 0;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= g.width || iy >= g.height) return 0;
    return g.data[(iy * g.width + ix) * 4 + 3];
}

function getInstanceBoundsForTouching(inst, canvas) {
    const tmpl = objectById[inst.templateId];
    if (!tmpl) return null;
    const perInst = runtimePositions[inst.instanceId] || {};
    const path = perInst.spritePath || (tmpl.media && tmpl.media[0] && tmpl.media[0].path ? tmpl.media[0].path : null);
    if (!path) return null;
    const img = imageCache[path];
    if (!img || !img.complete || img._broken || !(img.naturalWidth > 0)) return null;
    const scale = (typeof perInst.scale === 'number') ? Math.max(0, perInst.scale) : 1;
    const dw = img.width * scale;
    const dh = img.height * scale;
    const p = worldToCanvas(perInst.x || 0, perInst.y || 0, canvas);
    const left = p.x - dw / 2;
    const top = p.y - dh / 2;
    return { left, top, right: left + dw, bottom: top + dh, dw, dh, img, path };
}

/** Axis-aligned canvas bounds that fully contain the sprite quad (supports rotation). */
function getRotatedSpriteCanvasAABB(bounds, rotDeg) {
    if (!bounds) return null;
    const cx = bounds.left + bounds.dw / 2;
    const cy = bounds.top + bounds.dh / 2;
    const hw = bounds.dw / 2;
    const hh = bounds.dh / 2;
    if (rotDeg == null || rotDeg === 0 || rotDeg === 360 || rotDeg === -360) {
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
    }
    const θ = rotDeg * Math.PI / 180;
    const cos = Math.cos(θ);
    const sin = Math.sin(θ);
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < corners.length; i++) {
        const lx = corners[i][0];
        const ly = corners[i][1];
        const px = cx + lx * cos - ly * sin;
        const py = cy + lx * sin + ly * cos;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
    }
    return { left: minX, top: minY, right: maxX, bottom: maxY };
}

/**
 * Alpha 0–255 at canvas pixel (px,py) from this instance's costume (rotation + scale),
 * matching renderGameWindowSprite draw order math.
 */
function canvasAlphaFromInstanceSprite(inst, px, py, canvas) {
    const b = getInstanceBoundsForTouching(inst, canvas);
    if (!b) return 0;
    const perInst = runtimePositions[inst.instanceId] || {};
    const rotDeg = typeof perInst.rot === 'number' ? perInst.rot : 0;
    const θ = rotDeg * Math.PI / 180;
    const cos = Math.cos(θ);
    const sin = Math.sin(θ);
    const cx = b.left + b.dw / 2;
    const cy = b.top + b.dh / 2;
    const dx = px - cx;
    const dy = py - cy;
    const lx = cos * dx + sin * dy;
    const ly = -sin * dx + cos * dy;
    const hw = b.dw / 2;
    const hh = b.dh / 2;
    if (lx < -hw || lx > hw || ly < -hh || ly > hh) return 0;
    const u01 = (lx + hw) / b.dw;
    const v01 = (ly + hh) / b.dh;
    if (u01 < 0 || u01 > 1 || v01 < 0 || v01 > 1) return 0;
    const ix = u01 * b.img.naturalWidth;
    const iy = v01 * b.img.naturalHeight;
    const raw = spriteAlphaAtPath(b.path, ix, iy);
    const g = (typeof perInst.alpha === 'number') ? Math.max(0, Math.min(1, perInst.alpha)) : 1;
    return Math.round(raw * g);
}

function evalTouchingColor(inst, node, canvas) {
    const tr = Math.max(0, Math.min(255, Math.round(Number(node.rgb_r ?? 0) || 0)));
    const tg = Math.max(0, Math.min(255, Math.round(Number(node.rgb_g ?? 0) || 0)));
    const tb = Math.max(0, Math.min(255, Math.round(Number(node.rgb_b ?? 0) || 0)));
    const selfBounds = getInstanceBoundsForTouching(inst, canvas);
    if (!selfBounds) return 0;
    const selfRot = (runtimePositions[inst.instanceId] && typeof runtimePositions[inst.instanceId].rot === 'number')
        ? runtimePositions[inst.instanceId].rot : 0;
    const selfAabb = getRotatedSpriteCanvasAABB(selfBounds, selfRot);
    if (!selfAabb) return 0;
    const scratch = touchingScratchCanvas || (touchingScratchCanvas = document.createElement('canvas'));
    if (scratch.width !== canvas.width || scratch.height !== canvas.height) {
        scratch.width = canvas.width;
        scratch.height = canvas.height;
    }
    const sctx = scratch.getContext('2d');
    const fp = touchingWorldFingerprint(inst, canvas);
    if (!(__colorScratchCache.serial === __touchFrameSerial
        && __colorScratchCache.excludeId === inst.instanceId
        && __colorScratchCache.w === canvas.width
        && __colorScratchCache.h === canvas.height
        && __colorScratchCache.fingerprint === fp)) {
        sctx.fillStyle = '#777';
        sctx.fillRect(0, 0, canvas.width, canvas.height);
        sctx.imageSmoothingEnabled = false;
        const entries = [];
        for (let i = 0; i < runtimeInstances.length; i++) {
            const inst2 = runtimeInstances[i];
            if (inst2.instanceId === inst.instanceId) continue;
            const tmpl2 = objectById[inst2.templateId];
            const perInst2 = runtimePositions[inst2.instanceId] || {};
            const pth = perInst2.spritePath || (tmpl2 && tmpl2.media && tmpl2.media[0] && tmpl2.media[0].path ? tmpl2.media[0].path : null);
            if (pth) entries.push({ inst: inst2, path: pth });
        }
        entries.sort((a, b) => {
            const la = (runtimePositions[a.inst.instanceId] && typeof runtimePositions[a.inst.instanceId].layer === 'number') ? runtimePositions[a.inst.instanceId].layer : 0;
            const lb = (runtimePositions[b.inst.instanceId] && typeof runtimePositions[b.inst.instanceId].layer === 'number') ? runtimePositions[b.inst.instanceId].layer : 0;
            return la - lb;
        });
        for (const entry of entries) {
            let img = imageCache[entry.path];
            if (!img || !img.complete || img._broken || !(img.naturalWidth > 0)) continue;
            const perInst = runtimePositions[entry.inst.instanceId] || {};
            const scale = (typeof perInst.scale === 'number') ? Math.max(0, perInst.scale) : 1;
            const dw = img.width * scale;
            const dh = img.height * scale;
            const p = worldToCanvas(perInst.x || 0, perInst.y || 0, canvas);
            const drawX = Math.round(p.x - dw / 2);
            const drawY = Math.round(p.y - dh / 2);
            if (drawX + dw < 0 || drawY + dh < 0 || drawX > canvas.width || drawY > canvas.height) continue;
            const alpha = (typeof perInst.alpha === 'number') ? Math.max(0, Math.min(1, perInst.alpha)) : 1;
            if (typeof perInst.rot === 'number') {
                const angleRad = (perInst.rot || 0) * Math.PI / 180;
                sctx.save();
                sctx.translate(drawX + dw / 2, drawY + dh / 2);
                sctx.rotate(angleRad);
                const prev = sctx.globalAlpha;
                sctx.globalAlpha = alpha;
                sctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
                sctx.globalAlpha = prev;
                sctx.restore();
            } else {
                const prev = sctx.globalAlpha;
                sctx.globalAlpha = alpha;
                sctx.drawImage(img, drawX, drawY, dw, dh);
                sctx.globalAlpha = prev;
            }
        }
        __colorScratchCache.serial = __touchFrameSerial;
        __colorScratchCache.excludeId = inst.instanceId;
        __colorScratchCache.w = canvas.width;
        __colorScratchCache.h = canvas.height;
        __colorScratchCache.fingerprint = fp;
    }
    const left = Math.max(Math.floor(selfAabb.left), 0);
    const top = Math.max(Math.floor(selfAabb.top), 0);
    const right = Math.min(Math.ceil(selfAabb.right), canvas.width);
    const bottom = Math.min(Math.ceil(selfAabb.bottom), canvas.height);
    if (right <= left || bottom <= top) return 0;
    const w = right - left;
    const h = bottom - top;
    const area = w * h;
    const stride = area > 80000 ? 3 : (area > 20000 ? 2 : 1);
    const ALPHA_THRESHOLD = 32;
    for (let py = top; py < bottom; py += stride) {
        const pyFloor = py | 0;
        if (pyFloor < 0 || pyFloor >= canvas.height) continue;
        const rowLeft = Math.max(0, left);
        const rowRight = Math.min(canvas.width, right);
        const rowW = rowRight - rowLeft;
        if (rowW <= 0) continue;
        let rowData;
        try { rowData = sctx.getImageData(rowLeft, pyFloor, rowW, 1).data; } catch (_) { continue; }
        for (let px = left; px < right; px += stride) {
            if (px < 0 || px >= canvas.width) continue;
            if (canvasAlphaFromInstanceSprite(inst, px + 0.5, py + 0.5, canvas) < ALPHA_THRESHOLD) continue;
            const ix = (px - rowLeft) * 4;
            if (rowData[ix] === tr && rowData[ix + 1] === tg && rowData[ix + 2] === tb) return 1;
        }
    }
    return 0;
}

function evalTouchingObject(inst, node, canvas) {
    const tid = parseInt(String(node.val_a || '0'), 10);
    if (!Number.isFinite(tid)) return 0;
    const selfB = getInstanceBoundsForTouching(inst, canvas);
    if (!selfB) return 0;
    const selfRot = (runtimePositions[inst.instanceId] && typeof runtimePositions[inst.instanceId].rot === 'number')
        ? runtimePositions[inst.instanceId].rot : 0;
    const selfAabb = getRotatedSpriteCanvasAABB(selfB, selfRot);
    if (!selfAabb) return 0;
    const ALPHA_THRESHOLD = 16;
    for (let i = 0; i < runtimeInstances.length; i++) {
        const other = runtimeInstances[i];
        if (other.instanceId === inst.instanceId) continue;
        if (other.templateId !== tid) continue;
        const ob = getInstanceBoundsForTouching(other, canvas);
        if (!ob) continue;
        const otherRot = (runtimePositions[other.instanceId] && typeof runtimePositions[other.instanceId].rot === 'number')
            ? runtimePositions[other.instanceId].rot : 0;
        const otherAabb = getRotatedSpriteCanvasAABB(ob, otherRot);
        if (!otherAabb) continue;
        const left = Math.max(selfAabb.left, otherAabb.left, 0);
        const top = Math.max(selfAabb.top, otherAabb.top, 0);
        const right = Math.min(selfAabb.right, otherAabb.right, canvas.width);
        const bottom = Math.min(selfAabb.bottom, otherAabb.bottom, canvas.height);
        if (right <= left || bottom <= top) continue;
        const w = right - left;
        const h = bottom - top;
        const area = w * h;
        const stride = area > 80000 ? 3 : (area > 20000 ? 2 : 1);
        for (let py = Math.floor(top); py < Math.ceil(bottom); py += stride) {
            for (let px = Math.floor(left); px < Math.ceil(right); px += stride) {
                const a = canvasAlphaFromInstanceSprite(inst, px + 0.5, py + 0.5, canvas);
                if (a < ALPHA_THRESHOLD) continue;
                const bAlpha = canvasAlphaFromInstanceSprite(other, px + 0.5, py + 0.5, canvas);
                if (bAlpha >= ALPHA_THRESHOLD) return 1;
            }
        }
    }
    return 0;
}

function resetRuntimePositions() {
    runtimePositions = {};
    runtimeInstances.forEach(inst => {
        runtimePositions[inst.instanceId] = { x: 0, y: 0, layer: 0 };
    });
}
/** Parses block literals and inputs: numbers, optional fraction syntax like 1/60. */
function parseNumericInput(raw) {
    if (raw == null || raw === '') return 0;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
    if (typeof raw === 'boolean') return raw ? 1 : 0;
    if (typeof raw === 'string') {
        const s = raw.trim();
        if (s === '') return 0;
        const m = s.match(/^([+-]?(?:\d*\.?\d+|\d+\.?\d*))\s*\/\s*([+-]?(?:\d*\.?\d+|\d+\.?\d*))$/);
        if (m) {
            const a = parseFloat(m[1]);
            const b = parseFloat(m[2]);
            if (b !== 0 && Number.isFinite(a) && Number.isFinite(b)) return a / b;
        }
        const n = Number(s);
        if (Number.isFinite(n)) return n;
        const f = parseFloat(s);
        return Number.isFinite(f) ? f : 0;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
}

function registerRuntimeInstanceFromTemplate(instanceId, templateId) {
    const template = objectById[templateId];
    if (!template) return false;
    runtimeInstances.push({ instanceId, templateId });
    runtimePositions[instanceId] = { x: 0, y: 0, layer: 0 };
    runtimeVariables[instanceId] = {};
    try {
        const arrs = Array.isArray(template.arrayVariables) ? template.arrayVariables : [];
        arrs.forEach(name => { runtimeVariables[instanceId][name] = []; });
    } catch (_) {}
    const codeT = Array.isArray(template.code) ? template.code : [];
    const startT = codeT.find(b => b.type === 'start');
    const pcT = startT && typeof startT.next_block_a === 'number' ? startT.next_block_a : null;
    runtimeExecState[instanceId] = { pc: pcT, waitMs: 0, waitingBlockId: null, repeatStack: [], yieldFrame: false, yieldResumePc: null };
    return true;
}

/** Run the new instance's When Created chain before the Instantiate caller's next block runs. */
function runInstanceStartChainSync(instanceId) {
    const savedFilter = __stepOnlyInstanceIds;
    const savedSnapshot = frameGlobalReadSnapshot;
    const ITER_GUARD = 100000;
    let n = 0;
    try {
        while (isPlaying && n++ < ITER_GUARD) {
            const exec = runtimeExecState[instanceId];
            if (!exec) break;
            if (exec.waitMs > 0) break;
            if (exec.yieldFrame) break;
            if (exec.pc == null && exec.repeatStack.length === 0) break;
            __stepOnlyInstanceIds = [instanceId];
            stepInterpreter(0);
        }
    } finally {
        __stepOnlyInstanceIds = savedFilter;
        frameGlobalReadSnapshot = savedSnapshot;
    }
}

function isAppControllerTemplate(o) {
    return !!(o && (o.type === 'controller' || o.name === 'AppController'));
}

function stepInterpreter(dtMs) {
    if (!isPlaying) return;
    frameGlobalReadSnapshot = null;
    // Fair scheduling with round-robin and budgets
    let totalStepsThisFrame = 0;
    const instanceCount = runtimeInstances.length;
    if (instanceCount === 0) return;
    const isFilteredStep = __stepOnlyInstanceIds && Array.isArray(__stepOnlyInstanceIds) && __stepOnlyInstanceIds.length > 0;
    // Resume all instances that yielded last frame (forever loops) — perfectly synchronized
    // Skip during nested/filtered calls (e.g. runInstanceStartChainSync) to avoid clearing other instances' yields
    if (!isFilteredStep) {
        for (let i = 0; i < instanceCount; i++) {
            const exec = runtimeExecState[runtimeInstances[i].instanceId];
            if (exec && exec.yieldFrame) {
                exec.yieldFrame = false;
                exec.pc = exec.yieldResumePc;
                exec.yieldResumePc = null;
            }
        }
    }
    // AppController runs first every frame so globals (e.g. scroll) update before other instances read them.
    // Non-controller instances run in stable insertion order so all see the same snapshot values.
    const orderedInstances = [];
    for (let i = 0; i < instanceCount; i++) {
        const inst = runtimeInstances[i];
        const o = objectById[inst.templateId];
        if (isAppControllerTemplate(o)) orderedInstances.push(inst);
    }
    for (let i = 0; i < instanceCount; i++) {
        const inst = runtimeInstances[i];
        const o = objectById[inst.templateId];
        if (!isAppControllerTemplate(o)) orderedInstances.push(inst);
    }
    for (let offset = 0; offset < orderedInstances.length; offset++) {
        const inst = orderedInstances[offset];
        if (__stepOnlyInstanceIds && Array.isArray(__stepOnlyInstanceIds) && __stepOnlyInstanceIds.length > 0) {
            if (!__stepOnlyInstanceIds.includes(inst.instanceId)) continue;
        }
        const o = objectById[inst.templateId];
        const exec = runtimeExecState[inst.instanceId];
        if (!o || !exec) continue;
        if (!isAppControllerTemplate(o) && frameGlobalReadSnapshot === null) {
            frameGlobalReadSnapshot = {};
            for (const k of Object.keys(runtimeGlobalVariables)) {
                const v = runtimeGlobalVariables[k];
                if (typeof v === 'number') frameGlobalReadSnapshot[k] = v;
                else if (Array.isArray(v)) frameGlobalReadSnapshot[k] = v;
            }
        }
        const useGlobalReadSnapshot = frameGlobalReadSnapshot !== null && !isAppControllerTemplate(o);
        const code = o.code || [];
        const codeMap = codeMapByTemplateId[o.id] || null;

        // Handle active wait first
        if (exec.waitMs > 0) {
            exec.waitMs -= dtMs;
            if (exec.waitMs > 0) continue; // still waiting
            exec.waitMs = 0;
            if (exec.waitingBlockId != null) {
                const waitingBlock = codeMap ? codeMap[exec.waitingBlockId] : code.find(b => b && b.id === exec.waitingBlockId);
                exec.waitingBlockId = null;
                if (waitingBlock) {
                    exec.pc = (typeof waitingBlock.next_block_a === 'number') ? waitingBlock.next_block_a : null;
                }
            }
        }

        let steps = 0;
        let outerPasses = 0;
        const perInstanceBudgetStart = performance.now();
        outerInstanceLoop: while (isPlaying && outerPasses < MAX_REPEAT_OUTER_PASSES) {
            outerPasses++;
        while (isPlaying && exec.pc != null && steps < MAX_STEPS_PER_OBJECT) {
            const block = codeMap ? codeMap[exec.pc] : code.find(b => b && b.id === exec.pc);
            if (!block) { exec.pc = null; break; }
            const coerceScalarLiteral = (v) => {
                if (typeof v === 'number') return v;
                if (typeof v === 'string') {
                    const s = v.trim();
                    if (s === '') return '';
                    if (/^\s*[+-]?(?:\d*\.?\d+|\d+\.?\d*)\s*\/\s*[+-]?(?:\d*\.?\d+|\d+\.?\d*)\s*$/.test(s)) {
                        return parseNumericInput(s);
                    }
                    const n = Number(s);
                    return Number.isFinite(n) ? n : v;
                }
                return v;
            };
            const getArrayRef = (varName, instanceOnly) => {
                const name = varName || '';
                const store = instanceOnly
                    ? (runtimeVariables[inst.instanceId] || (runtimeVariables[inst.instanceId] = {}))
                    : runtimeGlobalVariables;
                let arr = store[name];
                if (!Array.isArray(arr)) {
                    arr = [];
                    store[name] = arr;
                }
                return arr;
            };
            // Resolve inputs if connected
            const resolveInput = (blockRef, key) => {
                const inputId = blockRef[key];
                if (inputId == null) return null;
                const node = codeMap ? codeMap[inputId] : code.find(b => b && b.id === inputId);
                if (!node) return null;
                if (node.content === 'mouse_x') return runtimeMouse.x;
                if (node.content === 'mouse_y') return runtimeMouse.y;
                if (node.content === 'window_width') { const c = document.getElementById('game-window'); return c ? c.width : window.innerWidth; }
                if (node.content === 'window_height') { const c = document.getElementById('game-window'); return c ? c.height : window.innerHeight; }
                if (node.content === 'object_x') { const pos = runtimePositions[inst.instanceId] || { x: 0, y: 0 }; return (typeof pos.x === 'number') ? pos.x : 0; }
                if (node.content === 'object_y') { const pos = runtimePositions[inst.instanceId] || { x: 0, y: 0 }; return (typeof pos.y === 'number') ? pos.y : 0; }
                if (node.content === 'rotation') { const pos = runtimePositions[inst.instanceId] || { rot: 0 }; return (typeof pos.rot === 'number') ? pos.rot : 0; }
                if (node.content === 'size') { const pos = runtimePositions[inst.instanceId] || { scale: 1 }; return (typeof pos.scale === 'number') ? pos.scale : 1; }
                if (node.content === 'mouse_pressed') return runtimeMousePressed ? 1 : 0;
                if (node.content === 'key_pressed') return runtimeKeys[node.key_name] ? 1 : 0;
                if (node.content === 'image_name') {
                    try {
                        // Determine current image name for this instance
                        const tmpl = objectById[inst.templateId];
                        const path = (runtimePositions[inst.instanceId] && runtimePositions[inst.instanceId].spritePath)
                            || (tmpl && tmpl.media && tmpl.media[0] && tmpl.media[0].path ? tmpl.media[0].path : null);
                        if (!tmpl || !path) return '';
                        const images = objectImages[String(tmpl.id)] || [];
                        const base = path.split('?')[0];
                        const found = images.find(img => (img.src || '').split('?')[0] === base);
                        return (found && found.name) ? found.name : '';
                    } catch (_) { return ''; }
                }
                if (node.content === 'distance_to') {
                    const pos = runtimePositions[inst.instanceId] || { x: 0, y: 0 };
                    const tx = parseNumericInput((node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0));
                    const ty = parseNumericInput((node.input_b != null) ? (resolveInput(node, 'input_b') ?? node.val_b ?? 0) : (node.val_b ?? 0));
                    const dx = (typeof pos.x === 'number' ? pos.x : 0) - tx;
                    const dy = (typeof pos.y === 'number' ? pos.y : 0) - ty;
                    return Math.hypot(dx, dy);
                }
                if (node.content === 'pixel_is_rgb') {
                    const canvas = document.getElementById('game-window');
                    if (!canvas) return 0;
                    const xw = parseNumericInput((node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0));
                    const yw = parseNumericInput((node.input_b != null) ? (resolveInput(node, 'input_b') ?? node.val_b ?? 0) : (node.val_b ?? 0));
                    const p = worldToCanvas(xw, yw, canvas);
                    const px = Math.round(p.x);
                    const py = Math.round(p.y);
                    if (!Number.isFinite(px) || !Number.isFinite(py)) return 0;
                    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return 0;
                    const cctx = canvas.getContext('2d');
                    if (!cctx) return 0;
                    let data;
                    try { data = cctx.getImageData(px, py, 1, 1).data; } catch (_) { return 0; }
                    const r = data[0], g = data[1], b = data[2];
                    const tr = Math.max(0, Math.min(255, Math.round(Number(node.rgb_r ?? 0) || 0)));
                    const tg = Math.max(0, Math.min(255, Math.round(Number(node.rgb_g ?? 0) || 0)));
                    const tb = Math.max(0, Math.min(255, Math.round(Number(node.rgb_b ?? 0) || 0)));
                    return (r === tr && g === tg && b === tb) ? 1 : 0;
                }
                if (node.content === 'touching') {
                    const canvas = document.getElementById('game-window');
                    if (!canvas) return 0;
                    const mode = node.touching_mode || 'object';
                    if (mode === 'object') return evalTouchingObject(inst, node, canvas);
                    if (mode === 'color') return evalTouchingColor(inst, node, canvas);
                    return 0;
                }
                if (node.content === 'random_int') {
                    const minVal = (node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0);
                    const maxVal = (node.input_b != null) ? (resolveInput(node, 'input_b') ?? node.val_b ?? 0) : (node.val_b ?? 0);
                    let a = parseNumericInput(minVal);
                    let b = parseNumericInput(maxVal);
                    if (Number.isNaN(a)) a = 0;
                    if (Number.isNaN(b)) b = 0;
                    if (a > b) { const t = a; a = b; b = t; }
                    return Math.floor(Math.random() * (b - a + 1)) + a; // inclusive
                }
                if (node.content === 'operation') {
                    const rawA = (node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.op_x ?? 0) : (node.op_x ?? 0);
                    const rawB = (node.input_b != null) ? (resolveInput(node, 'input_b') ?? node.op_y ?? 0) : (node.op_y ?? 0);
                    const op = node.val_a || '+';
                    if (op === '+') {
                        if (typeof rawA === 'string' || typeof rawB === 'string') {
                            return String(rawA ?? '') + String(rawB ?? '');
                        }
                        return parseNumericInput(rawA) + parseNumericInput(rawB);
                    }
                    const xVal = parseNumericInput(rawA);
                    const yVal = parseNumericInput(rawB);
                    switch (op) {
                        case '-': return xVal - yVal;
                        case '*': return xVal * yVal;
                        case '/': return yVal === 0 ? 0 : xVal / yVal;
                        case '^': return Math.pow(xVal, yVal);
                        default: return xVal + yVal;
                    }
                }
                if (node.content === 'not') {
                    const v = (node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0);
                    const num = parseNumericInput(v);
                    return num ? 0 : 1;
                }
                if (node.content === 'equals') {
                    const aVal = (node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0);
                    const bVal = (node.input_b != null) ? (resolveInput(node, 'input_b') ?? node.val_b ?? 0) : (node.val_b ?? 0);
                    const A = (aVal == null) ? '' : aVal;
                    const B = (bVal == null) ? '' : bVal;
                    return A == B ? 1 : 0;
                }
                if (node.content === 'less_than') {
                    const aVal = (node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0);
                    const bVal = (node.input_b != null) ? (resolveInput(node, 'input_b') ?? node.val_b ?? 0) : (node.val_b ?? 0);
                    let A = parseNumericInput(aVal);
                    let B = parseNumericInput(bVal);
                    if (Number.isNaN(A)) A = 0;
                    if (Number.isNaN(B)) B = 0;
                    return A < B ? 1 : 0;
                }
                if (node.content === 'and') {
                    const aVal = (node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0);
                    const bVal = (node.input_b != null) ? (resolveInput(node, 'input_b') ?? node.val_b ?? 0) : (node.val_b ?? 0);
                    const A = parseNumericInput(aVal);
                    const B = parseNumericInput(bVal);
                    return (A !== 0 && B !== 0) ? 1 : 0;
                }
                if (node.content === 'or') {
                    const aVal = (node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0);
                    const bVal = (node.input_b != null) ? (resolveInput(node, 'input_b') ?? node.val_b ?? 0) : (node.val_b ?? 0);
                    const A = parseNumericInput(aVal);
                    const B = parseNumericInput(bVal);
                    return (A !== 0 || B !== 0) ? 1 : 0;
                }
                if (node.content === 'variable') {
                    const varName = node.var_name || '';
                    if (node.var_instance_only) {
                        const vars = runtimeVariables[inst.instanceId] || (runtimeVariables[inst.instanceId] = {});
                        const v = vars[varName];
                        return typeof v === 'number' ? v : 0;
                    } else {
                        const store = useGlobalReadSnapshot ? frameGlobalReadSnapshot : runtimeGlobalVariables;
                        const v = store[varName];
                        return typeof v === 'number' ? v : 0;
                    }
                }
                if (node.content === 'array_get') {
                    const arr = getArrayRef(node.var_name || '', !!node.var_instance_only);
                    const idxVal = (node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0);
                    const idx = Math.floor(parseNumericInput(idxVal));
                    if (!Number.isFinite(idx) || idx < 0 || idx >= arr.length) return '';
                    return arr[idx];
                }
                if (node.content === 'array_length') {
                    const arr = getArrayRef(node.var_name || '', !!node.var_instance_only);
                    return arr.length;
                }
                return null;
            };

            if (block.type === 'action') {
                if (block.content === 'move_xy') {
                    const x = parseNumericInput(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    const y = parseNumericInput(resolveInput(block, 'input_b') ?? block.val_b ?? 0);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    runtimePositions[inst.instanceId].x += x;
                    runtimePositions[inst.instanceId].y += y;
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'move_forward') {
                    // Move forward by distance in the direction the instance is facing (0° is up)
                    const distance = parseNumericInput(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    const pos = runtimePositions[inst.instanceId];
                    if (pos.rot === undefined) pos.rot = 0;
                    const rotRad = (pos.rot || 0) * Math.PI / 180;
                    // 0° moves up (+y), x uses sin, y uses cos in our coordinate system
                    pos.x += Math.sin(rotRad) * distance;
                    pos.y += Math.cos(rotRad) * distance;
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'rotate') {
                    // Store rotation per object; create if absent
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    if (runtimePositions[inst.instanceId].rot === undefined) runtimePositions[inst.instanceId].rot = 0;
                    runtimePositions[inst.instanceId].rot += parseNumericInput(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'set_rotation') {
                    // Set absolute rotation
                    const absoluteDeg = parseNumericInput(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    runtimePositions[inst.instanceId].rot = absoluteDeg;
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'set_size') {
                    const s = parseNumericInput(resolveInput(block, 'input_a') ?? block.val_a ?? 1);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    if (runtimePositions[inst.instanceId].scale === undefined) runtimePositions[inst.instanceId].scale = 1;
                    runtimePositions[inst.instanceId].scale = Math.max(0, s);
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'set_opacity') {
                    let a = parseNumericInput(resolveInput(block, 'input_a') ?? block.val_a ?? 1);
                    if (Number.isNaN(a)) a = 1;
                    a = Math.max(0, Math.min(1, a));
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0, layer: 0 };
                    runtimePositions[inst.instanceId].alpha = a;
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'set_layer') {
                    const layer = parseNumericInput(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0, layer: 0 };
                    runtimePositions[inst.instanceId].layer = layer;
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'point_towards') {
                    // Compute angle from current position to (x,y) and set rot
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0, layer: 0 };
                    const pos = runtimePositions[inst.instanceId];
                    const targetX = parseNumericInput((block.input_a != null ? (resolveInput(block, 'input_a') ?? block.val_a) : block.val_a) ?? 0);
                    const targetY = parseNumericInput((block.input_b != null ? (resolveInput(block, 'input_b') ?? block.val_b) : block.val_b) ?? 0);
                    const dx = (typeof pos.x === 'number' ? pos.x : 0) - targetX;
                    const dy = targetY - (typeof pos.y === 'number' ? pos.y : 0);
                    // In our world coord system, +x right, +y up; canvas y inverted elsewhere. Use atan2(dy, dx)
                    const angleRad = Math.atan2(dy, dx);
                    const angleDeg = angleRad * 180 / Math.PI;
                    // Adjust so sprite's TOP points toward target (sprites face up at 0deg)
                    pos.rot = angleDeg - 90;
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'change_size') {
                    const ds = parseNumericInput(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    if (runtimePositions[inst.instanceId].scale === undefined) runtimePositions[inst.instanceId].scale = 1;
                    runtimePositions[inst.instanceId].scale = Math.max(0, (runtimePositions[inst.instanceId].scale || 1) + ds);
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'wait') {
                    const seconds = Math.max(0, parseNumericInput(resolveInput(block, 'input_a') ?? block.val_a ?? 0));
                    if (seconds <= 0) {
                        exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                        continue;
                    }
                    if (exec.waitMs <= 0 || exec.waitingBlockId !== block.id) {
                        exec.waitMs = seconds * 1000;
                        exec.waitingBlockId = block.id;
                    }
                    break;
                }
                if (block.content === 'repeat') {
                    const times = Math.max(0, Math.floor(parseNumericInput(block.val_a ?? 0)));
                    if (times <= 0) {
                        exec.pc = (typeof block.next_block_b === 'number') ? block.next_block_b : null;
                        continue;
                    }
                    exec.repeatStack.push({ repeatBlockId: block.id, timesRemaining: times, afterId: (typeof block.next_block_b === 'number') ? block.next_block_b : null });
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'print') {
                    const val = (block.input_a != null) ? (resolveInput(block, 'input_a') ?? block.val_a ?? '') : (block.val_a ?? '');
                    try { __ORIG_CONSOLE__.log(val); } catch(_) {}
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'if') {
                    const condVal = parseNumericInput(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    const isTrue = condVal ? true : false;
                    exec.pc = isTrue ? ((typeof block.next_block_b === 'number') ? block.next_block_b : null)
                                     : ((typeof block.next_block_a === 'number') ? block.next_block_a : null);
                    continue;
                }
                if (block.content === 'set_x') {
                    const x = parseNumericInput(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    runtimePositions[inst.instanceId].x = x;
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'set_y') {
                    const y = parseNumericInput(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    runtimePositions[inst.instanceId].y = y;
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'switch_image') {
                    const imgs = objectImages[String(o.id)] || [];
                    let found = null;
                    if (block.input_a != null) {
                        const sel = resolveInput(block, 'input_a');
                        if (sel == null || sel === '') {
                            found = imgs.find(img => String(img.id) === String(block.val_a));
                        } else if (typeof sel === 'string') {
                            const s = sel.trim();
                            found = imgs.find(img => img.name === s) || imgs.find(img => String(img.id) === s);
                        } else {
                            found = imgs.find(img => String(img.id) === String(sel));
                        }
                    } else {
                        found = imgs.find(img => String(img.id) === String(block.val_a));
                    }
                    if (found) {
                        if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                        runtimePositions[inst.instanceId].spritePath = (found.src || '').split('?')[0];
                    }
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'play_sound') {
                    const snds = objectSounds[String(o.id)] || [];
                    let sfound = null;
                    if (block.input_a != null) {
                        const sel = resolveInput(block, 'input_a');
                        if (sel == null || sel === '') {
                            sfound = snds.find((s) => String(s.id) === String(block.val_a));
                        } else if (typeof sel === 'string') {
                            const s = sel.trim();
                            sfound = snds.find((x) => x.name === s) || snds.find((x) => String(x.id) === s);
                        } else {
                            sfound = snds.find((x) => String(x.id) === String(sel));
                        }
                    } else {
                        sfound = snds.find((s) => String(s.id) === String(block.val_a));
                    }
                    if (sfound && sfound.src) {
                        playGameSoundFromSrc(sfound.src);
                    }
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'instantiate') {
                    const objId = parseInt(block.val_a, 10);
                    const template = objectById[objId];
                    if (template) {
                        let instanceIdToUse;
                        const pool = freeInstancesByTemplate[template.id];
                        if (pool && pool.length > 0) {
                            instanceIdToUse = pool.pop();
                        } else {
                            instanceIdToUse = nextInstanceId++;
                        }
                        if (registerRuntimeInstanceFromTemplate(instanceIdToUse, template.id)) {
                            runInstanceStartChainSync(instanceIdToUse);
                        }
                    }
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'delete_instance') {
                    // Mark this runtime instance for removal (do not delete template/object)
                    instancesPendingRemoval.add(inst.instanceId);
                    exec.pc = null;
                    continue;
                }
                if (block.content === 'set_variable') {
                    const varName = block.var_name || '';
                    const value = parseNumericInput(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (block.var_instance_only) {
                        if (!runtimeVariables[inst.instanceId]) runtimeVariables[inst.instanceId] = {};
                        runtimeVariables[inst.instanceId][varName] = value;
                    } else {
                        runtimeGlobalVariables[varName] = value;
                        syncFrameGlobalReadSnapshotAfterPublicWrite(varName);
                    }
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'change_variable') {
                    const varName = block.var_name || '';
                    const delta = parseNumericInput(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (block.var_instance_only) {
                        if (!runtimeVariables[inst.instanceId]) runtimeVariables[inst.instanceId] = {};
                        const curVal = runtimeVariables[inst.instanceId][varName];
                        const current = (typeof curVal === 'number') ? curVal : 0;
                        runtimeVariables[inst.instanceId][varName] = current + delta;
                    } else {
                        const curVal = runtimeGlobalVariables[varName];
                        const current = (typeof curVal === 'number') ? curVal : 0;
                        runtimeGlobalVariables[varName] = current + delta;
                        syncFrameGlobalReadSnapshotAfterPublicWrite(varName);
                    }
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'array_append') {
                    const varName = block.var_name || '';
                    const raw = (block.input_a != null) ? (resolveInput(block, 'input_a') ?? block.val_a ?? '') : (block.val_a ?? '');
                    const value = coerceScalarLiteral(raw);
                    const arr = getArrayRef(varName, !!block.var_instance_only);
                    arr.push(value);
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'array_insert') {
                    const varName = block.var_name || '';
                    const raw = (block.input_a != null) ? (resolveInput(block, 'input_a') ?? block.val_a ?? '') : (block.val_a ?? '');
                    const value = coerceScalarLiteral(raw);
                    const idxVal = (block.input_b != null) ? (resolveInput(block, 'input_b') ?? block.val_b ?? 0) : (block.val_b ?? 0);
                    let idx = Math.floor(parseNumericInput(idxVal));
                    if (!Number.isFinite(idx)) idx = 0;
                    const arr = getArrayRef(varName, !!block.var_instance_only);
                    idx = Math.max(0, Math.min(arr.length, idx));
                    arr.splice(idx, 0, value);
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'array_delete') {
                    const varName = block.var_name || '';
                    const idxVal = (block.input_a != null) ? (resolveInput(block, 'input_a') ?? block.val_a ?? 0) : (block.val_a ?? 0);
                    const idx = Math.floor(parseNumericInput(idxVal));
                    const arr = getArrayRef(varName, !!block.var_instance_only);
                    if (Number.isFinite(idx) && idx >= 0 && idx < arr.length) {
                        arr.splice(idx, 1);
                    }
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'forever') {
                    // Enter infinite loop over branch A
                    exec.repeatStack.push({ repeatBlockId: block.id, timesRemaining: Infinity, afterId: (typeof block.next_block_b === 'number') ? block.next_block_b : null });
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
            }
            // Unknown block or non-action: just follow next_block_a
            exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
            steps += 1;
            totalStepsThisFrame += 1;
            if (totalStepsThisFrame >= MAX_TOTAL_STEPS_PER_FRAME) break;
            if ((performance.now() - perInstanceBudgetStart) >= TIME_BUDGET_MS) break;
        }

        // If we reached end of a chain, check repeat stack (may loop same frame)
        if (exec.pc == null && exec.repeatStack.length > 0) {
            const frame = exec.repeatStack[exec.repeatStack.length - 1];
            frame.timesRemaining -= 1;
            if (frame.timesRemaining > 0) {
                const repeatBlock = codeMap ? codeMap[frame.repeatBlockId] : code.find(b => b && b.id === frame.repeatBlockId);
                if (repeatBlock && repeatBlock.content === 'forever') {
                    exec.yieldFrame = true;
                    exec.yieldResumePc = (typeof repeatBlock.next_block_a === 'number') ? repeatBlock.next_block_a : null;
                    exec.pc = null;
                    break outerInstanceLoop;
                }
                exec.pc = repeatBlock && (typeof repeatBlock.next_block_a === 'number') ? repeatBlock.next_block_a : null;
                if (exec.pc != null) {
                    continue outerInstanceLoop;
                }
                // No first block (empty repeat body): yield to prevent infinite spin
                exec.yieldFrame = true;
                exec.yieldResumePc = null;
                break outerInstanceLoop;
            }
            exec.repeatStack.pop();
            exec.pc = frame.afterId != null ? frame.afterId : null;
            continue outerInstanceLoop;
        }
        break outerInstanceLoop;
        }

        if (totalStepsThisFrame >= MAX_TOTAL_STEPS_PER_FRAME) { break; }
    }
    
    // Instantiate is handled synchronously in the Instantiate block (runInstanceStartChainSync).
    // Remove any instances that requested deletion this frame
    if (instancesPendingRemoval && instancesPendingRemoval.size > 0) {
        runtimeInstances = runtimeInstances.filter(inst => {
            if (instancesPendingRemoval.has(inst.instanceId)) {
                // Return this instance id to the pool for its template
                const pool = freeInstancesByTemplate[inst.templateId] || (freeInstancesByTemplate[inst.templateId] = []);
                pool.push(inst.instanceId);
                delete runtimePositions[inst.instanceId];
                delete runtimeExecState[inst.instanceId];
                delete runtimeVariables[inst.instanceId];
                return false;
            }
            return true;
        });
        instancesPendingRemoval.clear();
    }
    frameGlobalReadSnapshot = null;
}
function runWhenCreatedChains() {
    // No-op: interpreter now runs chains over time in stepInterpreter
}
function startPlay() {
    if (isPlaying) return;
    isPlaying = true;
    // Ensure object index is in sync before runtime starts
    rebuildObjectIndex();
    rebuildCodeMaps();
    rrInstanceStartIndex = 0;
    // Initialize runtime world: only AppController exists at start
    runtimeInstances = [];
    runtimeExecState = {};
    instancesPendingRemoval = new Set();
    freeInstancesByTemplate = {};
    runtimeVariables = {};
    runtimeGlobalVariables = {};
    const controller = objects.find(o => o.type === 'controller' || o.name === 'AppController');
    if (controller) {
        // Seed public array variables
        try {
            const pubArrs = Array.isArray(controller.arrayVariables) ? controller.arrayVariables : [];
            pubArrs.forEach(name => { if (!Array.isArray(runtimeGlobalVariables[name])) runtimeGlobalVariables[name] = []; });
        } catch (_) {}
        const instId = nextInstanceId++;
        runtimeInstances.push({ instanceId: instId, templateId: controller.id });
        runtimePositions[instId] = { x: 0, y: 0, layer: 0 };
        runtimeVariables[instId] = {};
        const code = Array.isArray(controller.code) ? controller.code : [];
        const start = code.find(b => b.type === 'start');
        const pc = start && typeof start.next_block_a === 'number' ? start.next_block_a : null;
        runtimeExecState[instId] = { pc: pc, waitMs: 0, waitingBlockId: null, repeatStack: [], yieldFrame: false, yieldResumePc: null };
    } else {
        console.warn('No AppController found to start.');
    }
    resetRuntimePositions();
    playStartTime = performance.now();
    lastFrameTime = playStartTime;
    const FRAME_MS = 1000 / 60;
    const loop = () => {
        if (!isPlaying) return;
        playLoopHandle = requestAnimationFrame(loop);
        const now = performance.now();
        const elapsed = now - lastFrameTime;
        if (elapsed < FRAME_MS) return;
        lastFrameTime = now - (elapsed % FRAME_MS);
        __touchFrameSerial++;
        stepInterpreter(FRAME_MS);
        renderGameWindowSprite();
    };
    playLoopHandle = requestAnimationFrame(loop);
}
/** One-shot sounds during game preview (Play button); stopped when playback stops. */
const __runtimeGameAudios = new Set();
function playGameSoundFromSrc(src) {
    if (!isPlaying || !src || typeof src !== 'string') return;
    try {
        const a = new Audio();
        a.src = src;
        a.volume = 1;
        __runtimeGameAudios.add(a);
        const done = () => {
            try {
                __runtimeGameAudios.delete(a);
            } catch (_) {}
        };
        a.addEventListener('ended', done, { once: true });
        a.addEventListener('error', done, { once: true });
        a.play().catch(done);
    } catch (_) {}
}
function stopAllGameSounds() {
    __runtimeGameAudios.forEach((a) => {
        try {
            a.pause();
            a.removeAttribute('src');
            a.load();
        } catch (_) {}
    });
    __runtimeGameAudios.clear();
}

function stopPlay() {
    isPlaying = false;
    if (playLoopHandle) cancelAnimationFrame(playLoopHandle);
    playLoopHandle = null;
    stopAllGameSounds();
    renderGameWindowSprite();
}

// ---- Code block selection, clipboard, marquee ----
function clientToScrollContent(clientX, clientY) {
    const c = getCodeScrollContainer();
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return { x: (clientX - r.left) + c.scrollLeft, y: (clientY - r.top) + c.scrollTop };
}
function clientToLayerLocal(clientX, clientY) {
    return scrollContentToLayerLocal(clientToScrollContent(clientX, clientY));
}
function syncCodeSelectionOwnership(selectedObj) {
    if (!selectedObj) return;
    if (codeSelectionOwnerId !== selected_object) {
        selectedCodeBlockIds.clear();
        codeSelectionOwnerId = selected_object;
    }
    const valid = new Set(selectedObj.code.map(c => c.id));
    for (const id of [...selectedCodeBlockIds]) {
        if (!valid.has(id)) selectedCodeBlockIds.delete(id);
    }
}
function applyCodeBlockSelectionClasses(layerOverride) {
    const layer = layerOverride || document.getElementById('code-zoom-layer');
    if (!layer) return;
    layer.querySelectorAll('.node-block').forEach(el => {
        const id = parseInt(el.dataset.codeId, 10);
        if (Number.isFinite(id) && selectedCodeBlockIds.has(id)) el.classList.add('node-block-selected');
        else el.classList.remove('node-block-selected');
    });
}
function removeCodeBlockFromObject(selectedObj, codeIdNum) {
    const codeData = selectedObj.code.find(c => c.id === codeIdNum);
    if (!codeData) return;
    selectedObj.code.forEach(c => {
        if (c.next_block_a === codeIdNum) {
            c.next_block_a = (typeof codeData.next_block_a === 'number') ? codeData.next_block_a : null;
        }
        if (c.next_block_b === codeIdNum) {
            c.next_block_b = (typeof codeData.next_block_b === 'number') ? codeData.next_block_b : null;
        }
        if (c.input_a === codeIdNum) c.input_a = null;
        if (c.input_b === codeIdNum) c.input_b = null;
    });
    const idx = selectedObj.code.findIndex(c => c.id === codeIdNum);
    if (idx >= 0) selectedObj.code.splice(idx, 1);
    selectedCodeBlockIds.delete(codeIdNum);
}
function copyCodeBlocksToClipboardInternal() {
    const selectedObj = objects.find(o => o.id == selected_object);
    if (!selectedObj || selectedCodeBlockIds.size === 0) return;
    const blocks = selectedObj.code.filter(b => selectedCodeBlockIds.has(b.id)).map(b => JSON.parse(JSON.stringify(b)));
    codeBlocksClipboard = { v: 1, blocks };
    const text = JSON.stringify({ __maxiverse: 'codeblocks-v1', v: 1, blocks });
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
    }
}
async function pasteCodeBlocksFromClipboardInternal() {
    const selectedObj = objects.find(o => o.id == selected_object);
    if (!selectedObj) return;
    let payload = codeBlocksClipboard;
    try {
        if (navigator.clipboard && navigator.clipboard.readText) {
            const t = await navigator.clipboard.readText();
            try {
                const j = JSON.parse(t);
                if (j && j.__maxiverse === 'codeblocks-v1' && Array.isArray(j.blocks)) payload = j;
            } catch (_) {}
        }
    } catch (_) {}
    if (!payload || !Array.isArray(payload.blocks) || payload.blocks.length === 0) return;
    const hasStart = selectedObj.code.some(b => b.type === 'start');
    const oldIds = new Set(payload.blocks.map(b => b.id));
    const idMap = new Map();
    let maxId = selectedObj.code.length ? Math.max(...selectedObj.code.map(b => b.id)) : 0;
    for (const b of payload.blocks) {
        maxId++;
        idMap.set(b.id, maxId);
    }
    const host = getCodeScrollContainer();
    const hr = host ? host.getBoundingClientRect() : null;
    const center = hr ? clientToLayerLocal(hr.left + hr.width / 2, hr.top + hr.height / 2) : { x: 200, y: 200 };
    let sumX = 0;
    let sumY = 0;
    let n = 0;
    payload.blocks.forEach(b => {
        const p = b.position || { x: 0, y: 0 };
        sumX += p.x;
        sumY += p.y;
        n++;
    });
    const cx = n ? sumX / n : 0;
    const cy = n ? sumY / n : 0;
    const dx = center.x - cx;
    const dy = center.y - cy;
    const refKeys = ['next_block_a', 'next_block_b', 'input_a', 'input_b'];
    const newBlocks = [];
    for (const b of payload.blocks) {
        const nb = JSON.parse(JSON.stringify(b));
        nb.id = idMap.get(b.id);
        for (const k of refKeys) {
            if (typeof nb[k] === 'number') {
                nb[k] = oldIds.has(nb[k]) ? idMap.get(nb[k]) : null;
            }
        }
        const pos = nb.position || { x: 0, y: 0 };
        nb.position = { x: pos.x + dx, y: pos.y + dy };
        if (nb.type === 'start' && hasStart) {
            nb.type = 'action';
            nb.content = 'wait';
            nb.val_a = 0;
        }
        newBlocks.push(nb);
    }
    selectedObj.code.push(...newBlocks);
    rebuildCodeMaps();
    selectedCodeBlockIds.clear();
    newBlocks.forEach(b => selectedCodeBlockIds.add(b.id));
    codeSelectionOwnerId = selected_object;
    updateWorkspace();
}

const CODE_BLOCK_DUPLICATE_OFFSET = 24;

function removeCodeBlockContextMenu() {
    const el = document.getElementById('__code_block_ctx_menu');
    if (el && el.parentNode) el.parentNode.removeChild(el);
}
let _codeBlockCtxMenuDismissBound = false;
function bindCodeBlockContextMenuDismiss() {
    if (_codeBlockCtxMenuDismissBound) return;
    _codeBlockCtxMenuDismissBound = true;
    document.addEventListener('mousedown', (ev) => {
        const menu = document.getElementById('__code_block_ctx_menu');
        if (!menu || menu.contains(ev.target)) return;
        removeCodeBlockContextMenu();
    }, true);
}
function showCodeBlockContextMenu(clientX, clientY) {
    bindCodeBlockContextMenuDismiss();
    removeCodeBlockContextMenu();
    const menu = document.createElement('div');
    menu.id = '__code_block_ctx_menu';
    menu.setAttribute('role', 'menu');
    menu.className = 'ctx-menu';
    const dupBtn = document.createElement('button');
    dupBtn.type = 'button';
    dupBtn.textContent = 'Duplicate';
    dupBtn.setAttribute('role', 'menuitem');
    dupBtn.className = 'ctx-menu-item';
    dupBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        removeCodeBlockContextMenu();
        duplicateSelectedCodeBlocksInternal();
    });
    menu.appendChild(dupBtn);
    document.body.appendChild(menu);
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    let lx = clientX;
    let ly = clientY;
    if (lx + w > window.innerWidth - 8) lx = window.innerWidth - w - 8;
    if (ly + h > window.innerHeight - 8) ly = window.innerHeight - h - 8;
    menu.style.left = `${Math.max(8, lx)}px`;
    menu.style.top = `${Math.max(8, ly)}px`;
}

function duplicateSelectedCodeBlocksInternal() {
    const selectedObj = objects.find(o => o.id == selected_object);
    if (!selectedObj || selectedCodeBlockIds.size === 0) return;
    const payloadBlocks = selectedObj.code.filter(b => selectedCodeBlockIds.has(b.id)).map(b => JSON.parse(JSON.stringify(b)));
    if (payloadBlocks.length === 0) return;
    const hasStart = selectedObj.code.some(b => b.type === 'start');
    const oldIds = new Set(payloadBlocks.map(b => b.id));
    const idMap = new Map();
    let maxId = selectedObj.code.length ? Math.max(...selectedObj.code.map(b => b.id)) : 0;
    for (const b of payloadBlocks) {
        maxId++;
        idMap.set(b.id, maxId);
    }
    const ox = CODE_BLOCK_DUPLICATE_OFFSET;
    const oy = CODE_BLOCK_DUPLICATE_OFFSET;
    const refKeys = ['next_block_a', 'next_block_b', 'input_a', 'input_b'];
    const newBlocks = [];
    for (const b of payloadBlocks) {
        const nb = JSON.parse(JSON.stringify(b));
        nb.id = idMap.get(b.id);
        for (const k of refKeys) {
            if (typeof nb[k] === 'number') {
                nb[k] = oldIds.has(nb[k]) ? idMap.get(nb[k]) : null;
            }
        }
        const pos = nb.position || { x: 0, y: 0 };
        nb.position = { x: pos.x + ox, y: pos.y + oy };
        if (nb.type === 'start' && hasStart) {
            nb.type = 'action';
            nb.content = 'wait';
            nb.val_a = 0;
        }
        newBlocks.push(nb);
    }
    selectedObj.code.push(...newBlocks);
    rebuildCodeMaps();
    const newIds = newBlocks.map(b => b.id);
    updateWorkspace();
    // Re-apply after DOM rebuild: syncCodeSelectionOwnership may clear the set (e.g. owner id mismatch), and classes must run when nodes exist.
    codeSelectionOwnerId = selected_object;
    selectedCodeBlockIds.clear();
    newIds.forEach(id => selectedCodeBlockIds.add(id));
    applyCodeBlockSelectionClasses();
    requestAnimationFrame(() => applyCodeBlockSelectionClasses());
}

function onCodeBlockLayerContextMenu(e) {
    if (activeTab !== 'code') return;
    const block = e.target.closest && e.target.closest('.node-block');
    if (!block) return;
    const tag = (e.target && e.target.tagName) ? String(e.target.tagName).toLowerCase() : '';
    if (tag === 'select' || tag === 'input' || tag === 'textarea' || (e.target.closest && e.target.closest('select'))) {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const id = parseInt(block.dataset.codeId, 10);
    const selectedObj = objects.find(obj => obj.id == selected_object);
    if (!selectedObj) return;
    syncCodeSelectionOwnership(selectedObj);
    if (!selectedCodeBlockIds.has(id)) {
        if (!e.shiftKey) selectedCodeBlockIds.clear();
        selectedCodeBlockIds.add(id);
        applyCodeBlockSelectionClasses();
    }
    showCodeBlockContextMenu(e.clientX, e.clientY);
}

function deleteSelectedCodeBlocks() {
    const selectedObj = objects.find(o => o.id == selected_object);
    if (!selectedObj) return;
    const toDelete = [...selectedCodeBlockIds].filter(id => {
        const b = selectedObj.code.find(c => c.id === id);
        return b && b.type !== 'start';
    });
    if (toDelete.length === 0) return;
    toDelete.forEach(id => removeCodeBlockFromObject(selectedObj, id));
    rebuildCodeMaps();
    updateWorkspace();
}
function selectAllCodeBlocks() {
    const selectedObj = objects.find(o => o.id == selected_object);
    if (!selectedObj) return;
    syncCodeSelectionOwnership(selectedObj);
    selectedCodeBlockIds.clear();
    selectedObj.code.forEach(b => selectedCodeBlockIds.add(b.id));
    applyCodeBlockSelectionClasses();
}
function updateMarqueeRectVisual() {
    if (!marqueeSelectState) return;
    const { x0, y0, x1, y1, marqueeEl } = marqueeSelectState;
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    marqueeEl.style.left = `${left}px`;
    marqueeEl.style.top = `${top}px`;
    marqueeEl.style.width = `${w}px`;
    marqueeEl.style.height = `${h}px`;
}
function onMarqueeMouseMove(e) {
    if (!marqueeSelectState) return;
    const p = clientToLayerLocal(e.clientX, e.clientY);
    marqueeSelectState.x1 = p.x;
    marqueeSelectState.y1 = p.y;
    updateMarqueeRectVisual();
    autoScrollIfNearEdge(e.clientX, e.clientY);
}
function onMarqueeMouseUp(e) {
    document.removeEventListener('mousemove', onMarqueeMouseMove);
    document.removeEventListener('mouseup', onMarqueeMouseUp, true);
    stopCodeViewportAutoScroll();
    if (!marqueeSelectState) return;
    const { x0, y0, x1, y1, shift, marqueeEl, layer } = marqueeSelectState;
    if (marqueeEl.parentNode) marqueeEl.parentNode.removeChild(marqueeEl);
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const right = Math.max(x0, x1);
    const bottom = Math.max(y0, y1);
    const w = right - left;
    const h = bottom - top;
    marqueeSelectState = null;
    const selectedObj = objects.find(obj => obj.id == selected_object);
    if (!selectedObj) return;
    syncCodeSelectionOwnership(selectedObj);
    if (w < 4 && h < 4) {
        if (!shift) {
            selectedCodeBlockIds.clear();
            applyCodeBlockSelectionClasses();
        }
        return;
    }
    const z = getLayerUniformScale(layer);
    const layerRect = layer.getBoundingClientRect();
    const idsInRect = new Set();
    selectedObj.code.forEach(cd => {
        const el = layer.querySelector(`[data-code-id="${cd.id}"]`);
        if (!el) return;
        const r = getLayerLocalRect(layer, el, layerRect, z);
        const intersects = !(r.left + r.width < left || r.left > right || r.top + r.height < top || r.top > bottom);
        if (intersects) idsInRect.add(cd.id);
    });
    if (!shift) selectedCodeBlockIds.clear();
    idsInRect.forEach(id => selectedCodeBlockIds.add(id));
    applyCodeBlockSelectionClasses();
}
function onCodeZoomLayerMouseDown(e) {
    if (activeTab !== 'code') return;
    if (e.button !== 0) return;
    if (isConnecting) return;
    if (e.target.closest && e.target.closest('.node-block')) return;
    if (e.target.closest && e.target.closest('.code-zoom-controls')) return;
    e.preventDefault();
    e.stopPropagation();
    const nw = document.getElementById('node-window');
    if (nw) try { nw.focus(); } catch (_) {}
    const layer = document.getElementById('code-zoom-layer');
    if (!layer) return;
    const p0 = clientToLayerLocal(e.clientX, e.clientY);
    const marqueeEl = document.createElement('div');
    marqueeEl.className = 'code-marquee-rect';
    marqueeEl.style.position = 'absolute';
    marqueeEl.style.pointerEvents = 'none';
    marqueeEl.style.zIndex = '40';
    layer.appendChild(marqueeEl);
    marqueeSelectState = {
        layer,
        x0: p0.x,
        y0: p0.y,
        x1: p0.x,
        y1: p0.y,
        shift: e.shiftKey,
        marqueeEl
    };
    updateMarqueeRectVisual();
    document.addEventListener('mousemove', onMarqueeMouseMove);
    document.addEventListener('mouseup', onMarqueeMouseUp, true);
}
function handleCodeBlockDragMouseMove(e) {
    if (!pendingDragGroup && !dragBlockGroup) return;
    const z = codeZoom || 1;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (pendingDragGroup && !dragBlockGroup) {
        if (Math.hypot(dx, dy) < CODE_DRAG_THRESHOLD_PX) return;
        dragBlockGroup = pendingDragGroup.entries;
        pendingDragGroup = null;
        dragBlockGroup.forEach(({ el }) => {
            el.classList.add('dragging');
            el.style.transition = 'none';
        });
    }
    if (!dragBlockGroup) return;
    for (const ent of dragBlockGroup) {
        const nx = ent.baseX + dx / z;
        const ny = ent.baseY + dy / z;
        ent.el.style.left = `${nx}px`;
        ent.el.style.top = `${ny}px`;
    }
    autoScrollIfNearEdge(e.clientX, e.clientY);
    drawConnections();
}
function handleCodeBlockDragMouseUp(e) {
    document.removeEventListener('mousemove', handleCodeBlockDragMouseMove);
    document.removeEventListener('mouseup', handleCodeBlockDragMouseUp);
    if (pendingDragGroup && !dragBlockGroup) {
        pendingDragGroup = null;
        return;
    }
    if (!dragBlockGroup) return;
    const z = codeZoom || 1;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    const selectedObj = objects.find(obj => obj.id == selected_object);
    if (selectedObj) {
        for (const ent of dragBlockGroup) {
            const finalX = ent.baseX + dx / z;
            const finalY = ent.baseY + dy / z;
            ent.el.style.left = `${finalX}px`;
            ent.el.style.top = `${finalY}px`;
            const codeId = parseInt(ent.el.dataset.codeId, 10);
            const codeData = selectedObj.code.find(code => code.id == codeId);
            if (codeData) codeData.position = { x: finalX, y: finalY };
            ent.el.classList.remove('dragging');
            ent.el.style.transition = 'transform 0.1s ease-out';
        }
    }
    dragBlockGroup = null;
    pendingDragGroup = null;
    stopCodeViewportAutoScroll();
    drawConnections();
    updateSpacerFromBlocks();
}
function handleCodeBlockDragTouchMove(e) {
    if (!pendingDragGroup && !dragBlockGroup) return;
    e.preventDefault();
    const touch = e.touches[0];
    if (!touch) return;
    const z = codeZoom || 1;
    const dx = touch.clientX - dragStartX;
    const dy = touch.clientY - dragStartY;
    if (pendingDragGroup && !dragBlockGroup) {
        if (Math.hypot(dx, dy) < CODE_DRAG_THRESHOLD_PX) return;
        dragBlockGroup = pendingDragGroup.entries;
        pendingDragGroup = null;
        dragBlockGroup.forEach(({ el }) => {
            el.classList.add('dragging');
            el.style.transition = 'none';
        });
    }
    if (!dragBlockGroup) return;
    for (const ent of dragBlockGroup) {
        const nx = ent.baseX + dx / z;
        const ny = ent.baseY + dy / z;
        ent.el.style.left = `${nx}px`;
        ent.el.style.top = `${ny}px`;
    }
    autoScrollIfNearEdge(touch.clientX, touch.clientY);
    drawConnections();
}
function handleCodeBlockDragTouchEnd(e) {
    document.removeEventListener('touchmove', handleCodeBlockDragTouchMove, { passive: false });
    document.removeEventListener('touchend', handleCodeBlockDragTouchEnd);
    if (pendingDragGroup && !dragBlockGroup) {
        pendingDragGroup = null;
        return;
    }
    if (!dragBlockGroup) return;
    const z = codeZoom || 1;
    let dx = 0;
    let dy = 0;
    if (e.changedTouches && e.changedTouches.length > 0) {
        const touch = e.changedTouches[0];
        dx = touch.clientX - dragStartX;
        dy = touch.clientY - dragStartY;
    }
    const selectedObj = objects.find(obj => obj.id == selected_object);
    if (selectedObj) {
        for (const ent of dragBlockGroup) {
            const finalX = ent.baseX + dx / z;
            const finalY = ent.baseY + dy / z;
            ent.el.style.left = `${finalX}px`;
            ent.el.style.top = `${finalY}px`;
            const codeId = parseInt(ent.el.dataset.codeId, 10);
            const codeData = selectedObj.code.find(code => code.id == codeId);
            if (codeData) codeData.position = { x: finalX, y: finalY };
            ent.el.classList.remove('dragging');
            ent.el.style.transition = 'transform 0.1s ease-out';
        }
    }
    dragBlockGroup = null;
    pendingDragGroup = null;
    stopCodeViewportAutoScroll();
    drawConnections();
    updateSpacerFromBlocks();
}
function initCodeBlockKeyboardShortcuts() {
    if (window.__codeBlockKbBound) return;
    window.__codeBlockKbBound = true;
    window.addEventListener('keydown', (e) => {
        if (activeTab !== 'code') return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key === 'c') {
            copyCodeBlocksToClipboardInternal();
            e.preventDefault();
            return;
        }
        if (mod && e.key === 'v') {
            e.preventDefault();
            pasteCodeBlocksFromClipboardInternal();
            return;
        }
        if (mod && (e.key === 'a' || e.key === 'A')) {
            selectAllCodeBlocks();
            e.preventDefault();
            return;
        }
        if (mod && e.key === 'x') {
            copyCodeBlocksToClipboardInternal();
            deleteSelectedCodeBlocks();
            e.preventDefault();
            return;
        }
        // Delete / Backspace: remove selected blocks (Backspace = "Delete" on many Mac keyboards)
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedCodeBlockIds.size === 0) return;
            deleteSelectedCodeBlocks();
            e.preventDefault();
            return;
        }
        if (e.key === 'Escape') {
            removeCodeBlockContextMenu();
            selectedCodeBlockIds.clear();
            applyCodeBlockSelectionClasses();
        }
    });
}

// Create a node block
function createNodeBlock(codeData, x, y) {
    const block = document.createElement("div");
    block.className = "node-block";
    if (codeData.type === 'start') block.classList.add('node-block-start');
    if (codeData.type === 'value') block.classList.add('node-block-value');
    block.dataset.codeId = codeData.id;
    block.style.left = `${x}px`;
    block.style.top = `${y}px`;
    block.style.transition = 'transform 0.1s ease-out';
    // Use custom drag handlers only; disable native HTML5 drag to avoid ghost image/offset issues
    block.draggable = false;

    // Label with dropdowns integrated
    const label = document.createElement("span");
    label.className = "node-label"
    if (codeData.content === "move_xy") {
        label.innerHTML = "Move By (";
        const xSelectSpan = document.createElement("span");
        xSelectSpan.className = 'node-input-container';
        const ySelectSpan = document.createElement("span");
        ySelectSpan.className = 'node-input-container';
        label.appendChild(xSelectSpan);
        label.innerHTML += ", ";
        label.appendChild(ySelectSpan);
        label.innerHTML += ")";
    } else if (codeData.content === "move_forward") {
        // Move Forward ( [pixels] )
        label.textContent = "";
        label.append("Move Forward (");
        const span = document.createElement("span");
        span.className = 'node-input-container';
        const input = document.createElement("input");
        input.type = "number";
        input.step = "1";
        if (typeof codeData.val_a !== 'number') codeData.val_a = 10;
        input.value = codeData.val_a;
        input.addEventListener("change", () => { codeData.val_a = parseNumericInput(input.value); });
        span.appendChild(input);
        label.appendChild(span);
        label.append(")");
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        span.appendChild(btn);
        if (codeData.input_a != null) { input.value = '^'; input.readOnly = true; }
    } else if (codeData.content === "wait") {
        // Wait ( [seconds] )
        label.textContent = "";
        label.append("Wait (");
        const waitSpan = document.createElement("span");
        waitSpan.className = 'node-input-container';
        const waitInput = document.createElement("input");
        waitInput.type = "text";
        waitInput.setAttribute('inputmode', 'decimal');
        waitInput.autocomplete = 'off';
        waitInput.value = (typeof codeData.val_a === 'number' ? codeData.val_a : 1);
        waitInput.addEventListener("change", () => {
            codeData.val_a = parseNumericInput(waitInput.value);
        });
        waitSpan.appendChild(waitInput);
        label.appendChild(waitSpan);
        label.append(")");
        if (codeData.input_a != null) { waitInput.value = '^'; waitInput.readOnly = true; }
    } else if (codeData.content === "repeat") {
        // Repeat ( [times] ) times
        label.textContent = "";
        label.append("Repeat (");
        const repeatSpan = document.createElement("span");
        repeatSpan.className = 'node-input-container';
        const repeatInput = document.createElement("input");
        repeatInput.type = "number";
        repeatInput.min = "1";
        repeatInput.step = "1";
        repeatInput.value = (typeof codeData.val_a === 'number' ? codeData.val_a : 2);
        repeatInput.addEventListener("change", () => {
            codeData.val_a = Math.max(1, Math.floor(parseNumericInput(repeatInput.value)));
        });
        repeatSpan.appendChild(repeatInput);
        label.appendChild(repeatSpan);
        label.append(") times");
        if (codeData.input_a != null) { repeatInput.value = '^'; repeatInput.readOnly = true; }
    } else if (codeData.content === 'if') {
        // If ( [value] ) then -> A else -> B
        label.textContent = '';
        label.append('If (');
        const condSpan = document.createElement('span');
        condSpan.className = 'node-input-container';
        const condInput = document.createElement('input');
        condInput.type = 'number'; condInput.step = '1';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 1;
        condInput.value = codeData.val_a;
        condInput.addEventListener('change', () => { codeData.val_a = parseNumericInput(condInput.value); });
        condSpan.appendChild(condInput);
        label.appendChild(condSpan);
        label.append(')');
        // input-plus for condition
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            // Prevent starting a new drag if one is already in progress
            if (isConnecting) {
                console.log('Drag already in progress, ignoring mousedown');
                return;
            }
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            // Ensure focus on node window and clear any lingering menu handlers
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        condSpan.appendChild(btn);
        if (codeData.input_a != null) { condInput.value = '^'; condInput.readOnly = true; }
    } else if (codeData.content === "forever") {
        label.textContent = "Forever";
    } else if (codeData.content === "rotate") {
        // Rotate ( [degrees] )
        label.textContent = "";
        label.append("Rotate (");
        const rotSpan = document.createElement("span");
        rotSpan.className = 'node-input-container';
        label.appendChild(rotSpan);
        label.append(")");
    } else if (codeData.content === 'set_rotation') {
        // Set Rotation ( [degrees] )
        label.textContent = '';
        label.append('Set Rotation (');
        const rotSpan = document.createElement('span');
        rotSpan.className = 'node-input-container';
        const rotInput = document.createElement('input');
        rotInput.type = 'number'; rotInput.step = '1';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 0;
        rotInput.value = codeData.val_a;
        rotInput.addEventListener('change', () => { codeData.val_a = parseNumericInput(rotInput.value); });
        rotSpan.appendChild(rotInput);
        label.appendChild(rotSpan);
        label.append(')');
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        rotSpan.appendChild(btn);
        if (codeData.input_a != null) { rotInput.value = '^'; rotInput.readOnly = true; }
    } else if (codeData.content === 'set_size') {
        label.textContent = '';
        label.append('Set Size (');
        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'node-input-container';
        const sizeInput = document.createElement('input');
        sizeInput.type = 'number'; sizeInput.step = '0.1';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 1;
        sizeInput.value = codeData.val_a;
        sizeInput.addEventListener('change', () => { codeData.val_a = (parseNumericInput(sizeInput.value) || 1); });
        sizeSpan.appendChild(sizeInput);
        label.appendChild(sizeSpan);
        label.append(')');
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            // Prevent starting a new drag if one is already in progress
            if (isConnecting) {
                console.log('Drag already in progress, ignoring mousedown');
                return;
            }
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        sizeSpan.appendChild(btn);
        if (codeData.input_a != null) { sizeInput.value = '^'; sizeInput.readOnly = true; }
    } else if (codeData.content === 'change_size') {
        label.textContent = '';
        label.append('Change Size (');
        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'node-input-container';
        const sizeInput = document.createElement('input');
        sizeInput.type = 'number'; sizeInput.step = '0.1';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 0.1;
        sizeInput.value = codeData.val_a;
        sizeInput.addEventListener('change', () => { codeData.val_a = parseNumericInput(sizeInput.value); });
        sizeSpan.appendChild(sizeInput);
        label.appendChild(sizeSpan);
        label.append(')');
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            // Prevent starting a new drag if one is already in progress
            if (isConnecting) {
                console.log('Drag already in progress, ignoring mousedown');
                return;
            }
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        sizeSpan.appendChild(btn);
        if (codeData.input_a != null) { sizeInput.value = '^'; sizeInput.readOnly = true; }
    } else if (codeData.content === 'set_layer') {
        label.textContent = '';
        label.append('Set Layer (');
        const layerSpan = document.createElement('span');
        layerSpan.className = 'node-input-container';
        const layerInput = document.createElement('input');
        layerInput.type = 'number'; layerInput.step = '1';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 0;
        layerInput.value = codeData.val_a;
        layerInput.addEventListener('change', () => { codeData.val_a = parseNumericInput(layerInput.value); });
        layerSpan.appendChild(layerInput);
        label.appendChild(layerSpan);
        label.append(')');
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        layerSpan.appendChild(btn);
        if (codeData.input_a != null) { layerInput.value = '^'; layerInput.readOnly = true; }
    } else if (codeData.content === 'set_opacity') {
        label.textContent = '';
        label.append('Set Opacity (');
        const opSpan = document.createElement('span');
        opSpan.className = 'node-input-container';
        const opInput = document.createElement('input');
        opInput.type = 'number'; opInput.step = '0.01';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 1;
        opInput.value = codeData.val_a;
        opInput.min = '0'; opInput.max = '1';
        opInput.addEventListener('change', () => { let v = parseNumericInput(opInput.value); if (!Number.isFinite(v)) v = 1; codeData.val_a = Math.max(0, Math.min(1, v)); });
        opSpan.appendChild(opInput);
        label.appendChild(opSpan);
        label.append(')');
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        opSpan.appendChild(btn);
        if (codeData.input_a != null) { opInput.value = '^'; opInput.readOnly = true; }
    } else if (codeData.content === 'operation') {
        // Operation block: ( X [op] Y ) — text fields so + can take strings; other ops coerce to numbers
        label.textContent = '';
        const leftSpan = document.createElement('span');
        leftSpan.className = 'node-input-container';
        const leftInput = document.createElement('input');
        leftInput.className = 'node-op-input';
        leftInput.type = 'text';
        leftInput.autocomplete = 'off';
        leftInput.spellcheck = false;
        if (codeData.op_x === undefined || codeData.op_x === null) codeData.op_x = 0;
        const rightSpan = document.createElement('span');
        rightSpan.className = 'node-input-container';
        const rightInput = document.createElement('input');
        rightInput.className = 'node-op-input';
        rightInput.type = 'text';
        rightInput.autocomplete = 'off';
        rightInput.spellcheck = false;
        if (codeData.op_y === undefined || codeData.op_y === null) codeData.op_y = 0;
        if (!codeData.val_a) codeData.val_a = '+';

        const applyOpLiteral = (key, inputEl) => {
            const raw = inputEl.value;
            if (codeData.val_a === '+') {
                codeData[key] = raw;
            } else {
                codeData[key] = parseNumericInput(raw);
            }
        };
        const refreshOpInputsFromData = () => {
            const fmt = (v) => (v === undefined || v === null) ? '' : String(v);
            leftInput.value = codeData.input_a != null ? '^' : fmt(codeData.op_x);
            rightInput.value = codeData.input_b != null ? '^' : fmt(codeData.op_y);
            leftInput.readOnly = codeData.input_a != null;
            rightInput.readOnly = codeData.input_b != null;
        };
        refreshOpInputsFromData();
        leftInput.addEventListener('change', () => { applyOpLiteral('op_x', leftInput); });
        rightInput.addEventListener('change', () => { applyOpLiteral('op_y', rightInput); });
        leftSpan.appendChild(leftInput);

        const opSelect = document.createElement('select');
        opSelect.className = 'node-op-select';
        const ops = ['+','-','*','/','^'];
        ops.forEach(sym => {
            const opt = document.createElement('option');
            opt.value = sym; opt.textContent = sym;
            opSelect.appendChild(opt);
        });
        opSelect.value = codeData.val_a;
        opSelect.addEventListener('change', () => {
            const prev = codeData.val_a;
            codeData.val_a = opSelect.value;
            if (prev === '+' && codeData.val_a !== '+') {
                codeData.op_x = parseNumericInput(String(codeData.op_x));
                codeData.op_y = parseNumericInput(String(codeData.op_y));
            } else if (prev !== '+' && codeData.val_a === '+') {
                /* keep numeric values as readable text */
                codeData.op_x = String(codeData.op_x);
                codeData.op_y = String(codeData.op_y);
            }
            refreshOpInputsFromData();
        });

        rightSpan.appendChild(rightInput);

        label.append('(');
        label.appendChild(leftSpan);
        label.append(' ');
        label.appendChild(opSelect);
        label.append(' ');
        label.appendChild(rightSpan);
        label.append(')');
        
        // per-input plus buttons for operation operands
        const addOpInputPlus = (containerEl, which) => {
            const btn = document.createElement('button');
            btn.className = `node-plus-btn node-input-plus-btn node-input-plus-btn-${which}`;
            btn.textContent = '+';
            btn.title = `Add input (${which.toUpperCase()})`;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                showAddInputBlockMenu(block, codeData, which, btn);
            });
            btn.addEventListener('mousedown', (e) => {
                e.stopPropagation(); e.preventDefault();
                // Prevent multiple simultaneous drag operations
                if (isConnecting) return;

                if (!getCodeScrollContainer()) return;
                setConnectMouseFromClientEvent(e);
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true;
                connectStartTime = Date.now();
                connectFromInput = { blockId: codeData.id, which };
                attachConnectDragListeners();
                drawConnections();
            });
            containerEl.appendChild(btn);
        };
        addOpInputPlus(leftSpan, 'a');
        addOpInputPlus(rightSpan, 'b');
        refreshOpInputsFromData();

    } else if (codeData.content === 'mouse_x') {
        label.textContent = 'mouseX';
        block.classList.add('node-block-slim');
    } else if (codeData.content === 'mouse_y') {
        label.textContent = 'mouseY';
        block.classList.add('node-block-slim');
    } else if (codeData.content === 'window_width') {
        label.textContent = 'WindowWidth';
        block.classList.add('node-block-slim');
    } else if (codeData.content === 'window_height') {
        label.textContent = 'WindowHeight';
        block.classList.add('node-block-slim');
    } else if (codeData.content === 'object_x') {
        label.textContent = 'ObjectX';
        block.classList.add('node-block-slim');
    } else if (codeData.content === 'object_y') {
        label.textContent = 'ObjectY';
        block.classList.add('node-block-slim');
    } else if (codeData.content === 'rotation') {
        label.textContent = 'Rotation';
        block.classList.add('node-block-slim');
    } else if (codeData.content === 'size') {
        label.textContent = 'Size';
        block.classList.add('node-block-slim');
    } else if (codeData.content === 'key_pressed') {
        label.textContent = '';
        label.append('key pressed (');
        const keySpan = document.createElement('span');
        const keySelect = document.createElement('select');
        const keys = [];
        // a-z
        for (let i = 97; i <= 122; i++) keys.push(String.fromCharCode(i));
        // 0-9
        for (let i = 0; i <= 9; i++) keys.push(String(i));
        // Common keys
        keys.push('Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter','Shift','Control','Alt','Tab','Escape','Backspace','Delete','Home','End','PageUp','PageDown');
        keys.forEach(k => { const opt = document.createElement('option'); opt.value = k; opt.textContent = k; keySelect.appendChild(opt); });
        if (!codeData.key_name) codeData.key_name = 'Space';
        keySelect.value = codeData.key_name;
        keySelect.addEventListener('change', () => { codeData.key_name = keySelect.value; });
        keySpan.appendChild(keySelect);
        label.appendChild(keySpan);
        label.append(')');
    } else if (codeData.content === 'mouse_pressed') {
        label.textContent = 'Mouse Down';
        block.classList.add('node-block-slim');
    } else if (codeData.content === 'set_x') {
        label.textContent = '';
        label.append('Set X (');
        const span = document.createElement('span');
        span.className = 'node-input-container';
        const input = document.createElement('input');
        input.type = 'number'; input.step = '1';
        input.value = (typeof codeData.val_a === 'number' ? codeData.val_a : 0);
        input.addEventListener('change', () => { codeData.val_a = parseNumericInput(input.value); });
        span.appendChild(input);
        label.appendChild(span);
        label.append(')');
        // add input-plus and caret behavior
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            // Prevent multiple simultaneous drag operations
            if (isConnecting) return;

            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            // Ensure canvas focus and clear any lingering menu handlers
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true;
            connectStartTime = Date.now();
            connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        span.appendChild(btn);
        if (codeData.input_a != null) { input.value = '^'; input.readOnly = true; }
    } else if (codeData.content === 'set_y') {
        label.textContent = '';
        label.append('Set Y (');
        const span = document.createElement('span');
        span.className = 'node-input-container';
        const input = document.createElement('input');
        input.type = 'number'; input.step = '1';
        input.value = (typeof codeData.val_a === 'number' ? codeData.val_a : 0);
        input.addEventListener('change', () => { codeData.val_a = parseNumericInput(input.value); });
        span.appendChild(input);
        label.appendChild(span);
        label.append(')');
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            // Prevent multiple simultaneous drag operations
            if (isConnecting) return;

            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            // Ensure canvas focus and clear any lingering menu handlers
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true;
            connectStartTime = Date.now();
            connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        span.appendChild(btn);
        if (codeData.input_a != null) { input.value = '^'; input.readOnly = true; }
    } else if (codeData.content === 'switch_image') {
        label.textContent = '';
        label.append('Switch Image (');
        const span = document.createElement('span');
        const select = document.createElement('select');
        // Populate with images available to current object
        const imgs = getCurrentObjectImages();
        imgs.forEach(img => { const opt = document.createElement('option'); opt.value = String(img.id); opt.textContent = img.name; select.appendChild(opt); });
        if (!codeData.val_a && imgs[0]) codeData.val_a = String(imgs[0].id);
        select.value = codeData.val_a || '';
        select.addEventListener('change', () => { codeData.val_a = select.value; });
        span.appendChild(select);
        label.appendChild(span);
        label.append(')');
    } else if (codeData.content === 'play_sound') {
        label.textContent = '';
        label.append('Start Sound (');
        const span = document.createElement('span');
        span.className = 'node-input-container';
        const select = document.createElement('select');
        const snds = getCurrentObjectSounds();
        snds.forEach((s) => {
            const opt = document.createElement('option');
            opt.value = String(s.id);
            opt.textContent = s.name;
            select.appendChild(opt);
        });
        if (!codeData.val_a && snds[0]) codeData.val_a = String(snds[0].id);
        select.value = codeData.val_a || '';
        select.addEventListener('change', () => { codeData.val_a = select.value; });
        span.appendChild(select);
        label.appendChild(span);
        label.append(')');
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        span.appendChild(btn);
        if (codeData.input_a != null) { select.style.display = 'none'; const connInd = document.createElement('input'); connInd.type = 'text'; connInd.value = '^'; connInd.readOnly = true; span.insertBefore(connInd, btn); }
    } else if (codeData.content === 'instantiate') {
        label.textContent = '';
        label.append('Instantiate (');
        const span = document.createElement('span');
        const select = document.createElement('select');
        const instantiables = objects.filter(o => o.name !== 'AppController');
        instantiables.forEach(o => { const opt = document.createElement('option'); opt.value = String(o.id); opt.textContent = o.name; select.appendChild(opt); });
        if (!codeData.val_a && instantiables[0]) codeData.val_a = String(instantiables[0].id);
        select.value = codeData.val_a || '';
        select.addEventListener('change', () => { codeData.val_a = select.value; });
        span.appendChild(select);
        label.appendChild(span);
        label.append(')');
    } else if (codeData.content === 'delete_instance') {
        label.textContent = 'Delete Instance';
    } else if (codeData.content === 'distance_to') {
        // Distance To ( [x] , [y] )
        label.textContent = '';
        label.append('Distance To (');
        const aSpan = document.createElement('span');
        aSpan.className = 'node-input-container';
        const aInput = document.createElement('input');
        aInput.type = 'number'; aInput.step = '1';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 0;
        aInput.value = codeData.val_a;
        aInput.addEventListener('change', () => { codeData.val_a = parseNumericInput(aInput.value); });
        aSpan.appendChild(aInput);
        label.appendChild(aSpan);
        label.append(', ');
        const bSpan = document.createElement('span');
        bSpan.className = 'node-input-container';
        const bInput = document.createElement('input');
        bInput.type = 'number'; bInput.step = '1';
        if (typeof codeData.val_b !== 'number') codeData.val_b = 0;
        bInput.value = codeData.val_b;
        bInput.addEventListener('change', () => { codeData.val_b = parseNumericInput(bInput.value); });
        bSpan.appendChild(bInput);
        label.appendChild(bSpan);
        label.append(')');

        const addInputPlus = (containerEl, which) => {
            const btn = document.createElement('button');
            btn.className = `node-plus-btn node-input-plus-btn node-input-plus-btn-${which}`;
            btn.textContent = '+'; btn.title = `Add input (${which.toUpperCase()})`;
            btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, which, btn); });
            btn.addEventListener('mousedown', (e) => {
                e.stopPropagation(); e.preventDefault();
                if (isConnecting) return;
                if (!getCodeScrollContainer()) return;
                setConnectMouseFromClientEvent(e);
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which };
                attachConnectDragListeners();
                drawConnections();
            });
            containerEl.appendChild(btn);
        };
        addInputPlus(aSpan, 'a');
        addInputPlus(bSpan, 'b');
        if (codeData.input_a != null) { aInput.value = '^'; aInput.readOnly = true; }
        if (codeData.input_b != null) { bInput.value = '^'; bInput.readOnly = true; }
    } else if (codeData.content === 'pixel_is_rgb') {
        // Pixel at (x,y) is rgb(r,g,b)  -> returns 1/0 when used as an input block
        label.textContent = '';
        label.append('Pixel at (');

        const xSpan = document.createElement('span');
        xSpan.className = 'node-input-container';
        const xInput = document.createElement('input');
        xInput.type = 'number'; xInput.step = '1';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 0;
        xInput.value = codeData.val_a;
        xInput.addEventListener('change', () => { codeData.val_a = parseNumericInput(xInput.value); });
        xSpan.appendChild(xInput);
        label.appendChild(xSpan);

        label.append(', ');

        const ySpan = document.createElement('span');
        ySpan.className = 'node-input-container';
        const yInput = document.createElement('input');
        yInput.type = 'number'; yInput.step = '1';
        if (typeof codeData.val_b !== 'number') codeData.val_b = 0;
        yInput.value = codeData.val_b;
        yInput.addEventListener('change', () => { codeData.val_b = parseNumericInput(yInput.value); });
        ySpan.appendChild(yInput);
        label.appendChild(ySpan);

        label.append(') is rgb (');

        const rSpan = document.createElement('span');
        rSpan.className = 'node-input-container';
        const rInput = document.createElement('input');
        rInput.type = 'number'; rInput.step = '1'; rInput.min = '0'; rInput.max = '255';
        if (typeof codeData.rgb_r !== 'number') codeData.rgb_r = 0;
        rInput.value = codeData.rgb_r;
        rInput.addEventListener('change', () => { codeData.rgb_r = Math.max(0, Math.min(255, Math.round(parseNumericInput(rInput.value)))); rInput.value = codeData.rgb_r; });
        rSpan.appendChild(rInput);
        label.appendChild(rSpan);

        label.append(', ');

        const gSpan = document.createElement('span');
        gSpan.className = 'node-input-container';
        const gInput = document.createElement('input');
        gInput.type = 'number'; gInput.step = '1'; gInput.min = '0'; gInput.max = '255';
        if (typeof codeData.rgb_g !== 'number') codeData.rgb_g = 0;
        gInput.value = codeData.rgb_g;
        gInput.addEventListener('change', () => { codeData.rgb_g = Math.max(0, Math.min(255, Math.round(parseNumericInput(gInput.value)))); gInput.value = codeData.rgb_g; });
        gSpan.appendChild(gInput);
        label.appendChild(gSpan);

        label.append(', ');

        const bSpan = document.createElement('span');
        bSpan.className = 'node-input-container';
        const bInput = document.createElement('input');
        bInput.type = 'number'; bInput.step = '1'; bInput.min = '0'; bInput.max = '255';
        if (typeof codeData.rgb_b !== 'number') codeData.rgb_b = 0;
        bInput.value = codeData.rgb_b;
        bInput.addEventListener('change', () => { codeData.rgb_b = Math.max(0, Math.min(255, Math.round(parseNumericInput(bInput.value)))); bInput.value = codeData.rgb_b; });
        bSpan.appendChild(bInput);
        label.appendChild(bSpan);

        label.append(')');

        const addInputPlus = (containerEl, which) => {
            const btn = document.createElement('button');
            btn.className = `node-plus-btn node-input-plus-btn node-input-plus-btn-${which}`;
            btn.textContent = '+'; btn.title = `Add input (${which.toUpperCase()})`;
            btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, which, btn); });
            btn.addEventListener('mousedown', (e) => {
                e.stopPropagation(); e.preventDefault();
                if (isConnecting) return;
                if (!getCodeScrollContainer()) return;
                setConnectMouseFromClientEvent(e);
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which };
                attachConnectDragListeners();
                drawConnections();
            });
            containerEl.appendChild(btn);
        };
        addInputPlus(xSpan, 'a');
        addInputPlus(ySpan, 'b');
        if (codeData.input_a != null) { xInput.value = '^'; xInput.readOnly = true; }
        if (codeData.input_b != null) { yInput.value = '^'; yInput.readOnly = true; }
    } else if (codeData.content === 'touching') {
        label.textContent = '';
        label.append('Touching ');
        const modeSel = document.createElement('select');
        modeSel.className = 'node-touching-mode-select';
        const optObj = document.createElement('option');
        optObj.value = 'object';
        optObj.textContent = 'Game Object';
        const optCol = document.createElement('option');
        optCol.value = 'color';
        optCol.textContent = 'Color';
        modeSel.appendChild(optObj);
        modeSel.appendChild(optCol);
        if (!codeData.touching_mode) codeData.touching_mode = 'object';
        modeSel.value = codeData.touching_mode;
        label.appendChild(modeSel);

        const objectWrap = document.createElement('span');
        objectWrap.className = 'node-touching-object-wrap';
        const objSelect = document.createElement('select');
        const instantiables = objects.filter(o => o.name !== 'AppController');
        instantiables.forEach(o => {
            const opt = document.createElement('option');
            opt.value = String(o.id);
            opt.textContent = o.name;
            objSelect.appendChild(opt);
        });
        if (!codeData.val_a && instantiables[0]) codeData.val_a = String(instantiables[0].id);
        objSelect.value = codeData.val_a || '';
        objSelect.addEventListener('change', () => { codeData.val_a = objSelect.value; });
        objectWrap.appendChild(objSelect);

        const colorWrap = document.createElement('span');
        colorWrap.className = 'node-touching-color-wrap';
        colorWrap.append('rgb(');
        const rIn = document.createElement('input');
        rIn.type = 'number'; rIn.step = '1'; rIn.min = '0'; rIn.max = '255';
        if (typeof codeData.rgb_r !== 'number') codeData.rgb_r = 0;
        rIn.value = codeData.rgb_r;
        rIn.addEventListener('change', () => { codeData.rgb_r = Math.max(0, Math.min(255, Math.round(parseNumericInput(rIn.value)))); rIn.value = codeData.rgb_r; });
        colorWrap.appendChild(rIn);
        colorWrap.append(', ');
        const gIn = document.createElement('input');
        gIn.type = 'number'; gIn.step = '1'; gIn.min = '0'; gIn.max = '255';
        if (typeof codeData.rgb_g !== 'number') codeData.rgb_g = 0;
        gIn.value = codeData.rgb_g;
        gIn.addEventListener('change', () => { codeData.rgb_g = Math.max(0, Math.min(255, Math.round(parseNumericInput(gIn.value)))); gIn.value = codeData.rgb_g; });
        colorWrap.appendChild(gIn);
        colorWrap.append(', ');
        const bIn = document.createElement('input');
        bIn.type = 'number'; bIn.step = '1'; bIn.min = '0'; bIn.max = '255';
        if (typeof codeData.rgb_b !== 'number') codeData.rgb_b = 0;
        bIn.value = codeData.rgb_b;
        bIn.addEventListener('change', () => { codeData.rgb_b = Math.max(0, Math.min(255, Math.round(parseNumericInput(bIn.value)))); bIn.value = codeData.rgb_b; });
        colorWrap.appendChild(bIn);
        colorWrap.append(') ');

        const colorPickBtn = document.createElement('button');
        colorPickBtn.type = 'button';
        colorPickBtn.className = 'node-color-pick-btn';
        colorPickBtn.title = 'Pick a color';
        const lucide = window.lucide;
        if (lucide && lucide.icons) {
            const iconDef = (lucide.icons.pipette || lucide.icons.eyedropper);
            if (iconDef && typeof iconDef.toSvg === 'function') {
                colorPickBtn.innerHTML = iconDef.toSvg({ width: 14, height: 14 });
            } else {
                colorPickBtn.textContent = '◐';
            }
        } else {
            colorPickBtn.textContent = '◐';
        }

        function applyPickedRgb(r, g, b) {
            codeData.rgb_r = r; codeData.rgb_g = g; codeData.rgb_b = b;
            rIn.value = r; gIn.value = g; bIn.value = b;
        }

        colorPickBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (typeof window.EyeDropper === 'function' && window.isSecureContext) {
                let openPromise;
                try { openPromise = new EyeDropper().open(); } catch (_) { return; }
                openPromise.then((result) => {
                    const hex = result.sRGBHex;
                    if (!hex) return;
                    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
                    if (!m) return;
                    applyPickedRgb(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
                }).catch(() => {});
                return;
            }
            const canvas = document.querySelector('.image-editor-surface');
            if (!canvas) return;
            const prevCursor = canvas.style.cursor;
            canvas.style.cursor = 'crosshair';
            const wrapper = canvas.parentElement;
            if (wrapper) wrapper.style.cursor = 'crosshair';

            function cleanup() {
                canvas.style.cursor = prevCursor;
                if (wrapper) wrapper.style.cursor = '';
                canvas.removeEventListener('pointerdown', onPick, true);
                document.removeEventListener('keydown', onCancel, true);
            }
            function onPick(e) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                cleanup();
                const rect = canvas.getBoundingClientRect();
                const x = Math.floor((e.clientX - rect.left) / rect.width * canvas.width);
                const y = Math.floor((e.clientY - rect.top) / rect.height * canvas.height);
                if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return;
                let pixel;
                try { pixel = canvas.getContext('2d').getImageData(x, y, 1, 1).data; } catch (_) { return; }
                applyPickedRgb(pixel[0], pixel[1], pixel[2]);
            }
            function onCancel(e) {
                if (e.key !== 'Escape') return;
                cleanup();
            }
            canvas.addEventListener('pointerdown', onPick, true);
            document.addEventListener('keydown', onCancel, true);
        });
        colorWrap.appendChild(colorPickBtn);

        const syncTouchingVisibility = () => {
            const m = codeData.touching_mode || 'object';
            objectWrap.style.display = m === 'object' ? '' : 'none';
            colorWrap.style.display = m === 'color' ? '' : 'none';
        };
        modeSel.addEventListener('change', () => {
            codeData.touching_mode = modeSel.value;
            syncTouchingVisibility();
        });
        label.appendChild(objectWrap);
        label.appendChild(colorWrap);
        syncTouchingVisibility();

        block.classList.add('node-block-compact');
    } else if (codeData.content === 'set_variable') {
        label.textContent = '';
        label.append('Set ');
        const varSpan = document.createElement('span');
        varSpan.className = 'node-input-container';
        const varSelect = document.createElement('select');
        varSelect.classList.add('node-var-select');
        populateVariableSelect(varSelect, codeData);
        // Default UI selection to public 'i' if available and var not set
        try {
            if (!codeData.var_name) {
                const key = 'pub:i';
                varSelect.value = key;
                if (varSelect.value === key) {
                    codeData.var_name = 'i';
                    codeData.var_instance_only = false;
                }
            }
        } catch(_) {}
        varSelect.addEventListener('change', () => handleVariableSelectChange(varSelect, codeData));
        varSelect.addEventListener('mousedown', (e) => { if (varSelect.value === '__create__') { e.preventDefault(); e.stopPropagation(); handleVariableSelectChange(varSelect, codeData); } });
        // Ensure reasonable size and alignment
        varSelect.style.minWidth = '120px';
        // Avoid tiny fixed heights (can clip text on some platforms)
        varSelect.style.minHeight = '30px';
        varSpan.appendChild(varSelect);
        label.appendChild(varSpan);
        label.append(' to (');
        const valSpan = document.createElement('span');
        valSpan.className = 'node-input-container';
        const input = document.createElement('input');
        input.type = 'number'; input.step = '1';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 0;
        input.value = codeData.val_a;
        input.addEventListener('change', () => { codeData.val_a = parseNumericInput(input.value); });
        valSpan.appendChild(input);
        label.appendChild(valSpan);
        label.append(')');
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        valSpan.appendChild(btn);
        if (codeData.input_a != null) { input.value = '^'; input.readOnly = true; }
    } else if (codeData.content === 'change_variable') {
        label.textContent = '';
        label.append('Change ');
        const varSpan = document.createElement('span');
        varSpan.className = 'node-input-container';
        const varSelect = document.createElement('select');
        varSelect.classList.add('node-var-select');
        populateVariableSelect(varSelect, codeData);
        // Default UI selection to public 'i' if available and var not set
        try {
            if (!codeData.var_name) {
                const key = 'pub:i';
                varSelect.value = key;
                if (varSelect.value === key) {
                    codeData.var_name = 'i';
                    codeData.var_instance_only = false;
                }
            }
        } catch(_) {}
        varSelect.addEventListener('change', () => handleVariableSelectChange(varSelect, codeData));
        varSelect.addEventListener('mousedown', (e) => { if (varSelect.value === '__create__') { e.preventDefault(); e.stopPropagation(); handleVariableSelectChange(varSelect, codeData); } });
        varSelect.style.minWidth = '120px';
        varSelect.style.minHeight = '30px';
        varSpan.appendChild(varSelect);
        label.appendChild(varSpan);
        label.append(' by (');
        const valSpan = document.createElement('span');
        valSpan.className = 'node-input-container';
        const input = document.createElement('input');
        input.type = 'number'; input.step = '1';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 1;
        input.value = codeData.val_a;
        input.addEventListener('change', () => { codeData.val_a = parseNumericInput(input.value); });
        valSpan.appendChild(input);
        label.appendChild(valSpan);
        label.append(')');
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        valSpan.appendChild(btn);
        if (codeData.input_a != null) { input.value = '^'; input.readOnly = true; }
    } else if (codeData.content === 'array_append') {
        // Array Append: Array <name> append (value)
        label.textContent = '';
        label.append('Array ');
        const varSpan = document.createElement('span');
        varSpan.className = 'node-input-container';
        const varSelect = document.createElement('select');
        varSelect.classList.add('node-var-select');
        populateArrayVariableSelect(varSelect, codeData);
        try {
            if (!codeData.var_name) {
                const currentObj = objects.find(obj => obj.id == selected_object);
                const last = (currentObj && lastCreatedArrayVariableByObject[currentObj.id]) ? lastCreatedArrayVariableByObject[currentObj.id] : lastCreatedArrayVariable;
                if (last && last.name) {
                    const key = `${last.isPrivate ? 'priv' : 'pub'}:${last.name}`;
                    varSelect.value = key;
                    if (varSelect.value === key) {
                        codeData.var_name = last.name;
                        codeData.var_instance_only = !!last.isPrivate;
                    }
                }
            }
        } catch(_) {}
        varSelect.addEventListener('change', () => handleArrayVariableSelectChange(varSelect, codeData));
        varSelect.addEventListener('mousedown', (e) => { if (varSelect.value === '__create__') { e.preventDefault(); e.stopPropagation(); handleArrayVariableSelectChange(varSelect, codeData); } });
        varSelect.style.minWidth = '120px';
        varSelect.style.minHeight = '30px';
        varSpan.appendChild(varSelect);
        label.appendChild(varSpan);
        label.append(' append (');
        const valSpan = document.createElement('span');
        valSpan.className = 'node-input-container';
        const input = document.createElement('input');
        input.type = 'text';
        if (typeof codeData.val_a !== 'string' && typeof codeData.val_a !== 'number') codeData.val_a = '';
        input.value = codeData.val_a;
        input.addEventListener('change', () => { codeData.val_a = input.value; });
        valSpan.appendChild(input);
        label.appendChild(valSpan);
        label.append(')');
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        valSpan.appendChild(btn);
        if (codeData.input_a != null) { input.value = '^'; input.readOnly = true; }
    } else if (codeData.content === 'array_insert') {
        // Array Insert: Array <name> insert (value) at (index)
        label.textContent = '';
        label.append('Array ');
        const varSpan = document.createElement('span');
        varSpan.className = 'node-input-container';
        const varSelect = document.createElement('select');
        varSelect.classList.add('node-var-select');
        populateArrayVariableSelect(varSelect, codeData);
        try {
            if (!codeData.var_name) {
                const currentObj = objects.find(obj => obj.id == selected_object);
                const last = (currentObj && lastCreatedArrayVariableByObject[currentObj.id]) ? lastCreatedArrayVariableByObject[currentObj.id] : lastCreatedArrayVariable;
                if (last && last.name) {
                    const key = `${last.isPrivate ? 'priv' : 'pub'}:${last.name}`;
                    varSelect.value = key;
                    if (varSelect.value === key) {
                        codeData.var_name = last.name;
                        codeData.var_instance_only = !!last.isPrivate;
                    }
                }
            }
        } catch(_) {}
        varSelect.addEventListener('change', () => handleArrayVariableSelectChange(varSelect, codeData));
        varSelect.addEventListener('mousedown', (e) => { if (varSelect.value === '__create__') { e.preventDefault(); e.stopPropagation(); handleArrayVariableSelectChange(varSelect, codeData); } });
        varSelect.style.minWidth = '120px';
        varSelect.style.minHeight = '30px';
        varSpan.appendChild(varSelect);
        label.appendChild(varSpan);
        label.append(' insert (');
        const valSpan = document.createElement('span');
        valSpan.className = 'node-input-container';
        const valInput = document.createElement('input');
        valInput.type = 'text';
        if (typeof codeData.val_a !== 'string' && typeof codeData.val_a !== 'number') codeData.val_a = '';
        valInput.value = codeData.val_a;
        valInput.addEventListener('change', () => { codeData.val_a = valInput.value; });
        valSpan.appendChild(valInput);
        label.appendChild(valSpan);
        label.append(') at (');
        const idxSpan = document.createElement('span');
        idxSpan.className = 'node-input-container';
        const idxInput = document.createElement('input');
        idxInput.type = 'number'; idxInput.step = '1';
        if (typeof codeData.val_b !== 'number') codeData.val_b = 0;
        idxInput.value = codeData.val_b;
        idxInput.addEventListener('change', () => { codeData.val_b = parseNumericInput(idxInput.value); });
        idxSpan.appendChild(idxInput);
        label.appendChild(idxSpan);
        label.append(')');
        const btnA = document.createElement('button');
        btnA.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btnA.textContent = '+'; btnA.title = 'Add input (A)';
        btnA.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btnA); });
        btnA.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        valSpan.appendChild(btnA);
        const btnB = document.createElement('button');
        btnB.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-b';
        btnB.textContent = '+'; btnB.title = 'Add input (B)';
        btnB.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'b', btnB); });
        btnB.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'b' };
            attachConnectDragListeners();
            drawConnections();
        });
        idxSpan.appendChild(btnB);
        if (codeData.input_a != null) { valInput.value = '^'; valInput.readOnly = true; }
        if (codeData.input_b != null) { idxInput.value = '^'; idxInput.readOnly = true; }
    } else if (codeData.content === 'array_delete') {
        // Array Delete: Array <name> delete at (index)
        label.textContent = '';
        label.append('Array ');
        const varSpan = document.createElement('span');
        varSpan.className = 'node-input-container';
        const varSelect = document.createElement('select');
        varSelect.classList.add('node-var-select');
        populateArrayVariableSelect(varSelect, codeData);
        try {
            if (!codeData.var_name) {
                const currentObj = objects.find(obj => obj.id == selected_object);
                const last = (currentObj && lastCreatedArrayVariableByObject[currentObj.id]) ? lastCreatedArrayVariableByObject[currentObj.id] : lastCreatedArrayVariable;
                if (last && last.name) {
                    const key = `${last.isPrivate ? 'priv' : 'pub'}:${last.name}`;
                    varSelect.value = key;
                    if (varSelect.value === key) {
                        codeData.var_name = last.name;
                        codeData.var_instance_only = !!last.isPrivate;
                    }
                }
            }
        } catch(_) {}
        varSelect.addEventListener('change', () => handleArrayVariableSelectChange(varSelect, codeData));
        varSelect.addEventListener('mousedown', (e) => { if (varSelect.value === '__create__') { e.preventDefault(); e.stopPropagation(); handleArrayVariableSelectChange(varSelect, codeData); } });
        varSelect.style.minWidth = '120px';
        varSelect.style.minHeight = '30px';
        varSpan.appendChild(varSelect);
        label.appendChild(varSpan);
        label.append(' delete at (');
        const idxSpan = document.createElement('span');
        idxSpan.className = 'node-input-container';
        const idxInput = document.createElement('input');
        idxInput.type = 'number'; idxInput.step = '1';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 0;
        idxInput.value = codeData.val_a;
        idxInput.addEventListener('change', () => { codeData.val_a = parseNumericInput(idxInput.value); });
        idxSpan.appendChild(idxInput);
        label.appendChild(idxSpan);
        label.append(')');
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        idxSpan.appendChild(btn);
        if (codeData.input_a != null) { idxInput.value = '^'; idxInput.readOnly = true; }
    } else if (codeData.content === 'variable') {
        label.textContent = '';
        const varSpan = document.createElement('span');
        varSpan.className = 'node-input-container';
        const varSelect = document.createElement('select');
        varSelect.classList.add('node-var-select');
        populateVariableSelect(varSelect, codeData);
        // Default UI selection to public 'i' if available and var not set
        try {
            if (!codeData.var_name) {
                const key = 'pub:i';
                varSelect.value = key;
                if (varSelect.value === key) {
                    codeData.var_name = 'i';
                    codeData.var_instance_only = false;
                }
            }
        } catch(_) {}
        varSelect.addEventListener('change', () => handleVariableSelectChange(varSelect, codeData));
        varSelect.addEventListener('mousedown', (e) => { if (varSelect.value === '__create__') { e.preventDefault(); e.stopPropagation(); handleVariableSelectChange(varSelect, codeData); } });
        varSelect.style.minWidth = '120px';
        varSelect.style.minHeight = '30px';
        varSpan.appendChild(varSelect);
        label.appendChild(varSpan);
        block.classList.add('node-block-compact');
    } else if (codeData.content === 'array_get') {
        // Array Get: <array>[index]
        label.textContent = '';
        const varSpan = document.createElement('span');
        varSpan.className = 'node-input-container';
        const varSelect = document.createElement('select');
        varSelect.classList.add('node-var-select');
        populateArrayVariableSelect(varSelect, codeData);
        try {
            if (!codeData.var_name) {
                const currentObj = objects.find(obj => obj.id == selected_object);
                const last = (currentObj && lastCreatedArrayVariableByObject[currentObj.id]) ? lastCreatedArrayVariableByObject[currentObj.id] : lastCreatedArrayVariable;
                if (last && last.name) {
                    const key = `${last.isPrivate ? 'priv' : 'pub'}:${last.name}`;
                    varSelect.value = key;
                    if (varSelect.value === key) {
                        codeData.var_name = last.name;
                        codeData.var_instance_only = !!last.isPrivate;
                    }
                }
            }
        } catch(_) {}
        varSelect.addEventListener('change', () => handleArrayVariableSelectChange(varSelect, codeData));
        varSelect.addEventListener('mousedown', (e) => { if (varSelect.value === '__create__') { e.preventDefault(); e.stopPropagation(); handleArrayVariableSelectChange(varSelect, codeData); } });
        varSelect.style.minWidth = '120px';
        varSelect.style.minHeight = '30px';
        varSpan.appendChild(varSelect);
        label.appendChild(varSpan);
        label.append('[');
        const idxSpan = document.createElement('span');
        idxSpan.className = 'node-input-container';
        const idxInput = document.createElement('input');
        idxInput.type = 'number'; idxInput.step = '1';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 0;
        idxInput.value = codeData.val_a;
        idxInput.addEventListener('change', () => { codeData.val_a = parseNumericInput(idxInput.value); });
        idxSpan.appendChild(idxInput);
        label.appendChild(idxSpan);
        label.append(']');
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        idxSpan.appendChild(btn);
        if (codeData.input_a != null) { idxInput.value = '^'; idxInput.readOnly = true; }
        block.classList.add('node-block-compact');
    } else if (codeData.content === 'array_length') {
        // Array Length: len(array)
        label.textContent = '';
        label.append('Len(');
        const varSpan = document.createElement('span');
        varSpan.className = 'node-input-container';
        const varSelect = document.createElement('select');
        varSelect.classList.add('node-var-select');
        populateArrayVariableSelect(varSelect, codeData);
        try {
            if (!codeData.var_name) {
                const currentObj = objects.find(obj => obj.id == selected_object);
                const last = (currentObj && lastCreatedArrayVariableByObject[currentObj.id]) ? lastCreatedArrayVariableByObject[currentObj.id] : lastCreatedArrayVariable;
                if (last && last.name) {
                    const key = `${last.isPrivate ? 'priv' : 'pub'}:${last.name}`;
                    varSelect.value = key;
                    if (varSelect.value === key) {
                        codeData.var_name = last.name;
                        codeData.var_instance_only = !!last.isPrivate;
                    }
                }
            }
        } catch(_) {}
        varSelect.addEventListener('change', () => handleArrayVariableSelectChange(varSelect, codeData));
        varSelect.addEventListener('mousedown', (e) => { if (varSelect.value === '__create__') { e.preventDefault(); e.stopPropagation(); handleArrayVariableSelectChange(varSelect, codeData); } });
        varSelect.style.minWidth = '120px';
        varSelect.style.minHeight = '30px';
        varSpan.appendChild(varSelect);
        label.appendChild(varSpan);
        label.append(')');
        block.classList.add('node-block-compact');
    } else if (codeData.content === 'image_name') {
        label.textContent = 'ImageName';
        block.classList.add('node-block-compact');
    } else if (codeData.content === 'not') {
        // not [A]
        label.textContent = '';
        label.append('not ');
        const aSpan = document.createElement('span');
        aSpan.className = 'node-input-container';
        const aInput = document.createElement('input');
        aInput.type = 'number'; aInput.step = '1';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 0;
        aInput.value = codeData.val_a;
        aInput.addEventListener('change', () => { codeData.val_a = parseNumericInput(aInput.value); });
        aSpan.appendChild(aInput);
        label.appendChild(aSpan);
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        aSpan.appendChild(btn);
        if (codeData.input_a != null) { aInput.value = '^'; aInput.readOnly = true; }
        block.classList.add('node-block-slim');
        block.classList.add('node-block-compact');
    } else if (codeData.content === 'delete_instance') {
        label.textContent = 'Delete Instance';
    } else if (codeData.content === 'distance_to') {
        // Distance To ( [x] , [y] )
        label.textContent = '';
        label.append('Distance To (');
        const aSpan = document.createElement('span');
        aSpan.className = 'node-input-container';
        const aInput = document.createElement('input');
        aInput.type = 'number'; aInput.step = '1';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 0;
        aInput.value = codeData.val_a;
        aInput.addEventListener('change', () => { codeData.val_a = parseNumericInput(aInput.value); });
        aSpan.appendChild(aInput);
        label.appendChild(aSpan);
        label.append(', ');
        const bSpan = document.createElement('span');
        bSpan.className = 'node-input-container';
        const bInput = document.createElement('input');
        bInput.type = 'number'; bInput.step = '1';
        if (typeof codeData.val_b !== 'number') codeData.val_b = 0;
        bInput.value = codeData.val_b;
        bInput.addEventListener('change', () => { codeData.val_b = parseNumericInput(bInput.value); });
        bSpan.appendChild(bInput);
        label.appendChild(bSpan);
        label.append(')');

        const addInputPlus = (containerEl, which) => {
            const btn = document.createElement('button');
            btn.className = `node-plus-btn node-input-plus-btn node-input-plus-btn-${which}`;
            btn.textContent = '+'; btn.title = `Add input (${which.toUpperCase()})`;
            btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, which, btn); });
            btn.addEventListener('mousedown', (e) => {
                e.stopPropagation(); e.preventDefault();
                if (isConnecting) return;
                if (!getCodeScrollContainer()) return;
                setConnectMouseFromClientEvent(e);
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which };
                attachConnectDragListeners();
                drawConnections();
            });
            containerEl.appendChild(btn);
        };
        addInputPlus(aSpan, 'a');
        addInputPlus(bSpan, 'b');
        if (codeData.input_a != null) { aInput.value = '^'; aInput.readOnly = true; }
        if (codeData.input_b != null) { bInput.value = '^'; bInput.readOnly = true; }
    } else if (codeData.content === 'print') {
        // Print ( [value] )
        label.textContent = '';
        label.append('Print (');
        const aSpan = document.createElement('span');
        aSpan.className = 'node-input-container';
        const aInput = document.createElement('input');
        aInput.type = 'text';
        if (typeof codeData.val_a !== 'string' && typeof codeData.val_a !== 'number') codeData.val_a = '';
        aInput.value = codeData.val_a;
        aInput.addEventListener('change', () => { codeData.val_a = aInput.value; });
        aSpan.appendChild(aInput);
        label.appendChild(aSpan);
        label.append(')');
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            if (!getCodeScrollContainer()) return;
            setConnectMouseFromClientEvent(e);
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            attachConnectDragListeners();
            drawConnections();
        });
        aSpan.appendChild(btn);
        if (codeData.input_a != null) { aInput.value = '^'; aInput.readOnly = true; }
    } else if (codeData.content === 'equals' || codeData.content === 'less_than' || codeData.content === 'and' || codeData.content === 'or') {
        // [A] = [B] -> number 0/1
        label.textContent = '';
        const aSpan = document.createElement('span');
        aSpan.className = 'node-input-container';
        const aInput = document.createElement('input');
        aInput.type = 'text';
        if (codeData.val_a === undefined) codeData.val_a = 0;
        aInput.value = codeData.val_a;
        aInput.addEventListener('change', () => { codeData.val_a = aInput.value; });
        aSpan.appendChild(aInput);
        label.appendChild(aSpan);
        label.append(
            codeData.content === 'less_than'
                ? ' < '
                : (codeData.content === 'equals' ? ' = ' : (codeData.content === 'and' ? ' and ' : ' or '))
        );
        const bSpan = document.createElement('span');
        bSpan.className = 'node-input-container';
        const bInput = document.createElement('input');
        bInput.type = 'text';
        if (codeData.val_b === undefined) codeData.val_b = 0;
        bInput.value = codeData.val_b;
        bInput.addEventListener('change', () => { codeData.val_b = bInput.value; });
        bSpan.appendChild(bInput);
        label.appendChild(bSpan);
        const addInputPlus = (containerEl, which) => {
            const btn = document.createElement('button');
            btn.className = `node-plus-btn node-input-plus-btn node-input-plus-btn-${which}`;
            btn.textContent = '+'; btn.title = `Add input (${which.toUpperCase()})`;
            btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, which, btn); });
            btn.addEventListener('mousedown', (e) => {
                e.stopPropagation(); e.preventDefault();
                if (isConnecting) return;
                if (!getCodeScrollContainer()) return;
                setConnectMouseFromClientEvent(e);
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which };
                attachConnectDragListeners();
                drawConnections();
            });
            containerEl.appendChild(btn);
        };
        addInputPlus(aSpan, 'a');
        addInputPlus(bSpan, 'b');
        if (codeData.input_a != null) { aInput.value = '^'; aInput.readOnly = true; }
        if (codeData.input_b != null) { bInput.value = '^'; bInput.readOnly = true; }
        block.classList.add('node-block-compact');
    } else if (codeData.content === 'random_int') {
        if (codeData.input_a == null && typeof codeData.val_a !== 'number') codeData.val_a = 0;
        if (codeData.input_b == null && typeof codeData.val_b !== 'number') codeData.val_b = 10;
        label.textContent = '';
        label.append('Random int (');
        const aSpan = document.createElement('span');
        aSpan.className = 'node-input-container';
        const aInput = document.createElement('input');
        aInput.type = 'number';
        aInput.step = '1';
        aInput.title = 'Min (inclusive)';
        aInput.value = codeData.val_a;
        aInput.addEventListener('change', () => { codeData.val_a = parseNumericInput(aInput.value); });
        aSpan.appendChild(aInput);
        label.appendChild(aSpan);
        label.append(', ');
        const bSpan = document.createElement('span');
        bSpan.className = 'node-input-container';
        const bInput = document.createElement('input');
        bInput.type = 'number';
        bInput.step = '1';
        bInput.title = 'Max (inclusive)';
        bInput.value = codeData.val_b;
        bInput.addEventListener('change', () => { codeData.val_b = parseNumericInput(bInput.value); });
        bSpan.appendChild(bInput);
        label.appendChild(bSpan);
        label.append(') inclusive');

        const addInputPlus = (containerEl, which) => {
            const btn = document.createElement('button');
            btn.className = `node-plus-btn node-input-plus-btn node-input-plus-btn-${which}`;
            btn.textContent = '+';
            btn.title = `Wire ${which === 'b' ? 'max' : 'min'} from another block`;
            btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, which, btn); });
            btn.addEventListener('mousedown', (e) => {
                e.stopPropagation(); e.preventDefault();
                if (isConnecting) return;
                if (!getCodeScrollContainer()) return;
                setConnectMouseFromClientEvent(e);
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex', '0'); try { nodeWindow.focus(); } catch (_) {} }
                clearMenuDocHandlers();
                isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which };
                attachConnectDragListeners();
                drawConnections();
            });
            containerEl.appendChild(btn);
        };
        addInputPlus(aSpan, 'a');
        addInputPlus(bSpan, 'b');

        aInput.value = codeData.val_a;
        bInput.value = codeData.val_b;
        if (codeData.input_a != null) { aInput.value = '^'; aInput.readOnly = true; }
        if (codeData.input_b != null) { bInput.value = '^'; bInput.readOnly = true; }
        block.classList.add('node-block-compact');
        block.classList.add('node-block-random-int');
    } else {
        label.textContent = codeData.content;
    }

    // Point Towards (x,y) UI and inputs
    if (codeData.content === 'point_towards') {
        // Label skeleton: Point Towards ( [x] , [y] )
        label.textContent = '';
        label.append('Point Towards (');
        const xSpan = document.createElement('span');
        xSpan.className = 'node-input-container';
        const xInput = document.createElement('input');
        xInput.type = 'number'; xInput.step = '1';
        if (typeof codeData.val_a !== 'number') codeData.val_a = 0;
        xInput.value = codeData.val_a;
        xInput.addEventListener('change', () => { codeData.val_a = parseNumericInput(xInput.value); });
        xSpan.appendChild(xInput);
        label.appendChild(xSpan);
        label.append(', ');
        const ySpan = document.createElement('span');
        ySpan.className = 'node-input-container';
        const yInput = document.createElement('input');
        yInput.type = 'number'; yInput.step = '1';
        if (typeof codeData.val_b !== 'number') codeData.val_b = 0;
        yInput.value = codeData.val_b;
        yInput.addEventListener('change', () => { codeData.val_b = parseNumericInput(yInput.value); });
        ySpan.appendChild(yInput);
        label.appendChild(ySpan);
        label.append(')');

        const addInputPlus = (containerEl, which) => {
            const btn = document.createElement('button');
            btn.className = `node-plus-btn node-input-plus-btn node-input-plus-btn-${which}`;
            btn.textContent = '+'; btn.title = `Add input (${which.toUpperCase()})`;
            btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, which, btn); });
            btn.addEventListener('mousedown', (e) => {
                e.stopPropagation(); e.preventDefault();
                if (isConnecting) return;
                if (!getCodeScrollContainer()) return;
                setConnectMouseFromClientEvent(e);
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true; connectStartTime = Date.now();
                connectFromInput = { blockId: codeData.id, which };
                attachConnectDragListeners();
                drawConnections();
            });
            containerEl.appendChild(btn);
        };
        addInputPlus(xSpan, 'a');
        addInputPlus(ySpan, 'b');
        if (codeData.input_a != null) { xInput.value = '^'; xInput.readOnly = true; }
        if (codeData.input_b != null) { yInput.value = '^'; yInput.readOnly = true; }
    }
    block.appendChild(label);

    // For value blocks, add a bottom output anchor for drawing connections
    if (codeData.type === 'value') {
        const out = document.createElement('div');
        out.className = 'node-output-anchor';
        block.appendChild(out);
    }

    // Close (X) button for non-start blocks
    if (codeData.type !== 'start') {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'node-close-btn';
        closeBtn.textContent = '×';
        closeBtn.title = 'Delete block';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const selectedObj = objects.find(obj => obj.id == selected_object);
            if (!selectedObj) return;
            removeCodeBlockFromObject(selectedObj, codeData.id);
            rebuildCodeMaps();
            updateWorkspace();
        });
        block.appendChild(closeBtn);
    }

    // Plus buttons: only add B for repeat blocks; start and others only A
    const addPlusA = () => {
        const plusBtnA = document.createElement('button');
        plusBtnA.className = 'node-plus-btn node-plus-btn-a';
        plusBtnA.textContent = '+';
        plusBtnA.title = 'Add block (A)';
        plusBtnA.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            showAddBlockMenu(block, codeData, 'a');
        });
        // drag from A to connect to another block's top
        plusBtnA.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            // Prevent starting a new drag if one is already in progress
            if (isConnecting) {
                console.log('Drag already in progress, ignoring mousedown');
                return;
            }
            // Ensure we have a valid selected object
            const currentSelectedObj = objects.find(obj => obj.id == selected_object);
            if (!currentSelectedObj) {
                console.log('Cannot start drag - no valid selected object');
                return;
            }
            startConnectFromNext(codeData.id, 'a');
        });
        block.appendChild(plusBtnA);
    };
    const addPlusB = () => {
        const plusBtnB = document.createElement('button');
        plusBtnB.className = 'node-plus-btn node-plus-btn-b';
        plusBtnB.textContent = '+';
        plusBtnB.title = 'Add block (B)';
        plusBtnB.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            showAddBlockMenu(block, codeData, 'b');
        });
        plusBtnB.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            // Prevent starting a new drag if one is already in progress
            if (isConnecting) {
                console.log('Drag already in progress, ignoring mousedown');
                return;
            }
            // Ensure we have a valid selected object
            const currentSelectedObj = objects.find(obj => obj.id == selected_object);
            if (!currentSelectedObj) {
                console.log('Cannot start drag - no valid selected object');
                return;
            }
            startConnectFromNext(codeData.id, 'b');
        });
        block.appendChild(plusBtnB);
    };

    // Start block: only A; value blocks do not have next-block plus by default
    if (codeData.type === 'start') {
        addPlusA();
    } else if (codeData.type !== 'value') {
        // Repeat block: A + B; If block: A + B; others: only A
        addPlusA();
        if (codeData.content === 'repeat' || codeData.content === 'if') addPlusB();
    }

    // Inputs for move_xy (with per-input plus anchored to container)
    if (codeData.content === "move_xy") {
        // X input
        const xInput = document.createElement("input");
        xInput.type = "number";
        xInput.step = "1";
        xInput.value = (typeof codeData.val_a === 'number' ? codeData.val_a : 0);
        xInput.addEventListener("change", () => {
            codeData.val_a = parseNumericInput(xInput.value);
        });
        label.children[0].appendChild(xInput);
        // Y input
        const yInput = document.createElement("input");
        yInput.type = "number";
        yInput.step = "1";
        yInput.value = (typeof codeData.val_b === 'number' ? codeData.val_b : 0);
        yInput.addEventListener("change", () => {
            codeData.val_b = parseNumericInput(yInput.value);
        });
        label.children[1].appendChild(yInput);

        // plus buttons above each input
        const addInputPlus = (containerEl, which) => {
            const btn = document.createElement('button');
            btn.className = `node-plus-btn node-input-plus-btn node-input-plus-btn-${which}`;
            btn.textContent = '+';
            btn.title = `Add input (${which.toUpperCase()})`;
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); e.preventDefault();
                showAddInputBlockMenu(block, codeData, which, btn);
            });
            // Drag from input-plus to connect to a provider
            btn.addEventListener('mousedown', (e) => {
                e.stopPropagation(); e.preventDefault();
                // Prevent starting a new drag if one is already in progress
                if (isConnecting) {
                    console.log('Drag already in progress, ignoring mousedown');
                    return;
                }

                if (!getCodeScrollContainer()) return;
                setConnectMouseFromClientEvent(e);

                // Ensure canvas has focus and no lingering menu handlers intercept events
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();

                isConnecting = true;
                connectStartTime = Date.now();
                connectFromInput = { blockId: codeData.id, which };
                attachConnectDragListeners();
                drawConnections();
            });
            containerEl.appendChild(btn);
        };
        addInputPlus(label.children[0], 'a');
        addInputPlus(label.children[1], 'b');
        if (codeData.input_a != null) { xInput.value = '^'; xInput.readOnly = true; }
        if (codeData.input_b != null) { yInput.value = '^'; yInput.readOnly = true; }
    }

    // Inputs for rotate (single input with plus)
    if (codeData.content === "rotate") {
        const rotInput = document.createElement("input");
        rotInput.type = "number";
        rotInput.step = "1";
        rotInput.value = (typeof codeData.val_a === 'number' ? codeData.val_a : 5);
        rotInput.addEventListener("change", () => {
            codeData.val_a = parseNumericInput(rotInput.value);
        });
        label.children[0].appendChild(rotInput);
        if (codeData.input_a != null) { rotInput.value = '^'; rotInput.readOnly = true; }
    }

    // Single-input actions: add plus above the input container
    if (codeData.content === 'wait') {
        const container = label.querySelector('.node-input-container');
        if (container) {
            const btn = document.createElement('button');
            btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
            btn.textContent = '+';
            btn.title = 'Add input (A)';
            btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
            // Drag from input-plus to connect to a provider
            btn.addEventListener('mousedown', (e) => {
                e.stopPropagation(); e.preventDefault();
                // Prevent multiple simultaneous drag operations
                if (isConnecting) return;

                // Ensure we have a valid selected object
                const currentSelectedObj = objects.find(obj => obj.id == selected_object);
                if (!currentSelectedObj) {
                    console.log('Cannot start drag - no valid selected object');
                    return;
                }

                if (!getCodeScrollContainer()) return;
                setConnectMouseFromClientEvent(e);
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true;
                connectStartTime = Date.now();
                connectFromInput = { blockId: codeData.id, which: 'a' };
                attachConnectDragListeners();
                drawConnections();
            });
            container.appendChild(btn);
        }
    }
    if (codeData.content === 'repeat') {
        const container = label.querySelector('.node-input-container');
        if (container) {
            const btn = document.createElement('button');
            btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
            btn.textContent = '+';
            btn.title = 'Add input (A)';
            btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
            // Drag from input-plus to connect to a provider
            btn.addEventListener('mousedown', (e) => {
                e.stopPropagation(); e.preventDefault();
                // Prevent multiple simultaneous drag operations
                if (isConnecting) return;

                // Ensure we have a valid selected object
                const currentSelectedObj = objects.find(obj => obj.id == selected_object);
                if (!currentSelectedObj) {
                    console.log('Cannot start drag - no valid selected object');
                    return;
                }

                if (!getCodeScrollContainer()) return;
                setConnectMouseFromClientEvent(e);
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true;
                connectStartTime = Date.now();
                connectFromInput = { blockId: codeData.id, which: 'a' };
                attachConnectDragListeners();
                drawConnections();
            });
            container.appendChild(btn);
        }
    }
    if (codeData.content === 'rotate') {
        const container = label.querySelector('.node-input-container');
        if (container) {
            const btn = document.createElement('button');
            btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
            btn.textContent = '+';
            btn.title = 'Add input (A)';
            btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
            // Drag from input-plus to connect to a provider
            btn.addEventListener('mousedown', (e) => {
                e.stopPropagation(); e.preventDefault();
                // Prevent multiple simultaneous drag operations
                if (isConnecting) return;

                // Ensure we have a valid selected object
                const currentSelectedObj = objects.find(obj => obj.id == selected_object);
                if (!currentSelectedObj) {
                    console.log('Cannot start drag - no valid selected object');
                    return;
                }

                if (!getCodeScrollContainer()) return;
                setConnectMouseFromClientEvent(e);
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true;
                connectStartTime = Date.now();
                connectFromInput = { blockId: codeData.id, which: 'a' };
                attachConnectDragListeners();
                drawConnections();
            });
            container.appendChild(btn);
        }
    }

    // (Input-plus buttons are added per-input container above)
    // Helper: variable select population and creation flow
    function getAppController() {
        return objects.find(o => o.type === 'controller' || o.name === 'AppController');
    }
    function ensureVarArrays(obj) {
        if (!obj.variables) obj.variables = [];
    }
    function ensureArrayVarArrays(obj) {
        if (!obj.arrayVariables) obj.arrayVariables = [];
    }
    function populateVariableSelect(selectEl, codeDataRef) {
        const currentObj = objects.find(obj => obj.id == selected_object);
        const app = getAppController();
        if (!currentObj) return;
        ensureVarArrays(currentObj);
        if (app) ensureVarArrays(app);
        selectEl.innerHTML = '';
        // Public (App) variables first
        if (app && app.variables && app.variables.length) {
            const groupPub = document.createElement('optgroup');
            groupPub.label = 'Public';
            app.variables.forEach(name => {
                const opt = document.createElement('option');
                opt.value = `pub:${name}`; opt.textContent = name; groupPub.appendChild(opt);
            });
            selectEl.appendChild(groupPub);
        }
        // Private (object) variables
        if (currentObj.variables && currentObj.variables.length) {
            const groupPriv = document.createElement('optgroup');
            groupPriv.label = 'Private (this object)';
            currentObj.variables.forEach(name => {
                const opt = document.createElement('option');
                opt.value = `priv:${name}`; opt.textContent = name; groupPriv.appendChild(opt);
            });
            selectEl.appendChild(groupPriv);
        }
        const createOpt = document.createElement('option');
        createOpt.value = '__create__'; createOpt.textContent = 'New variable…';
        selectEl.appendChild(createOpt);
        // Initialize selection from codeDataRef
        if (codeDataRef.var_name) {
            const isPriv = !!codeDataRef.var_instance_only;
            const key = `${isPriv ? 'priv' : 'pub'}:${codeDataRef.var_name}`;
            selectEl.value = key;
            if (selectEl.value !== key) selectEl.value = '__create__';
        } else {
            selectEl.value = '__create__';
        }
    }
    function openCreateVariableModal(onCreate, hideInstanceToggle, titleText = 'Create Variable') {
        // Remove any existing modal to avoid duplicates
        const existing = document.getElementById('__var_modal');
        if (existing) { try { document.body.removeChild(existing); } catch {} }

        // Build lightweight modal
        const overlay = document.createElement('div');
        overlay.id = '__var_modal';
        overlay.className = 'modal-overlay';
        const panel = document.createElement('div');
        panel.className = 'modal-panel';
        const title = document.createElement('div');
        title.className = 'modal-title';
        title.textContent = titleText;
        const nameLabel = document.createElement('div');
        nameLabel.className = 'modal-field-label';
        nameLabel.textContent = 'Name';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'score';
        nameInput.className = 'modal-input';
        const scopeRow = document.createElement('label');
        scopeRow.className = 'modal-scope-row';
        const scopeCb = document.createElement('input');
        scopeCb.type = 'checkbox';
        const scopeText = document.createElement('span');
        scopeText.textContent = 'For this instance only';
        scopeRow.appendChild(scopeCb); scopeRow.appendChild(scopeText);
        if (hideInstanceToggle) scopeRow.style.display = 'none';
        const btnRow = document.createElement('div');
        btnRow.className = 'modal-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.className = 'ui-btn-secondary';
        const createBtn = document.createElement('button');
        createBtn.type = 'button';
        createBtn.textContent = 'Create';
        createBtn.className = 'ui-btn-primary';
        btnRow.appendChild(cancelBtn); btnRow.appendChild(createBtn);
        panel.appendChild(title); panel.appendChild(nameLabel); panel.appendChild(nameInput); panel.appendChild(scopeRow); panel.appendChild(btnRow);
        overlay.appendChild(panel);

        function handleKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); close(); }
            if (e.key === 'Enter') { e.preventDefault(); createBtn.click(); }
        }
        function close() {
            try {
                window.removeEventListener('keydown', handleKey, true);
                document.body.removeChild(overlay);
            } catch {}
        }
        cancelBtn.addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        createBtn.addEventListener('click', () => {
            const raw = (nameInput.value || '').trim();
            if (!raw) { nameInput.focus(); return; }
            // Prevent double-submits
            createBtn.disabled = true;
            const instanceOnly = !!scopeCb.checked;
            // Close first to guarantee overlay removal even if onCreate throws
            close();
            // Defer onCreate slightly so UI can tear down cleanly
            setTimeout(() => {
                try { onCreate(raw, instanceOnly); } catch (e) { console.warn('Variable create handler error', e); }
            }, 0);
        });
        document.body.appendChild(overlay);
        window.addEventListener('keydown', handleKey, true);
        setTimeout(() => nameInput.focus(), 0);
    }
    function handleVariableSelectChange(selectEl, codeDataRef) {
        const currentObj = objects.find(obj => obj.id == selected_object);
        const app = getAppController();
        if (!currentObj) return;
        if (selectEl.value === '__create__') {
            const isAppController = !!(currentObj && (currentObj.type === 'controller' || currentObj.name === 'AppController'));
            openCreateVariableModal((name, instanceOnly) => {
                if (isAppController) {
                    // AppManager cannot create instance-only
                    instanceOnly = false;
                }
                if (instanceOnly) {
                    ensureVarArrays(currentObj);
                    if (!currentObj.variables.includes(name)) currentObj.variables.push(name);
                    codeDataRef.var_name = name;
                    codeDataRef.var_instance_only = true;
                    // Track last created private variable per object
                    try { lastCreatedVariableByObject[currentObj.id] = { name, isPrivate: true }; } catch(_) {}
                } else {
                    const appObj = app || currentObj; // fallback to current if no app found
                    ensureVarArrays(appObj);
                    if (!appObj.variables.includes(name)) appObj.variables.push(name);
                    codeDataRef.var_name = name;
                    codeDataRef.var_instance_only = false;
                    // Track last created public variable globally
                    try { lastCreatedPublicVariable = { name, isPrivate: false }; } catch(_) {}
                }
                // Remember globally so newly created blocks also default to it
                lastCreatedVariable = { name: codeDataRef.var_name, isPrivate: !!codeDataRef.var_instance_only };
                populateVariableSelect(selectEl, codeDataRef);
                const key = `${codeDataRef.var_instance_only ? 'priv' : 'pub'}:${codeDataRef.var_name}`;
                selectEl.value = key;
                updateWorkspace();
            }, isAppController, 'Create Variable');
        } else {
            // Parse selection key
            const [scope, name] = selectEl.value.split(':');
            codeDataRef.var_name = name || '';
            codeDataRef.var_instance_only = (scope === 'priv');
        }
    }

    function populateArrayVariableSelect(selectEl, codeDataRef) {
        const currentObj = objects.find(obj => obj.id == selected_object);
        const app = getAppController();
        if (!currentObj) return;
        ensureArrayVarArrays(currentObj);
        if (app) ensureArrayVarArrays(app);
        selectEl.innerHTML = '';
        // Public (App) arrays first
        if (app && app.arrayVariables && app.arrayVariables.length) {
            const groupPub = document.createElement('optgroup');
            groupPub.label = 'Public Arrays';
            app.arrayVariables.forEach(name => {
                const opt = document.createElement('option');
                opt.value = `pub:${name}`; opt.textContent = name; groupPub.appendChild(opt);
            });
            selectEl.appendChild(groupPub);
        }
        // Private (object) arrays
        if (currentObj.arrayVariables && currentObj.arrayVariables.length) {
            const groupPriv = document.createElement('optgroup');
            groupPriv.label = 'Private Arrays (this object)';
            currentObj.arrayVariables.forEach(name => {
                const opt = document.createElement('option');
                opt.value = `priv:${name}`; opt.textContent = name; groupPriv.appendChild(opt);
            });
            selectEl.appendChild(groupPriv);
        }
        const createOpt = document.createElement('option');
        createOpt.value = '__create__'; createOpt.textContent = 'New array…';
        selectEl.appendChild(createOpt);
        // Initialize selection from codeDataRef
        if (codeDataRef.var_name) {
            const isPriv = !!codeDataRef.var_instance_only;
            const key = `${isPriv ? 'priv' : 'pub'}:${codeDataRef.var_name}`;
            selectEl.value = key;
            if (selectEl.value !== key) selectEl.value = '__create__';
        } else {
            selectEl.value = '__create__';
        }
    }
    function handleArrayVariableSelectChange(selectEl, codeDataRef) {
        const currentObj = objects.find(obj => obj.id == selected_object);
        const app = getAppController();
        if (!currentObj) return;
        if (selectEl.value === '__create__') {
            const isAppController = !!(currentObj && (currentObj.type === 'controller' || currentObj.name === 'AppController'));
            openCreateVariableModal((name, instanceOnly) => {
                if (isAppController) {
                    // AppManager cannot create instance-only
                    instanceOnly = false;
                }
                if (instanceOnly) {
                    ensureArrayVarArrays(currentObj);
                    if (!currentObj.arrayVariables.includes(name)) currentObj.arrayVariables.push(name);
                    codeDataRef.var_name = name;
                    codeDataRef.var_instance_only = true;
                    try { lastCreatedArrayVariableByObject[currentObj.id] = { name, isPrivate: true }; } catch(_) {}
                } else {
                    const appObj = app || currentObj;
                    ensureArrayVarArrays(appObj);
                    if (!appObj.arrayVariables.includes(name)) appObj.arrayVariables.push(name);
                    codeDataRef.var_name = name;
                    codeDataRef.var_instance_only = false;
                }
                lastCreatedArrayVariable = { name: codeDataRef.var_name, isPrivate: !!codeDataRef.var_instance_only };
                populateArrayVariableSelect(selectEl, codeDataRef);
                const key = `${codeDataRef.var_instance_only ? 'priv' : 'pub'}:${codeDataRef.var_name}`;
                selectEl.value = key;
                updateWorkspace();
            }, isAppController, 'Create Array');
        } else {
            const [scope, name] = selectEl.value.split(':');
            codeDataRef.var_name = name || '';
            codeDataRef.var_instance_only = (scope === 'priv');
        }
    }

    // Desktop mouse events — selection, multi-drag, drag threshold
    block.addEventListener("mousedown", (e) => {
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        if (tag === 'select' || tag === 'input' || tag === 'button' || e.target.closest('select') || e.target.closest('button')) {
            return;
        }
        if (codeData.type === 'value' && e.target.closest && e.target.closest('.node-output-anchor')) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const selectedObj = objects.find(obj => obj.id == selected_object);
        if (!selectedObj) return;
        syncCodeSelectionOwnership(selectedObj);
        const id = codeData.id;
        if (e.shiftKey) {
            if (selectedCodeBlockIds.has(id)) selectedCodeBlockIds.delete(id);
            else selectedCodeBlockIds.add(id);
            applyCodeBlockSelectionClasses();
            return;
        }
        if (!selectedCodeBlockIds.has(id)) {
            selectedCodeBlockIds.clear();
            selectedCodeBlockIds.add(id);
            applyCodeBlockSelectionClasses();
        }
        const layer = document.getElementById('code-zoom-layer');
        const entries = [];
        for (const cid of selectedCodeBlockIds) {
            const el = layer ? layer.querySelector(`[data-code-id="${cid}"]`) : null;
            if (!el) continue;
            entries.push({
                el,
                baseX: parseFloat(el.style.left) || 0,
                baseY: parseFloat(el.style.top) || 0
            });
        }
        if (entries.length === 0) return;
        pendingDragGroup = { entries, clientX: e.clientX, clientY: e.clientY };
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        document.addEventListener("mousemove", handleCodeBlockDragMouseMove);
        document.addEventListener("mouseup", handleCodeBlockDragMouseUp);
    });

    // Mobile touch events
    block.addEventListener("touchstart", (e) => {
        const t = e.target;
        const tag = (t && t.tagName) ? t.tagName.toLowerCase() : '';
        if (tag === 'select' || tag === 'input' || tag === 'button' || t.closest('select') || t.closest('button')) {
            return;
        }
        if (codeData.type === 'value' && t.closest && t.closest('.node-output-anchor')) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const selectedObj = objects.find(obj => obj.id == selected_object);
        if (!selectedObj) return;
        syncCodeSelectionOwnership(selectedObj);
        if (!selectedCodeBlockIds.has(codeData.id)) {
            selectedCodeBlockIds.clear();
            selectedCodeBlockIds.add(id);
            applyCodeBlockSelectionClasses();
        }
        const layer = document.getElementById('code-zoom-layer');
        const entries = [];
        for (const cid of selectedCodeBlockIds) {
            const el = layer ? layer.querySelector(`[data-code-id="${cid}"]`) : null;
            if (!el) continue;
            entries.push({
                el,
                baseX: parseFloat(el.style.left) || 0,
                baseY: parseFloat(el.style.top) || 0
            });
        }
        if (entries.length === 0) return;
        const touch = e.touches[0];
        pendingDragGroup = { entries, clientX: touch.clientX, clientY: touch.clientY };
        dragStartX = touch.clientX;
        dragStartY = touch.clientY;
        document.addEventListener("touchmove", handleCodeBlockDragTouchMove, { passive: false });
        document.addEventListener("touchend", handleCodeBlockDragTouchEnd);
    });

    // Start drag-to-connect when mousedown on value block output anchor
    if (codeData.type === 'value') {
        const out = () => block.querySelector('.node-output-anchor');
        block.addEventListener('mousedown', (e) => {
            const a = out();
            if (!a) return;
            const r = a.getBoundingClientRect();
            const within = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
            if (within) {
                e.stopPropagation(); e.preventDefault();
                // Prevent starting a new drag if one is already in progress
                if (isConnecting) {
                    console.log('Drag already in progress, ignoring mousedown');
                    return;
                }
                // Ensure we have a valid selected object
                const currentSelectedObj = objects.find(obj => obj.id == selected_object);
                if (!currentSelectedObj) {
                    console.log('Cannot start drag - no valid selected object');
                    return;
                }
                startConnectFromBlock(codeData.id);
            }
        });
        // Touch support
        block.addEventListener('touchstart', (e) => {
            const a = out();
            if (!a) return;
            const t = e.touches[0];
            const r = a.getBoundingClientRect();
            const within = t.clientX >= r.left && t.clientX <= r.right && t.clientY >= r.top && t.clientY <= r.bottom;
            if (within) {
                e.stopPropagation(); e.preventDefault();
                startConnectFromBlock(codeData.id);
            }
        }, { passive: false });
    }

    return block;
}
// Show add-block chooser menu anchored to a block
function showAddBlockMenu(anchorBlock, anchorCodeData, branch, customPosition = null) {
    console.log('showAddBlockMenu called with:', { anchorBlock, anchorCodeData, branch, customPosition });
    closeAnyAddMenus();
    const menu = document.createElement('div');
    menu.className = 'node-add-menu';
    console.log('Created menu element:', menu);
    // Build items
    const addItem = (labelText, typeKey) => {
        const btn = document.createElement('button');
        btn.className = 'node-add-menu-item';
        btn.textContent = labelText;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const selectedObj = objects.find(obj => obj.id == selected_object);
            if (!selectedObj) return;
            insertBlockAfter(selectedObj, anchorCodeData, typeKey, branch === 'b' ? 'b' : 'a', customPosition);
            closeAnyAddMenus();
            // Reset and re-arm drag state so subsequent drags work immediately
            cleanupDragState();
            // Return focus to code canvas so drag-detect works without extra click
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) {
                if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex', '0');
                try { nodeWindow.focus(); } catch (_) {}
            }
            // Ensure there are no lingering menu handlers that could swallow the next mousedown
            clearMenuDocHandlers();
        });
        menu.appendChild(btn);
    };
    // Organized, consistently named action blocks
    // Flow control
    addItem('Repeat', 'repeat');
    addItem('If', 'if');
    addItem('Forever', 'forever');
    addItem('Wait', 'wait');
    // Motion
    addItem('Move By (x, y)', 'move_xy');
    addItem('Move Forward', 'move_forward');
    addItem('Set X', 'set_x');
    addItem('Set Y', 'set_y');
    addItem('Rotate Degrees', 'rotate');
    addItem('Set Rotation', 'set_rotation');
    addItem('Point Towards (x, y)', 'point_towards');
    // Looks / appearance
    addItem('Switch Image', 'switch_image');
    addItem('Start Sound', 'play_sound');
    addItem('Set Size', 'set_size');
    addItem('Change Size By', 'change_size');
    addItem('Set Opacity', 'set_opacity');
    addItem('Set Layer', 'set_layer');
    // Variables
    addItem('Set Variable', 'set_variable');
    addItem('Change Variable By', 'change_variable');
    addItem('Array Append', 'array_append');
    addItem('Array Insert', 'array_insert');
    addItem('Array Delete Index', 'array_delete');
    // Instances
    addItem('Instantiate', 'instantiate');
    addItem('Delete Instance', 'delete_instance');
    // Debug
    addItem('Print', 'print');
    console.log('Menu items added, menu children:', menu.children.length);
    // Position: append within block so CSS absolute positioning can anchor it
    if (customPosition) {
        // For drag-opened: show near mouse using fixed positioning, without changing size
        const scrollHost = getCodeScrollContainer();
        const nodeWindow = document.getElementById('node-window');
        const nodeRect = scrollHost.getBoundingClientRect();
        const absoluteX = nodeRect.left + (customPosition.x - (scrollHost.scrollLeft || 0));
        const absoluteY = nodeRect.top + (customPosition.y - (scrollHost.scrollTop || 0));

        menu.style.position = 'fixed';
        menu.style.left = `${absoluteX}px`;
        menu.style.top = `${absoluteY + 10}px`;
        menu.style.bottom = 'auto';
        menu.style.transform = 'translate(-50%, 0)';

        nodeWindow.appendChild(menu);

        // Clamp to viewport after mount
        requestAnimationFrame(() => {
            try {
                const rect = menu.getBoundingClientRect();
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                let dx = 0;
                let dy = 0;
                if (rect.right > vw - 8) dx = (vw - 8) - rect.right;
                if (rect.left < 8) dx = 8 - rect.left;
                if (rect.bottom > vh - 8) dy = (vh - 8) - rect.bottom;
                if (rect.top < 8) dy = 8 - rect.top;
                if (dx !== 0 || dy !== 0) {
                    const currentLeft = parseFloat(menu.style.left || '0');
                    const currentTop = parseFloat(menu.style.top || '0');
                    menu.style.left = `${currentLeft + dx}px`;
                    menu.style.top = `${currentTop + dy}px`;
                }
            } catch (_) {}
        });
    } else {
        console.log('Appending menu to anchorBlock:', anchorBlock);
        anchorBlock.appendChild(menu);
    }
    // Close menu when clicking elsewhere
    setTimeout(() => {
        function onDocClick(ev) {
            if (!menu.contains(ev.target)) {
                closeAnyAddMenus();
                document.removeEventListener('click', onDocClick, true);
            }
        }
        // Store handler and register centrally so it can't leak
        menu._onDocClick = onDocClick;
        addMenuDocHandler(onDocClick);
    }, 0);
}
// Show add-block chooser menu for input sources (below the button)
function showAddInputBlockMenu(anchorBlock, anchorCodeData, inputKey, anchorBtn, customPosition = null) {
    closeAnyAddMenus();
    const menu = document.createElement('div');
    menu.className = 'node-add-menu';
    // Build items (input-source list)
    const addItem = (labelText, typeKey) => {
        const btn = document.createElement('button');
        btn.className = 'node-add-menu-item';
        btn.textContent = labelText;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const selectedObj = objects.find(obj => obj.id == selected_object);
            if (!selectedObj) return;
            let inputBtnCenterX = null;
            if (!customPosition && anchorBtn && anchorBlock) {
                try {
                    const layer = document.getElementById('code-zoom-layer');
                    const scale = layer ? getLayerUniformScale(layer) : 1;
                    const blockRect = anchorBlock.getBoundingClientRect();
                    const btnRect = anchorBtn.getBoundingClientRect();
                    inputBtnCenterX = (btnRect.left + btnRect.width / 2 - blockRect.left) / scale;
                } catch (_) {}
            }
            insertInputBlockAbove(selectedObj, anchorCodeData, typeKey, inputKey === 'b' ? 'b' : 'a', customPosition, inputBtnCenterX);
            closeAnyAddMenus();
            // Reset and re-arm drag state so subsequent drags work immediately
            cleanupDragState();
            // Return focus to code canvas so drag-detect works without extra click
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) {
                if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex', '0');
                try { nodeWindow.focus(); } catch (_) {}
            }
            // Ensure there are no lingering menu handlers that could swallow the next mousedown
            clearMenuDocHandlers();
        });
        menu.appendChild(btn);
    };
    // Organized: math & data → logic → input → object → sensing
    addItem('Operation (+, -, *, /)', 'operation');
    addItem('Variable', 'variable');
    addItem('Random int', 'random_int');
    addItem('Array Get Item', 'array_get');
    addItem('Array Length', 'array_length');
    addItem('Equals', 'equals');
    addItem('Less Than', 'less_than');
    addItem('and', 'and');
    addItem('or', 'or');
    addItem('Not', 'not');
    addItem('Mouse X', 'mouse_x');
    addItem('Mouse Y', 'mouse_y');
    addItem('Window Width', 'window_width');
    addItem('Window Height', 'window_height');
    addItem('Mouse Down?', 'mouse_pressed');
    addItem('Key Pressed?', 'key_pressed');
    addItem('Object X', 'object_x');
    addItem('Object Y', 'object_y');
    addItem('Rotation', 'rotation');
    addItem('Size', 'size');
    addItem('Image Name', 'image_name');
    addItem('Distance To (x, y)', 'distance_to');
    addItem('Pixel is RGB at (x, y)', 'pixel_is_rgb');
    addItem('Touching', 'touching');
    // Position menu above the specific button if available; else above block
    if (customPosition) {
        // For drag-opened: we'll place via fixed positioning after creation below
    } else if (anchorBtn) {
        // place relative to block but horizontally aligned with button
        const blockRect = anchorBlock.getBoundingClientRect();
        const nodeWindow = document.getElementById('node-window');
        const nodeRect = nodeWindow.getBoundingClientRect();
        const btnRect = anchorBtn.getBoundingClientRect();
        const localX = (btnRect.left - blockRect.left) + (btnRect.width / 2);
        menu.style.left = `${localX}px`;
        // Let CSS handle positioning for consistency
    } else {
        // Let CSS handle positioning for consistency
    }

    if (customPosition) {
        // For drag-opened: show near mouse using fixed positioning, without changing size
        const scrollHost = getCodeScrollContainer();
        const nodeWindow = document.getElementById('node-window');
        const nodeRect = scrollHost.getBoundingClientRect();
        const absoluteX = nodeRect.left + (customPosition.x - (scrollHost.scrollLeft || 0));
        const absoluteY = nodeRect.top + (customPosition.y - (scrollHost.scrollTop || 0));

        menu.style.position = 'fixed';
        menu.style.left = `${absoluteX}px`;
        menu.style.top = `${absoluteY + 10}px`;
        menu.style.bottom = 'auto';
        menu.style.transform = 'translate(-50%, 0)';

        nodeWindow.appendChild(menu);

        // Clamp to viewport after mount
        requestAnimationFrame(() => {
            try {
                const rect = menu.getBoundingClientRect();
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                let dx = 0;
                let dy = 0;
                if (rect.right > vw - 8) dx = (vw - 8) - rect.right;
                if (rect.left < 8) dx = 8 - rect.left;
                if (rect.bottom > vh - 8) dy = (vh - 8) - rect.bottom;
                if (rect.top < 8) dy = 8 - rect.top;
                if (dx !== 0 || dy !== 0) {
                    const currentLeft = parseFloat(menu.style.left || '0');
                    const currentTop = parseFloat(menu.style.top || '0');
                    menu.style.left = `${currentLeft + dx}px`;
                    menu.style.top = `${currentTop + dy}px`;
                }
            } catch (_) {}
        });
    } else {
        console.log('Appending menu to anchorBlock:', anchorBlock);
        anchorBlock.appendChild(menu);
    }
    // Close menu when clicking elsewhere
    setTimeout(() => {
        function onDocClick(ev) {
            if (!menu.contains(ev.target)) {
                closeAnyAddMenus();
                document.removeEventListener('click', onDocClick, true);
            }
        }
        // Store handler and register centrally so it can't leak
        menu._onDocClick = onDocClick;
        addMenuDocHandler(onDocClick);
    }, 0);
}

function closeAnyAddMenus() {
    // Remove any lingering document click handlers attached by menus
    clearMenuDocHandlers();
    document.querySelectorAll('.node-add-menu').forEach(el => {
        try { el._onDocClick = null; } catch (_) {}
        if (el.parentNode) el.parentNode.removeChild(el);
    });
    // Also clean up any leftover temporary blocks
    document.querySelectorAll('[data-temp-block="true"]').forEach(el => {
        if (el.parentNode) el.parentNode.removeChild(el);
    });
}
// Insert a new block after the given anchor block in branch 'a' or 'b'
function insertBlockAfter(selectedObj, anchorCodeData, typeKey, branch, customPosition = null) {
    const existingIds = selectedObj.code.map(b => b.id);
    const newId = (existingIds.length ? Math.max(...existingIds) : 0) + 1;
    const branchKey = branch === 'b' ? 'next_block_b' : 'next_block_a';
    const oldNext = (anchorCodeData && typeof anchorCodeData[branchKey] !== 'undefined') ? anchorCodeData[branchKey] : null;
    const basePosition = customPosition || (anchorCodeData && anchorCodeData.position ? anchorCodeData.position : { x: 20, y: 20 });
    // Drag-to-create passes scroll content coords; block.position is layer-local (unscaled) inside #code-zoom-layer
    const placementPoint = customPosition ? scrollContentToLayerLocal(customPosition) : null;

    let newBlock = {
        id: newId,
        type: 'action',
        location: { x: 0, y: 0 },
        content: typeKey,
        val_a: null,
        val_b: null,
        input_a: null,
        input_b: null,
        next_block_a: oldNext,
        next_block_b: null,
        position: placementPoint ? { x: placementPoint.x, y: placementPoint.y } : { x: basePosition.x, y: basePosition.y + 60 }
    };

    if (typeKey === 'move_xy') {
        newBlock.val_a = 0;
        newBlock.val_b = 0;
    } else if (typeKey === 'wait') {
        // val_a holds seconds
        newBlock.val_a = 1;
    } else if (typeKey === 'repeat') {
        // val_a holds times
        newBlock.val_a = 2;
    } else if (typeKey === 'if') {
        // condition value (0/1)
        newBlock.val_a = 1;
    } else if (typeKey === 'forever') {
        // forever has only next_block_a
        newBlock.val_a = null;
    } else if (typeKey === 'rotate') {
        // val_a holds degrees
        newBlock.val_a = 5;
    } else if (typeKey === 'set_rotation') {
        // val_a holds absolute degrees
        newBlock.val_a = 0;
    } else if (typeKey === 'point_towards') {
        // val_a, val_b hold target X,Y
        newBlock.val_a = 0;
        newBlock.val_b = 0;
    } else if (typeKey === 'move_forward') {
        // val_a holds distance in pixels
        newBlock.val_a = 10;
    } else if (typeKey === 'set_size') {
        newBlock.val_a = 1;
    } else if (typeKey === 'change_size') {
        newBlock.val_a = 0.1;
    } else if (typeKey === 'set_opacity') {
        // val_a holds opacity in [0,1]
        newBlock.val_a = 1;
    } else if (typeKey === 'set_layer') {
        // val_a holds layer number
        newBlock.val_a = 0;
    } else if (typeKey === 'set_x') {
        newBlock.val_a = 0;
    } else if (typeKey === 'set_y') {
        newBlock.val_a = 0;
    } else if (typeKey === 'switch_image') {
        newBlock.val_a = '';
        // Allow input to name/id provider
        newBlock.input_a = null;
    } else if (typeKey === 'play_sound') {
        newBlock.val_a = '';
        newBlock.input_a = null;
    } else if (typeKey === 'instantiate') {
        newBlock.val_a = '';
    } else if (typeKey === 'delete_instance') {
        // no payload needed
        newBlock.val_a = null;
    } else if (typeKey === 'random_int') {
        newBlock.type = 'value';
        newBlock.val_a = 0; // min
        newBlock.val_b = 10; // max
    } else if (typeKey === 'distance_to') {
        newBlock.type = 'value';
        newBlock.val_a = 0;
        newBlock.val_b = 0;
    } else if (typeKey === 'array_get') {
        newBlock.type = 'value';
        newBlock.val_a = 0; // index
        newBlock.var_name = (lastCreatedArrayVariable && lastCreatedArrayVariable.name) ? lastCreatedArrayVariable.name : '';
        newBlock.var_instance_only = !!(lastCreatedArrayVariable && lastCreatedArrayVariable.isPrivate);
    } else if (typeKey === 'array_length') {
        newBlock.type = 'value';
        newBlock.var_name = (lastCreatedArrayVariable && lastCreatedArrayVariable.name) ? lastCreatedArrayVariable.name : '';
        newBlock.var_instance_only = !!(lastCreatedArrayVariable && lastCreatedArrayVariable.isPrivate);
    } else if (typeKey === 'print') {
        newBlock.val_a = '';
    } else if (typeKey === 'not') {
        newBlock.type = 'value';
        newBlock.val_a = 0;
    } else if (typeKey === 'less_than') {
        newBlock.type = 'value';
        newBlock.val_a = 0;
        newBlock.val_b = 0;
    } else if (typeKey === 'set_variable') {
        newBlock.val_a = 0;
        newBlock.var_name = 'i';
        newBlock.var_instance_only = false; // public
    } else if (typeKey === 'change_variable') {
        newBlock.val_a = 1;
        newBlock.var_name = 'i';
        newBlock.var_instance_only = false; // public
    } else if (typeKey === 'array_append') {
        newBlock.val_a = '';
        newBlock.var_name = (lastCreatedArrayVariable && lastCreatedArrayVariable.name) ? lastCreatedArrayVariable.name : '';
        newBlock.var_instance_only = !!(lastCreatedArrayVariable && lastCreatedArrayVariable.isPrivate);
    } else if (typeKey === 'array_insert') {
        newBlock.val_a = '';
        newBlock.val_b = 0;
        newBlock.var_name = (lastCreatedArrayVariable && lastCreatedArrayVariable.name) ? lastCreatedArrayVariable.name : '';
        newBlock.var_instance_only = !!(lastCreatedArrayVariable && lastCreatedArrayVariable.isPrivate);
    } else if (typeKey === 'array_delete') {
        newBlock.val_a = 0;
        newBlock.var_name = (lastCreatedArrayVariable && lastCreatedArrayVariable.name) ? lastCreatedArrayVariable.name : '';
        newBlock.var_instance_only = !!(lastCreatedArrayVariable && lastCreatedArrayVariable.isPrivate);
    }

    // Link anchor -> new -> oldNext on selected branch
    if (anchorCodeData) {
        anchorCodeData[branchKey] = newId;
    }
    selectedObj.code.push(newBlock);

    // For drag-to-create, adjust position to center the block on mouse coordinates
    if (placementPoint) {
        // Create a temporary block to get its dimensions
        const tempBlock = createNodeBlock(newBlock, 0, 0);
        tempBlock.style.visibility = 'hidden';
        tempBlock.style.position = 'absolute';
        document.body.appendChild(tempBlock);

        const blockWidth = tempBlock.offsetWidth;
        const blockHeight = tempBlock.offsetHeight;

        // Center the block on the mouse position
        newBlock.position.x = placementPoint.x - (blockWidth / 2);
        newBlock.position.y = placementPoint.y - (blockHeight / 2);

        // Remove temporary block
        document.body.removeChild(tempBlock);
    }

    // Render the new block and redraw connections
    updateWorkspace();
}

// Insert a new input block above the given anchor block and connect via input_a/input_b
function insertInputBlockAbove(selectedObj, anchorCodeData, typeKey, inputKey, customPosition = null, inputBtnCenterX = null) {
    const existingIds = selectedObj.code.map(b => b.id);
    const newId = (existingIds.length ? Math.max(...existingIds) : 0) + 1;
    const basePosition = customPosition || (anchorCodeData && anchorCodeData.position ? anchorCodeData.position : { x: 20, y: 20 });
    const placementPoint = customPosition ? scrollContentToLayerLocal(customPosition) : null;

    let newBlock = {
        id: newId,
        type: 'value',
        location: { x: 0, y: 0 },
        content: typeKey,
        val_a: null,
        val_b: null,
        input_a: null,
        input_b: null,
        next_block_a: null,
        next_block_b: null,
        position: placementPoint ? { x: placementPoint.x, y: placementPoint.y } : { x: basePosition.x, y: basePosition.y - 60 }
    };

    // Optional defaults for specific input blocks
    if (typeKey === 'operation') {
        newBlock.val_a = '+'; // operator placeholder
    } else if (typeKey === 'variable') {
        newBlock.var_name = 'i';
        newBlock.var_instance_only = false; // public
    } else if (typeKey === 'array_get') {
        newBlock.val_a = 0;
        newBlock.var_name = (lastCreatedArrayVariable && lastCreatedArrayVariable.name) ? lastCreatedArrayVariable.name : '';
        newBlock.var_instance_only = !!(lastCreatedArrayVariable && lastCreatedArrayVariable.isPrivate);
    } else if (typeKey === 'array_length') {
        newBlock.var_name = (lastCreatedArrayVariable && lastCreatedArrayVariable.name) ? lastCreatedArrayVariable.name : '';
        newBlock.var_instance_only = !!(lastCreatedArrayVariable && lastCreatedArrayVariable.isPrivate);
    } else if (typeKey === 'and') {
        // two-operand logical AND input block; default 0, 0
        newBlock.val_a = 0;
        newBlock.val_b = 0;
    } else if (typeKey === 'or') {
        // two-operand logical OR input block; default 0, 0
        newBlock.val_a = 0;
        newBlock.val_b = 0;
    } else if (typeKey === 'pixel_is_rgb') {
        // Pixel is RGB at (x,y)
        newBlock.val_a = 0; // x (world coords)
        newBlock.val_b = 0; // y (world coords)
        newBlock.rgb_r = 0;
        newBlock.rgb_g = 0;
        newBlock.rgb_b = 0;
    } else if (typeKey === 'touching') {
        newBlock.touching_mode = 'object';
        const instList = objects.filter(o => o.name !== 'AppController');
        newBlock.val_a = instList[0] ? String(instList[0].id) : '';
        newBlock.rgb_r = 0;
        newBlock.rgb_g = 0;
        newBlock.rgb_b = 0;
    } else if (typeKey === 'random_int') {
        newBlock.val_a = 0;
        newBlock.val_b = 10;
    }

    // Connect anchor block's input
    const key = inputKey === 'b' ? 'input_b' : 'input_a';
    anchorCodeData[key] = newId;
    // Null out the corresponding numeric field when connecting
    if (anchorCodeData.content === 'move_xy') {
        if (inputKey === 'a') anchorCodeData.val_a = '^';
        if (inputKey === 'b') anchorCodeData.val_b = '^';
    } else if (anchorCodeData.content === 'wait' || anchorCodeData.content === 'repeat' || anchorCodeData.content === 'rotate' || anchorCodeData.content === 'set_rotation' || anchorCodeData.content === 'move_forward') {
        anchorCodeData.val_a = '^';
    } else if (anchorCodeData.content === 'operation') {
        if (inputKey === 'a') anchorCodeData.op_x = '^';
        if (inputKey === 'b') anchorCodeData.op_y = '^';
    } else if (anchorCodeData.content === 'set_variable' || anchorCodeData.content === 'change_variable') {
        anchorCodeData.val_a = '^';
    } else if (anchorCodeData.content === 'array_append') {
        anchorCodeData.val_a = '^';
    } else if (anchorCodeData.content === 'array_insert') {
        if (inputKey === 'a') anchorCodeData.val_a = '^';
        if (inputKey === 'b') anchorCodeData.val_b = '^';
    } else if (anchorCodeData.content === 'array_delete') {
        anchorCodeData.val_a = '^';
    } else if (anchorCodeData.content === 'array_get') {
        anchorCodeData.val_a = '^';
    } else if (anchorCodeData.content === 'distance_to' || anchorCodeData.content === 'random_int') {
        if (inputKey === 'a') anchorCodeData.val_a = '^';
        if (inputKey === 'b') anchorCodeData.val_b = '^';
    }

    selectedObj.code.push(newBlock);

    // For drag-to-create, adjust position to center the block on mouse coordinates
    if (placementPoint) {
        const tempBlock = createNodeBlock(newBlock, 0, 0);
        tempBlock.style.visibility = 'hidden';
        tempBlock.style.position = 'absolute';
        document.body.appendChild(tempBlock);

        const blockWidth = tempBlock.offsetWidth;
        const blockHeight = tempBlock.offsetHeight;

        newBlock.position.x = placementPoint.x - (blockWidth / 2);
        newBlock.position.y = placementPoint.y - (blockHeight / 2);

        document.body.removeChild(tempBlock);
    } else if (inputBtnCenterX != null) {
        const tempBlock = createNodeBlock(newBlock, 0, 0);
        tempBlock.style.visibility = 'hidden';
        tempBlock.style.position = 'absolute';
        document.body.appendChild(tempBlock);

        const blockWidth = tempBlock.offsetWidth;
        document.body.removeChild(tempBlock);

        newBlock.position.x = basePosition.x + inputBtnCenterX - blockWidth / 2;
    }

    // Re-render to reflect caret changes and redraw connections
    updateWorkspace();
}
// Canvas lives inside #code-zoom-layer (same scroll + transform as blocks) so wires stay aligned when panning.
const connectionCanvas = document.createElement("canvas");
connectionCanvas.style.position = "absolute";
connectionCanvas.style.top = "0";
connectionCanvas.style.left = "0";
connectionCanvas.style.width = "100%";
connectionCanvas.style.height = "100%";
connectionCanvas.style.pointerEvents = "none";
connectionCanvas.style.zIndex = "0";
const connectionCtx = connectionCanvas.getContext("2d");

// ---- Scrollable code workspace helpers ----
const SCROLL_EDGE_THRESHOLD_PX = 48;
const SCROLL_STEP_H_PX = 10; // faster horizontal
const SCROLL_STEP_V_PX = 4;  // smoother vertical
let autoScrollRAF = null;
let autoScrollTarget = { dx: 0, dy: 0 };
const BASE_SPACER_SIZE_PX = 2000;
const EXTRA_SPACER_PADDING_PX = 400;
let nodeWindowListenersAttached = false;
let codeMiddlePanAttached = false;

/** Scrollable host for the code tab (#code-viewport) or legacy #node-window */
function getCodeScrollContainer() {
    return document.getElementById('code-viewport') || document.getElementById('node-window');
}

let codeZoom = 1.0;

function setCodeZoom(z) {
    codeZoom = Math.max(0.25, Math.min(2.5, z));
    updateSpacerFromBlocks();
    drawConnections();
}

function setCodeZoomBtnIcon(btn, iconNameOrNames, fallbackText, iconSizePx) {
    const size = iconSizePx != null ? iconSizePx : 18;
    const names = Array.isArray(iconNameOrNames) ? iconNameOrNames : [iconNameOrNames];
    const primary = names[0];
    const lucide = window.lucide;
    const safeFallback = fallbackText == null ? '' : String(fallbackText);
    if (lucide && lucide.icons) {
        const found = names.find(n => lucide.icons && lucide.icons[n]);
        const iconDef = found ? lucide.icons[found] : null;
        if (iconDef && typeof iconDef.toSvg === 'function') {
            btn.innerHTML = `${iconDef.toSvg({ width: size, height: size })}<span class="icon-fallback">${safeFallback}</span>`;
            return;
        }
    }
    if (lucide && typeof lucide.createIcons === 'function') {
        btn.innerHTML = `<i data-lucide="${primary}"></i><span class="icon-fallback">${safeFallback}</span>`;
        return;
    }
    btn.textContent = safeFallback;
}

/** Top bar play/stop — Lucide `play` when idle, `square` while running (CSS fills the rect for a solid stop). */
function setPlayStopButtonIcon(btn, playing) {
    setCodeZoomBtnIcon(btn, playing ? ['square'] : ['play'], playing ? '■' : '▶', 16);
    try { window.lucide && window.lucide.createIcons && window.lucide.createIcons(); } catch (_) {}
}

/**
 * Shared zoom strip for code tab + image draw area — reset uses Lucide Equal (equal).
 * @param {{ onZoomOut: function, onZoomReset: function, onZoomIn: function }} handlers
 */
function createZoomControlStrip(handlers) {
    const wrap = document.createElement('div');
    wrap.className = 'code-zoom-controls';
    const mk = (iconNames, title, onClick, fallback) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'zoom-btn';
        b.title = title;
        setCodeZoomBtnIcon(b, iconNames, fallback);
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return b;
    };
    const zoomOutBtn = mk(['zoom-out', 'search-minus', 'minus'], 'Zoom out', handlers.onZoomOut, '−');
    const zoomResetBtn = mk(['equal'], 'Reset zoom (100%)', handlers.onZoomReset, '=');
    const zoomInBtn = mk(['zoom-in', 'search-plus', 'plus'], 'Zoom in', handlers.onZoomIn, '+');
    wrap.appendChild(zoomOutBtn);
    wrap.appendChild(zoomResetBtn);
    wrap.appendChild(zoomInBtn);
    // Do not call createIcons() here — the strip is often not in the document yet; Lucide only
    // replaces [data-lucide] nodes that are connected. Call createIcons after append (code tab)
    // or rely on refreshLucideIcons after the images UI is mounted.
    return { wrap, zoomOutBtn, zoomResetBtn, zoomInBtn };
}

function createCodeZoomControls() {
    const { wrap } = createZoomControlStrip({
        onZoomOut: () => setCodeZoom(codeZoom / 1.2),
        onZoomReset: () => setCodeZoom(1),
        onZoomIn: () => setCodeZoom(codeZoom * 1.2),
    });
    return wrap;
}

function autoScrollIfNearEdge(clientX, clientY) {
    const nodeWindow = getCodeScrollContainer();
    if (!nodeWindow) return;
    const r = nodeWindow.getBoundingClientRect();
    let dx = 0, dy = 0;
    if ((clientX - r.left) < SCROLL_EDGE_THRESHOLD_PX) dx = -SCROLL_STEP_H_PX;
    else if ((r.right - clientX) < SCROLL_EDGE_THRESHOLD_PX) dx = SCROLL_STEP_H_PX;
    if ((clientY - r.top) < SCROLL_EDGE_THRESHOLD_PX) dy = -SCROLL_STEP_V_PX;
    else if ((r.bottom - clientY) < SCROLL_EDGE_THRESHOLD_PX) dy = SCROLL_STEP_V_PX;
    autoScrollTarget.dx = dx;
    autoScrollTarget.dy = dy;
    if (autoScrollRAF == null && (dx !== 0 || dy !== 0)) {
        const step = () => {
            autoScrollRAF = null;
            if (!nodeWindow) return;
            if (autoScrollTarget.dx === 0 && autoScrollTarget.dy === 0) return;
            nodeWindow.scrollLeft += autoScrollTarget.dx;
            nodeWindow.scrollTop += autoScrollTarget.dy;
            drawConnections();
            autoScrollRAF = requestAnimationFrame(step);
        };
        autoScrollRAF = requestAnimationFrame(step);
    }
    if (dx === 0 && dy === 0 && autoScrollRAF != null) {
        cancelAnimationFrame(autoScrollRAF);
        autoScrollRAF = null;
    }
}

/** Stops edge auto-scroll when a drag/marquee/connect ends; otherwise RAF keeps applying the last dx/dy. */
function stopCodeViewportAutoScroll() {
    autoScrollTarget.dx = 0;
    autoScrollTarget.dy = 0;
    if (autoScrollRAF != null) {
        cancelAnimationFrame(autoScrollRAF);
        autoScrollRAF = null;
    }
}

function updateSpacerFromBlocks() {
    const nodeWindow = document.getElementById('node-window');
    if (!nodeWindow || activeTab !== 'code') return;
    const layer = document.getElementById('code-zoom-layer');
    const sizer = document.getElementById('code-zoom-sizer');
    const blocks = nodeWindow.querySelectorAll('.node-block');
    let maxRight = BASE_SPACER_SIZE_PX;
    let maxBottom = BASE_SPACER_SIZE_PX;
    blocks.forEach(el => {
        const x = parseFloat(el.style.left);
        const y = parseFloat(el.style.top);
        const lx = Number.isFinite(x) ? x : 0;
        const ly = Number.isFinite(y) ? y : 0;
        const bw = el.offsetWidth;
        const bh = el.offsetHeight;
        maxRight = Math.max(maxRight, lx + bw + EXTRA_SPACER_PADDING_PX);
        maxBottom = Math.max(maxBottom, ly + bh + EXTRA_SPACER_PADDING_PX);
    });
    const w = Math.max(BASE_SPACER_SIZE_PX, Math.ceil(maxRight));
    const h = Math.max(BASE_SPACER_SIZE_PX, Math.ceil(maxBottom));
    const z = codeZoom || 1;
    if (layer) {
        layer.style.width = w + 'px';
        layer.style.height = h + 'px';
        layer.style.minWidth = '';
        layer.style.minHeight = '';
        layer.style.transform = `scale(${z})`;
        layer.style.transformOrigin = '0 0';
    }
    if (sizer) {
        sizer.style.width = Math.max(1, Math.ceil(w * z)) + 'px';
        sizer.style.height = Math.max(1, Math.ceil(h * z)) + 'px';
    }
}

function ensureScrollableWorkspace() {
    const nodeWindow = document.getElementById('node-window');
    if (!nodeWindow || activeTab !== 'code') return;
    const scrollHost = getCodeScrollContainer();
    if (!scrollHost) return;
    nodeWindow.style.overflow = 'hidden';
    scrollHost.style.overflow = 'auto';
    if (!scrollHost.style.position) scrollHost.style.position = 'relative';
    scrollHost.style.backgroundImage = 'none';
    scrollHost.style.backgroundColor = '#1e1e1e';

    const layer = document.getElementById('code-zoom-layer');
    if (layer) {
        layer.style.backgroundImage = `
            linear-gradient(to right, rgba(255,255,255,0.06) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px)`;
        layer.style.backgroundSize = '24px 24px';
        layer.style.backgroundColor = '#1e1e1e';
    }

    /* Sync first so scrollHeight is correct before any wheel/scrollbar interaction */
    updateSpacerFromBlocks();
    requestAnimationFrame(updateSpacerFromBlocks);

    if (!scrollHost.__drawOnScrollBound) {
        scrollHost.__drawOnScrollBound = true;
        scrollHost.addEventListener('scroll', () => {
            drawConnections();
        });
    }

    if (!nodeWindowListenersAttached) {
        window.addEventListener('resize', () => {
            drawConnections();
            requestAnimationFrame(updateSpacerFromBlocks);
        });
        nodeWindowListenersAttached = true;
    }

    if (!codeMiddlePanAttached) {
        nodeWindow.addEventListener('mousedown', (e) => {
            if (activeTab !== 'code') return;
            if (e.button !== 1) return;
            const host = getCodeScrollContainer();
            if (!host || !host.contains(e.target)) return;
            if (e.target.closest && e.target.closest('.code-zoom-controls')) return;
            e.preventDefault();
            let lastX = e.clientX;
            let lastY = e.clientY;
            function onMove(ev) {
                host.scrollLeft -= ev.clientX - lastX;
                host.scrollTop -= ev.clientY - lastY;
                lastX = ev.clientX;
                lastY = ev.clientY;
                drawConnections();
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp, true);
                document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp, true);
            document.addEventListener('mouseup', onUp);
        });
        codeMiddlePanAttached = true;
    }
}

// Drag-to-connect state
let isConnecting = false;
let connectFromBlockId = null;
let connectMouse = { x: 0, y: 0 };
let connectFromInput = null; // { blockId, which }
let connectFromNext = null; // { blockId, which }
let lastConnectEndedAt = 0;
let connectStartTime = 0;
let connectDragMoved = false;

function setConnectMouseFromClientEvent(e) {
    const container = getCodeScrollContainer();
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const sl = container.scrollLeft || 0;
    const st = container.scrollTop || 0;
    connectMouse.x = (e.clientX - rect.left) + sl;
    connectMouse.y = (e.clientY - rect.top) + st;
}

function attachConnectDragListeners() {
    connectDragMoved = false;
    document.addEventListener('mousemove', handleConnectMouseMove);
    document.addEventListener('mouseup', handleConnectMouseUp, true);
    window.addEventListener('mouseup', handleConnectMouseUp, true);
}

// connectMouse: scroll content coords = scrollLeft + (clientX - hostBorderLeft).
// Layer has transform: scale(z); layer-local (unscaled) coords = (screen - layerOrigin) / z.
/** Uniform scale from layer's computed transform (matches rendered blocks; avoids JS/CSS drift). */
function getLayerUniformScale(layer) {
    if (!layer) return codeZoom || 1;
    const inline = layer.style && layer.style.transform;
    if (inline && typeof inline === 'string') {
        const mScale = inline.match(/scale\(\s*([0-9.eE+-]+)\s*\)/);
        if (mScale) {
            const s = parseFloat(mScale[1]);
            if (s > 0.001 && Number.isFinite(s)) return s;
        }
    }
    try {
        const t = getComputedStyle(layer).transform;
        if (!t || t === 'none') return codeZoom || 1;
        const m = new DOMMatrixReadOnly(t);
        const s = Math.hypot(m.a, m.b);
        if (s > 0.001 && Number.isFinite(s)) return s;
    } catch (_) {}
    return codeZoom || 1;
}

function contentToViewport(_nodeWindow, point) {
    const c = getCodeScrollContainer();
    const layer = document.getElementById('code-zoom-layer');
    if (!c || !layer) return { x: 0, y: 0 };
    const sl = c.scrollLeft || 0;
    const st = c.scrollTop || 0;
    const host = c.getBoundingClientRect();
    const vx = point.x - sl + host.left;
    const vy = point.y - st + host.top;
    const lr = layer.getBoundingClientRect();
    const z = getLayerUniformScale(layer);
    return {
        x: (vx - lr.left) / z,
        y: (vy - lr.top) / z
    };
}

/** Same coordinate system as connectMouse / scrollLeft + viewport offset → layer-local unscaled (block position). */
function scrollContentToLayerLocal(point) {
    const c = getCodeScrollContainer();
    if (!point || !c) return point;
    return contentToViewport(c, point);
}

/** Element geometry in #code-zoom-layer local space (unscaled px), matching block style.left/top. */
function getLayerLocalRect(layer, el, lrCache, scale) {
    const lr = lrCache || layer.getBoundingClientRect();
    const br = el.getBoundingClientRect();
    const zz = scale || 1;
    const left = (br.left - lr.left) / zz;
    const top = (br.top - lr.top) / zz;
    return {
        left,
        top,
        width: br.width / zz,
        height: br.height / zz,
        cx: left + br.width / (2 * zz),
        cy: top + br.height / (2 * zz),
        bottom: top + br.height / zz
    };
}

// Track active document click handlers for node-add menus so we can remove them reliably
let activeMenuDocHandlers = [];
function addMenuDocHandler(handler) {
    activeMenuDocHandlers.push(handler);
    document.addEventListener('click', handler, true);
}
function clearMenuDocHandlers() {
    if (activeMenuDocHandlers.length) {
        try {
            activeMenuDocHandlers.forEach(h => document.removeEventListener('click', h, true));
        } catch (_) {}
        activeMenuDocHandlers = [];
    }
}

function startConnectFromBlock(blockId) {
    isConnecting = true;
    connectStartTime = Date.now();
    connectFromBlockId = blockId;
    attachConnectDragListeners();
}

function startConnectFromNext(blockId, which) {
    console.log('startConnectFromNext called:', { blockId, which, isConnecting });
    isConnecting = true;
    connectStartTime = Date.now();
    connectFromNext = { blockId, which: which === 'b' ? 'b' : 'a' };
    console.log('connectFromNext set to:', connectFromNext);
    attachConnectDragListeners();
}

function handleConnectMouseMove(e) {
    connectDragMoved = true;
    const container = getCodeScrollContainer();
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const sl = container.scrollLeft || 0;
    const st = container.scrollTop || 0;
    connectMouse.x = (e.clientX - rect.left) + sl;
    connectMouse.y = (e.clientY - rect.top) + st;
    autoScrollIfNearEdge(e.clientX, e.clientY);
    drawConnections();
}
function handleConnectMouseUp(e) {
    console.log('handleConnectMouseUp called, isConnecting:', isConnecting);
    if (!isConnecting) {
        console.log('Not connecting, returning early');
        return;
    }

    try {
        // Normalize mouse position to content coordinates at release time
        try {
            const container = getCodeScrollContainer();
            if (container) {
                const rect = container.getBoundingClientRect();
                const sl = container.scrollLeft || 0;
                const st = container.scrollTop || 0;
                connectMouse.x = (e.clientX - rect.left) + sl;
                connectMouse.y = (e.clientY - rect.top) + st;
            }
        } catch(_) {}
        // Clean up any leftover temporary blocks from previous operations
        document.querySelectorAll('[data-temp-block="true"]').forEach(el => {
            try {
                if (el.parentNode) el.parentNode.removeChild(el);
            } catch (err) {
                console.warn('Error cleaning up temp block:', err);
            }
        });

        const el = document.elementFromPoint(e.clientX, e.clientY);
        const selectedObj = objects.find(obj => obj.id == selected_object);

        // Validate that we have a valid selected object
        if (!selectedObj) {
            console.log('No valid selected object found, canceling drag operation');
            cleanupDragState();
            return;
        }

        // Double-check that we still have valid connection state
        if (!connectFromBlockId && !connectFromInput && !connectFromNext) {
            console.log('No valid connection state found, canceling drag operation');
            cleanupDragState();
            return;
        }

        // Check for timeout (prevent stale drag operations)
        const dragDuration = Date.now() - connectStartTime;
        if (dragDuration > 30000) { // 30 second timeout
            console.log('Drag operation timed out, canceling');
            cleanupDragState();
            return;
        }

        console.log('Mouse release detected:', {
            connectFromNext: connectFromNext,
            connectFromInput: connectFromInput,
            connectFromBlockId: connectFromBlockId,
            selectedObj: selectedObj,
            el: el
        });

    if (connectFromBlockId != null) {
        // Provider -> Input
        const btn = el && (el.classList && el.classList.contains('node-input-plus-btn') ? el : el.closest && el.closest('.node-input-plus-btn'));
        let foundValidTarget = false;

        if (btn && selectedObj) {
            const which = btn.classList.contains('node-input-plus-btn-b') ? 'b' : 'a';
            const blockEl = btn.closest('.node-block');
            if (blockEl) {
                const targetId = parseInt(blockEl.dataset.codeId, 10);
                const target = selectedObj.code.find(c => c.id === targetId);
                if (target) {
                    foundValidTarget = true;
                    connectProviderToInput(selectedObj, target, which, connectFromBlockId);
                }
            }
        }

        // Fallback: if dropped on a block body (not the tiny input-plus btn),
        // auto-connect to the first available input slot on that block.
        if (!foundValidTarget && el && selectedObj) {
            const blockEl = el.classList && el.classList.contains('node-block') ? el : (el.closest && el.closest('.node-block'));
            if (blockEl) {
                const targetId = parseInt(blockEl.dataset.codeId, 10);
                if (targetId !== connectFromBlockId) {
                    const target = selectedObj.code.find(c => c.id === targetId);
                    if (target && blockEl.querySelector('.node-input-plus-btn')) {
                        const which = (target.input_a == null) ? 'a' : (target.input_b == null && blockEl.querySelector('.node-input-plus-btn-b')) ? 'b' : null;
                        if (which) {
                            foundValidTarget = true;
                            connectProviderToInput(selectedObj, target, which, connectFromBlockId);
                        }
                    }
                }
            }
        }

        if (!foundValidTarget && connectDragMoved && selectedObj) {
            // No input button found - create new action block at mouse position (only after a real drag)
            const source = selectedObj.code.find(c => c.id === connectFromBlockId);
            if (source) {
                try {
                    // Create a temporary block element to show menu at mouse position
                    const tempBlock = document.createElement('div');
                    tempBlock.className = 'node-block';
                    tempBlock.style.position = 'absolute';
                    tempBlock.style.left = `${connectMouse.x}px`;
                    tempBlock.style.top = `${connectMouse.y}px`;
                    tempBlock.style.pointerEvents = 'none';
                    tempBlock.style.opacity = '0';
                    tempBlock.dataset.tempBlock = 'true'; // Mark as temporary for cleanup

                    const nodeWindow = document.getElementById('node-window');
                    if (nodeWindow) {
                        nodeWindow.appendChild(tempBlock);

                        // Show menu with position based on mouse in content coordinates
                        showAddBlockMenu(tempBlock, source, 'a', { x: connectMouse.x, y: connectMouse.y });

                        // Remove temp block after menu is shown
                        setTimeout(() => {
                            try {
                                if (tempBlock.parentNode) {
                                    tempBlock.parentNode.removeChild(tempBlock);
                                }
                            } catch (e) {
                                // Ignore cleanup errors
                            }
                        }, 100);
                    }
                } catch (e) {
                    console.warn('Error during drag-to-create action block from value:', e);
                }
            }
        }
    } else if (connectFromInput) {
        // Input -> Provider
        const anchor = el && (el.classList && el.classList.contains('node-output-anchor') ? el : el.closest && el.closest('.node-output-anchor'));
        let providerBlockEl = null;
        let foundValidTarget = false;

        if (anchor) {
            providerBlockEl = anchor.closest('.node-block');
            if (providerBlockEl && selectedObj) {
                const providerId = parseInt(providerBlockEl.dataset.codeId, 10);
                const provider = selectedObj.code.find(c => c.id === providerId);
                if (provider && provider.type === 'value') {
                    foundValidTarget = true;
                    const target = selectedObj.code.find(c => c.id === connectFromInput.blockId);
                    if (target) connectProviderToInput(selectedObj, target, connectFromInput.which, providerId);
                }
            }
        }

        // Fallback: output anchor has pointer-events:none, so elementFromPoint
        // won't return it directly. Accept drops anywhere on a value block body.
        if (!foundValidTarget && el) {
            const blockEl = el.classList && el.classList.contains('node-block') ? el : (el.closest && el.closest('.node-block'));
            if (blockEl && selectedObj) {
                const providerId = parseInt(blockEl.dataset.codeId, 10);
                const provider = selectedObj.code.find(c => c.id === providerId);
                if (provider && provider.type === 'value' && providerId !== connectFromInput.blockId) {
                    foundValidTarget = true;
                    const target = selectedObj.code.find(c => c.id === connectFromInput.blockId);
                    if (target) connectProviderToInput(selectedObj, target, connectFromInput.which, providerId);
                }
            }
        }

        // If dropped on blank space and this input already had a connection, disconnect instead of creating
        if (!foundValidTarget && selectedObj) {
            const isBlankDrop = !el || !(
                (el.classList && (el.classList.contains('node-block') || el.classList.contains('node-output-anchor') || el.classList.contains('node-input-plus-btn')))
                || (el.closest && (el.closest('.node-block') || el.closest('.node-output-anchor') || el.closest('.node-input-plus-btn')))
            );
            const target = selectedObj.code.find(c => c.id === connectFromInput.blockId);
            if (isBlankDrop && target) {
                const key = connectFromInput.which === 'b' ? 'input_b' : 'input_a';
                if (target[key]) {
                    target[key] = null;
                    updateWorkspace();
                    foundValidTarget = true;
                }
            }
        }

        if (!foundValidTarget && connectDragMoved && selectedObj) {
            // No provider block found - create new block at mouse position (only after a real drag, not a click)
            const target = selectedObj.code.find(c => c.id === connectFromInput.blockId);
            if (target) {
                try {
                    // Create a temporary block element to show menu at mouse position
                    const tempBlock = document.createElement('div');
                    tempBlock.className = 'node-block';
                    tempBlock.style.position = 'absolute';
                    tempBlock.style.left = `${connectMouse.x}px`;
                    tempBlock.style.top = `${connectMouse.y}px`;
                    tempBlock.style.pointerEvents = 'none';
                    tempBlock.style.opacity = '0';
                    tempBlock.dataset.tempBlock = 'true'; // Mark as temporary for cleanup

                    const nodeWindow = document.getElementById('node-window');
                    if (nodeWindow) {
                        nodeWindow.appendChild(tempBlock);

                        // Show menu with position based on mouse in content coordinates
                        showAddInputBlockMenu(tempBlock, target, connectFromInput.which, null, { x: connectMouse.x, y: connectMouse.y });

                        // Remove temp block after menu is shown
                        setTimeout(() => {
                            try {
                                if (tempBlock.parentNode) {
                                    tempBlock.parentNode.removeChild(tempBlock);
                                }
                            } catch (e) {
                                // Ignore cleanup errors
                            }
                        }, 100);
                    }
                } catch (e) {
                    console.warn('Error during drag-to-create:', e);
                }
            }
        }
    } else if (connectFromNext) {
        // Next (A/B) -> Block top anchor
        console.log('Processing connectFromNext:', connectFromNext);
        const blockEl = el && (el.classList && el.classList.contains('node-block') ? el : el.closest && el.closest('.node-block'));
        let foundValidTarget = false;
        console.log('Block element found:', blockEl);

        if (blockEl && selectedObj) {
            const destId = parseInt(blockEl.dataset.codeId, 10);
            const source = selectedObj.code.find(c => c.id === connectFromNext.blockId);
            if (source && destId !== source.id) {
                const dest = selectedObj.code.find(c => c.id === destId);
                if (!dest || dest.type !== 'value') {
                    foundValidTarget = true;
                    // Prevent creating immediate loop to itself via same branch
                    const key = connectFromNext.which === 'b' ? 'next_block_b' : 'next_block_a';
                    source[key] = destId;
                    // Also prevent the destination pointing back instantly to source on its A if it currently does
                    if (dest && dest.next_block_a === source.id) dest.next_block_a = null;
                    updateWorkspace();
                }
            }
        }

        // If dropped on blank space and a next connection existed, disconnect instead of creating
        if (!foundValidTarget && selectedObj) {
            const isBlankDrop = !el || !(
                (el.classList && (el.classList.contains('node-block') || el.classList.contains('node-output-anchor') || el.classList.contains('node-input-plus-btn')))
                || (el.closest && (el.closest('.node-block') || el.closest('.node-output-anchor') || el.closest('.node-input-plus-btn')))
            );
            const source = selectedObj.code.find(c => c.id === connectFromNext.blockId);
            if (isBlankDrop && source) {
                const key = connectFromNext.which === 'b' ? 'next_block_b' : 'next_block_a';
                if (source[key]) {
                    source[key] = null;
                    updateWorkspace();
                    foundValidTarget = true;
                }
            }
        }

        if (!foundValidTarget && connectDragMoved && selectedObj) {
            // No block found at mouse position - create new action block
            console.log('No valid target found, triggering drag-to-create for action block');
            const source = selectedObj.code.find(c => c.id === connectFromNext.blockId);
            if (source) {
                console.log('Source block found:', source);
                try {
                    // Create a temporary block element to show menu at mouse position
                    const tempBlock = document.createElement('div');
                    tempBlock.className = 'node-block';
                    tempBlock.style.position = 'absolute';
                    tempBlock.style.left = `${connectMouse.x}px`;
                    tempBlock.style.top = `${connectMouse.y}px`;
                    tempBlock.style.pointerEvents = 'none';
                    tempBlock.style.opacity = '0';
                    tempBlock.dataset.tempBlock = 'true'; // Mark as temporary for cleanup

                    const nodeWindow = document.getElementById('node-window');
                    if (nodeWindow) {
                        nodeWindow.appendChild(tempBlock);

                        // Show menu with position based on mouse in content coordinates
                        const pos = { x: connectMouse.x, y: connectMouse.y };
                        console.log('Calling showAddBlockMenu with custom position:', pos);
                        showAddBlockMenu(tempBlock, source, connectFromNext.which, pos);

                        // Remove temp block after menu is shown
                        setTimeout(() => {
                            try {
                                if (tempBlock.parentNode) {
                                    tempBlock.parentNode.removeChild(tempBlock);
                                }
                            } catch (e) {
                                // Ignore cleanup errors
                            }
                        }, 100);
                    }
                } catch (e) {
                    console.warn('Error during drag-to-create action block:', e);
                }
            }
        }
    }
    } catch (error) {
        console.error('Error in handleConnectMouseUp:', error);
        cleanupDragState();
        return;
    }

    cleanupDragState();
}

function cleanupDragState() {
    console.log('cleanupDragState called');
    stopCodeViewportAutoScroll();
    isConnecting = false;
    connectStartTime = 0;
    connectFromBlockId = null;
    connectFromInput = null;
    connectFromNext = null;
    document.removeEventListener('mousemove', handleConnectMouseMove);
    document.removeEventListener('mouseup', handleConnectMouseUp, true);
    window.removeEventListener('mouseup', handleConnectMouseUp, true);
    // Also clear any menu click handlers that might intercept the next drag start
    clearMenuDocHandlers();
    drawConnections();
}

function connectProviderToInput(selectedObj, targetBlock, which, providerId) {
    const key = which === 'b' ? 'input_b' : 'input_a';
    targetBlock[key] = providerId;
    // Mark value fields as caret so serialized data reflects connected state
    if (targetBlock.content === 'operation') {
        if (which === 'a') targetBlock.op_x = '^'; else targetBlock.op_y = '^';
    } else {
        if (which === 'a') targetBlock.val_a = '^';
        else targetBlock.val_b = '^';
    }
    updateWorkspace();
}

// Resize canvas to match zoom layer (unscaled layout size)
function resizeConnectionCanvas() {
    const layer = document.getElementById('code-zoom-layer');
    const viewport = document.getElementById('code-viewport') || document.getElementById('node-window');
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const cw = Math.max(1, layer ? layer.offsetWidth : viewport.clientWidth);
    const ch = Math.max(1, layer ? layer.offsetHeight : viewport.clientHeight);
    connectionCanvas.width = Math.floor(cw * dpr);
    connectionCanvas.height = Math.floor(ch * dpr);
    connectionCanvas.style.width = cw + 'px';
    connectionCanvas.style.height = ch + 'px';
}
// Draw connections between blocks (layer-local unscaled coords; canvas is inside transformed layer)
function drawConnections() {
    const nodeWindow = document.getElementById('node-window');
    if (!nodeWindow) return;
    const layer = document.getElementById('code-zoom-layer');
    if (!layer) return;
    if (!layer.contains(connectionCanvas)) {
        try {
            layer.insertBefore(connectionCanvas, layer.firstChild);
        } catch (_) {
            return;
        }
    }

    const lrCached = layer.getBoundingClientRect();
    const scale = getLayerUniformScale(layer);

    const cw = Math.max(1, layer.offsetWidth);
    const ch = Math.max(1, layer.offsetHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    connectionCanvas.width = Math.floor(cw * dpr);
    connectionCanvas.height = Math.floor(ch * dpr);
    connectionCanvas.style.width = cw + 'px';
    connectionCanvas.style.height = ch + 'px';
    connectionCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    connectionCtx.clearRect(0, 0, cw, ch);
    connectionCtx.lineCap = 'round';
    connectionCtx.lineJoin = 'round';
    const strokeW = Math.max(1.25, 1.75 * scale);
    const dashOn = Math.max(4, 6 * scale);
    const dashOff = Math.max(3, 4 * scale);

    const selectedObj = objects.find(obj => obj.id == selected_object);
    if (!selectedObj) return;

    selectedObj.code.forEach(code => {
        const startBlock = nodeWindow.querySelector(`.node-block[data-code-id="${code.id}"]`);
        if (!startBlock) return;
        const st = getLayerLocalRect(layer, startBlock, lrCached, scale);
        const plusA = startBlock.querySelector('.node-plus-btn-a');
        const plusB = startBlock.querySelector('.node-plus-btn-b');
        const rectA = plusA ? getLayerLocalRect(layer, plusA, lrCached, scale) : null;
        const rectB = plusB ? getLayerLocalRect(layer, plusB, lrCached, scale) : null;
        const startX_A = rectA ? rectA.cx : st.left + st.width * 0.45;
        const startX_B = rectB ? rectB.cx : st.left + st.width * 0.55;
        const startY_A = rectA ? rectA.cy : st.top + st.height;
        const startY_B = rectB ? rectB.cy : st.top + st.height;

        const drawArrow = (targetId, color, useB) => {
            if (targetId === null || typeof targetId === 'undefined') return;
            const endBlock = nodeWindow.querySelector(`.node-block[data-code-id="${targetId}"]`);
            if (!endBlock) return;
            const en = getLayerLocalRect(layer, endBlock, lrCached, scale);
            const endX = en.left + 23;
            const endY = en.top - 1;
            connectionCtx.beginPath();
            const pStart = { x: (useB ? startX_B : startX_A), y: (useB ? startY_B : startY_A) };
            const pEnd = { x: endX, y: endY };
            connectionCtx.moveTo(pStart.x, pStart.y);
            connectionCtx.lineTo(pEnd.x, pEnd.y);
            connectionCtx.strokeStyle = color;
            connectionCtx.lineWidth = strokeW;
            connectionCtx.stroke();
        };

        drawArrow(code.next_block_a, "#4da3ff", false); // blue-ish for A
        drawArrow(code.next_block_b, "#ffb84d", true); // orange-ish for B

        const inputPlusA = startBlock.querySelector('.node-input-plus-btn-a');
        const inputPlusB = startBlock.querySelector('.node-input-plus-btn-b');
        const getInputStart = (btnEl) => {
            if (!btnEl) return null;
            const r = getLayerLocalRect(layer, btnEl, lrCached, scale);
            return { x: r.cx, y: r.cy };
        };
        const drawInputArrow = (targetId, btnEl, color) => {
            if (targetId === null || typeof targetId === 'undefined' || !btnEl) return;
            const endBlock = nodeWindow.querySelector(`.node-block[data-code-id="${targetId}"]`);
            if (!endBlock) return;
            const outAnchor = endBlock.querySelector('.node-output-anchor');
            const outEl = outAnchor || endBlock;
            const outR = getLayerLocalRect(layer, outEl, lrCached, scale);
            const start = getInputStart(btnEl);
            if (!start) return;
            const endX = outR.cx;
            const endY = outR.cy;
            connectionCtx.beginPath();
            connectionCtx.moveTo(start.x, start.y);
            connectionCtx.lineTo(endX, endY);
            connectionCtx.strokeStyle = color;
            connectionCtx.lineWidth = strokeW;
            connectionCtx.stroke();
        };

        const scrollHost = getCodeScrollContainer();

        if (isConnecting && connectFromBlockId != null) {
            const fromBlock = nodeWindow.querySelector(`.node-block[data-code-id="${connectFromBlockId}"]`);
            if (fromBlock) {
                const anchor = fromBlock.querySelector('.node-output-anchor');
                if (anchor) {
                    const ar = getLayerLocalRect(layer, anchor, lrCached, scale);
                    connectionCtx.beginPath();
                    connectionCtx.moveTo(ar.cx, ar.cy);
                    const p2 = contentToViewport(scrollHost, connectMouse);
                    connectionCtx.lineTo(p2.x, p2.y);
                    connectionCtx.strokeStyle = '#66ff99';
                    connectionCtx.lineWidth = strokeW;
                    connectionCtx.setLineDash([dashOn, dashOff]);
                    connectionCtx.stroke();
                    connectionCtx.setLineDash([]);
                }
            }
        }

        if (isConnecting && connectFromInput) {
            const sb = nodeWindow.querySelector(`.node-block[data-code-id="${connectFromInput.blockId}"]`);
            if (sb) {
                const btnEl = sb.querySelector(connectFromInput.which === 'b' ? '.node-input-plus-btn-b' : '.node-input-plus-btn-a');
                if (btnEl) {
                    const start = getInputStart(btnEl);
                    if (start) {
                        connectionCtx.beginPath();
                        connectionCtx.moveTo(start.x, start.y);
                        const p = contentToViewport(scrollHost, connectMouse);
                        connectionCtx.lineTo(p.x, p.y);
                        connectionCtx.strokeStyle = '#66ff99';
                        connectionCtx.lineWidth = strokeW;
                        connectionCtx.setLineDash([dashOn, dashOff]);
                        connectionCtx.stroke();
                        connectionCtx.setLineDash([]);
                    }
                }
            }
        }

        if (isConnecting && connectFromNext) {
            const startBlockEl = nodeWindow.querySelector(`.node-block[data-code-id="${connectFromNext.blockId}"]`);
            if (startBlockEl) {
                const btnEl = startBlockEl.querySelector(connectFromNext.which === 'b' ? '.node-plus-btn-b' : '.node-plus-btn-a');
                if (btnEl) {
                    const br = getLayerLocalRect(layer, btnEl, lrCached, scale);
                    const sx = br.cx;
                    const sy = br.cy;
                    connectionCtx.beginPath();
                    connectionCtx.moveTo(sx, sy);
                    const p = contentToViewport(scrollHost, connectMouse);
                    connectionCtx.lineTo(p.x, p.y);
                    connectionCtx.strokeStyle = '#4da3ff';
                    connectionCtx.lineWidth = strokeW;
                    connectionCtx.setLineDash([dashOn, dashOff]);
                    connectionCtx.stroke();
                    connectionCtx.setLineDash([]);
                }
            }
        }

        drawInputArrow(code.input_a, inputPlusA, "#66ff99"); // green for input A
        drawInputArrow(code.input_b, inputPlusB, "#cc66ff"); // purple for input B
    });
}

// Global variables for images tab
let selectedImage = null; // current image src (path or data URL)
let imageZoom = 1.0;
let lastSelectedImage = localStorage.getItem('lastSelectedImage') || '';
function lastSelectedImageKeyForObject(objectId) {
    return `lastSelectedImage:${String(objectId)}`;
}
function getLastSelectedImageForObject(objectId) {
    try { return localStorage.getItem(lastSelectedImageKeyForObject(objectId)) || ''; } catch (_) { return ''; }
}
function setLastSelectedImageForObject(objectId, imagePath) {
    try {
        const k = lastSelectedImageKeyForObject(objectId);
        if (imagePath) localStorage.setItem(k, imagePath);
        else localStorage.removeItem(k);
    } catch (_) {}
}
// Deleted images per object for undo
const deletedImagesMap = {};
// Per-object image lists stored in-memory: { [objectId]: Array<{ id, name, src }> }
const objectImages = {};

// Per-object sound clips: { [objectId]: Array<{ id, name, src }> }
const objectSounds = {};
const deletedSoundsMap = {};
let selectedSoundSrc = null;
let currentSoundFilename = null;
let currentSoundInfo = null;
let soundRevision = 0;
let soundTabAudio = null;
/** Set while Sound tab UI is mounted; used by global `selectSound`. */
let soundSelectionHandler = null;

function lastSelectedSoundKeyForObject(objectId) {
    return `lastSelectedSound:${String(objectId)}`;
}
function getLastSelectedSoundForObject(objectId) {
    try { return localStorage.getItem(lastSelectedSoundKeyForObject(objectId)) || ''; } catch (_) { return ''; }
}
function setLastSelectedSoundForObject(objectId, soundPath) {
    try {
        const k = lastSelectedSoundKeyForObject(objectId);
        if (soundPath) localStorage.setItem(k, soundPath);
        else localStorage.removeItem(k);
    } catch (_) {}
}

/** HTTP(S) cache-bust only — never append ? to data:/blob: URLs (breaks Audio + fetch). */
function soundSrcForPlayback(src) {
    if (!src || typeof src !== 'string') return src;
    if (src.startsWith('data:') || src.startsWith('blob:')) return src;
    if (src.indexOf('?') >= 0) return src;
    return `${src}?r=${soundRevision}`;
}

function uint8ToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    const chunk = 0x8000;
    for (let i = 0; i < len; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, len)));
    }
    return btoa(binary);
}

/** Short silent WAV (PCM) as a data URL — default clip for new objects. */
function generateSilentWavDataUrl(durationSec = 0.2) {
    const sampleRate = 44100;
    const numChannels = 1;
    const bitsPerSample = 16;
    const numSamples = Math.max(1, Math.floor(sampleRate * durationSec));
    const blockAlign = numChannels * bitsPerSample / 8;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numSamples * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buffer);
    const writeStr = (off, s) => {
        for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    v.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, numChannels, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, byteRate, true);
    v.setUint16(32, blockAlign, true);
    v.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    v.setUint32(40, dataSize, true);
    const bytes = new Uint8Array(buffer);
    return `data:audio/wav;base64,${uint8ToBase64(bytes)}`;
}

/** Encode any decoded AudioBuffer as 16-bit PCM WAV data URL (for trim/crop export). */
function encodeAudioBufferToWavDataUrl(audioBuffer) {
    const numCh = audioBuffer.numberOfChannels;
    const sr = audioBuffer.sampleRate;
    const len = audioBuffer.length;
    const bitsPerSample = 16;
    const blockAlign = numCh * (bitsPerSample / 8);
    const byteRate = sr * blockAlign;
    const dataSize = len * blockAlign;
    const buf = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buf);
    const writeStr = (off, s) => {
        for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    v.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, numCh, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, byteRate, true);
    v.setUint16(32, blockAlign, true);
    v.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    v.setUint32(40, dataSize, true);
    let o = 44;
    for (let i = 0; i < len; i++) {
        for (let c = 0; c < numCh; c++) {
            const s = Math.max(-1, Math.min(1, audioBuffer.getChannelData(c)[i]));
            const int16 = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
            v.setInt16(o, int16, true);
            o += 2;
        }
    }
    return `data:audio/wav;base64,${uint8ToBase64(new Uint8Array(buf))}`;
}

async function cropSoundSrcToWavDataUrl(src, startSec, endSec) {
    const ctx = getSoundAudioContext();
    if (!ctx) throw new Error('AudioContext unavailable');
    try {
        await ctx.resume();
    } catch (_) {}
    let ab;
    if (typeof src === 'string' && (src.startsWith('data:') || src.startsWith('blob:'))) {
        ab = await (await fetch(src)).arrayBuffer();
    } else {
        const bust = typeof src === 'string' && src.indexOf('?') >= 0 ? src : `${src}?r=${soundRevision}`;
        const res = await fetch(bust, { credentials: 'same-origin' });
        ab = await res.arrayBuffer();
    }
    const decoded = await ctx.decodeAudioData(ab.slice(0));
    const dur = decoded.duration;
    const t0 = Math.max(0, Math.min(startSec, dur));
    const t1 = Math.max(t0 + 1 / decoded.sampleRate, Math.min(endSec, dur));
    const sr = decoded.sampleRate;
    const ch = decoded.numberOfChannels;
    const i0 = Math.floor(t0 * sr);
    const i1 = Math.floor(t1 * sr);
    const newLen = Math.max(1, i1 - i0);
    const out = ctx.createBuffer(ch, newLen, sr);
    for (let c = 0; c < ch; c++) {
        out.getChannelData(c).set(decoded.getChannelData(c).subarray(i0, i1));
    }
    return encodeAudioBufferToWavDataUrl(out);
}

/** Remove the time range [startSec, endSec] and concatenate head + tail into one clip. */
async function cutSoundRemoveMiddleToWavDataUrl(src, startSec, endSec) {
    const ctx = getSoundAudioContext();
    if (!ctx) throw new Error('AudioContext unavailable');
    try {
        await ctx.resume();
    } catch (_) {}
    let ab;
    if (typeof src === 'string' && (src.startsWith('data:') || src.startsWith('blob:'))) {
        ab = await (await fetch(src)).arrayBuffer();
    } else {
        const bust = typeof src === 'string' && src.indexOf('?') >= 0 ? src : `${src}?r=${soundRevision}`;
        const res = await fetch(bust, { credentials: 'same-origin' });
        ab = await res.arrayBuffer();
    }
    const decoded = await ctx.decodeAudioData(ab.slice(0));
    const dur = decoded.duration;
    const sr = decoded.sampleRate;
    const ch = decoded.numberOfChannels;
    const t0 = Math.max(0, Math.min(startSec, dur));
    const t1 = Math.max(t0 + 1 / decoded.sampleRate, Math.min(endSec, dur));
    const i0 = Math.floor(t0 * sr);
    const i1 = Math.floor(t1 * sr);
    const iDur = decoded.length;
    const lenA = Math.max(0, i0);
    const lenB = Math.max(0, iDur - i1);
    const newLen = lenA + lenB;
    if (newLen < 1) throw new Error('Nothing left after cut');
    const out = ctx.createBuffer(ch, newLen, sr);
    for (let c = 0; c < ch; c++) {
        const srcCh = decoded.getChannelData(c);
        const dstCh = out.getChannelData(c);
        if (lenA > 0) dstCh.set(srcCh.subarray(0, lenA), 0);
        if (lenB > 0) dstCh.set(srcCh.subarray(i1), lenA);
    }
    return encodeAudioBufferToWavDataUrl(out);
}

function getNextSoundNumber() {
    const key = String(selected_object);
    if (!objectSounds[key]) objectSounds[key] = [];
    const existingNumbers = new Set();
    objectSounds[key].forEach((s) => {
        const match = String(s.name).match(/^sound-(\d+)/);
        if (match) existingNumbers.add(parseInt(match[1], 10));
    });
    let num = 1;
    while (existingNumbers.has(num)) num++;
    return num;
}

function soundFilenameForNum(num, ext) {
    const e = (ext && /^\.?[a-z0-9]+$/i.test(ext.replace(/^\./, '')))
        ? (ext.startsWith('.') ? ext : `.${ext}`)
        : '.wav';
    return `sound-${num}${e}`;
}

function syncMediaSoundEntry(obj, src) {
    if (!obj || !src) return;
    if (!obj.media) obj.media = [];
    const idx = obj.media.findIndex((m) => m && m.type === 'sound');
    if (idx >= 0) obj.media[idx].path = src;
    else obj.media.push({ id: Date.now(), name: 'sound', type: 'sound', path: src });
}

function ensureDefaultSoundForObject(obj) {
    const key = String(obj.id);
    if (!objectSounds[key]) objectSounds[key] = [];
    if (objectSounds[key].length === 0) {
        if ((deletedSoundsMap[key] || []).length > 0) return;
        const silent = generateSilentWavDataUrl();
        const row = { id: Date.now(), name: 'sound-1.wav', src: silent };
        objectSounds[key].push(row);
        syncMediaSoundEntry(obj, silent);
    }
}

function initializeDefaultSounds() {
    objects.forEach((o) => ensureDefaultSoundForObject(o));
}

function getCurrentObjectSounds() {
    const key = String(selected_object);
    if (!objectSounds[key]) objectSounds[key] = [];
    if (objectSounds[key].length === 0) {
        const obj = objects.find((o) => o.id == selected_object);
        if (obj) ensureDefaultSoundForObject(obj);
    }
    return objectSounds[key];
}

function stopSoundTabPlayback() {
    if (soundTabAudio) {
        try {
            soundTabAudio.pause();
            soundTabAudio.removeAttribute('src');
            soundTabAudio.load();
        } catch (_) {}
        soundTabAudio = null;
    }
}

let __soundAudioContext = null;
function getSoundAudioContext() {
    if (!__soundAudioContext) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) __soundAudioContext = new AC();
    }
    return __soundAudioContext;
}

function generateBlankImageDataUrl(width = 128, height = 128) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const g = c.getContext('2d');
    g.clearRect(0, 0, width, height);
    return c.toDataURL('image/png');
}

// Get the next available image number for the current object
function getNextImageNumber() {
    const currentObjectId = selected_object;
    const key = String(currentObjectId);
    if (!objectImages[key]) objectImages[key] = [];

    // Find all existing image numbers
    const existingNumbers = new Set();
    objectImages[key].forEach(img => {
        const match = img.name.match(/^image-(\d+)$/);
        if (match) {
            existingNumbers.add(parseInt(match[1]));
        }
    });

    // Find the smallest available number starting from 1
    let num = 1;
    while (existingNumbers.has(num)) {
        num++;
    }
    return num;
}

function ensureDefaultImageForObject(obj) {
    const key = String(obj.id);
    if (!objectImages[key]) objectImages[key] = [];
    if (objectImages[key].length === 0) {
        // Last image(s) were deleted but may still be undoable — don't seed a blank on top.
        if ((deletedImagesMap[key] || []).length > 0) return;
        const blank = generateBlankImageDataUrl();
        // Always start with image-1 for new objects
        const imgInfo = { id: Date.now(), name: `image-1`, src: blank };
        objectImages[key].push(imgInfo);
        if (!obj.media) obj.media = [];
        if (obj.media.length === 0) obj.media.push({ id: 1, name: 'sprite', type: 'image', path: imgInfo.src });
        else obj.media[0].path = imgInfo.src;
    }
}

function initializeDefaultImages() {
    objects.forEach(o => ensureDefaultImageForObject(o));
}

function getCurrentObjectImages() {
    const key = String(selected_object);
    if (!objectImages[key]) objectImages[key] = [];
    // Seed a default blank image if none exists for the selected object
    if (objectImages[key].length === 0) {
        const obj = objects.find(o => o.id == selected_object);
        if (obj) ensureDefaultImageForObject(obj);
    }
    return objectImages[key];
}

// Reorder images by moving dragged image to position of target image
function reorderImages(draggedImageName, targetImageName) {
    const images = getCurrentObjectImages();
    const draggedIndex = images.findIndex(img => img.name === draggedImageName);
    const targetIndex = images.findIndex(img => img.name === targetImageName);

    if (draggedIndex === -1 || targetIndex === -1) return;

    // Remove dragged image from array
    const [draggedImage] = images.splice(draggedIndex, 1);

    // Insert at target slot (indices shift after removal when dragging downward)
    let insertAt = targetIndex;
    if (draggedIndex < targetIndex) insertAt = targetIndex - 1;
    images.splice(insertAt, 0, draggedImage);

    // Refresh the thumbnail display
    const thumbnailsContainer = document.querySelector('.images-thumbnails-scroll');
    if (thumbnailsContainer) {
        loadImagesFromDirectory(thumbnailsContainer);
    }
}
// No default preloaded images; objects start without images
// Editor instance
let imageEditor = null;
let currentImageFilename = null;
let currentImageInfo = null;
let imageRevision = 0; // increment to bust caches when saving

function removeImageAssetContextMenu() {
    const el = document.getElementById('__image_asset_ctx_menu');
    if (el && el.parentNode) el.parentNode.removeChild(el);
}
let _imageAssetCtxMenuDismissBound = false;
function bindImageAssetContextMenuDismiss() {
    if (_imageAssetCtxMenuDismissBound) return;
    _imageAssetCtxMenuDismissBound = true;
    document.addEventListener('mousedown', (ev) => {
        const menu = document.getElementById('__image_asset_ctx_menu');
        if (!menu || menu.contains(ev.target)) return;
        removeImageAssetContextMenu();
    }, true);
}
function sanitizeImageDownloadFilename(name) {
    const raw = name || `image_${Date.now()}.png`;
    const safeBase = String(raw).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '') || 'image';
    return /\.(png|gif|jpe?g|webp)$/i.test(safeBase) ? safeBase : `${safeBase}.png`;
}
function downloadImageAssetToComputer(src, filename) {
    const name = sanitizeImageDownloadFilename(filename);
    const finishBlob = (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1500);
    };
    if (typeof src === 'string' && src.startsWith('data:')) {
        const a = document.createElement('a');
        a.href = src;
        a.download = name;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
    }
    fetch(src)
        .then(r => {
            if (!r.ok) throw new Error('fetch failed');
            return r.blob();
        })
        .then(finishBlob)
        .catch(() => {
            const a = document.createElement('a');
            a.href = src;
            a.download = name;
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            a.remove();
        });
}
function showImageAssetSaveMenu(clientX, clientY, imgInfo) {
    bindImageAssetContextMenuDismiss();
    removeImageAssetContextMenu();
    const menu = document.createElement('div');
    menu.id = '__image_asset_ctx_menu';
    menu.setAttribute('role', 'menu');
    menu.className = 'ctx-menu';
    const dupBtn = document.createElement('button');
    dupBtn.type = 'button';
    dupBtn.textContent = 'Duplicate';
    dupBtn.setAttribute('role', 'menuitem');
    dupBtn.className = 'ctx-menu-item';
    dupBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        removeImageAssetContextMenu();
        duplicateObjectImage(imgInfo).catch((e) => console.warn('Duplicate image failed', e));
    });
    menu.appendChild(dupBtn);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Save image';
    btn.setAttribute('role', 'menuitem');
    btn.className = 'ctx-menu-item';
    btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        downloadImageAssetToComputer(imgInfo.src, imgInfo.name);
        removeImageAssetContextMenu();
    });
    menu.appendChild(btn);
    document.body.appendChild(menu);
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    let lx = clientX;
    let ly = clientY;
    if (lx + w > window.innerWidth - 8) lx = window.innerWidth - w - 8;
    if (ly + h > window.innerHeight - 8) ly = window.innerHeight - h - 8;
    menu.style.left = `${Math.max(8, lx)}px`;
    menu.style.top = `${Math.max(8, ly)}px`;
}

// Update workspace with node blocks or images interface
function updateWorkspace() {
    const nodeWindow = document.getElementById('node-window');
    removeCodeBlockContextMenu();

    const scrollHostBefore = getCodeScrollContainer();
    const prevScrollLeft = scrollHostBefore ? scrollHostBefore.scrollLeft : 0;
    const prevScrollTop = scrollHostBefore ? scrollHostBefore.scrollTop : 0;

    stopSoundTabPlayback();
    soundSelectionHandler = null;
    nodeWindow.innerHTML = '';

    if (activeTab === 'code') {
        nodeWindow.classList.add('code-tab-active');
        nodeWindow.style.overflow = 'hidden';

        const codeViewport = document.createElement('div');
        codeViewport.id = 'code-viewport';

        const sizer = document.createElement('div');
        sizer.id = 'code-zoom-sizer';

        const zoomLayer = document.createElement('div');
        zoomLayer.id = 'code-zoom-layer';

        sizer.appendChild(zoomLayer);

        zoomLayer.appendChild(connectionCanvas);

        const selectedObj = objects.find(obj => obj.id == selected_object);
        if (!selectedObj) return;

        syncCodeSelectionOwnership(selectedObj);
        zoomLayer.addEventListener('mousedown', onCodeZoomLayerMouseDown);
        zoomLayer.addEventListener('contextmenu', onCodeBlockLayerContextMenu);

        selectedObj.code.forEach(codeData => {
            const block = createNodeBlock(
                codeData,
                codeData.position.x,
                codeData.position.y
            );
            zoomLayer.appendChild(block);
        });
        applyCodeBlockSelectionClasses(zoomLayer);

        codeViewport.appendChild(sizer);

        nodeWindow.appendChild(codeViewport);
        nodeWindow.appendChild(createCodeZoomControls());
        try {
            window.lucide && window.lucide.createIcons && window.lucide.createIcons();
        } catch (_) {}

        ensureScrollableWorkspace();
        setCodeZoom(codeZoom);
        requestAnimationFrame(() => {
            try {
                codeViewport.scrollLeft = prevScrollLeft;
                codeViewport.scrollTop = prevScrollTop;
            } catch (_) {}
            requestAnimationFrame(() => {
                try {
                    codeViewport.scrollLeft = prevScrollLeft;
                    codeViewport.scrollTop = prevScrollTop;
                } catch (_) {}
                drawConnections();
            });
        });
    } else if (activeTab === 'images') {
        nodeWindow.classList.remove('code-tab-active');
        nodeWindow.style.overflow = '';
        // Create images tab interface
        createImagesInterface(nodeWindow);
        // Draw crosshair when switching to images tab
        if (imageEditor) {
            setTimeout(() => imageEditor.drawCrosshair && imageEditor.drawCrosshair(), 100);
        }
    } else if (activeTab === 'sound') {
        nodeWindow.classList.remove('code-tab-active');
        nodeWindow.style.overflow = '';
        createSoundInterface(nodeWindow);
    } else {
        nodeWindow.classList.remove('code-tab-active');
        nodeWindow.style.overflow = '';
        // Show a message for non-code tabs (no canvas, no connections)
        const message = document.createElement('div');
        message.className = 'tab-placeholder';
        message.innerHTML = `${activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}<br>Coming Soon`;
        nodeWindow.appendChild(message);
    }
}
// Create the images interface
function createImagesInterface(container) {
    // Create main container
    const imagesContainer = document.createElement('div');
    imagesContainer.className = 'images-container';

    // Create top editing panel
    const editingPanel = document.createElement('div');
    editingPanel.className = 'image-editing-panel';

    // Drawing tools toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'images-toolbar';

    function setIcon(el, iconNameOrNames, fallbackText) {
        const names = Array.isArray(iconNameOrNames) ? iconNameOrNames : [iconNameOrNames];
        const primary = names[0];
        const lucide = window.lucide;

        // Always render a visible fallback so buttons never look "blank" if icon rendering fails.
        // If lucide succeeds, CSS hides the fallback when an SVG is present.
        const safeFallback = (fallbackText == null) ? '' : String(fallbackText);

        // Prefer direct SVG rendering when available.
        if (lucide && lucide.icons) {
            const found = names.find(n => lucide.icons && lucide.icons[n]);
            const iconDef = found ? lucide.icons[found] : null;
            if (iconDef && typeof iconDef.toSvg === 'function') {
                el.innerHTML = `${iconDef.toSvg({ width: 18, height: 18 })}<span class="icon-fallback">${safeFallback}</span>`;
                return;
            }
        }

        // Fallback to createIcons() + data-lucide scan.
        if (lucide && typeof lucide.createIcons === 'function') {
            el.innerHTML = `<i data-lucide="${primary}"></i><span class="icon-fallback">${safeFallback}</span>`;
            return;
        }

        el.textContent = safeFallback;
    }

    function refreshLucideIcons() {
        try { window.lucide && window.lucide.createIcons && window.lucide.createIcons(); } catch (_) {}
    }

    const toolNames = [
        { id: 'brush', icon: ['brush', 'paintbrush'], fallback: 'B', title: 'Brush' },
        { id: 'rect', icon: ['square'], fallback: '▭', title: 'Rectangle' },
        { id: 'circle', icon: ['circle'], fallback: '◯', title: 'Circle' },
        { id: 'bucket', icon: ['paint-bucket', 'bucket'], fallback: 'F', title: 'Fill (Bucket)' },
        {
            id: 'select',
            icon: ['square-dashed-mouse-pointer', 'mouse-pointer-square-dashed', 'crop', 'scan-line', 'square-dashed'],
            fallback: '▢',
            title: 'Select — lift pixels; top handle rotates (Shift = 45° steps); Shift+drag corners for square · Enter places, Esc cancels',
        },
    ];
    const toolButtons = {};
    function updateShapeToolFillIndicators() {
        if (!imageEditor || !imageEditor.getFill) return;
        const fill = imageEditor.getFill();
        const rectBtn = toolButtons.rect;
        const circBtn = toolButtons.circle;
        if (rectBtn) {
            rectBtn.classList.toggle('shape-fill', fill);
            rectBtn.classList.toggle('shape-outline', !fill);
            setIcon(rectBtn, ['square'], '▭');
            rectBtn.title = fill
                ? 'Rectangle (filled) — click again for outline'
                : 'Rectangle (outline) — click again for fill';
        }
        if (circBtn) {
            circBtn.classList.toggle('shape-fill', fill);
            circBtn.classList.toggle('shape-outline', !fill);
            setIcon(circBtn, ['circle'], '◯');
            circBtn.title = fill
                ? 'Circle (filled) — click again for outline'
                : 'Circle (outline) — click again for fill';
        }
        refreshLucideIcons();
    }
    toolNames.forEach(t => {
        const btn = document.createElement('button');
        setIcon(btn, t.icon, t.fallback);
        btn.className = 'image-edit-tool';
        btn.dataset.tool = t.id;
        btn.title = t.title;
        btn.addEventListener('click', () => {
            if (imageEditor && (t.id === 'rect' || t.id === 'circle') && imageEditor.getTool && imageEditor.getTool() === t.id) {
                imageEditor.toggleFill();
                updateShapeToolFillIndicators();
                return;
            }
            if (imageEditor) imageEditor.setTool(t.id);
            Object.values(toolButtons).forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updateShapeToolFillIndicators();
        });
        toolButtons[t.id] = btn;
        toolbar.appendChild(btn);
    });

    // Symmetry toggle (cycles: off -> X -> Y -> XY)
    const sep1 = document.createElement('div');
    sep1.className = 'image-toolbar-separator';
    toolbar.appendChild(sep1);

    const symmetryBtn = document.createElement('button');
    symmetryBtn.className = 'image-edit-tool';
    symmetryBtn.title = 'Symmetry: Off';
    symmetryBtn.dataset.mode = 'none';
    const symmetryModes = ['none', 'x', 'y', 'xy'];
    function applySymmetryMode(mode) {
        symmetryBtn.dataset.mode = mode;
        if (mode === 'none') {
            setIcon(symmetryBtn, ['flip-horizontal', 'flip-horizontal-2'], 'SYM');
            symmetryBtn.title = 'Symmetry: Off';
        } else if (mode === 'x') {
            setIcon(symmetryBtn, ['flip-horizontal', 'flip-horizontal-2'], '↔');
            symmetryBtn.title = 'Symmetry: Mirror Left/Right';
        } else if (mode === 'y') {
            setIcon(symmetryBtn, ['flip-vertical', 'flip-vertical-2'], '↕');
            symmetryBtn.title = 'Symmetry: Mirror Up/Down';
        } else {
            setIcon(symmetryBtn, 'grid-2x2', '⤧');
            symmetryBtn.title = 'Symmetry: Both';
        }
        refreshLucideIcons();
        if (imageEditor && imageEditor.setSymmetry) imageEditor.setSymmetry(mode);
        if (imageEditor && imageEditor.drawCrosshair) imageEditor.drawCrosshair();
        // Make it look toggled when enabled
        symmetryBtn.classList.toggle('active', mode !== 'none');
    }
    symmetryBtn.addEventListener('click', () => {
        const cur = symmetryBtn.dataset.mode || 'none';
        const idx = symmetryModes.indexOf(cur);
        const next = symmetryModes[(idx + 1) % symmetryModes.length];
        applySymmetryMode(next);
    });
    toolbar.appendChild(symmetryBtn);

    const RECENT_IMAGE_COLORS_KEY = 'maxiverseImageRecentColors';
    function normalizeImageHex(s) {
        if (typeof s !== 'string') return null;
        let h = s.trim();
        if (!h.startsWith('#')) h = `#${h}`;
        if (/^#([0-9a-f]{3})$/i.test(h)) {
            const m = h.slice(1);
            return (`#${m[0]}${m[0]}${m[1]}${m[1]}${m[2]}${m[2]}`).toLowerCase();
        }
        if (/^#([0-9a-f]{6})$/i.test(h)) return h.toLowerCase();
        return null;
    }
    function rgbToHex(r, g, b) {
        return `#${[r, g, b]
            .map((x) => {
                const v = Math.max(0, Math.min(255, x | 0));
                return v.toString(16).padStart(2, '0');
            })
            .join('')}`;
    }
    function hexToRgbVals(hex) {
        const n = normalizeImageHex(hex);
        if (!n) return null;
        const h = n.slice(1);
        return [
            parseInt(h.slice(0, 2), 16),
            parseInt(h.slice(2, 4), 16),
            parseInt(h.slice(4, 6), 16),
        ];
    }
    function rgbToHsv01(r, g, b) {
        r /= 255;
        g /= 255;
        b /= 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;
        let hh = 0;
        if (d > 1e-8) {
            if (max === r) hh = ((g - b) / d + (g < b ? 6 : 0)) / 6;
            else if (max === g) hh = ((b - r) / d + 2) / 6;
            else hh = ((r - g) / d + 4) / 6;
        }
        const s = max < 1e-8 ? 0 : d / max;
        const v = max;
        return { h: hh * 360, s, v };
    }
    function hsv01ToRgb(h, s, v) {
        h = ((h % 360) + 360) % 360;
        const c = v * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = v - c;
        let rp = 0;
        let gp = 0;
        let bp = 0;
        if (h < 60) [rp, gp, bp] = [c, x, 0];
        else if (h < 120) [rp, gp, bp] = [x, c, 0];
        else if (h < 180) [rp, gp, bp] = [0, c, x];
        else if (h < 240) [rp, gp, bp] = [0, x, c];
        else if (h < 300) [rp, gp, bp] = [x, 0, c];
        else [rp, gp, bp] = [c, 0, x];
        return [
            Math.round((rp + m) * 255),
            Math.round((gp + m) * 255),
            Math.round((bp + m) * 255),
        ];
    }
    function hslToRgb(h, s, l) {
        h /= 360;
        let r;
        let g;
        let b;
        if (s === 0) {
            r = g = b = l;
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1 / 3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1 / 3);
        }
        return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    }
    function hslToHex(hDeg, s01, l01) {
        const [r, g, b] = hslToRgb(hDeg, s01, l01);
        return rgbToHex(r, g, b);
    }
    function buildImageColorPopupGridHexes() {
        const seen = new Set();
        const out = [];
        const add = (hex) => {
            const n = normalizeImageHex(hex);
            if (n && !seen.has(n)) {
                seen.add(n);
                out.push(n);
            }
        };
        [
            '#000000',
            '#0f0f0f',
            '#1a1a1a',
            '#2a2a2a',
            '#404040',
            '#5c5c5c',
            '#787878',
            '#9e9e9e',
            '#bdbdbd',
            '#e0e0e0',
            '#f5f5f5',
            '#ffffff',
        ].forEach(add);
        ['#1b0f0a', '#3e2723', '#5d4037', '#6d4c41', '#8d6e63', '#a1887f', '#bcaaa4', '#d7ccc8'].forEach(add);
        ['#1a237e', '#283593', '#3949ab', '#5c6bc0', '#7e57c2', '#8e24aa', '#ad1457', '#c62828', '#d84315', '#ef6c00', '#f9a825', '#f57f17', '#558b2f', '#33691e', '#00695c', '#00838f', '#0277bd'].forEach(add);
        for (let L = 0.26; L <= 0.74; L += 0.12) {
            for (let hue = 0; hue < 360; hue += 24) {
                add(hslToHex(hue, 0.82, L));
            }
        }
        for (let hue = 0; hue < 360; hue += 20) {
            add(hslToHex(hue, 0.42, 0.86));
        }
        for (let hue = 0; hue < 360; hue += 20) {
            add(hslToHex(hue, 0.92, 0.2));
        }
        for (let hue = 0; hue < 360; hue += 30) {
            add(hslToHex(hue, 0.18, 0.48));
        }
        return out;
    }
    function readRecentImageColors() {
        try {
            const raw = localStorage.getItem(RECENT_IMAGE_COLORS_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(arr)) return [];
            return arr.map(normalizeImageHex).filter(Boolean).slice(0, 7);
        } catch (_) {
            return [];
        }
    }
    function writeRecentImageColors(arr) {
        try {
            localStorage.setItem(RECENT_IMAGE_COLORS_KEY, JSON.stringify(arr.slice(0, 7)));
        } catch (_) {}
    }

    // Color: opaque from picker; transparent control = alpha 0 (erase)
    let paintAlpha = 1;
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = '#ff0000';
    colorInput.title = 'System color dialog';
    colorInput.className = 'image-color image-color--native-hidden';
    const transparentBtn = document.createElement('button');
    transparentBtn.type = 'button';
    transparentBtn.className = 'image-transparent-btn';
    transparentBtn.title = 'Transparent — paints with 0 alpha (erase)';
    transparentBtn.setAttribute('aria-label', 'Transparent color');

    const colorWrap = document.createElement('div');
    colorWrap.className = 'image-color-wrap';
    colorWrap.title = 'Brush color';
    const colorSwatchSlot = document.createElement('div');
    colorSwatchSlot.className = 'image-color-swatch-slot image-color-swatch-slot--current';
    colorSwatchSlot.title = 'Current color (most recent)';
    const swatchUnlockCover = document.createElement('button');
    swatchUnlockCover.type = 'button';
    swatchUnlockCover.className = 'image-color-swatch-unlock';
    swatchUnlockCover.title = 'Switch to opaque color (palette opens on next click)';
    swatchUnlockCover.setAttribute('aria-label', 'Switch to opaque color');
    const colorPreviewBtn = document.createElement('button');
    colorPreviewBtn.type = 'button';
    colorPreviewBtn.className = 'image-color-preview-btn';
    colorPreviewBtn.title = 'Choose color';
    colorSwatchSlot.appendChild(colorPreviewBtn);
    colorSwatchSlot.appendChild(colorInput);
    colorSwatchSlot.appendChild(swatchUnlockCover);
    colorWrap.appendChild(colorSwatchSlot);
    colorWrap.appendChild(transparentBtn);

    const paletteRow = document.createElement('div');
    paletteRow.className = 'image-color-palette';

    const recentInitial = readRecentImageColors();
    if (recentInitial.length) colorInput.value = recentInitial[0];

    function renderRecentPalette() {
        paletteRow.innerHTML = '';
        paletteRow.title = 'Six older colors from history (newest is the large swatch)';
        const recent = readRecentImageColors();
        // recent[0] is always the large picker swatch; palette shows recent[1..6] only
        for (let i = 1; i < 7; i++) {
            const hex = recent[i];
            if (hex) {
                const sw = document.createElement('button');
                sw.type = 'button';
                sw.className = 'image-color-palette-swatch';
                sw.style.background = hex;
                sw.title = hex.toUpperCase();
                sw.dataset.hex = hex;
                sw.addEventListener('click', (e) => {
                    e.preventDefault();
                    colorInput.value = hex;
                    paintAlpha = 1;
                    syncPaintAlphaUI();
                    updateColorPreview();
                    applyColorFromUI();
                    pushRecentImageColor(hex);
                });
                paletteRow.appendChild(sw);
            } else {
                const empty = document.createElement('span');
                empty.className = 'image-color-palette-slot--empty';
                empty.title = 'Pick colors to build history';
                empty.addEventListener('click', () => {
                    if (colorInput.style.pointerEvents === 'none') return;
                    openColorPopup();
                });
                paletteRow.appendChild(empty);
            }
        }
    }

    function pushRecentImageColor(hex) {
        const n = normalizeImageHex(hex);
        if (!n) return;
        const list = readRecentImageColors().filter(h => h !== n);
        list.unshift(n);
        writeRecentImageColors(list);
        renderRecentPalette();
    }

    function updateColorPreview() {
        colorPreviewBtn.style.backgroundColor = colorInput.value;
    }

    let colorPopupRoot = null;
    function closeColorPopup() {
        if (!colorPopupRoot) return;
        colorPopupRoot.classList.remove('is-open');
        colorPopupRoot.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', onColorPopupEsc);
    }
    function resetColorPopupToPalette() {
        if (!colorPopupRoot) return;
        const grid = colorPopupRoot.querySelector('.image-color-popup-grid');
        const moreBtn = colorPopupRoot.querySelector('.image-color-popup-more');
        const custom = colorPopupRoot.querySelector('.image-color-popup-custom');
        const panel = colorPopupRoot.querySelector('.image-color-popup-panel');
        const sampleRow = colorPopupRoot.querySelector('.image-color-popup-sample-row');
        if (!grid || !moreBtn || !custom || !panel) return;
        grid.style.display = '';
        if (sampleRow) sampleRow.style.display = '';
        moreBtn.style.display = '';
        custom.setAttribute('hidden', '');
        panel.classList.remove('image-color-popup-panel--custom');
    }
    function onColorPopupEsc(e) {
        if (e.key === 'Escape') closeColorPopup();
    }
    function positionColorPopup() {
        if (!colorPopupRoot) return;
        const panel = colorPopupRoot.querySelector('.image-color-popup-panel');
        const margin = 8;
        const pw = panel.offsetWidth || 280;
        const ph = panel.offsetHeight || 200;
        const rect = colorPreviewBtn.getBoundingClientRect();
        let left = rect.left;
        let top = rect.bottom + margin;
        if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
        if (left < margin) left = margin;
        if (top + ph > window.innerHeight - margin) top = rect.top - ph - margin;
        if (top < margin) top = margin;
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
    }
    function syncRgbReadout() {
        const rgb = hexToRgbVals(colorInput.value);
        const text = rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : '';
        if (!colorPopupRoot) return;
        const pal = colorPopupRoot.querySelector('.image-color-popup-rgb--palette');
        const cust = colorPopupRoot.querySelector('.image-color-popup-rgb--custom');
        if (pal) pal.textContent = text;
        if (cust) cust.textContent = text;
    }
    let _canvasPickActive = false;
    function startCanvasColorPick() {
        if (!editorCanvas || _canvasPickActive) return;
        _canvasPickActive = true;
        const prevCursor = editorCanvas.style.cursor;
        editorCanvas.style.cursor = 'crosshair';
        const wrapper = editorCanvas.parentElement;
        if (wrapper) wrapper.style.cursor = 'crosshair';

        function cleanup() {
            _canvasPickActive = false;
            editorCanvas.style.cursor = prevCursor;
            if (wrapper) wrapper.style.cursor = '';
            editorCanvas.removeEventListener('pointerdown', onPick, true);
            document.removeEventListener('keydown', onCancel, true);
        }

        function onPick(e) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            cleanup();
            const rect = editorCanvas.getBoundingClientRect();
            const x = Math.floor((e.clientX - rect.left) / rect.width * editorCanvas.width);
            const y = Math.floor((e.clientY - rect.top) / rect.height * editorCanvas.height);
            if (x < 0 || x >= editorCanvas.width || y < 0 || y >= editorCanvas.height) return;

            let pixel;
            try {
                pixel = editorCanvas.getContext('2d').getImageData(x, y, 1, 1).data;
            } catch (_) { return; }

            const hex = '#' + ((1 << 24) | (pixel[0] << 16) | (pixel[1] << 8) | pixel[2]).toString(16).slice(1);
            const normalized = normalizeImageHex(hex);
            if (!normalized) return;

            colorInput.value = normalized;
            paintAlpha = 1;
            syncPaintAlphaUI();
            updateColorPreview();
            applyColorFromUI();
            pushRecentImageColor(normalized);
            requestAnimationFrame(() => {
                openColorPopup();
                syncRgbReadout();
            });
        }

        function onCancel(e) {
            if (e.key !== 'Escape') return;
            cleanup();
        }

        editorCanvas.addEventListener('pointerdown', onPick, true);
        document.addEventListener('keydown', onCancel, true);
    }

    function ensureColorPopup() {
        if (colorPopupRoot) return;
        colorPopupRoot = document.createElement('div');
        colorPopupRoot.className = 'image-color-popup-root';
        colorPopupRoot.setAttribute('aria-hidden', 'true');
        const backdrop = document.createElement('div');
        backdrop.className = 'image-color-popup-backdrop';
        const panel = document.createElement('div');
        panel.className = 'image-color-popup-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Choose color');
        const grid = document.createElement('div');
        grid.className = 'image-color-popup-grid';
        buildImageColorPopupGridHexes().forEach((hex) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'image-color-popup-swatch';
            b.style.background = hex;
            b.title = hex.toUpperCase();
            b.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const n = normalizeImageHex(hex);
                if (!n) return;
                colorInput.value = n;
                paintAlpha = 1;
                syncPaintAlphaUI();
                updateColorPreview();
                syncRgbReadout();
                applyColorFromUI();
                pushRecentImageColor(n);
                closeColorPopup();
            });
            grid.appendChild(b);
        });
        const sampleRow = document.createElement('div');
        sampleRow.className = 'image-color-popup-sample-row';
        const sampleBtn = document.createElement('button');
        sampleBtn.type = 'button';
        sampleBtn.className = 'image-color-popup-sample';
        sampleBtn.setAttribute('aria-label', 'Sample color from screen');
        sampleBtn.title = 'Pick a color from anywhere on the screen (eyedropper)';
        setIcon(sampleBtn, ['pipette', 'eyedropper'], '◐');
        refreshLucideIcons();
        const eyeDropperAvailable =
            typeof window.EyeDropper === 'function' && window.isSecureContext;
        if (!eyeDropperAvailable) {
            sampleBtn.title = 'Pick a color from the canvas';
        }
        const rgbReadoutPalette = document.createElement('span');
        rgbReadoutPalette.className = 'image-color-popup-rgb image-color-popup-rgb--palette';
        rgbReadoutPalette.setAttribute('aria-live', 'polite');
        sampleBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (typeof window.EyeDropper === 'function' && window.isSecureContext) {
                let openPromise;
                try {
                    openPromise = new EyeDropper().open();
                } catch (_) {
                    return;
                }
                closeColorPopup();
                openPromise
                    .then((result) => {
                        const hex = normalizeImageHex(result.sRGBHex);
                        if (!hex) return;
                        colorInput.value = hex;
                        paintAlpha = 1;
                        syncPaintAlphaUI();
                        updateColorPreview();
                        applyColorFromUI();
                        pushRecentImageColor(hex);
                        requestAnimationFrame(() => {
                            openColorPopup();
                            syncRgbReadout();
                        });
                    })
                    .catch((err) => {
                        if (err && err.name === 'AbortError') return;
                    });
                return;
            }
            closeColorPopup();
            startCanvasColorPick();
        });
        sampleRow.appendChild(sampleBtn);
        sampleRow.appendChild(rgbReadoutPalette);
        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'image-color-popup-more';
        moreBtn.textContent = 'Custom color…';
        moreBtn.title = 'Full custom picker — hue, saturation, and brightness';
        let customH = 0;
        let customS = 1;
        let customV = 1;
        const customPanel = document.createElement('div');
        customPanel.className = 'image-color-popup-custom';
        customPanel.setAttribute('hidden', '');
        const customTop = document.createElement('div');
        customTop.className = 'image-color-popup-custom-top';
        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.className = 'image-color-popup-custom-back';
        backBtn.textContent = '← Palette';
        backBtn.title = 'Back to preset colors';
        customTop.appendChild(backBtn);
        const svCanvas = document.createElement('canvas');
        svCanvas.className = 'image-color-popup-sv';
        svCanvas.width = 200;
        svCanvas.height = 130;
        svCanvas.setAttribute('role', 'img');
        svCanvas.setAttribute('aria-label', 'Saturation and brightness');
        const svCtx = svCanvas.getContext('2d', { willReadFrequently: true });
        const hueInput = document.createElement('input');
        hueInput.type = 'range';
        hueInput.className = 'image-color-popup-hue';
        hueInput.min = '0';
        hueInput.max = '360';
        hueInput.step = '1';
        hueInput.title = 'Hue';
        hueInput.setAttribute('aria-label', 'Hue');
        const hexWrap = document.createElement('div');
        hexWrap.className = 'image-color-popup-hex-row';
        const hexLabel = document.createElement('label');
        hexLabel.className = 'image-color-popup-hex-label';
        hexLabel.textContent = 'Hex';
        hexLabel.htmlFor = 'image-color-popup-hex';
        const hexInput = document.createElement('input');
        hexInput.type = 'text';
        hexInput.id = 'image-color-popup-hex';
        hexInput.className = 'image-color-popup-hex';
        hexInput.spellcheck = false;
        hexInput.autocomplete = 'off';
        hexInput.maxLength = 7;
        hexInput.title = 'Color as #RRGGBB';
        hexInput.setAttribute('aria-label', 'Hex color');
        hexWrap.appendChild(hexLabel);
        hexWrap.appendChild(hexInput);
        const rgbRowCustom = document.createElement('div');
        rgbRowCustom.className = 'image-color-popup-rgb-row';
        const rgbLabelCustom = document.createElement('span');
        rgbLabelCustom.className = 'image-color-popup-rgb-label';
        rgbLabelCustom.textContent = 'RGB';
        const rgbReadoutCustom = document.createElement('span');
        rgbReadoutCustom.className = 'image-color-popup-rgb image-color-popup-rgb--custom';
        rgbReadoutCustom.setAttribute('aria-live', 'polite');
        rgbRowCustom.appendChild(rgbLabelCustom);
        rgbRowCustom.appendChild(rgbReadoutCustom);
        const nativeLink = document.createElement('button');
        nativeLink.type = 'button';
        nativeLink.className = 'image-color-popup-native';
        nativeLink.textContent = 'System color dialog…';
        nativeLink.title = 'Use the browser or OS color picker instead';
        function sVFromClient(clientX, clientY) {
            const rect = svCanvas.getBoundingClientRect();
            const x = (clientX - rect.left) / Math.max(1e-6, rect.width);
            const y = (clientY - rect.top) / Math.max(1e-6, rect.height);
            return {
                s: Math.max(0, Math.min(1, x)),
                v: Math.max(0, Math.min(1, 1 - y)),
            };
        }
        function drawSvPlane() {
            const w = svCanvas.width;
            const h = svCanvas.height;
            const img = svCtx.createImageData(w, h);
            const hh = customH;
            for (let py = 0; py < h; py++) {
                const vv = 1 - py / Math.max(1, h - 1);
                for (let px = 0; px < w; px++) {
                    const ss = px / Math.max(1, w - 1);
                    const [r, g, b] = hsv01ToRgb(hh, ss, vv);
                    const i = (py * w + px) * 4;
                    img.data[i] = r;
                    img.data[i + 1] = g;
                    img.data[i + 2] = b;
                    img.data[i + 3] = 255;
                }
            }
            svCtx.putImageData(img, 0, 0);
            const mx = customS * (w - 1);
            const my = (1 - customV) * (h - 1);
            svCtx.beginPath();
            svCtx.arc(mx, my, 5, 0, Math.PI * 2);
            svCtx.strokeStyle = 'rgba(255,255,255,0.95)';
            svCtx.lineWidth = 2;
            svCtx.stroke();
            svCtx.strokeStyle = 'rgba(0,0,0,0.5)';
            svCtx.lineWidth = 1;
            svCtx.stroke();
        }
        function applyCustomFromHsv(commitRecent) {
            const [r, g, b] = hsv01ToRgb(customH, customS, customV);
            const hex = rgbToHex(r, g, b);
            colorInput.value = hex;
            hexInput.value = hex;
            paintAlpha = 1;
            syncPaintAlphaUI();
            updateColorPreview();
            syncRgbReadout();
            applyColorFromUI();
            if (commitRecent) pushRecentImageColor(hex);
        }
        function syncCustomFromInput() {
            const rgb = hexToRgbVals(colorInput.value);
            if (!rgb) return;
            const o = rgbToHsv01(rgb[0], rgb[1], rgb[2]);
            customH = o.h;
            customS = o.s;
            customV = o.v;
            hueInput.value = String(Math.round(customH));
            const n = normalizeImageHex(colorInput.value);
            if (n) hexInput.value = n;
            drawSvPlane();
        }
        backBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            resetColorPopupToPalette();
            syncRgbReadout();
            requestAnimationFrame(() => positionColorPopup());
        });
        moreBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            grid.style.display = 'none';
            sampleRow.style.display = 'none';
            moreBtn.style.display = 'none';
            customPanel.removeAttribute('hidden');
            panel.classList.add('image-color-popup-panel--custom');
            syncCustomFromInput();
            syncRgbReadout();
            requestAnimationFrame(() => {
                positionColorPopup();
                hueInput.focus();
            });
        });
        hueInput.addEventListener('input', () => {
            customH = parseFloat(hueInput.value);
            if (!Number.isFinite(customH)) customH = 0;
            applyCustomFromHsv(false);
            drawSvPlane();
        });
        hueInput.addEventListener('change', () => {
            applyCustomFromHsv(true);
        });
        hexInput.addEventListener('input', () => {
            const n = normalizeImageHex(hexInput.value);
            if (!n) return;
            const rgb = hexToRgbVals(n);
            if (!rgb) return;
            const o = rgbToHsv01(rgb[0], rgb[1], rgb[2]);
            customH = o.h;
            customS = o.s;
            customV = o.v;
            hueInput.value = String(Math.round(customH));
            colorInput.value = n;
            paintAlpha = 1;
            syncPaintAlphaUI();
            updateColorPreview();
            syncRgbReadout();
            applyColorFromUI();
            drawSvPlane();
        });
        hexInput.addEventListener('change', () => {
            const n = normalizeImageHex(hexInput.value);
            if (n) pushRecentImageColor(n);
        });
        nativeLink.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            requestAnimationFrame(() => {
                try {
                    if (typeof colorInput.showPicker === 'function') colorInput.showPicker();
                    else colorInput.click();
                } catch (_) {
                    colorInput.click();
                }
            });
        });
        let svDrag = false;
        svCanvas.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            svDrag = true;
            try {
                svCanvas.setPointerCapture(e.pointerId);
            } catch (_) {}
            const { s, v } = sVFromClient(e.clientX, e.clientY);
            customS = s;
            customV = v;
            applyCustomFromHsv(false);
            drawSvPlane();
        });
        svCanvas.addEventListener('pointermove', (e) => {
            if (!svDrag) return;
            e.preventDefault();
            const { s, v } = sVFromClient(e.clientX, e.clientY);
            customS = s;
            customV = v;
            applyCustomFromHsv(false);
            drawSvPlane();
        });
        function endSvDrag(e) {
            if (!svDrag) return;
            svDrag = false;
            try {
                svCanvas.releasePointerCapture(e.pointerId);
            } catch (_) {}
            applyCustomFromHsv(true);
        }
        svCanvas.addEventListener('pointerup', endSvDrag);
        svCanvas.addEventListener('pointercancel', endSvDrag);
        svCanvas.style.touchAction = 'none';
        customPanel.appendChild(customTop);
        customPanel.appendChild(svCanvas);
        customPanel.appendChild(hueInput);
        customPanel.appendChild(hexWrap);
        customPanel.appendChild(rgbRowCustom);
        customPanel.appendChild(nativeLink);
        panel.appendChild(grid);
        panel.appendChild(sampleRow);
        panel.appendChild(moreBtn);
        panel.appendChild(customPanel);
        backdrop.addEventListener('click', closeColorPopup);
        colorPopupRoot.appendChild(backdrop);
        colorPopupRoot.appendChild(panel);
        document.body.appendChild(colorPopupRoot);
        refreshLucideIcons();
    }
    function openColorPopup() {
        if (paintAlpha < 0.5) return;
        ensureColorPopup();
        if (colorPopupRoot.classList.contains('is-open')) return;
        resetColorPopupToPalette();
        document.removeEventListener('keydown', onColorPopupEsc);
        colorPopupRoot.classList.add('is-open');
        colorPopupRoot.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => {
            positionColorPopup();
            requestAnimationFrame(() => positionColorPopup());
        });
        document.addEventListener('keydown', onColorPopupEsc);
        syncRgbReadout();
    }

    renderRecentPalette();
    updateColorPreview();

    const colorBlock = document.createElement('div');
    colorBlock.className = 'image-color-block';
    colorBlock.appendChild(colorWrap);
    colorBlock.appendChild(paletteRow);

    function syncPaintAlphaUI() {
        const transparent = paintAlpha < 0.5;
        transparentBtn.classList.toggle('active', transparent);
        transparentBtn.setAttribute('aria-pressed', transparent ? 'true' : 'false');
        transparentBtn.title = transparent
            ? 'Opaque color — first click swatch (no picker), then pick color'
            : 'Transparent (erase) — click to toggle, or right-drag on the canvas with the brush';
        colorWrap.classList.toggle('image-color-wrap--transparent', transparent);
        colorWrap.classList.toggle('image-color-wrap--opaque', !transparent);
        swatchUnlockCover.style.display = transparent ? 'flex' : 'none';
        colorInput.style.pointerEvents = transparent ? 'none' : 'auto';
        colorSwatchSlot.title = transparent
            ? 'Click to leave erase mode, then choose a color'
            : 'Click to choose color';
    }

    const sizeInput = document.createElement('input');
    sizeInput.type = 'range';
    sizeInput.min = '1';
    sizeInput.max = '100';
    sizeInput.value = '16';
    sizeInput.title = 'Brush size';
    sizeInput.className = 'image-range image-range-size';
    const sizeNum = document.createElement('input');
    sizeNum.type = 'number';
    sizeNum.min = '1';
    sizeNum.max = '100';
    sizeNum.step = '1';
    sizeNum.value = '16';
    sizeNum.className = 'image-value-input';
    sizeNum.title = 'Brush size';
    sizeNum.setAttribute('aria-label', 'Brush size');

    function setBrushSizeUI(next) {
        const clamped = Math.max(1, Math.min(100, next | 0));
        sizeInput.value = String(clamped);
        sizeNum.value = String(clamped);
        if (imageEditor) imageEditor.setBrushSize(clamped);
    }
    // Slider must drive size directly — do not prefer the number field or drags are ignored.
    sizeInput.addEventListener('input', () => {
        const v = parseInt(sizeInput.value, 10);
        if (Number.isFinite(v)) setBrushSizeUI(v);
    });
    sizeNum.addEventListener('input', () => {
        const v = parseInt(sizeNum.value, 10);
        if (Number.isFinite(v)) setBrushSizeUI(v);
    });
    sizeNum.addEventListener('blur', () => {
        let v = parseInt(sizeNum.value, 10);
        if (!Number.isFinite(v)) v = 16;
        setBrushSizeUI(v);
    });

    // Undo / Redo
    const undoBtn = document.createElement('button');
    setIcon(undoBtn, ['undo', 'undo-2', 'undo2'], '↩');
    undoBtn.className = 'image-edit-tool';
    undoBtn.title = 'Undo';
    undoBtn.addEventListener('click', () => imageEditor && imageEditor.undo());
    const redoBtn = document.createElement('button');
    setIcon(redoBtn, ['redo', 'redo-2', 'redo2'], '↪');
    redoBtn.className = 'image-edit-tool';
    redoBtn.title = 'Redo';
    redoBtn.addEventListener('click', () => imageEditor && imageEditor.redo());

    // Clear
    const clearBtn = document.createElement('button');
    setIcon(clearBtn, 'trash-2', 'CLR');
    clearBtn.className = 'image-edit-tool';
    clearBtn.title = 'Clear';
    clearBtn.addEventListener('click', () => imageEditor && imageEditor.clear());

    function applyColorFromUI() {
        if (!imageEditor) return;
        imageEditor.setColor(colorInput.value, paintAlpha);
    }
    function onColorPickerInput() {
        paintAlpha = 1;
        syncPaintAlphaUI();
        updateColorPreview();
        syncRgbReadout();
        applyColorFromUI();
    }
    function onColorPickerChange() {
        onColorPickerInput();
        pushRecentImageColor(colorInput.value);
    }
    colorInput.addEventListener('input', onColorPickerInput);
    colorInput.addEventListener('change', onColorPickerChange);
    colorPreviewBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (paintAlpha < 0.5) return;
        openColorPopup();
    });
    swatchUnlockCover.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        paintAlpha = 1;
        syncPaintAlphaUI();
        updateColorPreview();
        applyColorFromUI();
    });
    transparentBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (paintAlpha < 0.5) {
            paintAlpha = 1;
            syncPaintAlphaUI();
            updateColorPreview();
            applyColorFromUI();
        } else {
            paintAlpha = 0;
            syncPaintAlphaUI();
            applyColorFromUI();
        }
    });

    const sizeGroup = document.createElement('div');
    sizeGroup.className = 'image-control-group';
    const sizeRow = document.createElement('div');
    sizeRow.className = 'image-control-row';
    sizeRow.appendChild(sizeInput);
    sizeRow.appendChild(sizeNum);
    sizeGroup.title = 'Brush size';
    sizeGroup.appendChild(sizeRow);
    toolbar.appendChild(colorBlock);
    toolbar.appendChild(sizeGroup);
    toolbar.appendChild(undoBtn);
    toolbar.appendChild(redoBtn);
    toolbar.appendChild(clearBtn);
    editingPanel.appendChild(toolbar);

    // Create main content area (split view)
    const contentArea = document.createElement('div');
    contentArea.className = 'images-content';

    // Left scroll view for image thumbnails
    const leftPanel = document.createElement('div');
    leftPanel.className = 'images-left-panel';

    // Create thumbnails container
    const thumbnailsContainer = document.createElement('div');
    thumbnailsContainer.className = 'images-thumbnails-scroll';

    // Load and display images from ./images/0/
    loadImagesFromDirectory(thumbnailsContainer);

    // Add action buttons row at bottom (Add + Upload)
    const actionsRow = document.createElement('div');
    actionsRow.className = 'images-actions-row';

    const addBtn = document.createElement('button');
    addBtn.className = 'images-action-btn images-action-btn--primary';
    addBtn.type = 'button';
    setIcon(addBtn, 'plus', '+');
    addBtn.title = 'Add new image';
    addBtn.addEventListener('click', () => createNewImage());

    const uploadBtn = document.createElement('button');
    uploadBtn.className = 'images-action-btn images-action-btn--secondary';
    uploadBtn.type = 'button';
    setIcon(uploadBtn, ['upload', 'upload-cloud'], '↑');
    uploadBtn.title = 'Upload image file';
    uploadBtn.addEventListener('click', () => triggerUploadImage());

    actionsRow.appendChild(addBtn);
    actionsRow.appendChild(uploadBtn);

    leftPanel.appendChild(thumbnailsContainer);
    leftPanel.appendChild(actionsRow);

    // Right preview area
    const rightPanel = document.createElement('div');
    rightPanel.className = 'images-right-panel';

    // Image preview container
    const previewContainer = document.createElement('div');
    previewContainer.className = 'image-preview-container';

    // Canvas size: fixed top-right of preview (outside pan/zoom drawing area)
    const dimW = document.createElement('input');
    dimW.type = 'number';
    dimW.min = '1';
    dimW.max = '4096';
    dimW.id = '__image_canvas_resize_w';
    dimW.className = 'image-value-input image-canvas-resize-input';
    dimW.title = 'Canvas width (pixels)';
    dimW.setAttribute('aria-label', 'Canvas width');
    const dimSep = document.createElement('span');
    dimSep.className = 'image-canvas-resize-sep';
    dimSep.textContent = '\u00d7';
    dimSep.setAttribute('aria-hidden', 'true');
    const dimH = document.createElement('input');
    dimH.type = 'number';
    dimH.min = '1';
    dimH.max = '4096';
    dimH.id = '__image_canvas_resize_h';
    dimH.className = 'image-value-input image-canvas-resize-input';
    dimH.title = 'Canvas height (pixels)';
    dimH.setAttribute('aria-label', 'Canvas height');

    function syncCanvasDimensionsUI() {
        if (!imageEditor || typeof imageEditor.getCanvasSize !== 'function') return;
        const sz = imageEditor.getCanvasSize();
        dimW.value = String(sz.width);
        dimH.value = String(sz.height);
    }
    function applyCanvasDimensionsFromUI() {
        if (!imageEditor || typeof imageEditor.setCanvasSize !== 'function') return;
        const w = parseInt(dimW.value, 10);
        const h = parseInt(dimH.value, 10);
        if (!Number.isFinite(w) || !Number.isFinite(h)) {
            syncCanvasDimensionsUI();
            return;
        }
        imageEditor.setCanvasSize(w, h);
    }
    dimW.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            applyCanvasDimensionsFromUI();
            dimW.blur();
        }
    });
    dimH.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            applyCanvasDimensionsFromUI();
            dimH.blur();
        }
    });

    const resizeFlyout = document.createElement('div');
    resizeFlyout.className = 'image-canvas-resize-flyout';

    const resizeToggleBtn = document.createElement('button');
    resizeToggleBtn.type = 'button';
    resizeToggleBtn.className = 'image-canvas-resize-toggle';
    resizeToggleBtn.title = 'Canvas size (px)';
    resizeToggleBtn.setAttribute('aria-label', 'Canvas size — width and height in pixels');
    resizeToggleBtn.setAttribute('aria-expanded', 'false');
    resizeToggleBtn.setAttribute('aria-controls', '__image_canvas_resize_panel');
    const resizeToggleIcon = document.createElement('span');
    resizeToggleIcon.className = 'image-canvas-resize-toggle-icon';
    setIcon(resizeToggleIcon, ['maximize-2', 'expand'], '⛶');
    resizeToggleBtn.appendChild(resizeToggleIcon);

    const resizeBody = document.createElement('div');
    resizeBody.className = 'image-canvas-resize-body';
    resizeBody.id = '__image_canvas_resize_panel';
    resizeBody.hidden = true;
    resizeBody.setAttribute('role', 'region');
    resizeBody.setAttribute('aria-label', 'Canvas dimensions');

    const resizeFieldsRow = document.createElement('div');
    resizeFieldsRow.className = 'image-canvas-resize-fields';

    const lblW = document.createElement('label');
    lblW.className = 'image-canvas-resize-field-label';
    lblW.htmlFor = dimW.id;
    lblW.textContent = 'Width';
    const lblMid = document.createElement('span');
    lblMid.className = 'image-canvas-resize-label-spacer';
    lblMid.setAttribute('aria-hidden', 'true');
    const lblH = document.createElement('label');
    lblH.className = 'image-canvas-resize-field-label';
    lblH.htmlFor = dimH.id;
    lblH.textContent = 'Height';

    resizeFieldsRow.appendChild(lblW);
    resizeFieldsRow.appendChild(lblMid);
    resizeFieldsRow.appendChild(lblH);
    resizeFieldsRow.appendChild(dimW);
    resizeFieldsRow.appendChild(dimSep);
    resizeFieldsRow.appendChild(dimH);

    const resizeFooter = document.createElement('div');
    resizeFooter.className = 'image-canvas-resize-footer';
    const resizeApplyBtn = document.createElement('button');
    resizeApplyBtn.type = 'button';
    resizeApplyBtn.className = 'image-canvas-resize-apply';
    resizeApplyBtn.textContent = 'Apply';
    resizeApplyBtn.title = 'Apply size';
    resizeApplyBtn.setAttribute('aria-label', 'Apply canvas size');
    resizeApplyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        applyCanvasDimensionsFromUI();
    });
    resizeFooter.appendChild(resizeApplyBtn);

    resizeBody.appendChild(resizeFieldsRow);
    resizeBody.appendChild(resizeFooter);
    resizeFlyout.appendChild(resizeToggleBtn);
    resizeFlyout.appendChild(resizeBody);

    function setResizePanelOpen(open) {
        resizeFlyout.classList.toggle('image-canvas-resize-flyout--open', open);
        resizeBody.hidden = !open;
        resizeToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
            syncCanvasDimensionsUI();
            requestAnimationFrame(() => {
                try { dimW.focus(); dimW.select(); } catch (_) {}
            });
        } else {
            syncCanvasDimensionsUI();
        }
    }

    resizeToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setResizePanelOpen(!resizeFlyout.classList.contains('image-canvas-resize-flyout--open'));
    });

    document.addEventListener(
        'pointerdown',
        (e) => {
            if (activeTab !== 'images') return;
            if (!resizeFlyout.classList.contains('image-canvas-resize-flyout--open')) return;
            if (resizeFlyout.contains(e.target)) return;
            setResizePanelOpen(false);
        },
        true
    );

    ['pointerdown', 'wheel', 'dblclick', 'contextmenu'].forEach((evt) => {
        resizeFlyout.addEventListener(evt, (e) => e.stopPropagation(), { passive: evt === 'wheel' });
    });

    // Zoom controls — same strip builder as code tab (identical icons + DOM)
    const { wrap: zoomControls, zoomOutBtn, zoomResetBtn, zoomInBtn } = createZoomControlStrip({
        onZoomOut: () => zoomImage(0.8),
        onZoomReset: () => resetZoom(),
        onZoomIn: () => zoomImage(1.2),
    });

    // Editor canvas wrapper: one inner host gets pan+zoom transform (canvas + overlay share it — avoids double scale() cost when zoomed).
    const canvasWrapper = document.createElement('div');
    canvasWrapper.className = 'image-editor-canvas-wrap';
    const viewTransformHost = document.createElement('div');
    viewTransformHost.className = 'image-editor-view';
    const checker = document.createElement('div');
    checker.className = 'image-editor-checker';
    const editorCanvas = document.createElement('canvas');
    editorCanvas.width = 720;
    editorCanvas.height = 720;
    editorCanvas.className = 'image-editor-surface';
    editorCanvas.tabIndex = -1;
    editorCanvas.setAttribute('aria-label', 'Image editor');
    canvasWrapper.appendChild(viewTransformHost);
    viewTransformHost.appendChild(checker);
    viewTransformHost.appendChild(editorCanvas);
    viewTransformHost.appendChild(resizeFlyout);

    previewContainer.appendChild(canvasWrapper);
    previewContainer.appendChild(zoomControls);

    rightPanel.appendChild(previewContainer);

    contentArea.appendChild(leftPanel);
    contentArea.appendChild(rightPanel);

    imagesContainer.appendChild(editingPanel);
    imagesContainer.appendChild(contentArea);

    container.appendChild(imagesContainer);

    // Initialize editor logic
    imageEditor = initializeImageEditor({
        editorCanvas,
        canvasWrapper,
        viewTransformHost,
        previewContainer,
        setDefaultUI: () => {},
        onCanvasSizeChange: syncCanvasDimensionsUI,
    });
    syncCanvasDimensionsUI();

    // Defaults for toolbar state
    toolButtons.brush && toolButtons.brush.classList.add('active');
    applySymmetryMode('none');
    refreshLucideIcons();
    setBrushSizeUI(parseInt(sizeInput.value, 10) || 16);
    applyColorFromUI();
    syncPaintAlphaUI();
    updateShapeToolFillIndicators();

    // After initializing the editor, ensure an image is shown immediately
    setTimeout(() => {
        if (!imageEditor) return;
        if (imageEditor.drawCrosshair) imageEditor.drawCrosshair();
        if (selectedImage) {
            imageEditor.loadImage(selectedImage);
        } else {
            const containerEl = document.querySelector('.images-thumbnails-scroll');
            if (containerEl && containerEl.firstElementChild) {
                const firstItem = containerEl.firstElementChild;
                const firstImg = firstItem.querySelector('img');
                if (firstImg) selectImage(firstImg.src, firstItem);
            }
        }
    }, 50);
}

function computePeaksFromBuffer(audioBuffer, width) {
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
    const len = ch0.length;
    const peaks = new Float32Array(width);
    const block = Math.max(1, Math.floor(len / width));
    for (let i = 0; i < width; i++) {
        const start = i * block;
        const end = Math.min(start + block, len);
        let m = 0;
        for (let j = start; j < end; j++) {
            const v = ch1 ? (Math.abs(ch0[j]) + Math.abs(ch1[j])) * 0.5 : Math.abs(ch0[j]);
            m = Math.max(m, v);
        }
        peaks[i] = m;
    }
    return peaks;
}

function drawWaveformPeaks(canvas, peaks, progress01, trimOpt) {
    const ctx = canvas.getContext('2d');
    if (!ctx || !peaks || !peaks.length) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    let cssW = Math.max(1, rect.width);
    let cssH = Math.max(1, rect.height);
    if (cssW <= 1 && canvas.parentElement) {
        const pr = canvas.parentElement.getBoundingClientRect();
        cssW = Math.max(1, pr.width);
    }
    if (cssH <= 1 && canvas.parentElement) {
        const pr = canvas.parentElement.getBoundingClientRect();
        cssH = Math.max(120, pr.height);
    }
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssW;
    const h = cssH;
    const mid = h / 2;
    const n = peaks.length;
    const step = w / n;
    const prog = Math.max(0, Math.min(1, progress01 || 0));
    const splitX = w * prog;

    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, 'rgba(0,0,0,0.45)');
    bg.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let i = 0; i < n; i++) {
        const amp = peaks[i] * (h * 0.42);
        const x = i * step + step * 0.5;
        ctx.lineTo(x, mid - amp);
    }
    for (let i = n - 1; i >= 0; i--) {
        const amp = peaks[i] * (h * 0.42);
        const x = i * step + step * 0.5;
        ctx.lineTo(x, mid + amp);
    }
    ctx.closePath();
    const wf = ctx.createLinearGradient(0, 0, w, 0);
    wf.addColorStop(0, 'rgba(0, 255, 204, 0.28)');
    wf.addColorStop(1, 'rgba(0, 255, 204, 0.12)');
    ctx.fillStyle = wf;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 255, 204, 0.75)';
    ctx.lineWidth = 1.35;
    ctx.stroke();

    let trimA = 0;
    let trimB = 1;
    if (trimOpt && typeof trimOpt.start01 === 'number' && typeof trimOpt.end01 === 'number') {
        trimA = Math.max(0, Math.min(1, trimOpt.start01));
        trimB = Math.max(trimA, Math.min(1, trimOpt.end01));
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(0, 0, w * trimA, h);
        ctx.fillRect(w * trimB, 0, w * (1 - trimB), h);
        const xTrimA = Math.round(w * trimA) + 0.5;
        const xTrimB = Math.round(w * trimB) + 0.5;
        ctx.strokeStyle = 'rgba(0, 255, 204, 0.95)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xTrimA, 0);
        ctx.lineTo(xTrimA, h);
        ctx.moveTo(xTrimB, 0);
        ctx.lineTo(xTrimB, h);
        ctx.stroke();
    }

    if (prog < 1) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fillRect(splitX, 0, w - splitX, h);
    }

    ctx.strokeStyle = 'rgba(0, 255, 204, 0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(splitX, 0);
    ctx.lineTo(splitX, h);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
}

function drawMiniWaveform(canvas, peaks) {
    const ctx = canvas.getContext('2d');
    if (!ctx || !peaks || !peaks.length) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, w, h);
    const mid = h / 2;
    const n = peaks.length;
    const step = w / n;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let i = 0; i < n; i++) {
        const amp = peaks[i] * (h * 0.4);
        const x = i * step + step * 0.5;
        ctx.lineTo(x, mid - amp);
    }
    for (let i = n - 1; i >= 0; i--) {
        const amp = peaks[i] * (h * 0.4);
        const x = i * step + step * 0.5;
        ctx.lineTo(x, mid + amp);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 255, 204, 0.22)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 255, 204, 0.75)';
    ctx.lineWidth = 1;
    ctx.stroke();
}

async function fetchDecodePeaks(src, peakWidth) {
    const ctx = getSoundAudioContext();
    if (!ctx) return null;
    try {
        await ctx.resume();
    } catch (_) {}
    try {
        let ab;
        if (typeof src === 'string' && (src.startsWith('data:') || src.startsWith('blob:'))) {
            const res = await fetch(src);
            ab = await res.arrayBuffer();
        } else {
            const bust = src.indexOf('?') >= 0 ? src : `${src}?r=${soundRevision}`;
            const res = await fetch(bust, { credentials: 'same-origin' });
            ab = await res.arrayBuffer();
        }
        const buf = await ctx.decodeAudioData(ab.slice(0));
        return computePeaksFromBuffer(buf, peakWidth);
    } catch (e) {
        console.warn('decode peaks failed', e);
        return null;
    }
}

function createSoundInterface(container) {
    const root = document.createElement('div');
    root.className = 'sounds-container';

    const editingPanel = document.createElement('div');
    editingPanel.className = 'sound-editing-panel';

    function setIcon(el, iconNameOrNames, fallbackText) {
        const names = Array.isArray(iconNameOrNames) ? iconNameOrNames : [iconNameOrNames];
        const primary = names[0];
        const lucide = window.lucide;
        const safeFallback = fallbackText == null ? '' : String(fallbackText);
        if (lucide && lucide.icons) {
            const found = names.find((n) => lucide.icons && lucide.icons[n]);
            const iconDef = found ? lucide.icons[found] : null;
            if (iconDef && typeof iconDef.toSvg === 'function') {
                el.innerHTML = `${iconDef.toSvg({ width: 18, height: 18 })}<span class="icon-fallback">${safeFallback}</span>`;
                return;
            }
        }
        if (lucide && typeof lucide.createIcons === 'function') {
            el.innerHTML = `<i data-lucide="${primary}"></i><span class="icon-fallback">${safeFallback}</span>`;
            return;
        }
        el.textContent = safeFallback;
    }
    function refreshLucideIcons() {
        try {
            window.lucide && window.lucide.createIcons && window.lucide.createIcons();
        } catch (_) {}
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'sounds-toolbar';

    const cropToolBtn = document.createElement('button');
    cropToolBtn.type = 'button';
    cropToolBtn.className = 'sound-tool-btn';
    cropToolBtn.title = 'Trim — drag the end handles, then Crop or Cut';
    cropToolBtn.setAttribute('aria-pressed', 'false');
    cropToolBtn.setAttribute('aria-label', 'Trim clip');
    setIcon(cropToolBtn, ['square-dashed-mouse-pointer', 'crop'], '▭');
    toolbar.appendChild(cropToolBtn);

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'sound-tool-btn sound-tool-btn--play';
    playBtn.title = 'Play / Pause';
    setIcon(playBtn, ['play', 'circle-play'], '▶');
    toolbar.appendChild(playBtn);

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'sound-tool-btn';
    stopBtn.title = 'Stop';
    setIcon(stopBtn, ['square'], '■');
    toolbar.appendChild(stopBtn);

    const loopBtn = document.createElement('button');
    loopBtn.type = 'button';
    loopBtn.className = 'sound-tool-btn';
    loopBtn.title = 'Loop playback';
    setIcon(loopBtn, ['repeat'], '↻');
    toolbar.appendChild(loopBtn);

    const sep0 = document.createElement('div');
    sep0.className = 'sound-toolbar-separator';
    toolbar.appendChild(sep0);

    const volRange = document.createElement('input');
    volRange.type = 'range';
    volRange.min = '0';
    volRange.max = '100';
    volRange.value = '90';
    volRange.className = 'sound-volume-range';
    volRange.title = 'Volume';
    toolbar.appendChild(volRange);

    const sep1 = document.createElement('div');
    sep1.className = 'sound-toolbar-separator';
    toolbar.appendChild(sep1);

    const dupBtn = document.createElement('button');
    dupBtn.type = 'button';
    dupBtn.className = 'sound-tool-btn';
    dupBtn.title = 'Duplicate selected';
    setIcon(dupBtn, ['copy', 'copy-plus'], '⎘');
    toolbar.appendChild(dupBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'sound-tool-btn sound-tool-btn--danger';
    delBtn.title = 'Delete selected';
    setIcon(delBtn, ['trash-2', 'trash'], '×');
    toolbar.appendChild(delBtn);

    editingPanel.appendChild(toolbar);

    const contentArea = document.createElement('div');
    contentArea.className = 'sounds-content';

    const leftPanel = document.createElement('div');
    leftPanel.className = 'images-left-panel';

    const thumbnailsContainer = document.createElement('div');
    thumbnailsContainer.className = 'sounds-thumbnails-scroll';

    const actionsRow = document.createElement('div');
    actionsRow.className = 'images-actions-row';
    const bottomImport = document.createElement('button');
    bottomImport.type = 'button';
    bottomImport.className = 'images-action-btn images-action-btn--secondary';
    setIcon(bottomImport, ['upload', 'upload-cloud'], '↑');
    bottomImport.title = 'Upload audio file';
    const bottomAdd = document.createElement('button');
    bottomAdd.type = 'button';
    bottomAdd.className = 'images-action-btn images-action-btn--primary';
    setIcon(bottomAdd, 'plus', '+');
    bottomAdd.title = 'Add new sound clip';
    actionsRow.appendChild(bottomAdd);
    actionsRow.appendChild(bottomImport);

    leftPanel.appendChild(thumbnailsContainer);
    leftPanel.appendChild(actionsRow);

    const rightPanel = document.createElement('div');
    rightPanel.className = 'sounds-right-panel';

    const previewContainer = document.createElement('div');
    previewContainer.className = 'sound-preview-container';

    const metaRow = document.createElement('div');
    metaRow.className = 'sound-meta-row';
    const nameEl = document.createElement('div');
    nameEl.className = 'sound-meta-name';
    nameEl.textContent = '—';
    const timeEl = document.createElement('div');
    timeEl.className = 'sound-meta-time';
    timeEl.textContent = '0:00 / 0:00';
    metaRow.appendChild(nameEl);
    metaRow.appendChild(timeEl);

    const waveformWorkspace = document.createElement('div');
    waveformWorkspace.className = 'sound-waveform-workspace';
    const waveformStack = document.createElement('div');
    waveformStack.className = 'sound-waveform-stack';
    const waveformFrame = document.createElement('div');
    waveformFrame.className = 'sound-waveform-frame';
    const waveformCanvas = document.createElement('canvas');
    waveformCanvas.className = 'sound-waveform-canvas';
    waveformCanvas.setAttribute('aria-label', 'Waveform');
    waveformCanvas.height = 120;
    const trimOverlay = document.createElement('div');
    trimOverlay.className = 'sound-trim-overlay';
    trimOverlay.setAttribute('aria-hidden', 'true');
    const handleStart = document.createElement('button');
    handleStart.type = 'button';
    handleStart.className = 'sound-trim-handle sound-trim-handle--start';
    handleStart.setAttribute('aria-label', 'Trim start');
    handleStart.title = 'Drag inward from the start';
    const handleEnd = document.createElement('button');
    handleEnd.type = 'button';
    handleEnd.className = 'sound-trim-handle sound-trim-handle--end';
    handleEnd.setAttribute('aria-label', 'Trim end');
    handleEnd.title = 'Drag inward from the end';
    trimOverlay.appendChild(handleStart);
    trimOverlay.appendChild(handleEnd);
    waveformFrame.appendChild(waveformCanvas);
    waveformFrame.appendChild(trimOverlay);
    waveformStack.appendChild(waveformFrame);
    waveformWorkspace.appendChild(waveformStack);

    const cropRow = document.createElement('div');
    cropRow.className = 'sound-crop-row';
    const cropRangeEl = document.createElement('div');
    cropRangeEl.className = 'sound-crop-range';
    cropRangeEl.setAttribute('aria-live', 'polite');
    cropRangeEl.setAttribute('aria-label', 'Selected range');
    const cropResetBtn = document.createElement('button');
    cropResetBtn.type = 'button';
    cropResetBtn.className = 'sound-tool-btn sound-crop-reset';
    cropResetBtn.title = 'Reset selection to full clip';
    setIcon(cropResetBtn, ['rotate-ccw'], '↺');
    const cropApplyBtn = document.createElement('button');
    cropApplyBtn.type = 'button';
    cropApplyBtn.className = 'sound-crop-text-btn sound-crop-text-btn--primary';
    cropApplyBtn.textContent = 'Crop';
    cropApplyBtn.title = 'Keep only the selected range';
    const cutApplyBtn = document.createElement('button');
    cutApplyBtn.type = 'button';
    cutApplyBtn.className = 'sound-crop-text-btn';
    cutApplyBtn.textContent = 'Cut';
    cutApplyBtn.title = 'Remove the selected range (join the rest)';
    const cropActions = document.createElement('div');
    cropActions.className = 'sound-crop-row-actions';
    cropActions.appendChild(cropResetBtn);
    cropActions.appendChild(cropApplyBtn);
    cropActions.appendChild(cutApplyBtn);
    cropRow.appendChild(cropRangeEl);
    cropRow.appendChild(cropActions);

    previewContainer.appendChild(metaRow);
    previewContainer.appendChild(waveformWorkspace);
    previewContainer.appendChild(cropRow);

    rightPanel.appendChild(previewContainer);

    contentArea.appendChild(leftPanel);
    contentArea.appendChild(rightPanel);

    root.appendChild(editingPanel);
    root.appendChild(contentArea);
    container.appendChild(root);

    let mainPeaks = null;
    let progressRaf = null;
    let isLooping = false;
    let clipDurationSec = 0;
    /** Crop region in seconds (replaces former number inputs). `trimEndSec === null` means full length until metadata sync. */
    let trimStartSec = 0;
    let trimEndSec = null;
    let cropToolActive = false;

    function getDurationFromUi() {
        const d = clipDurationSec || (soundTabAudio && Number.isFinite(soundTabAudio.duration) ? soundTabAudio.duration : 0);
        return Number.isFinite(d) && d > 0 ? d : 0;
    }

    function clientXToTime01(clientX) {
        const rect = waveformCanvas.getBoundingClientRect();
        const rw = rect.width || 1;
        return Math.max(0, Math.min(1, (clientX - rect.left) / rw));
    }

    function minTrimGapSec(d) {
        return Math.min(0.05, Math.max(0.001, d * 0.004));
    }

    function setCropToolUiActive(on) {
        cropToolActive = !!on;
        cropToolBtn.classList.toggle('sound-tool-btn--crop-active', cropToolActive);
        cropToolBtn.setAttribute('aria-pressed', cropToolActive ? 'true' : 'false');
        waveformWorkspace.classList.toggle('sound-waveform-workspace--crop-tool', cropToolActive);
        previewContainer.classList.toggle('sound-preview-container--crop-tool', cropToolActive);
        updateCropRangeDisplay();
        updateTrimHandlePositions();
    }

    function formatCropTime(sec) {
        if (!Number.isFinite(sec) || sec < 0) return '0:00.00';
        const m = Math.floor(sec / 60);
        const sRem = sec - m * 60;
        const whole = Math.floor(sRem);
        let cent = Math.round((sRem - whole) * 100);
        let w = whole;
        if (cent >= 100) {
            w += 1;
            cent = 0;
        }
        return `${m}:${String(w).padStart(2, '0')}.${String(cent).padStart(2, '0')}`;
    }

    function updateCropRangeDisplay() {
        const d = getDurationFromUi();
        const a = Number.isFinite(trimStartSec) ? trimStartSec : 0;
        const b = trimEndSec != null && Number.isFinite(trimEndSec) ? trimEndSec : d;
        if (!d || d <= 0) {
            cropRangeEl.textContent = '—';
            return;
        }
        const span = Math.max(0, b - a);
        cropRangeEl.textContent = `${formatCropTime(a)}–${formatCropTime(b)} (${formatCropTime(span)})`;
    }

    function updateTrimHandlePositions() {
        const d = getDurationFromUi();
        const tr = getTrimNormalized();
        const show = cropToolActive && d > 0 && tr;
        trimOverlay.classList.toggle('sound-trim-overlay--active', !!show);
        if (!show || !tr) {
            handleStart.style.visibility = 'hidden';
            handleEnd.style.visibility = 'hidden';
            return;
        }
        handleStart.style.visibility = 'visible';
        handleEnd.style.visibility = 'visible';
        const a = tr.start01 * 100;
        const b = tr.end01 * 100;
        handleStart.style.left = `${a}%`;
        handleEnd.style.left = `${b}%`;
    }

    function applyTrimSeconds(t0, t1) {
        const d = getDurationFromUi();
        if (!d) return;
        const gap = minTrimGapSec(d);
        let a = t0;
        let b = t1;
        a = Math.max(0, Math.min(a, d));
        b = Math.max(a + gap, Math.min(b, d));
        trimStartSec = Math.round(a * 1000) / 1000;
        trimEndSec = Math.round(b * 1000) / 1000;
        updateCropRangeDisplay();
        redrawMainWave();
    }

    function dragTrimEdge(which, ev) {
        if (!cropToolActive) return;
        const d = getDurationFromUi();
        if (!d) return;
        ev.preventDefault();
        ev.stopPropagation();
        const capId = ev.pointerId;
        try {
            (which === 'start' ? handleStart : handleEnd).setPointerCapture(capId);
        } catch (_) {}
        const onMove = (e) => {
            const t = clientXToTime01(e.clientX) * d;
            let t0 = trimStartSec;
            let t1 = trimEndSec;
            if (!Number.isFinite(t0)) t0 = 0;
            if (!Number.isFinite(t1)) t1 = d;
            const gap = minTrimGapSec(d);
            if (which === 'start') {
                t0 = Math.max(0, Math.min(t, t1 - gap));
            } else {
                t1 = Math.min(d, Math.max(t, t0 + gap));
            }
            trimStartSec = Math.round(t0 * 1000) / 1000;
            trimEndSec = Math.round(t1 * 1000) / 1000;
            updateCropRangeDisplay();
            redrawMainWave();
        };
        const onUp = () => {
            try {
                (which === 'start' ? handleStart : handleEnd).releasePointerCapture(capId);
            } catch (_) {}
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }

    handleStart.addEventListener('pointerdown', (e) => dragTrimEdge('start', e));
    handleEnd.addEventListener('pointerdown', (e) => dragTrimEdge('end', e));

    cropToolBtn.addEventListener('click', () => {
        setCropToolUiActive(!cropToolActive);
        refreshLucideIcons();
    });

    function onEscapeCropTool(e) {
        if (e.key !== 'Escape' || activeTab !== 'sound' || !cropToolActive) return;
        e.preventDefault();
        setCropToolUiActive(false);
        refreshLucideIcons();
    }
    window.addEventListener('keydown', onEscapeCropTool);

    function syncTrimInputsFromDuration(d) {
        clipDurationSec = Number.isFinite(d) && d > 0 ? d : 0;
        if (!clipDurationSec) return;
        const a = Math.max(0, Math.min(Number.isFinite(trimStartSec) ? trimStartSec : 0, clipDurationSec));
        const bRaw = trimEndSec != null && Number.isFinite(trimEndSec) ? trimEndSec : clipDurationSec;
        const b = Math.max(a, Math.min(bRaw, clipDurationSec));
        trimStartSec = Math.round(a * 1000) / 1000;
        trimEndSec = Math.round(b * 1000) / 1000;
        updateCropRangeDisplay();
    }

    function getTrimNormalized() {
        const d = clipDurationSec || (soundTabAudio && Number.isFinite(soundTabAudio.duration) ? soundTabAudio.duration : 0);
        if (!d || d <= 0) return null;
        let a = trimStartSec;
        let b = trimEndSec != null && Number.isFinite(trimEndSec) ? trimEndSec : d;
        if (!Number.isFinite(a)) a = 0;
        if (!Number.isFinite(b)) b = d;
        a = Math.max(0, Math.min(a, d));
        b = Math.max(a + 1e-6, Math.min(b, d));
        return { start01: a / d, end01: b / d };
    }

    function formatTime(sec) {
        if (!Number.isFinite(sec) || sec < 0) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function updatePlayIcon(playing) {
        setIcon(playBtn, playing ? ['pause', 'circle-pause'] : ['play', 'circle-play'], playing ? '❚❚' : '▶');
        refreshLucideIcons();
    }

    function redrawMainWave() {
        if (!mainPeaks) {
            const ctx = waveformCanvas.getContext('2d');
            if (ctx) {
                const rect = waveformCanvas.getBoundingClientRect();
                const dpr = window.devicePixelRatio || 1;
                waveformCanvas.width = Math.floor(Math.max(1, rect.width) * dpr);
                waveformCanvas.height = Math.floor(Math.max(1, rect.height) * dpr);
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.clearRect(0, 0, rect.width, rect.height);
                ctx.fillStyle = 'rgba(255,255,255,0.04)';
                ctx.fillRect(0, 0, rect.width, rect.height);
            }
            updateTrimHandlePositions();
            return;
        }
        const dur = soundTabAudio && soundTabAudio.duration ? soundTabAudio.duration : 0;
        const t = soundTabAudio && !soundTabAudio.paused ? soundTabAudio.currentTime : (soundTabAudio ? soundTabAudio.currentTime : 0);
        const prog = dur > 0 ? t / dur : 0;
        const trim = getTrimNormalized();
        drawWaveformPeaks(waveformCanvas, mainPeaks, prog, trim || undefined);
        timeEl.textContent = `${formatTime(t)} / ${formatTime(dur)}`;
        updateTrimHandlePositions();
    }

    function tickPlayback() {
        redrawMainWave();
        if (soundTabAudio && !soundTabAudio.paused) {
            progressRaf = requestAnimationFrame(tickPlayback);
        }
    }

    function attachAudioListeners() {
        if (!soundTabAudio) return;
        soundTabAudio.onplay = () => {
            updatePlayIcon(true);
            if (progressRaf) cancelAnimationFrame(progressRaf);
            progressRaf = requestAnimationFrame(tickPlayback);
        };
        soundTabAudio.onpause = () => {
            updatePlayIcon(false);
            if (progressRaf) cancelAnimationFrame(progressRaf);
            redrawMainWave();
        };
        soundTabAudio.onended = () => {
            updatePlayIcon(false);
            redrawMainWave();
        };
        soundTabAudio.ontimeupdate = () => {
            if (!soundTabAudio || soundTabAudio.paused) redrawMainWave();
        };
        soundTabAudio.onloadeddata = () => {
            redrawMainWave();
        };
    }

    async function loadMainPeaksForSrc(src) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        let px = waveformCanvas.getBoundingClientRect().width || waveformCanvas.clientWidth;
        if (px < 2 && waveformWorkspace) {
            px = waveformWorkspace.getBoundingClientRect().width;
        }
        if (px < 2) px = Math.max(320, previewContainer.clientWidth - 40);
        const peakCount = Math.min(640, Math.max(96, Math.floor(px / 2) || 256));
        mainPeaks = await fetchDecodePeaks(src, peakCount);
        if (!mainPeaks) {
            const pw = Math.min(200, Math.max(48, peakCount));
            mainPeaks = new Float32Array(pw);
            mainPeaks.fill(0.02);
        }
        redrawMainWave();
    }

    try {
        const ro = new ResizeObserver(() => {
            if (activeTab === 'sound') redrawMainWave();
        });
        ro.observe(previewContainer);
        ro.observe(waveformWorkspace);
        ro.observe(waveformFrame);
    } catch (_) {}

    function applySoundSelection(src, itemEl, info) {
        const list = document.querySelectorAll('.sound-thumbnail-item');
        list.forEach((n) => n.classList.remove('selected'));
        if (itemEl) itemEl.classList.add('selected');
        soundRevision++;
        const playbackUrl = soundSrcForPlayback(src);
        selectedSoundSrc = src;
        currentSoundFilename = info ? info.name : null;
        currentSoundInfo = info || null;
        try {
            localStorage.setItem('lastSelectedSound', (src || '').split('?')[0]);
        } catch (_) {}
        setLastSelectedSoundForObject(selected_object, (src || '').split('?')[0]);
        stopSoundTabPlayback();
        clipDurationSec = 0;
        trimStartSec = 0;
        trimEndSec = null;
        updateCropRangeDisplay();
        soundTabAudio = new Audio(playbackUrl);
        setCropToolUiActive(false);
        soundTabAudio.volume = parseInt(volRange.value, 10) / 100;
        soundTabAudio.loop = isLooping;
        attachAudioListeners();
        nameEl.textContent = info ? info.name : 'Sound';
        const obj = objects.find((o) => o.id == selected_object);
        if (obj && info) syncMediaSoundEntry(obj, info.src);
        loadMainPeaksForSrc(src).catch(() => redrawMainWave());
        updatePlayIcon(false);
        timeEl.textContent = '0:00 / 0:00';
        soundTabAudio.addEventListener(
            'loadedmetadata',
            () => {
                const d = soundTabAudio.duration;
                timeEl.textContent = `0:00 / ${formatTime(d)}`;
                syncTrimInputsFromDuration(d);
                redrawMainWave();
            },
            { once: true }
        );
    }
    soundSelectionHandler = applySoundSelection;

    cropResetBtn.addEventListener('click', () => {
        const d = (soundTabAudio && Number.isFinite(soundTabAudio.duration) ? soundTabAudio.duration : 0) || clipDurationSec;
        if (d > 0) {
            trimStartSec = 0;
            trimEndSec = Math.round(d * 1000) / 1000;
            syncTrimInputsFromDuration(d);
        }
        redrawMainWave();
    });
    cropApplyBtn.addEventListener('click', async () => {
        if (!currentSoundInfo || !selectedSoundSrc) return;
        const d = clipDurationSec || (soundTabAudio && soundTabAudio.duration) || 0;
        let t0 = trimStartSec;
        let t1 = trimEndSec != null && Number.isFinite(trimEndSec) ? trimEndSec : d;
        if (!Number.isFinite(t0)) t0 = 0;
        if (!Number.isFinite(t1)) t1 = d;
        if (d > 0) {
            t0 = Math.max(0, Math.min(t0, d));
            t1 = Math.max(t0 + 0.001, Math.min(t1, d));
        } else {
            return;
        }
        try {
            cropApplyBtn.disabled = true;
            cutApplyBtn.disabled = true;
            const newUrl = await cropSoundSrcToWavDataUrl(selectedSoundSrc, t0, t1);
            soundRevision++;
            const list = getCurrentObjectSounds();
            const found = list.find((x) => x.id === currentSoundInfo.id);
            if (found) {
                found.src = newUrl;
                if (/\.(mp3|m4a|aac|ogg|flac)$/i.test(found.name)) {
                    found.name = found.name.replace(/\.[^.]+$/, '.wav');
                }
            }
            const obj = objects.find((o) => o.id == selected_object);
            if (obj && found) syncMediaSoundEntry(obj, newUrl);
            loadSoundsFromDirectory(thumbnailsContainer);
            const el2 = Array.from(thumbnailsContainer.querySelectorAll('.sound-thumbnail-item')).find(
                (x) => found && x.dataset.filename === found.name
            );
            if (el2 && found) applySoundSelection(newUrl, el2, found);
        } catch (e) {
            console.warn('Crop failed', e);
        } finally {
            cropApplyBtn.disabled = false;
            cutApplyBtn.disabled = false;
        }
    });

    cutApplyBtn.addEventListener('click', async () => {
        if (!currentSoundInfo || !selectedSoundSrc) return;
        const d = clipDurationSec || (soundTabAudio && soundTabAudio.duration) || 0;
        let t0 = trimStartSec;
        let t1 = trimEndSec != null && Number.isFinite(trimEndSec) ? trimEndSec : d;
        if (!Number.isFinite(t0)) t0 = 0;
        if (!Number.isFinite(t1)) t1 = d;
        if (d > 0) {
            t0 = Math.max(0, Math.min(t0, d));
            t1 = Math.max(t0 + 0.001, Math.min(t1, d));
        } else {
            return;
        }
        if (t0 <= 0 && t1 >= d - 1e-6) {
            console.warn('Cut: select a range to remove');
            return;
        }
        try {
            cropApplyBtn.disabled = true;
            cutApplyBtn.disabled = true;
            const newUrl = await cutSoundRemoveMiddleToWavDataUrl(selectedSoundSrc, t0, t1);
            soundRevision++;
            const list = getCurrentObjectSounds();
            const found = list.find((x) => x.id === currentSoundInfo.id);
            if (found) {
                found.src = newUrl;
                if (/\.(mp3|m4a|aac|ogg|flac)$/i.test(found.name)) {
                    found.name = found.name.replace(/\.[^.]+$/, '.wav');
                }
            }
            const obj = objects.find((o) => o.id == selected_object);
            if (obj && found) syncMediaSoundEntry(obj, newUrl);
            loadSoundsFromDirectory(thumbnailsContainer);
            const el2 = Array.from(thumbnailsContainer.querySelectorAll('.sound-thumbnail-item')).find(
                (x) => found && x.dataset.filename === found.name
            );
            if (el2 && found) applySoundSelection(newUrl, el2, found);
        } catch (e) {
            console.warn('Cut failed', e);
        } finally {
            cropApplyBtn.disabled = false;
            cutApplyBtn.disabled = false;
        }
    });

    playBtn.addEventListener('click', async () => {
        if (!selectedSoundSrc) return;
        if (!soundTabAudio) {
            let el = thumbnailsContainer.querySelector('.sound-thumbnail-item.selected');
            if (!el) el = thumbnailsContainer.firstElementChild;
            const fn = el && el.dataset.filename;
            const s = fn && getCurrentObjectSounds().find((x) => x.name === fn);
            if (s) applySoundSelection(s.src, el, s);
        }
        if (!soundTabAudio) return;
        try {
            const ctx = getSoundAudioContext();
            if (ctx) await ctx.resume();
        } catch (_) {}
        if (soundTabAudio.paused) {
            const p = soundTabAudio.play();
            if (p && typeof p.catch === 'function') p.catch((e) => console.warn('play failed', e));
        } else {
            soundTabAudio.pause();
        }
    });

    stopBtn.addEventListener('click', () => {
        if (!soundTabAudio) return;
        soundTabAudio.pause();
        soundTabAudio.currentTime = 0;
        redrawMainWave();
    });

    loopBtn.addEventListener('click', () => {
        isLooping = !isLooping;
        loopBtn.classList.toggle('active', isLooping);
        if (soundTabAudio) soundTabAudio.loop = isLooping;
    });

    volRange.addEventListener('input', () => {
        if (soundTabAudio) soundTabAudio.volume = parseInt(volRange.value, 10) / 100;
    });

    dupBtn.addEventListener('click', () => {
        if (currentSoundInfo) duplicateObjectSound(currentSoundInfo).catch((e) => console.warn(e));
    });
    delBtn.addEventListener('click', () => {
        if (!currentSoundInfo) return;
        const el = Array.from(thumbnailsContainer.querySelectorAll('.sound-thumbnail-item')).find(
            (x) => x.dataset.filename === currentSoundInfo.name
        );
        if (el) deleteSound(el, currentSoundInfo.name, currentSoundInfo);
    });

    bottomImport.addEventListener('click', () => triggerUploadSound());
    bottomAdd.addEventListener('click', () => createNewSound());

    function seekFromClientX(clientX) {
        if (!soundTabAudio) return;
        const dur = soundTabAudio.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;
        const rect = waveformCanvas.getBoundingClientRect();
        const rw = rect.width || 1;
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / rw));
        soundTabAudio.currentTime = x * dur;
        redrawMainWave();
    }

    waveformCanvas.addEventListener('click', (e) => seekFromClientX(e.clientX));

    loadSoundsFromDirectory(thumbnailsContainer);

    bottomAdd.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.code === 'Space') e.preventDefault();
    });

    setTimeout(() => {
        refreshLucideIcons();
        if (selectedSoundSrc && currentSoundInfo) {
            const el = Array.from(thumbnailsContainer.querySelectorAll('.sound-thumbnail-item')).find(
                (x) => x.dataset.filename === currentSoundInfo.name
            );
            if (el) applySoundSelection(selectedSoundSrc, el, currentSoundInfo);
            else if (thumbnailsContainer.firstElementChild) {
                const fe = thumbnailsContainer.firstElementChild;
                const fn = fe.dataset.filename;
                const s = getCurrentObjectSounds().find((x) => x.name === fn);
                if (s) applySoundSelection(s.src, fe, s);
            }
        } else if (thumbnailsContainer.firstElementChild) {
            const fe = thumbnailsContainer.firstElementChild;
            const fn = fe.dataset.filename;
            const s = getCurrentObjectSounds().find((x) => x.name === fn);
            if (s) applySoundSelection(s.src, fe, s);
        }
    }, 40);
}

function selectSound(src, thumbnailElement, soundInfo) {
    if (soundSelectionHandler) {
        soundSelectionHandler(src, thumbnailElement, soundInfo);
    } else {
        selectedSoundSrc = src;
        currentSoundInfo = soundInfo || null;
        currentSoundFilename = soundInfo ? soundInfo.name : null;
        if (soundInfo) setLastSelectedSoundForObject(selected_object, (src || '').split('?')[0]);
    }
}

function loadSoundsFromDirectory(container) {
    const sounds = getCurrentObjectSounds();
    container.innerHTML = '';

    sounds.forEach((soundInfo) => {
        const item = document.createElement('div');
        item.className = 'sound-thumbnail-item';
        item.dataset.filename = soundInfo.name;

        const thumbWrap = document.createElement('div');
        thumbWrap.className = 'sound-thumb-wrap';

        const waveMini = document.createElement('canvas');
        waveMini.className = 'sound-thumb-wave';
        waveMini.width = 108;
        waveMini.height = 36;
        waveMini.setAttribute('aria-hidden', 'true');

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'object-delete-btn sound-thumb-delete';
        deleteBtn.textContent = '×';
        deleteBtn.title = 'Delete clip';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteSound(item, soundInfo.name, soundInfo);
        });

        thumbWrap.appendChild(waveMini);

        const label = document.createElement('span');
        label.className = 'sound-label';
        label.textContent = soundInfo.name;
        label.title = 'Double-click to rename';

        item.appendChild(thumbWrap);
        item.appendChild(label);
        item.appendChild(deleteBtn);

        item.addEventListener('click', () => {
            selectSound(soundInfo.src, item, soundInfo);
        });

        label.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            startRenameSound(item, soundInfo.name);
        });

        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showSoundAssetSaveMenu(e.clientX, e.clientY, soundInfo);
        });

        fetchDecodePeaks(soundInfo.src, 48).then((peaks) => {
            if (peaks) drawMiniWaveform(waveMini, peaks);
        });

        container.appendChild(item);
    });
}

function deleteSound(itemEl, filename, soundInfo) {
    const objectId = String(selected_object);
    if (!deletedSoundsMap[objectId]) deletedSoundsMap[objectId] = [];
    const wasSelected = itemEl.classList.contains('selected');
    deletedSoundsMap[objectId].push({
        filename,
        src: soundInfo ? soundInfo.src : '',
        wasSelected,
    });

    const list = getCurrentObjectSounds();
    const idx = list.findIndex((x) => x.name === filename);
    if (idx >= 0) list.splice(idx, 1);
    itemEl.remove();

    if (soundInfo && currentSoundInfo && currentSoundInfo.name === filename) {
        selectedSoundSrc = null;
        currentSoundInfo = null;
        currentSoundFilename = null;
        setLastSelectedSoundForObject(selected_object, '');
    }

    const tc = document.querySelector('.sounds-thumbnails-scroll');
    if (wasSelected && tc && tc.firstElementChild) {
        const first = tc.firstElementChild;
        const fn = first.dataset.filename;
        const s = getCurrentObjectSounds().find((x) => x.name === fn);
        if (s) selectSound(s.src, first, s);
    } else if (wasSelected) {
        stopSoundTabPlayback();
    }
    setTimeout(() => updateUndoMenu(), 50);
}

function undoSoundDeletion() {
    const objectId = String(selected_object);
    const stack = deletedSoundsMap[objectId] || [];
    if (stack.length === 0) return;
    const last = stack.pop();
    const key = String(selected_object);
    if (!objectSounds[key]) objectSounds[key] = [];
    objectSounds[key].unshift({ id: Date.now(), name: last.filename, src: last.src });
    const tc = document.querySelector('.sounds-thumbnails-scroll');
    if (tc) loadSoundsFromDirectory(tc);
    setTimeout(() => {
        if (last.wasSelected && tc) {
            const el = Array.from(tc.querySelectorAll('.sound-thumbnail-item')).find((x) => x.dataset.filename === last.filename);
            if (el) {
                const s = getCurrentObjectSounds().find((x) => x.name === last.filename);
                if (s) selectSound(s.src, el, s);
            }
        }
        updateUndoMenu();
    }, 40);
}

function hasPendingSoundDeletionUndo() {
    const objectId = String(selected_object);
    return (deletedSoundsMap[objectId] || []).length > 0;
}

function tryUndoSoundDeletion() {
    if (!hasPendingSoundDeletionUndo()) return false;
    undoSoundDeletion();
    return true;
}

function createNewSound() {
    const silent = generateSilentWavDataUrl();
    const nextNum = getNextSoundNumber();
    const name = soundFilenameForNum(nextNum, '.wav');
    const list = getCurrentObjectSounds();
    const newInfo = { id: Date.now(), name, src: silent };
    list.push(newInfo);
    currentSoundInfo = newInfo;
    const tc = document.querySelector('.sounds-thumbnails-scroll');
    if (tc) {
        loadSoundsFromDirectory(tc);
        setTimeout(() => {
            const el = Array.from(tc.querySelectorAll('.sound-thumbnail-item')).find((x) => x.dataset.filename === name);
            if (el) selectSound(silent, el, newInfo);
        }, 30);
    }
}

function triggerUploadSound() {
    try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*,.wav,.mp3,.ogg,.m4a,.aac,.flac,.webm';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) {
                document.body.removeChild(input);
                return;
            }
            try {
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onerror = reject;
                    reader.onload = () => resolve(String(reader.result || ''));
                    reader.readAsDataURL(file);
                });
                const ext = (file.name && file.name.indexOf('.') >= 0) ? file.name.slice(file.name.lastIndexOf('.')) : '.wav';
                const nextNum = getNextSoundNumber();
                const name = soundFilenameForNum(nextNum, ext);
                const list = getCurrentObjectSounds();
                const newInfo = { id: Date.now(), name, src: dataUrl };
                list.push(newInfo);
                const tc = document.querySelector('.sounds-thumbnails-scroll');
                if (tc) {
                    loadSoundsFromDirectory(tc);
                    setTimeout(() => {
                        const el = Array.from(tc.querySelectorAll('.sound-thumbnail-item')).find((x) => x.dataset.filename === name);
                        if (el) selectSound(dataUrl, el, newInfo);
                    }, 30);
                }
            } catch (e) {
                console.warn('Sound import failed', e);
            } finally {
                document.body.removeChild(input);
            }
        });
        input.click();
    } catch (e) {
        console.warn('Unable to open file dialog', e);
    }
}

async function duplicateObjectSound(soundInfo) {
    if (!soundInfo || !soundInfo.name) return;
    let srcCopy;
    try {
        const src = soundInfo.src;
        if (!src) {
            srcCopy = generateSilentWavDataUrl();
        } else if (typeof src === 'string' && src.startsWith('data:')) {
            srcCopy = src;
        } else {
            const clean = src.split('?')[0];
            const res = await fetch(clean, { credentials: 'same-origin' });
            if (!res.ok) throw new Error('fetch failed');
            const blob = await res.blob();
            srcCopy = await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(String(fr.result || ''));
                fr.onerror = () => reject(new Error('read failed'));
                fr.readAsDataURL(blob);
            });
        }
    } catch (e) {
        console.warn('Duplicate sound: using silent clip', e);
        srcCopy = generateSilentWavDataUrl();
    }
    const list = getCurrentObjectSounds();
    const sourceIndex = list.findIndex((x) => x.name === soundInfo.name);
    const nextNum = getNextSoundNumber();
    const ext = soundInfo.name.includes('.') ? soundInfo.name.slice(soundInfo.name.lastIndexOf('.')) : '.wav';
    const newName = soundFilenameForNum(nextNum, ext);
    const newInfo = { id: Date.now(), name: newName, src: srcCopy };
    if (sourceIndex >= 0) list.splice(sourceIndex + 1, 0, newInfo);
    else list.push(newInfo);
    const tc = document.querySelector('.sounds-thumbnails-scroll');
    if (tc) {
        loadSoundsFromDirectory(tc);
        setTimeout(() => {
            const el = Array.from(tc.querySelectorAll('.sound-thumbnail-item')).find((x) => x.dataset.filename === newName);
            if (el) selectSound(srcCopy, el, newInfo);
        }, 30);
    }
}

function sanitizeSoundDownloadFilename(name) {
    const raw = name || `sound_${Date.now()}.wav`;
    const safe = String(raw).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '') || 'sound';
    return /\.(wav|mp3|ogg|m4a|aac|flac|webm)$/i.test(safe) ? safe : `${safe}.wav`;
}

function downloadSoundAssetToComputer(src, filename) {
    const name = sanitizeSoundDownloadFilename(filename);
    const a = document.createElement('a');
    a.href = src;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function removeSoundAssetContextMenu() {
    const el = document.getElementById('__sound_asset_ctx_menu');
    if (el && el.parentNode) el.parentNode.removeChild(el);
}

let _soundAssetCtxMenuDismissBound = false;
function bindSoundAssetContextMenuDismiss() {
    if (_soundAssetCtxMenuDismissBound) return;
    _soundAssetCtxMenuDismissBound = true;
    document.addEventListener(
        'mousedown',
        (ev) => {
            const menu = document.getElementById('__sound_asset_ctx_menu');
            if (!menu || menu.contains(ev.target)) return;
            removeSoundAssetContextMenu();
        },
        true
    );
}

function showSoundAssetSaveMenu(clientX, clientY, soundInfo) {
    bindSoundAssetContextMenuDismiss();
    removeSoundAssetContextMenu();
    const menu = document.createElement('div');
    menu.id = '__sound_asset_ctx_menu';
    menu.setAttribute('role', 'menu');
    menu.className = 'ctx-menu';
    const dupBtn = document.createElement('button');
    dupBtn.type = 'button';
    dupBtn.textContent = 'Duplicate';
    dupBtn.setAttribute('role', 'menuitem');
    dupBtn.className = 'ctx-menu-item';
    dupBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        removeSoundAssetContextMenu();
        duplicateObjectSound(soundInfo).catch((e) => console.warn(e));
    });
    menu.appendChild(dupBtn);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Save audio';
    btn.setAttribute('role', 'menuitem');
    btn.className = 'ctx-menu-item';
    btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        downloadSoundAssetToComputer(soundInfo.src, soundInfo.name);
        removeSoundAssetContextMenu();
    });
    menu.appendChild(btn);
    document.body.appendChild(menu);
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let lx = clientX;
    let ly = clientY;
    if (lx + mw > window.innerWidth - 8) lx = window.innerWidth - mw - 8;
    if (ly + mh > window.innerHeight - 8) ly = window.innerHeight - mh - 8;
    menu.style.left = `${Math.max(8, lx)}px`;
    menu.style.top = `${Math.max(8, ly)}px`;
}

function startRenameSound(itemEl, oldFilename) {
    if (itemEl.querySelector('.rename-input')) return;
    const label = itemEl.querySelector('.sound-label');
    if (!label) return;
    const list = getCurrentObjectSounds();
    const info = list.find((x) => x.name === oldFilename);
    if (!info) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = oldFilename;
    input.className = 'rename-input';
    itemEl.classList.add('renaming');
    label.replaceWith(input);
    input.focus();
    input.select();

    const finish = () => {
        const raw = input.value.trim();
        itemEl.classList.remove('renaming');
        if (raw && raw !== oldFilename) {
            const taken = list.some((x) => x.name === raw && x.name !== oldFilename);
            if (!taken) {
                info.name = raw;
                if (currentSoundInfo && currentSoundInfo.name === oldFilename) {
                    currentSoundFilename = raw;
                    currentSoundInfo.name = raw;
                }
            }
        }
        label.textContent = info.name;
        input.replaceWith(label);
    };

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            finish();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            itemEl.classList.remove('renaming');
            label.textContent = info.name;
            input.replaceWith(label);
        }
    });
}

// Load images from ./images/0/ directory
function loadImagesFromDirectory(container) {
    const images = getCurrentObjectImages();
    container.innerHTML = '';

    images.forEach(imgInfo => {
        const imageItem = document.createElement('div');
        imageItem.className = 'image-thumbnail-item';
        imageItem.dataset.filename = imgInfo.name;

        const thumbnail = document.createElement('img');
        thumbnail.src = imgInfo.src;
        thumbnail.alt = imgInfo.name;

        const label = document.createElement('span');
        label.textContent = imgInfo.name;
        label.className = 'image-label';
        label.title = 'Click to type a new name';

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'object-delete-btn';
        deleteBtn.textContent = '×';
        deleteBtn.title = 'Delete image';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteImage(imageItem, imgInfo.name, imgInfo);
        });

        // Make thumbnail draggable for reordering
        imageItem.draggable = true;
        let suppressNextClick = false;
        let suppressClearTimeout = null;
        imageItem.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/html', imgInfo.name);
            try {
                e.dataTransfer.setDragImage(imageItem, Math.min(48, imageItem.offsetWidth / 2), 16);
            } catch (_) {}
            imageItem.classList.add('dragging');
        });

        imageItem.addEventListener('dragend', () => {
            imageItem.classList.remove('dragging');
            imageItem.classList.remove('drag-over');
            suppressNextClick = true;
            if (suppressClearTimeout) clearTimeout(suppressClearTimeout);
            suppressClearTimeout = setTimeout(() => {
                suppressNextClick = false;
                suppressClearTimeout = null;
            }, 450);
        });

        imageItem.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            imageItem.classList.add('drag-over');
        });

        imageItem.addEventListener('dragleave', (e) => {
            if (imageItem.contains(e.relatedTarget)) return;
            imageItem.classList.remove('drag-over');
        });

        imageItem.addEventListener('drop', (e) => {
            e.preventDefault();
            imageItem.classList.remove('drag-over');
            const draggedImageName = e.dataTransfer.getData('text/html');
            if (draggedImageName !== imgInfo.name) {
                reorderImages(draggedImageName, imgInfo.name);
            }
        });

        imageItem.appendChild(thumbnail);
        imageItem.appendChild(label);
        imageItem.appendChild(deleteBtn);

        imageItem.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showImageAssetSaveMenu(e.clientX, e.clientY, imgInfo);
        });

        imageItem.addEventListener('click', (e) => {
            if (e.target && e.target.closest && e.target.closest('.rename-input')) return;
            if (suppressNextClick) {
                suppressNextClick = false;
                if (suppressClearTimeout) {
                    clearTimeout(suppressClearTimeout);
                    suppressClearTimeout = null;
                }
                return;
            }
            currentImageFilename = imgInfo.name;
            currentImageInfo = imgInfo;
            selectImage(imgInfo.src, imageItem);
        });

        label.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (suppressNextClick) {
                suppressNextClick = false;
                if (suppressClearTimeout) {
                    clearTimeout(suppressClearTimeout);
                    suppressClearTimeout = null;
                }
                return;
            }
            currentImageFilename = imgInfo.name;
            currentImageInfo = imgInfo;
            selectImage(imgInfo.src, imageItem);
            // Editor surface focuses in selectImage; defer so the rename field keeps focus for typing.
            queueMicrotask(() => startRenameImage(imageItem, imgInfo.name));
        });

        imageItem.addEventListener('dblclick', (e) => {
            if (e.target && e.target.closest && e.target.closest('.image-label')) return;
            e.preventDefault();
            queueMicrotask(() => startRenameImage(imageItem, imgInfo.name));
        });

        let touchTimer;
        imageItem.addEventListener('touchstart', (e) => {
            if (e.target && e.target.closest && e.target.closest('.rename-input')) return;
            touchTimer = setTimeout(() => {
                startRenameImage(imageItem, imgInfo.name);
            }, 500);
        });
        imageItem.addEventListener('touchend', () => {
            clearTimeout(touchTimer);
        });
        imageItem.addEventListener('touchmove', () => {
            clearTimeout(touchTimer);
        });

        imageItem.addEventListener('mouseover', () => {
            if (imageItem !== document.querySelector('.image-thumbnail-item.selected')) {
                imageItem.style.background = '#333';
            }
        });
        imageItem.addEventListener('mouseout', () => {
            if (imageItem !== document.querySelector('.image-thumbnail-item.selected')) {
                imageItem.style.background = 'transparent';
            }
        });

        container.appendChild(imageItem);
    });

    // Auto-select logic: if something is already selected, do nothing.
    // Otherwise, prefer current selectedImage; else select first.
    setTimeout(() => {
        const existingSelection = container.querySelector('.image-thumbnail-item.selected');
        if (existingSelection) return;
        if (images.length > 0) {
            const selectedBase = (selectedImage || '').split('?')[0];
            const matchIndex = selectedBase ? images.findIndex(img => (img.src || '').split('?')[0] === selectedBase) : -1;
            if (matchIndex >= 0) {
                const el = container.children[matchIndex];
                if (el) {
                    currentImageFilename = images[matchIndex].name;
                    currentImageInfo = images[matchIndex];
                    selectImage(images[matchIndex].src, el);
                    return;
                }
            }
            const firstItem = container.children[0];
            if (firstItem) {
                currentImageFilename = images[0].name;
                currentImageInfo = images[0];
                selectImage(images[0].src, firstItem);
            }
        } else {
            selectedImage = null;
            if (imageEditor) imageEditor.clear(true);
        }
    }, 50);
}

/** Match thumbnail selection to objectImages[] when paths differ (e.g. resolved img.src vs stored relative path). */
function resolveImageListEntryForSelection(list, imagePath, thumbnailElement) {
    if (thumbnailElement && thumbnailElement.dataset && thumbnailElement.dataset.filename) {
        const byName = list.find((x) => x.name === thumbnailElement.dataset.filename);
        if (byName) return byName;
    }
    const norm = (s) => {
        if (!s || typeof s !== 'string') return '';
        const base = s.split('?')[0];
        if (base.startsWith('data:')) return base;
        try {
            return new URL(base, window.location.href).href;
        } catch (_) {
            return base;
        }
    };
    const target = norm(imagePath);
    return list.find((x) => norm(x.src) === target) || null;
}

// Select and display an image
function selectImage(imagePath, thumbnailElement, options) {
    const updateSprite = !options || options.updateSprite !== false;
    // Clear previous selection
    document.querySelectorAll('.image-thumbnail-item').forEach(item => {
        item.classList.remove('selected');
        item.style.background = 'transparent';
        item.style.borderColor = 'transparent';
    });

    // Set new selection
    thumbnailElement.classList.add('selected');
    thumbnailElement.style.background = '#444';
    thumbnailElement.style.borderColor = '#00ffcc';

    imageRevision += 1;
    const isDataUrl = typeof imagePath === 'string' && imagePath.startsWith('data:');
    const busted = isDataUrl ? imagePath : `${imagePath}${imagePath.includes('?') ? '&' : '?'}v=${imageRevision}`;
    selectedImage = busted;
    lastSelectedImage = imagePath;
    // Keep current image metadata in sync for save naming
    const list = getCurrentObjectImages();
    const info = resolveImageListEntryForSelection(list, imagePath, thumbnailElement);
    if (info) {
        currentImageFilename = info.name;
        currentImageInfo = info;
    }

    // Save to localStorage
    localStorage.setItem('lastSelectedImage', imagePath);
    setLastSelectedImageForObject(selected_object, imagePath);

    // Display on editor canvas
    if (imageEditor) {
        imageEditor.loadImage(busted);
        // update game window preview immediately
        renderGameWindowSprite();
    }
    const editorSurface = document.querySelector('.image-editor-surface');
    if (editorSurface) {
        try {
            editorSurface.focus({ preventScroll: true });
        } catch (_) {}
    }

    // Update selected object's first sprite and grid icon
    const obj = objects.find(o => o.id == selected_object);
    if (obj) {
        if (!obj.media) obj.media = [];
        if (obj.media.length === 0) {
            obj.media.push({ id: 1, name: 'sprite', type: 'image', path: busted });
            const box = document.querySelector(`.box[data-id="${obj.id}"]`);
            if (box) {
                let img = box.querySelector('img');
                if (!img) {
                    img = document.createElement('img');
                    box.insertBefore(img, box.firstChild);
                }
                img.src = busted;
                img.alt = obj.name;
            }
            renderGameWindowSprite();
        } else if (updateSprite) {
            obj.media[0].path = busted;
            const box = document.querySelector(`.box[data-id="${obj.id}"]`);
            if (box) {
                let img = box.querySelector('img');
                if (!img) {
                    img = document.createElement('img');
                    box.insertBefore(img, box.firstChild);
                }
                img.src = busted;
                img.alt = obj.name;
            }
            renderGameWindowSprite();
        }
    }
}
// Zoom image in preview
function zoomImage(factor) {
    imageZoom *= factor;
    imageZoom = Math.max(0.1, Math.min(12, imageZoom)); // Clamp between 0.1x and 12x
    if (imageEditor) imageEditor.setZoom(imageZoom);
}

// Show delete confirmation dialog
function showDeleteConfirmation(imageItem, filename) {
    // Remove any existing confirmation dialog
    const existingDialog = document.querySelector('.confirmation-dialog');
    if (existingDialog) {
        existingDialog.remove();
    }

    // Create confirmation dialog
    const dialog = document.createElement('div');
    dialog.className = 'confirmation-dialog';

    const content = document.createElement('div');
    content.className = 'confirmation-content';

    const title = document.createElement('div');
    title.className = 'confirmation-title';
    title.textContent = 'Delete Image';

    const message = document.createElement('div');
    message.className = 'confirmation-message';
    message.textContent = `Are you sure you want to delete "${filename}"? This action can be undone.`;

    const buttons = document.createElement('div');
    buttons.className = 'confirmation-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirmation-btn cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => dialog.remove());

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'confirmation-btn delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
        // Find imgInfo by filename in current object's images
        const list = getCurrentObjectImages();
        const imgInfo = list.find(x => x.name === filename);
        deleteImage(imageItem, filename, imgInfo);
        dialog.remove();
    });

    buttons.appendChild(cancelBtn);
    buttons.appendChild(deleteBtn);

    content.appendChild(title);
    content.appendChild(message);
    content.appendChild(buttons);

    dialog.appendChild(content);
    document.body.appendChild(dialog);

    // Close on backdrop click
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
            dialog.remove();
        }
    });

    // Close on Escape key
    document.addEventListener('keydown', function closeDialog(e) {
        if (e.key === 'Escape') {
            dialog.remove();
            document.removeEventListener('keydown', closeDialog);
        }
    });
}
// Delete an image
function deleteImage(imageItem, filename, imgInfo) {
    const objectId = String(selected_object);
    if (!deletedImagesMap[objectId]) deletedImagesMap[objectId] = [];

    // Store for undo functionality
    const deletedImageData = {
        filename: filename,
        src: imgInfo ? imgInfo.src : (selectedImage || ''),
        imageItem: imageItem,
        wasSelected: imageItem.classList.contains('selected')
    };
    deletedImagesMap[objectId].push(deletedImageData);

    // Remove from in-memory list
    const list = getCurrentObjectImages();
    const idx = list.findIndex(x => x.name === filename);
    if (idx >= 0) list.splice(idx, 1);

    // Remove from DOM
    imageItem.remove();

    // If this was the selected image, clear editor
    if (deletedImageData.wasSelected) {
        selectedImage = null;
        if (imageEditor) imageEditor.clear(true);
        localStorage.removeItem('lastSelectedImage');
        setLastSelectedImageForObject(selected_object, '');
    }

    // Update undo menu
    setTimeout(() => {
        updateUndoMenu();
    }, 100);

    console.log(`Image \"${filename}\" deleted`);
}

// Undo last deletion
function undoLastDeletion() {
    const objectId = String(selected_object);
    const stack = deletedImagesMap[objectId] || [];
    if (stack.length === 0) return;

    const lastDeleted = stack.pop();
    const container = document.querySelector('.images-thumbnails-scroll');
    if (!container) return;

    const restored = { id: Date.now(), name: lastDeleted.filename, src: lastDeleted.src };
    // Must not call getCurrentObjectImages() here while the list is still empty: we pop the
    // undo stack first, so pending-delete state is cleared and getCurrentObjectImages would
    // auto-seed a blank, then unshift would leave [restored, blank].
    const key = String(selected_object);
    if (!objectImages[key]) objectImages[key] = [];
    const list = objectImages[key];
    list.unshift(restored);
    loadImagesFromDirectory(container);
    setTimeout(() => {
        if (lastDeleted.wasSelected) {
            const firstItem = container.children[0];
            if (firstItem) selectImage(restored.src, firstItem);
        }
    }, 30);

    setTimeout(() => updateUndoMenu(), 100);
}

/** True if there is a thumbnail deletion to undo for the current object (Edit → Undo Delete). */
function hasPendingImageDeletionUndo() {
    const objectId = String(selected_object);
    return (deletedImagesMap[objectId] || []).length > 0;
}

/** Restores the last deleted thumbnail if any; returns true if handled (so canvas undo can be skipped). */
function tryUndoImageDeletion() {
    if (!hasPendingImageDeletionUndo()) return false;
    undoLastDeletion();
    return true;
}

// Handle edit menu actions
function handleEditAction(action) {
    console.log('Edit action triggered:', action);

    switch(action) {
        case 'undo':
            if (activeTab === 'images') {
                if (!tryUndoImageDeletion() && imageEditor && typeof imageEditor.undo === 'function') {
                    imageEditor.undo();
                }
            } else if (activeTab === 'sound') {
                tryUndoSoundDeletion();
            } else {
                undoLastDeletion();
            }
            break;
        case 'cut':
            if (activeTab === 'code') {
                copyCodeBlocksToClipboardInternal();
                deleteSelectedCodeBlocks();
            } else if (activeTab === 'images' && imageEditor && typeof imageEditor.cut === 'function') imageEditor.cut();
            else console.log('Cut action - not available in this tab');
            break;
        case 'copy':
            if (activeTab === 'code') copyCodeBlocksToClipboardInternal();
            else if (activeTab === 'images' && imageEditor && typeof imageEditor.copy === 'function') imageEditor.copy();
            else console.log('Copy action - not available in this tab');
            break;
        case 'paste':
            if (activeTab === 'code') pasteCodeBlocksFromClipboardInternal();
            else if (activeTab === 'images' && imageEditor && typeof imageEditor.paste === 'function') imageEditor.paste();
            else console.log('Paste action - not available in this tab');
            break;
        case 'selectAll':
            if (activeTab === 'code') selectAllCodeBlocks();
            else if (activeTab === 'images' && imageEditor && typeof imageEditor.selectAll === 'function') imageEditor.selectAll();
            else console.log('Select All action - not available in this tab');
            break;
    }

    // Close the menu after action
    const editBtn = document.querySelector('.edit-menu-btn');
    const undoMenu = document.getElementById('edit-dropdown');
    if (editBtn && undoMenu) {
        editBtn.classList.remove('active');
        undoMenu.style.display = 'none';
    }
}

// Update undo menu state
function updateUndoMenu() {
    const objectId = String(selected_object);
    const stack = deletedImagesMap[objectId] || [];
    const soundStack = deletedSoundsMap[objectId] || [];
    const undoMenu = document.getElementById('edit-dropdown');
    if (undoMenu) {
        const undoItems = undoMenu.querySelectorAll('.undo-menu-item');
        const undoItem = Array.from(undoItems).find(item => item.textContent.includes('Undo') || item.textContent.includes('Nothing'));

        if (undoItem) {
            const hasUndo =
                (activeTab === 'images' && stack.length > 0) ||
                (activeTab === 'sound' && soundStack.length > 0);
            if (!hasUndo) {
                undoItem.classList.add('disabled');
                undoItem.textContent = 'Nothing to undo';
            } else {
                undoItem.classList.remove('disabled');
                undoItem.textContent = 'Undo Delete';
            }
        }
    }
}

// Reset zoom to 100%
function resetZoom() {
    imageZoom = 1.0;
    if (imageEditor) imageEditor.setZoom(imageZoom);
}
// Create a new empty image
function createNewImage() {
    const timestamp = Date.now();
    const nextNum = getNextImageNumber();
    const filename = `image-${nextNum}.png`;

    // Create a simple 256x256 transparent PNG
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    // Leave fully transparent; no grid or background
    ctx.clearRect(0, 0, 256, 256);

    // In a real implementation, you would save this to the server
    // For now, we'll create a data URL and add it to our list
    const dataUrl = canvas.toDataURL('image/png');

    // Add and immediately select the new image in editor and UI
    console.log(`New image created: image-${nextNum}`);
    const list = getCurrentObjectImages();
    const newInfo = { id: timestamp, name: `image-${nextNum}`, src: dataUrl };
    list.push(newInfo);

    // Immediately show new image in editor; also keep state for later visual selection
    currentImageFilename = newInfo.name;
    currentImageInfo = newInfo;
    localStorage.setItem('lastSelectedImage', dataUrl);
    setLastSelectedImageForObject(selected_object, dataUrl);
    selectedImage = dataUrl;
    if (imageEditor) imageEditor.loadImage(dataUrl);

    // Refresh thumbnails and visually select the new image
    const thumbnailsContainer = document.querySelector('.images-thumbnails-scroll');
    if (thumbnailsContainer) {
        loadImagesFromDirectory(thumbnailsContainer);
        setTimeout(() => {
            let targetEl = thumbnailsContainer.querySelector(`.image-thumbnail-item[data-filename="${newInfo.name}"]`);
            if (!targetEl) {
                const items = Array.from(thumbnailsContainer.children);
                targetEl = items[items.length - 1] || null;
            }
            if (targetEl) {
                thumbnailsContainer.scrollTop = thumbnailsContainer.scrollHeight;
                const imgEl = targetEl.querySelector('img');
                const path = imgEl ? imgEl.src : dataUrl;
                selectImage(path, targetEl, { updateSprite: false });
            }
        }, 30);
    }
}

async function duplicateObjectImage(imgInfo) {
    if (!imgInfo || !imgInfo.name) return;
    let srcCopy;
    try {
        const src = imgInfo.src;
        if (!src) {
            srcCopy = generateBlankImageDataUrl();
        } else if (typeof src === 'string' && src.startsWith('data:')) {
            srcCopy = src;
        } else {
            const clean = src.split('?')[0];
            const res = await fetch(clean, { credentials: 'same-origin' });
            if (!res.ok) throw new Error('fetch failed');
            const blob = await res.blob();
            srcCopy = await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(String(fr.result || ''));
                fr.onerror = () => reject(new Error('read failed'));
                fr.readAsDataURL(blob);
            });
        }
    } catch (e) {
        console.warn('Duplicate image: could not clone pixels, using blank', e);
        srcCopy = generateBlankImageDataUrl();
    }

    const list = getCurrentObjectImages();
    const sourceIndex = list.findIndex((x) => x.name === imgInfo.name);
    const nextNum = getNextImageNumber();
    const newName = `image-${nextNum}`;
    const timestamp = Date.now();
    const newInfo = { id: timestamp, name: newName, src: srcCopy };
    if (typeof imgInfo.width === 'number' && typeof imgInfo.height === 'number' && imgInfo.width >= 1 && imgInfo.height >= 1) {
        newInfo.width = imgInfo.width;
        newInfo.height = imgInfo.height;
    }
    if (sourceIndex >= 0) {
        list.splice(sourceIndex + 1, 0, newInfo);
    } else {
        list.push(newInfo);
    }

    currentImageFilename = newInfo.name;
    currentImageInfo = newInfo;
    localStorage.setItem('lastSelectedImage', srcCopy);
    setLastSelectedImageForObject(selected_object, srcCopy);
    selectedImage = srcCopy;
    if (imageEditor) imageEditor.loadImage(srcCopy);

    const thumbnailsContainer = document.querySelector('.images-thumbnails-scroll');
    if (thumbnailsContainer) {
        loadImagesFromDirectory(thumbnailsContainer);
        setTimeout(() => {
            let targetEl = thumbnailsContainer.querySelector(`.image-thumbnail-item[data-filename="${newName}"]`);
            if (!targetEl) {
                const items = Array.from(thumbnailsContainer.children);
                targetEl = items[sourceIndex + 1] || items[items.length - 1] || null;
            }
            if (targetEl) {
                try {
                    targetEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                } catch (_) {}
                const imgEl = targetEl.querySelector('img');
                const path = imgEl ? imgEl.src : srcCopy;
                selectImage(path, targetEl, { updateSprite: false });
            }
        }, 30);
    }
}

// Upload a new image from disk and add to current object's images
function triggerUploadImage() {
    try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) { document.body.removeChild(input); return; }
            try {
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onerror = (e) => reject(e);
                    reader.onload = () => resolve(String(reader.result || ''));
                    reader.readAsDataURL(file);
                });

                const timestamp = Date.now();
                const nextNum = getNextImageNumber();
                const name = `image-${nextNum}`;
                const list = getCurrentObjectImages();
                const newInfo = { id: timestamp, name, src: dataUrl };
                list.push(newInfo);

                // Update state and select in editor
                currentImageFilename = name;
                currentImageInfo = newInfo;
                localStorage.setItem('lastSelectedImage', dataUrl);
                selectedImage = dataUrl;
                if (imageEditor) imageEditor.loadImage(dataUrl);

                // Refresh thumbnails and select the uploaded one
                const thumbnailsContainer = document.querySelector('.images-thumbnails-scroll');
                if (thumbnailsContainer) {
                    loadImagesFromDirectory(thumbnailsContainer);
                    setTimeout(() => {
                        let targetEl = thumbnailsContainer.querySelector(`.image-thumbnail-item[data-filename="${name}"]`);
                        if (!targetEl) {
                            const items = Array.from(thumbnailsContainer.children);
                            targetEl = items[items.length - 1] || null;
                        }
                        if (targetEl) {
                            thumbnailsContainer.scrollTop = thumbnailsContainer.scrollHeight;
                            const imgEl = targetEl.querySelector('img');
                            const path = imgEl ? imgEl.src : dataUrl;
                            selectImage(path, targetEl, { updateSprite: false });
                        }
                    }, 30);
                }
            } catch (e) {
                console.warn('Image upload failed', e);
            } finally {
                document.body.removeChild(input);
            }
        });
        input.click();
    } catch (e) {
        console.warn('Unable to open file dialog', e);
    }
}

// Start renaming an image
function startRenameImage(imageItem, oldFilename) {
    if (imageItem.querySelector('.rename-input')) return;
    const label = imageItem.querySelector('.image-label');
    if (!label) return;

    const prevDraggable = imageItem.draggable;
    imageItem.draggable = false;
    imageItem.classList.add('renaming');

    // Create input field
    const input = document.createElement('input');
    input.type = 'text';
    input.value = oldFilename;
    input.className = 'rename-input';
    input.setAttribute('aria-label', 'Image name');
    input.setAttribute('spellcheck', 'false');
    input.autocomplete = 'off';
    input.draggable = false;
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    input.addEventListener('dragstart', (e) => e.preventDefault());

    // Replace label with input
    label.parentNode.replaceChild(input, label);
    const focusInput = () => {
        try {
            input.focus({ preventScroll: true });
            input.select();
        } catch (_) {
            input.focus();
            input.select();
        }
    };
    focusInput();
    // Re-assert focus after editor steals it; do not select() again or caret clicks get wiped next frame.
    requestAnimationFrame(() => {
        try {
            input.focus({ preventScroll: true });
        } catch (_) {
            input.focus();
        }
    });

    let finished = false;
    const restoreDraggable = () => {
        imageItem.draggable = prevDraggable;
        imageItem.classList.remove('renaming');
    };

    // Handle input events
    const finishRename = () => {
        if (finished) return;
        finished = true;
        const newFilename = input.value.trim();
        const list = getCurrentObjectImages();
        const found = list.find(x => x.name === oldFilename);
        const thumb = imageItem.querySelector('img');

        if (newFilename && newFilename !== oldFilename) {
            if (found && list.some(x => x !== found && x.name === newFilename)) {
                label.textContent = oldFilename;
            } else if (found) {
                found.name = newFilename;
                label.textContent = newFilename;
                imageItem.dataset.filename = newFilename;
                if (thumb) thumb.alt = newFilename;
                if (currentImageFilename === oldFilename) currentImageFilename = newFilename;
                if (currentImageInfo && currentImageInfo === found) currentImageInfo.name = newFilename;
            }
        }

        // Replace input with label
        if (input.parentNode) input.parentNode.replaceChild(label, input);
        restoreDraggable();
    };

    const cancelRename = () => {
        if (finished) return;
        finished = true;
        label.textContent = oldFilename;
        if (input.parentNode) input.parentNode.replaceChild(label, input);
        restoreDraggable();
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            finishRename();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelRename();
        }
    });
}

// Tab switching functionality
function switchTab(tabName) {
    // Remove active class from all tabs
    document.querySelectorAll('.asset-tab').forEach(tab => {
        tab.classList.remove('active');
        tab.setAttribute('aria-selected', 'false');
    });

    // Add active class to selected tab
    const selectedTab = document.querySelector(`.${tabName}-tab`);
    if (selectedTab) {
        selectedTab.classList.add('active');
        selectedTab.setAttribute('aria-selected', 'true');
    } else {
        console.warn(`Tab with class .${tabName}-tab not found`);
    }

    // Update active tab variable
    activeTab = tabName;
    console.log(`Switched to tab: ${tabName}`);

    // Update workspace based on new tab
    updateWorkspace();
}


// Create a box in the grid
function createBox(boxData) {
    const box = document.createElement("div");
    box.className = "box";
    box.dataset.id = boxData.id;
    box.draggable = true;

    // Create icon element
    const icon = document.createElement("img"); // Use <img> instead of <image>
    // Check if media exists and has a valid path
    if (boxData.media && boxData.media.length > 0 && boxData.media[0].path) {
        icon.src = boxData.media[0].path; // Set src to the media path
        icon.style.width = "75px"; // Optional: set a size for the icon
        icon.style.height = "75px";
        box.appendChild(icon);
    }

    const nameContainer = document.createElement("div");
    nameContainer.className = "object-name-container";

    const name = document.createElement("span");
    name.className = "object-name";
    name.textContent = boxData.name;
    name.title = "Click to rename";
    name.style.cursor = "pointer";

    // Add double-click to rename
    name.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startRenameObject(boxData.id, name);
    });

    nameContainer.appendChild(name);
    box.appendChild(nameContainer);

    // Create delete button (only for non-controller objects)
    if (boxData.type !== 'controller') {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'object-delete-btn';
        deleteBtn.textContent = '×';
        deleteBtn.title = 'Delete object';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent box selection when clicking delete
            deleteObject(boxData.id);
        });
        box.appendChild(deleteBtn);
    }

    // Add drag and drop functionality
    box.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', boxData.id.toString());
        box.classList.add('dragging');
    });

    box.addEventListener('dragend', () => {
        box.classList.remove('dragging');
    });

    box.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    });

    box.addEventListener('drop', (e) => {
        e.preventDefault();
        const draggedObjectId = parseInt(e.dataTransfer.getData('text/html'));
        if (draggedObjectId !== boxData.id) {
            reorderObjects(draggedObjectId, boxData.id);
        }
    });

    box.addEventListener("click", () => {
        document.querySelectorAll('.box').forEach(otherBox => {
            otherBox.classList.remove("selected");
        });
        box.classList.add("selected");
        selected_object = boxData.id;
        // Reset editor state to avoid cross-object filename reuse
        currentImageFilename = null;
        currentImageInfo = null;
        // Ensure images exist and point the draw screen at THIS object's image (avoid stale editor state)
        const obj = objects.find(o => o.id == selected_object);
        if (obj) ensureDefaultImageForObject(obj);
        const images = getCurrentObjectImages();
        const baseFromMedia = (obj && obj.media && obj.media[0] && obj.media[0].path) ? String(obj.media[0].path).split('?')[0] : '';
        const remembered = getLastSelectedImageForObject(selected_object);
        const rememberedBase = remembered ? remembered.split('?')[0] : '';
        const chosen =
            (baseFromMedia && images.find(img => (img.src || '').split('?')[0] === baseFromMedia)) ||
            (rememberedBase && images.find(img => (img.src || '').split('?')[0] === rememberedBase)) ||
            (images[0] || null);
        selectedImage = chosen ? chosen.src : null;

        ensureDefaultSoundForObject(obj);
        const soundList = getCurrentObjectSounds();
        const mediaSound = obj.media && obj.media.find((m) => m && m.type === 'sound');
        const baseSound = mediaSound && mediaSound.path ? String(mediaSound.path).split('?')[0] : '';
        const rememberedS = getLastSelectedSoundForObject(selected_object);
        const rememberedSBase = rememberedS ? rememberedS.split('?')[0] : '';
        const chosenSound =
            (baseSound && soundList.find((s) => (s.src || '').split('?')[0] === baseSound)) ||
            (rememberedSBase && soundList.find((s) => (s.src || '').split('?')[0] === rememberedSBase)) ||
            (soundList[0] || null);
        selectedSoundSrc = chosenSound ? chosenSound.src : null;
        currentSoundInfo = chosenSound || null;
        currentSoundFilename = chosenSound ? chosenSound.name : null;

        updateWorkspace();
        renderGameWindowSprite();
    });

    return box;
}

// Function to add a new game object
function addNewObject() {
    // Find the next available ID
    const existingIds = objects.map(obj => obj.id);
    let nextId = 0;
    while (existingIds.includes(nextId)) {
        nextId++;
    }

    // Find the next available object number for naming
    const existingNames = objects.map(obj => {
        const match = obj.name.match(/^Object(\d+)$/);
        return match ? parseInt(match[1]) : 0;
    });
    let nextNum = 1;
    while (existingNames.includes(nextNum)) {
        nextNum++;
    }

    // Create new object with start block
    const newObject = {
        id: nextId,
        name: `Object${nextNum}`,
        type: "object",
        media: [],
        code: [
            {
                id: 0,
                type: "start",
                location: {x: 0, y: 0},
                content: "When Created",
                val_a: null,
                val_b: null,
                next_block_a: null,
                next_block_b: null,
                position: {x: 20, y: 20}
            }
        ]
    };

    // Add to objects array
    objects.push(newObject);
    rebuildObjectIndex();

    // Initialize images for the new object BEFORE rendering
    ensureDefaultImageForObject(newObject);
    ensureDefaultSoundForObject(newObject);

    // Re-render the grid to include the new object with its default image
    renderObjectGrid();

    // Select the new object
    document.querySelectorAll('.box').forEach(otherBox => {
        otherBox.classList.remove("selected");
    });
    const newBoxElement = document.querySelector(`.box[data-id="${newObject.id}"]`);
    if (newBoxElement) {
        newBoxElement.classList.add("selected");
    }
    selected_object = newObject.id;

    // Update workspace
    updateWorkspace();
    renderGameWindowSprite();

    console.log(`New object created: ${newObject.name} (ID: ${newObject.id})`);
}

// Function to delete an object
function deleteObject(objectId) {
    // Don't allow deleting the controller
    const obj = objects.find(o => o.id === objectId);
    if (!obj || obj.type === 'controller') return;

    // Confirm deletion
    if (!confirm(`Are you sure you want to delete "${obj.name}"? This action cannot be undone.`)) {
        return;
    }

    // Remove from objects array
    const index = objects.findIndex(o => o.id === objectId);
    if (index === -1) return;
    objects.splice(index, 1);
    rebuildObjectIndex();

    // Re-render the grid
    renderObjectGrid();

    // If the deleted object was selected, select another object
    if (selected_object === objectId) {
        const remainingObjects = objects.filter(o => o.id !== objectId);
        if (remainingObjects.length > 0) {
            // Select the first remaining object
            selected_object = remainingObjects[0].id;
            const newSelectedBox = document.querySelector(`.box[data-id="${selected_object}"]`);
            if (newSelectedBox) {
                document.querySelectorAll('.box').forEach(otherBox => {
                    otherBox.classList.remove("selected");
                });
                newSelectedBox.classList.add("selected");
            }
        } else {
            selected_object = -1; // No objects left
        }

        // Update workspace
        updateWorkspace();
        renderGameWindowSprite();
    }

    // Remove object images
    if (objectImages[String(objectId)]) {
        delete objectImages[String(objectId)];
    }
    if (objectSounds[String(objectId)]) {
        delete objectSounds[String(objectId)];
    }

    console.log(`Object deleted: ${obj.name} (ID: ${objectId})`);
}

// Function to reorder objects by moving dragged object to position of target object
function reorderObjects(draggedObjectId, targetObjectId) {
    const draggedIndex = objects.findIndex(obj => obj.id === draggedObjectId);
    const targetIndex = objects.findIndex(obj => obj.id === targetObjectId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    // Remove dragged object from array
    const [draggedObject] = objects.splice(draggedIndex, 1);

    // Insert dragged object at target position
    objects.splice(targetIndex, 0, draggedObject);
    rebuildObjectIndex();

    // Refresh the grid display
    renderObjectGrid();

    console.log(`Reordered objects: ${draggedObject.name} moved to position of ${objects[targetIndex].name}`);
}

// Function to start renaming an object
function startRenameObject(objectId, nameElement) {
    const obj = objects.find(o => o.id === objectId);
    if (!obj) return;

    const container = nameElement.parentElement;
    const currentName = nameElement.textContent;

    // Create input field
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;
    input.className = 'object-name-input';

    // Replace span with input
    container.replaceChild(input, nameElement);
    input.focus();
    input.select();

    // Handle input events
    const finishRename = () => {
        const newName = input.value.trim();
        if (newName && newName !== currentName) {
            obj.name = newName;
            nameElement.textContent = newName;
        }
        container.replaceChild(nameElement, input);
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            finishRename();
        } else if (e.key === 'Escape') {
            // Cancel rename
            container.replaceChild(nameElement, input);
        }
    });
}

// Initialize grid
renderObjectGrid();

// Function to create the plus button as a grid item
function createPlusButton() {
    const plusBox = document.createElement("div");
    plusBox.className = "box plus-button";
    plusBox.title = "Add new object";

    const plusIcon = document.createElement("div");
    plusIcon.className = "plus-icon";
    setCodeZoomBtnIcon(plusIcon, ['plus'], '+', 48);
    try { window.lucide && window.lucide.createIcons && window.lucide.createIcons(); } catch (_) {}
    plusBox.appendChild(plusIcon);

    plusBox.addEventListener("click", addNewObject);

    // Prevent dragging of the plus button
    plusBox.draggable = false;

    return plusBox;
}

// Function to render the grid with objects and plus button
function renderObjectGrid() {
    const grid = document.getElementById('grid');
    if (!grid) return;

    grid.innerHTML = '';

    // Add all existing objects
    objects.forEach((boxData, index) => {
        const boxElement = createBox(boxData);
        grid.appendChild(boxElement);
        if (index === 0 && selected_object === -1) {
            boxElement.classList.add("selected");
            selected_object = boxData.id;
        } else if (boxData.id === selected_object) {
            boxElement.classList.add("selected");
        }
    });

    // Add the plus button as a grid item
    const plusButton = createPlusButton();
    grid.appendChild(plusButton);
}
// Initialize tabs
function initializeTabs() {
    if (window.__tabsInitialized) return;
    window.__tabsInitialized = true;
    // Add event listeners to tabs
    document.querySelectorAll('.asset-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Get the specific tab type by checking for known tab classes
            let tabType = '';
            if (tab.classList.contains('images-tab')) tabType = 'images';
            else if (tab.classList.contains('code-tab')) tabType = 'code';
            else if (tab.classList.contains('sound-tab')) tabType = 'sound';
            else if (tab.classList.contains('threed-tab')) tabType = 'threed';

            if (tabType) {
                switchTab(tabType);
            }
        });
    });

    // Horizontal scroll: wheel over tab strip (narrow toolbars often need this)
    const tabStrip = document.querySelector('.asset-tabs');
    if (tabStrip && !tabStrip.__wheelBound) {
        tabStrip.__wheelBound = true;
        tabStrip.addEventListener(
            'wheel',
            (e) => {
                if (tabStrip.scrollWidth <= tabStrip.clientWidth) return;
                const dx = e.deltaX;
                const dy = e.deltaY;
                if (Math.abs(dx) > Math.abs(dy)) {
                    return;
                }
                if (dy !== 0) {
                    e.preventDefault();
                    tabStrip.scrollLeft += dy;
                }
            },
            { passive: false }
        );
    }

    // Set default active tab (Code)
    switchTab('code');
}

// Initialize workspace (will be handled by tab initialization)

// Simple function to toggle the edit menu (called from HTML onclick)
function toggleEditMenu() {
    const editBtn = document.querySelector('.edit-menu-btn');
    const undoMenu = document.getElementById('edit-dropdown');

    if (editBtn && undoMenu) {
        const isActive = editBtn.classList.contains('active');

        if (isActive) {
            editBtn.classList.remove('active');
            undoMenu.style.display = 'none';
            editBtn.setAttribute('aria-expanded', 'false');
        } else {
            editBtn.classList.add('active');
            undoMenu.style.display = 'block';
            editBtn.setAttribute('aria-expanded', 'true');
        }
    }
}
// Initialize Edit menu dropdown
function initializeEditMenu() {
    if (window.__editMenuSetupDone) {
        return;
    }
    window.__editMenuSetupDone = true;
    const editMenuContainer = document.querySelector('.edit-menu-container');
    const editBtn = document.querySelector('.edit-menu-btn');
    const undoMenu = document.getElementById('edit-dropdown');

    if (editMenuContainer && editBtn && undoMenu) {
        // Initialize undo menu state
        updateUndoMenu();

        // Ensure menu starts hidden
        undoMenu.style.display = 'none';

        // Close menu when clicking elsewhere (attach once)
        document.addEventListener('click', function(e) {
            if (!editMenuContainer.contains(e.target)) {
                editBtn.classList.remove('active');
                undoMenu.style.display = 'none';
            }
        });
    }
}

// =========================
// File Menu (Save / Load)
// =========================
function toggleFileMenu() {
	const fileBtn = document.querySelector('.file-menu-btn');
	const fileMenu = document.getElementById('file-dropdown');
	if (!fileBtn || !fileMenu) return;
	const isActive = fileBtn.classList.contains('active');
	if (isActive) {
		fileBtn.classList.remove('active');
		fileMenu.style.display = 'none';
		fileBtn.setAttribute('aria-expanded', 'false');
	} else {
		fileBtn.classList.add('active');
		fileMenu.style.display = 'block';
		fileBtn.setAttribute('aria-expanded', 'true');
	}
}

function initializeFileMenu() {
	if (window.__fileMenuSetupDone) return;
	window.__fileMenuSetupDone = true;
	const container = document.querySelector('.file-menu-container');
	const btn = document.querySelector('.file-menu-btn');
	const menu = document.getElementById('file-dropdown');
	const input = document.getElementById('file-input');
	if (!container || !btn || !menu || !input) return;
	menu.style.display = 'none';
	document.addEventListener('click', (e) => {
		if (!container.contains(e.target)) {
			btn.classList.remove('active');
			menu.style.display = 'none';
			btn.setAttribute('aria-expanded', 'false');
		}
	});
	// Wire file input change
	if (!input.__bound) {
		input.__bound = true;
		input.addEventListener('change', async (e) => {
			const file = e.target.files && e.target.files[0];
			if (file) {
				try {
					await loadProjectFromFile(file);
				} catch (err) {
					console.warn('Failed to load project', err);
				}
			}
		});
	}
}

function serializeProject() {
	// Ensure model is migrated and has start blocks prior to save
	migrateCodeModel();
	ensureStartBlocks();
	let sw = 800;
	let sh = 600;
	if (projectStageWidth != null && projectStageHeight != null
		&& projectStageWidth > 0 && projectStageHeight > 0) {
		sw = projectStageWidth;
		sh = projectStageHeight;
	} else {
		const gc = document.getElementById('game-window');
		if (gc && gc.width > 0 && gc.height > 0) {
			sw = gc.width;
			sh = gc.height;
		}
	}
	const project = {
		version: 1,
		stageWidth: sw,
		stageHeight: sh,
		selected_object,
		objects: JSON.parse(JSON.stringify(objects)),
		images: {},
		sounds: {}
	};
	Object.keys(objectImages).forEach((key) => {
		project.images[key] = (objectImages[key] || []).map((img) => {
			const row = { id: img.id, name: img.name, src: img.src };
			if (typeof img.width === 'number' && typeof img.height === 'number' && img.width >= 1 && img.height >= 1) {
				row.width = img.width;
				row.height = img.height;
			}
			return row;
		});
	});
	Object.keys(objectSounds).forEach((key) => {
		project.sounds[key] = (objectSounds[key] || []).map((s) => ({ id: s.id, name: s.name, src: s.src }));
	});
	return project;
}

async function saveProjectToFile() {
	try {
		const data = serializeProject();
		await ensureProjectImagesEmbedded(data);
		await ensureProjectSoundsEmbedded(data);
		// Sync each object's media paths with the embedded data URLs
		for (const obj of data.objects || []) {
			const key = String(obj.id);
			const imgs = data.images[key];
			if (imgs && imgs.length > 0 && imgs[0].src) {
				if (!obj.media) obj.media = [];
				if (obj.media.length === 0) obj.media.push({ id: 1, name: 'sprite', type: 'image', path: imgs[0].src });
				else obj.media[0].path = imgs[0].src;
			}
			const snds = data.sounds[key];
			if (snds && snds.length > 0 && snds[0].src) {
				if (!obj.media) obj.media = [];
				const si = obj.media.findIndex(m => m && m.type === 'sound');
				if (si >= 0) obj.media[si].path = snds[0].src;
				else obj.media.push({ id: Date.now(), name: 'sound', type: 'sound', path: snds[0].src });
			}
		}
		const json = JSON.stringify(data, null, 2);
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'maxiverse-project.app';
		document.body.appendChild(a);
		a.click();
		setTimeout(() => {
			URL.revokeObjectURL(url);
			document.body.removeChild(a);
		}, 0);
	} catch (e) {
		console.warn('Save failed', e);
	}
}

function triggerLoadProjectFromFile() {
	const input = document.getElementById('file-input');
	if (input) {
		input.value = '';
		input.click();
	}
}

async function loadProjectFromFile(file) {
	return new Promise((resolve, reject) => {
		try {
			const reader = new FileReader();
			reader.onerror = (err) => reject(err);
			reader.onload = () => {
				try {
					const text = String(reader.result || '');
					const data = JSON.parse(text);
					if (!data || typeof data !== 'object') throw new Error('Invalid file');
					if (!Array.isArray(data.objects)) throw new Error('Missing objects');
					// Stop play if running
					try { if (isPlaying) stopPlay(); } catch {}
					// Replace objects in-place to preserve const reference
					objects.length = 0;
					for (const obj of data.objects) objects.push(obj);
					// Replace objectImages in-place
					Object.keys(objectImages).forEach(k => { delete objectImages[k]; });
					Object.keys(objectSounds).forEach(k => { delete objectSounds[k]; });
					if (data.images && typeof data.images === 'object') {
						Object.keys(data.images).forEach(k => {
							const list = Array.isArray(data.images[k]) ? data.images[k] : [];
							objectImages[k] = list.map((img) => {
								const row = { id: img.id, name: img.name, src: img.src };
								if (typeof img.width === 'number' && typeof img.height === 'number' && img.width >= 1 && img.height >= 1) {
									row.width = img.width;
									row.height = img.height;
								}
								return row;
							});
						});
					}
					if (data.sounds && typeof data.sounds === 'object') {
						Object.keys(data.sounds).forEach(k => {
							const list = Array.isArray(data.sounds[k]) ? data.sounds[k] : [];
							objectSounds[k] = list.map((s) => ({ id: s.id, name: s.name, src: s.src }));
						});
					}
					// Sync object media paths from loaded embedded images/sounds
					for (const obj of objects) {
						const key = String(obj.id);
						const imgs = objectImages[key];
						if (imgs && imgs.length > 0 && imgs[0].src) {
							if (!obj.media) obj.media = [];
							if (obj.media.length === 0) obj.media.push({ id: 1, name: 'sprite', type: 'image', path: imgs[0].src });
							else obj.media[0].path = imgs[0].src;
						}
						const snds = objectSounds[key];
						if (snds && snds.length > 0 && snds[0].src) {
							if (!obj.media) obj.media = [];
							const si = obj.media.findIndex(m => m && m.type === 'sound');
							if (si >= 0) obj.media[si].path = snds[0].src;
							else obj.media.push({ id: Date.now(), name: 'sound', type: 'sound', path: snds[0].src });
						}
					}
					// Migrate and ensure start blocks after load
					migrateCodeModel();
					ensureStartBlocks();
					if (typeof data.stageWidth === 'number' && typeof data.stageHeight === 'number'
						&& data.stageWidth >= 1 && data.stageHeight >= 1) {
						projectStageWidth = Math.min(4096, Math.round(data.stageWidth));
						projectStageHeight = Math.min(4096, Math.round(data.stageHeight));
					} else {
						projectStageWidth = null;
						projectStageHeight = null;
					}
					// Ensure each object has at least a default image and sound clip
					initializeDefaultImages();
					initializeDefaultSounds();
					// Restore selection if present
					if (typeof data.selected_object === 'number') {
						selected_object = data.selected_object;
					} else if (objects[0]) {
						selected_object = objects[0].id;
					}
					// Clear stale image/sound selection so auto-select picks the loaded project's assets
					selectedImage = null;
					lastSelectedImage = '';
					// Refresh UI
					try { renderObjectGrid(); } catch {}
					try { refreshObjectGridIcons(); } catch {}
					// Rebuild current workspace (code or images)
					try { updateWorkspace(); } catch {}
					try {
						const thumbnailsContainer = document.querySelector('.images-thumbnails-scroll');
						if (thumbnailsContainer) loadImagesFromDirectory(thumbnailsContainer);
						const soundThumbs = document.querySelector('.sounds-thumbnails-scroll');
						if (soundThumbs) loadSoundsFromDirectory(soundThumbs);
					} catch {}
					try { setTimeout(renderGameWindowSprite, 30); } catch {}
					resolve(true);
				} catch (e) {
					reject(e);
				}
			};
			reader.readAsText(file);
		} catch (e) {
			reject(e);
		}
	});
}

// =========================
// Export as standalone HTML
// =========================
async function exportProjectAsHtml() {
	try {
		const data = serializeProject();
		await ensureProjectImagesEmbedded(data);
		await ensureProjectSoundsEmbedded(data);
		const html = generateStandaloneHtml(data);
		const blob = new Blob([html], { type: 'text/html' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'index.html';
		document.body.appendChild(a);
		a.click();
		setTimeout(() => {
			URL.revokeObjectURL(url);
			document.body.removeChild(a);
		}, 0);
	} catch (e) {
		console.warn('Export HTML failed', e);
	}
}

async function ensureProjectImagesEmbedded(project) {
	async function toEmbedded(src) {
		try {
			if (!src) return generateBlankImageDataUrl();
			if (src.startsWith('data:')) return src;
			const clean = src.split('?')[0];
			const res = await fetch(clean, { credentials: 'same-origin' });
			if (!res.ok) throw new Error('fetch failed: ' + res.status);
			const blob = await res.blob();
			return await new Promise((resolve) => {
				const fr = new FileReader();
				fr.onload = () => resolve(String(fr.result || ''));
				fr.readAsDataURL(blob);
			});
		} catch (_) {
			try { return generateBlankImageDataUrl(); } catch { return 'data:image/png;base64,'; }
		}
	}

	if (!project.images) project.images = {};
	for (const obj of project.objects || []) {
		const key = String(obj.id);
		if (!project.images[key] || project.images[key].length === 0) {
			const path = obj && obj.media && obj.media[0] && obj.media[0].path ? obj.media[0].path : null;
			if (path) {
				const src = await toEmbedded(path);
				project.images[key] = [{ id: Date.now(), name: 'image-1', src }];
			}
		}
	}
	const tasks = [];
	Object.keys(project.images).forEach((key) => {
		(project.images[key] || []).forEach((img) => {
			tasks.push((async () => { img.src = await toEmbedded(img.src); })());
		});
	});
	await Promise.all(tasks);
}

async function ensureProjectSoundsEmbedded(project) {
	async function toEmbedded(src) {
		try {
			if (!src) return generateSilentWavDataUrl();
			if (src.startsWith('data:')) return src;
			const clean = src.split('?')[0];
			const res = await fetch(clean, { credentials: 'same-origin' });
			if (!res.ok) throw new Error('fetch failed: ' + res.status);
			const blob = await res.blob();
			return await new Promise((resolve) => {
				const fr = new FileReader();
				fr.onload = () => resolve(String(fr.result || ''));
				fr.readAsDataURL(blob);
			});
		} catch (_) {
			try { return generateSilentWavDataUrl(); } catch { return ''; }
		}
	}

	if (!project.sounds) project.sounds = {};
	for (const obj of project.objects || []) {
		const key = String(obj.id);
		if (!project.sounds[key] || project.sounds[key].length === 0) {
			const m = obj && obj.media ? obj.media.find((x) => x && x.type === 'sound') : null;
			const path = m && m.path ? m.path : null;
			if (path) {
				const src = await toEmbedded(path);
				project.sounds[key] = [{ id: Date.now(), name: 'sound-1.wav', src }];
			}
		}
	}
	const tasks = [];
	Object.keys(project.sounds).forEach((key) => {
		(project.sounds[key] || []).forEach((s) => {
			tasks.push((async () => { s.src = await toEmbedded(s.src); })());
		});
	});
	await Promise.all(tasks);
}
function generateStandaloneHtml(project) {
	// Escape < so strings cannot contain "</script>" (or "</style>") and break the inline script/HTML.
	const safeJson = JSON.stringify(project).replace(/</g, '\\u003c');
	// Minimal runner uses same semantics as in-editor runtime
	return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Maxiverse Export</title>
	<style>
	  html,body{margin:0;height:100%;width:100%;overflow:hidden;background:#777;color:#fff}
	  body{display:flex;align-items:center;justify-content:center}
	  canvas{display:block;background:#777;image-rendering:pixelated;image-rendering:crisp-edges}
	</style>
	</head><body>
	<canvas id="game" tabindex="0"></canvas>
	<script>
	const project = ` + safeJson + `;
	let objects = project.objects || [];
	const objectImages = project.images || {};
	const objectSounds = project.sounds || {};
	const objectById = {};
	objects.forEach(o => { if (o) objectById[o.id] = o; });
	const codeMapByTemplateId = {};
	objects.forEach(o => {
	  if (!o) return;
	  const code = Array.isArray(o.code) ? o.code : [];
	  const map = {};
	  for (let i = 0; i < code.length; i++) {
	    const b = code[i];
	    if (b && typeof b.id !== 'undefined') map[b.id] = b;
	  }
	  codeMapByTemplateId[o.id] = map;
	});
	const TIME_BUDGET_MS = 6;
	const MAX_TOTAL_STEPS_PER_FRAME = 2000;
	let rrInstanceStartIndex = 0;
	let __stepOnlyInstanceIds = null;
	let isPlaying = true;
	let runtimeInstances = [];
	let runtimeExecState = {};
	let runtimePositions = {};
	let runtimeVariables = {};
	let runtimeGlobalVariables = {};
	let frameGlobalReadSnapshot = null;
	function syncFrameGlobalReadSnapshotAfterPublicWrite(varName) {
	  if (frameGlobalReadSnapshot == null) return;
	  const v = runtimeGlobalVariables[varName];
	  if (typeof v === 'number') frameGlobalReadSnapshot[varName] = v;
	  else if (Array.isArray(v)) frameGlobalReadSnapshot[varName] = v;
	}
	let nextInstanceId = 1;
	let instancesPendingRemoval = new Set();
	const runtimeMouse = { x: 0, y: 0 };
	let runtimeMousePressed = false;
	const runtimeKeys = {};

	function parseNumericInput(raw) {
	  if (raw == null || raw === '') return 0;
	  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
	  if (typeof raw === 'boolean') return raw ? 1 : 0;
	  if (typeof raw === 'string') {
	    const s = raw.trim();
	    if (s === '') return 0;
	    const m = s.match(/^([+-]?(?:\\d*\\.?\\d+|\\d+\\.?\\d*))\\s*\\/\\s*([+-]?(?:\\d*\\.?\\d+|\\d+\\.?\\d*))$/);
	    if (m) {
	      const a = parseFloat(m[1]);
	      const b = parseFloat(m[2]);
	      if (b !== 0 && Number.isFinite(a) && Number.isFinite(b)) return a / b;
	    }
	    const n = Number(s);
	    if (Number.isFinite(n)) return n;
	    const f = parseFloat(s);
	    return Number.isFinite(f) ? f : 0;
	  }
	  const n = Number(raw);
	  return Number.isFinite(n) ? n : 0;
	}

	function registerRuntimeInstanceFromTemplate(instanceId, templateId) {
	  const template = objectById[templateId];
	  if (!template) return false;
	  runtimeInstances.push({ instanceId, templateId });
	  runtimePositions[instanceId] = { x: 0, y: 0, layer: 0 };
	  runtimeVariables[instanceId] = {};
	  try {
	    const arrs = Array.isArray(template.arrayVariables) ? template.arrayVariables : [];
	    arrs.forEach(name => { runtimeVariables[instanceId][name] = []; });
	  } catch (_) {}
	  const cm = codeMapByTemplateId[templateId];
	  const code = Array.isArray(template.code) ? template.code : [];
	  const start = cm ? Object.values(cm).find(b => b && b.type === 'start') : code.find(b => b && b.type === 'start');
	  const pcT = start && typeof start.next_block_a === 'number' ? start.next_block_a : null;
	  runtimeExecState[instanceId] = { pc: pcT, waitMs: 0, waitingBlockId: null, repeatStack: [], yieldFrame: false, yieldResumePc: null };
	  return true;
	}
	function runInstanceStartChainSync(instanceId) {
	  const savedFilter = __stepOnlyInstanceIds;
	  const savedSnapshot = frameGlobalReadSnapshot;
	  let guard = 0;
	  try {
	    while (isPlaying && guard++ < 100000) {
	      const exec = runtimeExecState[instanceId];
	      if (!exec) break;
	      if (exec.waitMs > 0) break;
	      if (exec.yieldFrame) break;
	      if (exec.pc == null && exec.repeatStack.length === 0) break;
	      __stepOnlyInstanceIds = [instanceId];
	      stepInterpreter(0);
	    }
	  } finally {
	    __stepOnlyInstanceIds = savedFilter;
	    frameGlobalReadSnapshot = savedSnapshot;
	  }
	}

	function getFirstImagePathForTemplateId(tid){
	  const list = objectImages[String(tid)]||[];
	  if (!list[0]) return null;
	  const src = list[0].src || '';
	  return src.split('?')[0];
	}
	function normalizeExportPath(p) {
	  if (p == null || p === '') return null;
	  return String(p).split('?')[0];
	}

	function startPlay(){
	  runtimeInstances = [];
	  runtimeExecState = {};
	  instancesPendingRemoval = new Set();
	  runtimeVariables = {};
	  runtimeGlobalVariables = {};
	  const controller = objects.find(o=>o.type==='controller' || o.name==='AppController');
	  if (controller){
	    try { const pubArrs = Array.isArray(controller.arrayVariables) ? controller.arrayVariables : []; pubArrs.forEach(name => { if (!Array.isArray(runtimeGlobalVariables[name])) runtimeGlobalVariables[name] = []; }); } catch(_) {}
	    const instId = nextInstanceId++;
	    runtimeInstances.push({ instanceId: instId, templateId: controller.id });
	    runtimePositions[instId] = { x:0, y:0, layer: 0 };
	    runtimeVariables[instId] = {};
	    const cm = codeMapByTemplateId[controller.id];
	    const code = Array.isArray(controller.code) ? controller.code : [];
	    const start = cm ? Object.values(cm).find(b => b && b.type === 'start') : code.find(b => b && b.type === 'start');
	    runtimeExecState[instId] = { pc: start ? start.next_block_a : null, waitMs:0, waitingBlockId:null, repeatStack: [], yieldFrame: false, yieldResumePc: null };
	  }
	}

	function worldToCanvas(x,y,canvas){
	  const cx = canvas.width/2 + x;
	  const cy = canvas.height/2 - y;
	  return { x: cx, y: cy };
	}

	const imageCache = {};
	function resolveExportImage(inst) {
	  const tmpl = objectById[inst.templateId];
	  if (!tmpl) return null;
	  const pi = runtimePositions[inst.instanceId] || {};
	  const primary = normalizeExportPath(pi.spritePath || getFirstImagePathForTemplateId(tmpl.id));
	  const fallback = normalizeExportPath(getFirstImagePathForTemplateId(tmpl.id));
	  const mediaP = tmpl.media && tmpl.media[0] && tmpl.media[0].path ? normalizeExportPath(tmpl.media[0].path) : null;
	  const tryKeys = [];
	  if (primary) tryKeys.push(primary);
	  if (fallback && fallback !== primary) tryKeys.push(fallback);
	  if (mediaP && tryKeys.indexOf(mediaP) < 0) tryKeys.push(mediaP);
	  for (let ki = 0; ki < tryKeys.length; ki++) {
	    const key = tryKeys[ki];
	    const img = imageCache[key];
	    if (img && img.complete && img.naturalWidth > 0) return { img, pathKey: key };
	  }
	  return null;
	}
	let touchingScratchCanvasExport = null;
	let __touchFrameSerial = 0;
	const __colorScratchCacheExport = { serial: -1, excludeId: null, w: 0, h: 0, fingerprint: 0 };
	function touchingWorldFingerprintExport(inst, canvas) {
	  let h = (canvas.width << 16) ^ canvas.height;
	  for (let i = 0; i < runtimeInstances.length; i++) {
	    const o = runtimeInstances[i];
	    if (o.instanceId === inst.instanceId) continue;
	    const p = runtimePositions[o.instanceId] || {};
	    const x = typeof p.x === 'number' ? p.x : 0;
	    const y = typeof p.y === 'number' ? p.y : 0;
	    const rot = typeof p.rot === 'number' ? p.rot : 0;
	    const ly = typeof p.layer === 'number' ? p.layer : 0;
	    const sc = typeof p.scale === 'number' ? p.scale : 1;
	    const al = typeof p.alpha === 'number' ? p.alpha : 1;
	    const sp = p.spritePath != null ? String(p.spritePath) : '';
	    h = Math.imul(h, 0x9e3779b9) + o.instanceId;
	    h = Math.imul(h, 0x9e3779b9) + (x * 1000 | 0);
	    h = Math.imul(h, 0x9e3779b9) + (y * 1000 | 0);
	    h = Math.imul(h, 0x9e3779b9) + (rot * 1000 | 0);
	    h = Math.imul(h, 0x9e3779b9) + ly;
	    h = Math.imul(h, 0x9e3779b9) + (sc * 1000 | 0);
	    h = Math.imul(h, 0x9e3779b9) + (al * 1000 | 0);
	    for (let j = 0; j < sp.length; j++) h = Math.imul(h, 31) + sp.charCodeAt(j);
	  }
	  return h | 0;
	}
	const spriteImageDataTouch = {};
	function getSpriteImageDataTouch(path, img) {
	  if (spriteImageDataTouch[path]) return spriteImageDataTouch[path];
	  if (!img || !img.complete || !(img.naturalWidth > 0)) return null;
	  const c = document.createElement('canvas');
	  c.width = img.naturalWidth;
	  c.height = img.naturalHeight;
	  const x = c.getContext('2d');
	  try { x.drawImage(img, 0, 0); } catch (_) { return null; }
	  let d;
	  try { d = x.getImageData(0, 0, c.width, c.height).data; } catch (_) { return null; }
	  return spriteImageDataTouch[path] = { data: d, width: c.width, height: c.height };
	}
	function spriteAlphaTouch(path, lx, ly, img) {
	  const g = getSpriteImageDataTouch(path, img);
	  if (!g) return 0;
	  const ix = Math.floor(lx);
	  const iy = Math.floor(ly);
	  if (ix < 0 || iy < 0 || ix >= g.width || iy >= g.height) return 0;
	  return g.data[(iy * g.width + ix) * 4 + 3];
	}
	function getBoundsTouch(inst, canvas) {
	  const tmpl = objectById[inst.templateId];
	  if (!tmpl) return null;
	  const res = resolveExportImage(inst);
	  if (!res) return null;
	  const { img, pathKey: path } = res;
	  const perInst = runtimePositions[inst.instanceId] || {};
	  const scale = (typeof perInst.scale === 'number') ? Math.max(0, perInst.scale) : 1;
	  const nw = img.naturalWidth || img.width;
	  const nh = img.naturalHeight || img.height;
	  const dw = nw * scale;
	  const dh = nh * scale;
	  const p = worldToCanvas(perInst.x || 0, perInst.y || 0, canvas);
	  return { left: p.x - dw / 2, top: p.y - dh / 2, right: p.x + dw / 2, bottom: p.y + dh / 2, dw, dh, img, path };
	}
	function getRotatedSpriteCanvasAABBExp(bounds, rotDeg) {
	  if (!bounds) return null;
	  const cx = bounds.left + bounds.dw / 2;
	  const cy = bounds.top + bounds.dh / 2;
	  const hw = bounds.dw / 2;
	  const hh = bounds.dh / 2;
	  if (rotDeg == null || rotDeg === 0 || rotDeg === 360 || rotDeg === -360) {
	    return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
	  }
	  const th = rotDeg * Math.PI / 180;
	  const cos = Math.cos(th);
	  const sin = Math.sin(th);
	  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
	  let minX = Infinity;
	  let maxX = -Infinity;
	  let minY = Infinity;
	  let maxY = -Infinity;
	  for (let ci = 0; ci < 4; ci++) {
	    const lx = corners[ci][0];
	    const ly = corners[ci][1];
	    const px = cx + lx * cos - ly * sin;
	    const py = cy + lx * sin + ly * cos;
	    if (px < minX) minX = px;
	    if (px > maxX) maxX = px;
	    if (py < minY) minY = py;
	    if (py > maxY) maxY = py;
	  }
	  return { left: minX, top: minY, right: maxX, bottom: maxY };
	}
	function canvasAlphaFromInstanceExport(inst, px, py, canvas) {
	  const b = getBoundsTouch(inst, canvas);
	  if (!b) return 0;
	  const perInst = runtimePositions[inst.instanceId] || {};
	  const rotDeg = typeof perInst.rot === 'number' ? perInst.rot : 0;
	  const th = rotDeg * Math.PI / 180;
	  const cos = Math.cos(th);
	  const sin = Math.sin(th);
	  const cx = b.left + b.dw / 2;
	  const cy = b.top + b.dh / 2;
	  const dx = px - cx;
	  const dy = py - cy;
	  const lx = cos * dx + sin * dy;
	  const ly = -sin * dx + cos * dy;
	  const hw = b.dw / 2;
	  const hh = b.dh / 2;
	  if (lx < -hw || lx > hw || ly < -hh || ly > hh) return 0;
	  const u01 = (lx + hw) / b.dw;
	  const v01 = (ly + hh) / b.dh;
	  if (u01 < 0 || u01 > 1 || v01 < 0 || v01 > 1) return 0;
	  const ix = u01 * b.img.naturalWidth;
	  const iy = v01 * b.img.naturalHeight;
	  const raw = spriteAlphaTouch(b.path, ix, iy, b.img);
	  const g = (typeof perInst.alpha === 'number') ? Math.max(0, Math.min(1, perInst.alpha)) : 1;
	  return Math.round(raw * g);
	}
	function evalTouchingObjectExport(inst, node, canvas) {
	  const tid = parseInt(String(node.val_a || '0'), 10);
	  if (!Number.isFinite(tid)) return 0;
	  const selfB = getBoundsTouch(inst, canvas);
	  if (!selfB) return 0;
	  const selfRot = (runtimePositions[inst.instanceId] && typeof runtimePositions[inst.instanceId].rot === 'number')
	    ? runtimePositions[inst.instanceId].rot : 0;
	  const selfAabb = getRotatedSpriteCanvasAABBExp(selfB, selfRot);
	  if (!selfAabb) return 0;
	  const ALPHA_THRESHOLD = 16;
	  for (let i = 0; i < runtimeInstances.length; i++) {
	    const other = runtimeInstances[i];
	    if (other.instanceId === inst.instanceId) continue;
	    if (other.templateId !== tid) continue;
	    const ob = getBoundsTouch(other, canvas);
	    if (!ob) continue;
	    const otherRot = (runtimePositions[other.instanceId] && typeof runtimePositions[other.instanceId].rot === 'number')
	      ? runtimePositions[other.instanceId].rot : 0;
	    const otherAabb = getRotatedSpriteCanvasAABBExp(ob, otherRot);
	    if (!otherAabb) continue;
	    const left = Math.max(selfAabb.left, otherAabb.left, 0);
	    const top = Math.max(selfAabb.top, otherAabb.top, 0);
	    const right = Math.min(selfAabb.right, otherAabb.right, canvas.width);
	    const bottom = Math.min(selfAabb.bottom, otherAabb.bottom, canvas.height);
	    if (right <= left || bottom <= top) continue;
	    const w = right - left;
	    const h = bottom - top;
	    const area = w * h;
	    const stride = area > 80000 ? 3 : (area > 20000 ? 2 : 1);
	    for (let py = Math.floor(top); py < Math.ceil(bottom); py += stride) {
	      for (let px = Math.floor(left); px < Math.ceil(right); px += stride) {
	        const aa = canvasAlphaFromInstanceExport(inst, px + 0.5, py + 0.5, canvas);
	        if (aa < ALPHA_THRESHOLD) continue;
	        const bb = canvasAlphaFromInstanceExport(other, px + 0.5, py + 0.5, canvas);
	        if (bb >= ALPHA_THRESHOLD) return 1;
	      }
	    }
	  }
	  return 0;
	}
	function evalTouchingColorExport(inst, node, canvas) {
	  const tr = Math.max(0, Math.min(255, Math.round(Number(node.rgb_r ?? 0) || 0)));
	  const tg = Math.max(0, Math.min(255, Math.round(Number(node.rgb_g ?? 0) || 0)));
	  const tb = Math.max(0, Math.min(255, Math.round(Number(node.rgb_b ?? 0) || 0)));
	  const selfB = getBoundsTouch(inst, canvas);
	  if (!selfB) return 0;
	  const sc = touchingScratchCanvasExport || (touchingScratchCanvasExport = document.createElement('canvas'));
	  if (sc.width !== canvas.width || sc.height !== canvas.height) {
	    sc.width = canvas.width;
	    sc.height = canvas.height;
	  }
	  const sctx = sc.getContext('2d');
	  const fp = touchingWorldFingerprintExport(inst, canvas);
	  if (!(__colorScratchCacheExport.serial === __touchFrameSerial
	      && __colorScratchCacheExport.excludeId === inst.instanceId
	      && __colorScratchCacheExport.w === canvas.width
	      && __colorScratchCacheExport.h === canvas.height
	      && __colorScratchCacheExport.fingerprint === fp)) {
	    sctx.fillStyle = '#777';
	    sctx.fillRect(0, 0, canvas.width, canvas.height);
	    sctx.imageSmoothingEnabled = false;
	    const entries = [];
	    for (let i = 0; i < runtimeInstances.length; i++) {
	      const i2 = runtimeInstances[i];
	      if (i2.instanceId === inst.instanceId) continue;
	      const res = resolveExportImage(i2);
	      if (res) entries.push({ inst: i2, path: res.pathKey });
	    }
	    entries.sort((a, b) => {
	      const la = (runtimePositions[a.inst.instanceId] && typeof runtimePositions[a.inst.instanceId].layer === 'number') ? runtimePositions[a.inst.instanceId].layer : 0;
	      const lb = (runtimePositions[b.inst.instanceId] && typeof runtimePositions[b.inst.instanceId].layer === 'number') ? runtimePositions[b.inst.instanceId].layer : 0;
	      return la - lb;
	    });
	    for (const e of entries) {
	      let im = imageCache[e.path];
	      if (!im || !im.complete || !(im.naturalWidth > 0)) continue;
	      const pi = runtimePositions[e.inst.instanceId] || {};
	      const sca = (typeof pi.scale === 'number') ? Math.max(0, pi.scale) : 1;
	      const dw = (im.naturalWidth || im.width) * sca;
	      const dh = (im.naturalHeight || im.height) * sca;
	      const p = worldToCanvas(pi.x || 0, pi.y || 0, canvas);
	      const dx = Math.round(p.x - dw / 2);
	      const dy = Math.round(p.y - dh / 2);
	      if (dx + dw < 0 || dy + dh < 0 || dx > canvas.width || dy > canvas.height) continue;
	      const al = (typeof pi.alpha === 'number') ? Math.max(0, Math.min(1, pi.alpha)) : 1;
	      if (typeof pi.rot === 'number') {
	        const ar = (pi.rot || 0) * Math.PI / 180;
	        sctx.save();
	        sctx.translate(dx + dw / 2, dy + dh / 2);
	        sctx.rotate(ar);
	        const pr = sctx.globalAlpha;
	        sctx.globalAlpha = al;
	        sctx.drawImage(im, -dw / 2, -dh / 2, dw, dh);
	        sctx.globalAlpha = pr;
	        sctx.restore();
	      } else {
	        const pr = sctx.globalAlpha;
	        sctx.globalAlpha = al;
	        sctx.drawImage(im, dx, dy, dw, dh);
	        sctx.globalAlpha = pr;
	      }
	    }
	    __colorScratchCacheExport.serial = __touchFrameSerial;
	    __colorScratchCacheExport.excludeId = inst.instanceId;
	    __colorScratchCacheExport.w = canvas.width;
	    __colorScratchCacheExport.h = canvas.height;
	    __colorScratchCacheExport.fingerprint = fp;
	  }
	  const selfRot = (runtimePositions[inst.instanceId] && typeof runtimePositions[inst.instanceId].rot === 'number')
	    ? runtimePositions[inst.instanceId].rot : 0;
	  const selfAabb = getRotatedSpriteCanvasAABBExp(selfB, selfRot);
	  if (!selfAabb) return 0;
	  const left = Math.max(Math.floor(selfAabb.left), 0);
	  const top = Math.max(Math.floor(selfAabb.top), 0);
	  const right = Math.min(Math.ceil(selfAabb.right), canvas.width);
	  const bottom = Math.min(Math.ceil(selfAabb.bottom), canvas.height);
	  if (right <= left || bottom <= top) return 0;
	  const w = right - left;
	  const h = bottom - top;
	  const area = w * h;
	  const stride = area > 80000 ? 3 : (area > 20000 ? 2 : 1);
	  const ALPHA_THRESHOLD = 32;
	  for (let py = top; py < bottom; py += stride) {
	    const pyFloor = py | 0;
	    if (pyFloor < 0 || pyFloor >= canvas.height) continue;
	    const rowLeft = Math.max(0, left);
	    const rowRight = Math.min(canvas.width, right);
	    const rowW = rowRight - rowLeft;
	    if (rowW <= 0) continue;
	    let rowData;
	    try { rowData = sctx.getImageData(rowLeft, pyFloor, rowW, 1).data; } catch (_) { continue; }
	    for (let px = left; px < right; px += stride) {
	      if (px < 0 || px >= canvas.width) continue;
	      if (canvasAlphaFromInstanceExport(inst, px + 0.5, py + 0.5, canvas) < ALPHA_THRESHOLD) continue;
	      const ix = (px - rowLeft) * 4;
	      if (rowData[ix] === tr && rowData[ix + 1] === tg && rowData[ix + 2] === tb) return 1;
	    }
	  }
	  return 0;
	}

	function stepInterpreter(dt){
	  frameGlobalReadSnapshot=null;
	  let totalStepsThisFrame = 0;
	  const maxStepsPerObject = 50;
	  const count = runtimeInstances.length;
	  if (count === 0) return;
	  function isAppCtrl(o){ return o && (o.type==='controller' || o.name==='AppController'); }
	  const isFilteredStep = __stepOnlyInstanceIds && Array.isArray(__stepOnlyInstanceIds) && __stepOnlyInstanceIds.length > 0;
	  if (!isFilteredStep) {
	    for (let ri = 0; ri < count; ri++) {
	      const exec = runtimeExecState[runtimeInstances[ri].instanceId];
	      if (exec && exec.yieldFrame) {
	        exec.yieldFrame = false;
	        exec.pc = exec.yieldResumePc;
	        exec.yieldResumePc = null;
	      }
	    }
	  }
	  const orderedInstances = [];
	  for (let ii=0; ii<count; ii++) { const inst=runtimeInstances[ii]; const o=objectById[inst.templateId]; if(isAppCtrl(o)) orderedInstances.push(inst); }
	  for (let ii=0; ii<count; ii++) { const inst=runtimeInstances[ii]; const o=objectById[inst.templateId]; if(!isAppCtrl(o)) orderedInstances.push(inst); }
	  for (let i=0; i<orderedInstances.length; i++){
	    const inst = orderedInstances[i];
	    if (!inst) continue;
	    if (__stepOnlyInstanceIds && Array.isArray(__stepOnlyInstanceIds) && __stepOnlyInstanceIds.length>0){ if (!__stepOnlyInstanceIds.includes(inst.instanceId)) continue; }
	    const o = objectById[inst.templateId];
	    const exec = runtimeExecState[inst.instanceId];
	    if (!o || !exec) continue;
	    if (!isAppCtrl(o) && frameGlobalReadSnapshot===null) {
	      frameGlobalReadSnapshot={};
	      for (const k of Object.keys(runtimeGlobalVariables)) {
	        const v=runtimeGlobalVariables[k];
	        if (typeof v==='number') frameGlobalReadSnapshot[k]=v;
	        else if (Array.isArray(v)) frameGlobalReadSnapshot[k]=v;
	      }
	    }
	    const useGlobalReadSnapshot = frameGlobalReadSnapshot!==null && !isAppCtrl(o);
	    const code = o.code || [];
	    const codeMap = codeMapByTemplateId[o.id] || null;
	    if (exec.waitMs>0){ exec.waitMs-=dt; if (exec.waitMs>0) continue; exec.waitMs=0; if(exec.waitingBlockId!=null){ const waitingBlock=codeMap ? codeMap[exec.waitingBlockId] : code.find(b=>b&&b.id===exec.waitingBlockId); exec.waitingBlockId=null; if(waitingBlock){ exec.pc = (typeof waitingBlock.next_block_a==='number') ? waitingBlock.next_block_a : null; } } }
	    let steps=0;
	    let outerPasses=0;
	    const perInstanceBudgetStart = performance.now();
	    outerLoop: while (outerPasses < 50000) {
	    outerPasses++;
	    while (exec.pc!=null && steps<maxStepsPerObject){
	      const block = codeMap ? codeMap[exec.pc] : code.find(b=>b&&b.id===exec.pc); if(!block){ exec.pc=null; break; }
	      const coerceScalarLiteral=(v)=>{ if(typeof v==='number') return v; if(typeof v==='string'){ const s=v.trim(); if(s==='') return ''; if(/^\\s*[+-]?(?:\\d*\\.?\\d+|\\d+\\.?\\d*)\\s*\\/\\s*[+-]?(?:\\d*\\.?\\d+|\\d+\\.?\\d*)\\s*$/.test(s)) return parseNumericInput(s); const n=Number(s); return Number.isFinite(n)?n:v; } return v; };
	      const getArrayRef=(varName,instanceOnly)=>{ const name=varName||''; const store=instanceOnly ? (runtimeVariables[inst.instanceId] || (runtimeVariables[inst.instanceId]={})) : runtimeGlobalVariables; let arr=store[name]; if(!Array.isArray(arr)){ arr=[]; store[name]=arr; } return arr; };
	      const resolveInput=(blockRef,key)=>{ const inputId=blockRef[key]; if(inputId==null) return null; const node=codeMap ? codeMap[inputId] : code.find(b=>b&&b.id===inputId); if(!node) return null; if(node.content==='mouse_x') return runtimeMouse.x; if(node.content==='mouse_y') return runtimeMouse.y; if(node.content==='window_width'){ const c=document.getElementById('game'); return c? c.width : window.innerWidth; } if(node.content==='window_height'){ const c=document.getElementById('game'); return c? c.height : window.innerHeight; } if(node.content==='object_x'){ const pos=runtimePositions[inst.instanceId]||{x:0,y:0}; return typeof pos.x==='number'?pos.x:0;} if(node.content==='object_y'){ const pos=runtimePositions[inst.instanceId]||{y:0}; return typeof pos.y==='number'?pos.y:0;} if(node.content==='rotation'){ const pos=runtimePositions[inst.instanceId]||{rot:0}; return typeof pos.rot==='number'?pos.rot:0;} if(node.content==='size'){ const pos=runtimePositions[inst.instanceId]||{scale:1}; return typeof pos.scale==='number'?pos.scale:1;} if(node.content==='mouse_pressed') return runtimeMousePressed?1:0; if(node.content==='key_pressed') return runtimeKeys[node.key_name]?1:0; if(node.content==='image_name'){ try{ const tmpl=objectById[inst.templateId]; const path=(runtimePositions[inst.instanceId]&&runtimePositions[inst.instanceId].spritePath)||(tmpl&&tmpl.media&&tmpl.media[0]&&tmpl.media[0].path?tmpl.media[0].path:null); if(!tmpl||!path) return ''; const images=objectImages[String(tmpl.id)]||[]; const base=path.split('?')[0]; const found=images.find(img=>(img.src||'').split('?')[0]===base); return (found&&found.name)?found.name:''; }catch(_){ return ''; } } if(node.content==='distance_to'){ const pos=runtimePositions[inst.instanceId]||{x:0,y:0}; const tx=parseNumericInput((node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0)); const ty=parseNumericInput((node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0)); const dx=(typeof pos.x==='number'?pos.x:0)-tx; const dy=(typeof pos.y==='number'?pos.y:0)-ty; return Math.hypot(dx,dy);} if(node.content==='pixel_is_rgb'){ const c=document.getElementById('game'); if(!c) return 0; const xw=parseNumericInput((node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0)); const yw=parseNumericInput((node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0)); const p=worldToCanvas(xw,yw,c); const px=Math.round(p.x); const py=Math.round(p.y); if(!Number.isFinite(px)||!Number.isFinite(py)) return 0; if(px<0||py<0||px>=c.width||py>=c.height) return 0; const cctx=c.getContext('2d'); if(!cctx) return 0; let data; try{ data=cctx.getImageData(px,py,1,1).data; }catch(_){ return 0; } const r=data[0], g=data[1], b=data[2]; const tr=Math.max(0, Math.min(255, Math.round(Number(node.rgb_r ?? 0) || 0))); const tg=Math.max(0, Math.min(255, Math.round(Number(node.rgb_g ?? 0) || 0))); const tb=Math.max(0, Math.min(255, Math.round(Number(node.rgb_b ?? 0) || 0))); return (r===tr && g===tg && b===tb) ? 1 : 0; } if(node.content==='touching'){ const mode=node.touching_mode||'object'; const c=document.getElementById('game'); if(!c) return 0; if(mode==='object'){ return evalTouchingObjectExport(inst,node,c); } if(mode==='color'){ return evalTouchingColorExport(inst,node,c); } return 0; } if(node.content==='random_int'){ let a=parseNumericInput((node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0)); let b=parseNumericInput((node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0)); if(Number.isNaN(a)) a=0; if(Number.isNaN(b)) b=0; if(a>b){ const t=a; a=b; b=t; } return Math.floor(Math.random()*(b-a+1))+a; } if(node.content==='operation'){ const rawA=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.op_x ?? 0):(node.op_x ?? 0); const rawB=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.op_y ?? 0):(node.op_y ?? 0); const op=node.val_a||'+'; if(op==='+'){ if(typeof rawA==='string'||typeof rawB==='string') return String(rawA??'')+String(rawB??''); return parseNumericInput(rawA)+parseNumericInput(rawB);} const xVal=parseNumericInput(rawA); const yVal=parseNumericInput(rawB); switch(op){ case '-': return xVal - yVal; case '*': return xVal * yVal; case '/': return (yVal===0)?0:(xVal / yVal); case '^': return Math.pow(xVal, yVal); default: return xVal + yVal; } } if(node.content==='not'){ const v=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const num=parseNumericInput(v); return num?0:1; } if(node.content==='equals'){ const aVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const bVal=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0); const A=(aVal==null)?'':aVal; const B=(bVal==null)?'':bVal; return (A==B)?1:0; } if(node.content==='less_than'){ const aVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const bVal=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0); let A=parseNumericInput(aVal); let B=parseNumericInput(bVal); if(Number.isNaN(A)) A=0; if(Number.isNaN(B)) B=0; return (A<B)?1:0; } if(node.content==='and'){ const aVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const bVal=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0); const A=parseNumericInput(aVal); const B=parseNumericInput(bVal); return (A!==0 && B!==0)?1:0; } if(node.content==='or'){ const aVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const bVal=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0); const A=parseNumericInput(aVal); const B=parseNumericInput(bVal); return (A!==0 || B!==0)?1:0; } if(node.content==='variable'){ const varName=node.var_name||''; if(node.var_instance_only){ const vars=runtimeVariables[inst.instanceId] || (runtimeVariables[inst.instanceId]={}); const v=vars[varName]; return (typeof v==='number')?v:0; } else { const store=useGlobalReadSnapshot?frameGlobalReadSnapshot:runtimeGlobalVariables; const v=store[varName]; return (typeof v==='number')?v:0; } } if(node.content==='array_get'){ const arr=getArrayRef(node.var_name||'', !!node.var_instance_only); const idxVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const idx=Math.floor(parseNumericInput(idxVal)); if(!Number.isFinite(idx) || idx<0 || idx>=arr.length) return ''; return arr[idx]; } if(node.content==='array_length'){ const arr=getArrayRef(node.var_name||'', !!node.var_instance_only); return arr.length; } return null; };
	      if (block.type==='action'){
	        if (block.content==='move_xy'){ const x=parseNumericInput(resolveInput(block,'input_a') ?? block.val_a ?? 0); const y=parseNumericInput(resolveInput(block,'input_b') ?? block.val_b ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,layer:0}; runtimePositions[inst.instanceId].x += x; runtimePositions[inst.instanceId].y += y; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='move_forward'){ const distance=parseNumericInput(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,rot:0}; const rotDeg=runtimePositions[inst.instanceId].rot || 0; const rotRad=(rotDeg)*Math.PI/180; runtimePositions[inst.instanceId].x += Math.sin(rotRad)*distance; runtimePositions[inst.instanceId].y += Math.cos(rotRad)*distance; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='rotate'){ if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,rot:0}; runtimePositions[inst.instanceId].rot = (runtimePositions[inst.instanceId].rot||0) + parseNumericInput(resolveInput(block,'input_a') ?? block.val_a ?? 0); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='set_rotation'){ if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,rot:0}; runtimePositions[inst.instanceId].rot = parseNumericInput(resolveInput(block,'input_a') ?? block.val_a ?? 0); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='set_size'){ const s=parseNumericInput(resolveInput(block,'input_a') ?? block.val_a ?? 1); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,scale:1,layer:0}; runtimePositions[inst.instanceId].scale = Math.max(0,s); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='set_opacity'){ let a=parseNumericInput(resolveInput(block,'input_a') ?? block.val_a ?? 1); if(Number.isNaN(a)) a=1; a=Math.max(0,Math.min(1,a)); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,layer:0}; runtimePositions[inst.instanceId].alpha=a; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='set_layer'){ const layer=parseNumericInput(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,layer:0}; runtimePositions[inst.instanceId].layer = layer; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='point_towards'){ if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,rot:0}; const pos=runtimePositions[inst.instanceId]; const tx=parseNumericInput((block.input_a!=null)?(resolveInput(block,'input_a') ?? block.val_a ?? 0):(block.val_a ?? 0)); const ty=parseNumericInput((block.input_b!=null)?(resolveInput(block,'input_b') ?? block.val_b ?? 0):(block.val_b ?? 0)); const dx=tx-(typeof pos.x==='number'?pos.x:0); const dy=ty-(typeof pos.y==='number'?pos.y:0); const ang=90 - (Math.atan2(dy,dx)*180/Math.PI); pos.rot = ang; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='change_size'){ const ds=parseNumericInput(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,scale:1}; const cur=runtimePositions[inst.instanceId].scale||1; runtimePositions[inst.instanceId].scale=Math.max(0,cur+ds); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='wait'){ const seconds=Math.max(0, parseNumericInput(resolveInput(block,'input_a') ?? block.val_a ?? 0)); if(seconds<=0){ exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; } if(exec.waitMs<=0 || exec.waitingBlockId!==block.id){ exec.waitMs=seconds*1000; exec.waitingBlockId=block.id; } break; }
	        if (block.content==='repeat'){ const times=Math.max(0, Math.floor(parseNumericInput(block.val_a ?? 0))); if(times<=0){ exec.pc=(typeof block.next_block_b==='number')?block.next_block_b:null; continue; } exec.repeatStack.push({ repeatBlockId:block.id, timesRemaining:times, afterId:(typeof block.next_block_b==='number')?block.next_block_b:null }); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='print'){ const val=(block.input_a!=null)?(resolveInput(block,'input_a') ?? block.val_a ?? ''):(block.val_a ?? ''); try{ console.log(val);}catch(_){} exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='if'){ const condVal=parseNumericInput(resolveInput(block,'input_a') ?? block.val_a ?? 0); const isTrue = !!condVal; exec.pc = isTrue ? ((typeof block.next_block_b==='number')?block.next_block_b:null) : ((typeof block.next_block_a==='number')?block.next_block_a:null); continue; }
	        if (block.content==='set_x'){ const x=parseNumericInput(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,layer:0}; runtimePositions[inst.instanceId].x=x; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='set_y'){ const y=parseNumericInput(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0}; runtimePositions[inst.instanceId].y=y; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='switch_image'){ const imgs=(objectImages[String(o.id)]||[]); let found=null; if(block.input_a!=null){ const sel=resolveInput(block,'input_a'); if(sel==null||sel===''){ found=imgs.find(img=>String(img.id)===String(block.val_a)); } else if(typeof sel==='string'){ const s=sel.trim(); found=imgs.find(img=>img.name===s)||imgs.find(img=>String(img.id)===s); } else { found=imgs.find(img=>String(img.id)===String(sel)); } } else { found=imgs.find(img=>String(img.id)===String(block.val_a)); } if(found){ if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0}; runtimePositions[inst.instanceId].spritePath = (found.src||'').split('?')[0]; } exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='play_sound'){ const snds=(objectSounds[String(o.id)]||[]); let sfound=null; if(block.input_a!=null){ const sel=resolveInput(block,'input_a'); if(sel==null||sel===''){ sfound=snds.find(s=>String(s.id)===String(block.val_a)); } else if(typeof sel==='string'){ const s=sel.trim(); sfound=snds.find(x=>x.name===s)||snds.find(x=>String(x.id)===s); } else { sfound=snds.find(s=>String(s.id)===String(sel)); } } else { sfound=snds.find(s=>String(s.id)===String(block.val_a)); } if(sfound){ try{ const src=(sfound.src||''); if(src){ const a=new Audio(); a.src=src; a.volume=1; a.play().catch(()=>{});}}catch(_){} } exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='instantiate'){ const objId=parseInt(block.val_a,10); const template=objectById[objId]; if(template){ const newId=nextInstanceId++; if(registerRuntimeInstanceFromTemplate(newId, template.id)){ runInstanceStartChainSync(newId); } } exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='delete_instance'){ instancesPendingRemoval.add(inst.instanceId); exec.pc=null; continue; }
	        if (block.content==='set_variable'){ const varName=block.var_name||''; const value=parseNumericInput(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(block.var_instance_only){ if(!runtimeVariables[inst.instanceId]) runtimeVariables[inst.instanceId]={}; runtimeVariables[inst.instanceId][varName]=value; } else { runtimeGlobalVariables[varName]=value; syncFrameGlobalReadSnapshotAfterPublicWrite(varName); } exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='change_variable'){ const varName=block.var_name||''; const delta=parseNumericInput(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(block.var_instance_only){ if(!runtimeVariables[inst.instanceId]) runtimeVariables[inst.instanceId]={}; const curVal=runtimeVariables[inst.instanceId][varName]; const current=(typeof curVal==='number')?curVal:0; runtimeVariables[inst.instanceId][varName]=current+delta; } else { const curVal=runtimeGlobalVariables[varName]; const current=(typeof curVal==='number')?curVal:0; runtimeGlobalVariables[varName]=current+delta; syncFrameGlobalReadSnapshotAfterPublicWrite(varName); } exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='array_append'){ const varName=block.var_name||''; const raw=(block.input_a!=null)?(resolveInput(block,'input_a') ?? block.val_a ?? ''):(block.val_a ?? ''); const value=coerceScalarLiteral(raw); const arr=getArrayRef(varName, !!block.var_instance_only); arr.push(value); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='array_insert'){ const varName=block.var_name||''; const raw=(block.input_a!=null)?(resolveInput(block,'input_a') ?? block.val_a ?? ''):(block.val_a ?? ''); const value=coerceScalarLiteral(raw); const idxVal=(block.input_b!=null)?(resolveInput(block,'input_b') ?? block.val_b ?? 0):(block.val_b ?? 0); let idx=Math.floor(parseNumericInput(idxVal)); if(!Number.isFinite(idx)) idx=0; const arr=getArrayRef(varName, !!block.var_instance_only); idx=Math.max(0, Math.min(arr.length, idx)); arr.splice(idx,0,value); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='array_delete'){ const varName=block.var_name||''; const idxVal=(block.input_a!=null)?(resolveInput(block,'input_a') ?? block.val_a ?? 0):(block.val_a ?? 0); const idx=Math.floor(parseNumericInput(idxVal)); const arr=getArrayRef(varName, !!block.var_instance_only); if(Number.isFinite(idx) && idx>=0 && idx<arr.length){ arr.splice(idx,1); } exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='forever'){ exec.repeatStack.push({ repeatBlockId:block.id, timesRemaining:Infinity, afterId:(typeof block.next_block_b==='number')?block.next_block_b:null }); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	      }
	      exec.pc = (typeof block.next_block_a==='number') ? block.next_block_a : null;
	      steps += 1;
	      totalStepsThisFrame += 1;
	      if (totalStepsThisFrame >= MAX_TOTAL_STEPS_PER_FRAME) break;
	      if ((performance.now() - perInstanceBudgetStart) >= TIME_BUDGET_MS) break;
	    }
	    if (exec.pc==null && exec.repeatStack.length>0){
	      const frame=exec.repeatStack[exec.repeatStack.length-1];
	      frame.timesRemaining-=1;
	      if(frame.timesRemaining>0){
	        const repeatBlock=codeMap ? codeMap[frame.repeatBlockId] : code.find(b=>b&&b.id===frame.repeatBlockId);
	        if(repeatBlock && repeatBlock.content==='forever'){
	          exec.yieldFrame = true;
	          exec.yieldResumePc = (typeof repeatBlock.next_block_a === 'number') ? repeatBlock.next_block_a : null;
	          exec.pc = null;
	          break outerLoop;
	        }
	        exec.pc = repeatBlock && (typeof repeatBlock.next_block_a==='number') ? repeatBlock.next_block_a : null;
	        if(exec.pc!=null){ continue outerLoop; }
	        exec.yieldFrame = true;
	        exec.yieldResumePc = null;
	        break outerLoop;
	      }
	      exec.repeatStack.pop();
	      exec.pc = frame.afterId != null ? frame.afterId : null;
	      continue outerLoop;
	    }
	    break outerLoop;
	    }
	  }
	  
	  if (instancesPendingRemoval && instancesPendingRemoval.size>0){
	    runtimeInstances = runtimeInstances.filter(inst=>{ if(instancesPendingRemoval.has(inst.instanceId)){ delete runtimePositions[inst.instanceId]; delete runtimeVariables[inst.instanceId]; delete runtimeExecState[inst.instanceId]; return false; } return true; });
	    instancesPendingRemoval.clear();
	  }
	  frameGlobalReadSnapshot=null;
	}

	const canvas = document.getElementById('game');
	const gctx = canvas.getContext('2d');
	const stageW = Math.max(1, Math.round(Number(project.stageWidth) || window.innerWidth));
	const stageH = Math.max(1, Math.round(Number(project.stageHeight) || window.innerHeight));
	function fit(){
	  canvas.width = stageW;
	  canvas.height = stageH;
	  const vw = window.innerWidth;
	  const vh = window.innerHeight;
	  const sc = Math.min(vw / stageW, vh / stageH);
	  canvas.style.width = (stageW * sc) + 'px';
	  canvas.style.height = (stageH * sc) + 'px';
	}
	window.addEventListener('resize', fit);
	fit();

	function updateExportMouse(e){
	  const rect = canvas.getBoundingClientRect();
	  const localX = e.clientX - rect.left;
	  const localY = e.clientY - rect.top;
	  const sx = canvas.width / Math.max(1e-6, rect.width);
	  const sy = canvas.height / Math.max(1e-6, rect.height);
	  runtimeMouse.x = Math.round((localX - rect.width / 2) * sx);
	  runtimeMouse.y = Math.round((rect.height / 2 - localY) * sy);
	}
	canvas.addEventListener('mousemove', updateExportMouse);
	canvas.addEventListener('pointermove', updateExportMouse, { passive: true });
	canvas.addEventListener('mousedown',()=>{ runtimeMousePressed=true; });
	canvas.addEventListener('mouseup',()=>{ runtimeMousePressed=false; });
	canvas.addEventListener('mouseleave',()=>{ runtimeMousePressed=false; });
	window.addEventListener('mouseup',()=>{ runtimeMousePressed=false; });
	function normalizeKeyName(k){ if(k===' '||k==='Spacebar') return 'Space'; return k; }
	document.addEventListener('keydown',(e)=>{ const k=normalizeKeyName(e.key); if(isPlaying&&k==='Space'){ const t=e.target; const tag=t&&t.tagName?String(t.tagName).toLowerCase():''; if(tag!=='input'&&tag!=='textarea'&&tag!=='select'&&!(t&&t.isContentEditable))e.preventDefault(); } runtimeKeys[k]=true;},true);
	document.addEventListener('keyup',(e)=>{ const k=normalizeKeyName(e.key); runtimeKeys[k]=false;});

	function render(){
	  gctx.clearRect(0,0,canvas.width,canvas.height);
	  gctx.fillStyle='#777';
	  gctx.fillRect(0,0,canvas.width,canvas.height);
	  gctx.imageSmoothingEnabled=false;
	  const centerX=canvas.width/2, centerY=canvas.height/2;
	  const visibleEntries = [];
	  for (let i = 0; i < runtimeInstances.length; i++) {
	    const inst = runtimeInstances[i];
	    const tmpl = objectById[inst.templateId];
	    if (!tmpl) continue;
	    const perInst = runtimePositions[inst.instanceId] || {};
	    const pth = perInst.spritePath || getFirstImagePathForTemplateId(tmpl.id);
	    const path = pth ? String(pth).split('?')[0] : null;
	    if (path) visibleEntries.push({ inst, tmpl, path });
	  }
	  visibleEntries.sort((a, b) => {
	    const la = (runtimePositions[a.inst.instanceId] && typeof runtimePositions[a.inst.instanceId].layer === 'number') ? runtimePositions[a.inst.instanceId].layer : 0;
	    const lb = (runtimePositions[b.inst.instanceId] && typeof runtimePositions[b.inst.instanceId].layer === 'number') ? runtimePositions[b.inst.instanceId].layer : 0;
	    return la - lb;
	  });
	  for (let ei = 0; ei < visibleEntries.length; ei++) {
	    const entry = visibleEntries[ei];
	    const mediaPath = entry.path;
	    let img = imageCache[mediaPath];
	    if (!img) { img = new Image(); img.crossOrigin = 'anonymous'; imageCache[mediaPath] = img; img.onerror = function(){ img._broken = true; }; img.src = mediaPath; }
	    if (!img.complete || img._broken || !(img.naturalWidth > 0 && img.naturalHeight > 0)) continue;
	    const perInst = runtimePositions[entry.inst.instanceId] || {};
	    let scale = 1;
	    if (typeof perInst.scale === 'number') scale = Math.max(0, perInst.scale || 1);
	    const dw = (img.naturalWidth || img.width) * scale;
	    const dh = (img.naturalHeight || img.height) * scale;
	    const p = worldToCanvas(perInst.x || 0, perInst.y || 0, canvas);
	    const drawX = Math.round(p.x - dw / 2);
	    const drawY = Math.round(p.y - dh / 2);
	    const alpha = (typeof perInst.alpha === 'number') ? Math.max(0, Math.min(1, perInst.alpha)) : 1;
	    if (typeof perInst.rot === 'number') {
	      const angleRad = (perInst.rot || 0) * Math.PI / 180;
	      gctx.save();
	      gctx.translate(drawX + dw / 2, drawY + dh / 2);
	      gctx.rotate(angleRad);
	      const prevAlpha = gctx.globalAlpha;
	      gctx.globalAlpha = alpha;
	      gctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
	      gctx.globalAlpha = prevAlpha;
	      gctx.restore();
	    } else {
	      const prevAlpha = gctx.globalAlpha;
	      gctx.globalAlpha = alpha;
	      gctx.drawImage(img, drawX, drawY, dw, dh);
	      gctx.globalAlpha = prevAlpha;
	    }
	  }
	}

	let last=performance.now();
	const FRAME_MS=1000/60;
	function loop(now){
	  requestAnimationFrame(loop);
	  const elapsed=now-last;
	  if(elapsed<FRAME_MS) return;
	  last=now-(elapsed%FRAME_MS);
	  __touchFrameSerial++;
	  stepInterpreter(FRAME_MS);
	  render();
	}
	startPlay();
	requestAnimationFrame(loop);
	</script>
	</body></html>`;
}

// Single app bootstrap: deferred scripts see `interactive` (not `loading`), so a naive
// "else branch" after DOMContentLoaded would double-run tab setup and stack click handlers.
function initApp() {
    if (window.__appInitialized) return;
    window.__appInitialized = true;
    try {
        const root = document.documentElement;
        root.style.overscrollBehavior = 'none';
        root.style.overscrollBehaviorX = 'none';
    } catch (_) {}
    console.log('🚀 DOM Content Loaded - Initializing app...');
    initializeDefaultImages();
    initializeDefaultSounds();
    initializeTabs();
    initializeEditMenu();
    initializeFileMenu();
    initCodeBlockKeyboardShortcuts();
    setTimeout(() => refreshObjectGridIcons(), 50);
    console.log('✅ App initialization complete');
    try {
        const topPlay = document.getElementById('topbar-play');
        if (topPlay && !topPlay.__bound) {
            topPlay.__bound = true;
            setPlayStopButtonIcon(topPlay, false);
            topPlay.addEventListener('click', () => {
                if (isPlaying) {
                    stopPlay();
                    setPlayStopButtonIcon(topPlay, false);
                    topPlay.classList.remove('active');
                } else {
                    startPlay();
                    setPlayStopButtonIcon(topPlay, true);
                    topPlay.classList.add('active');
                }
            });
        }
        const canvas = document.getElementById('game-window');
        const wrapper = canvas && canvas.parentElement ? canvas.parentElement : document.body;
        let playBtn = document.getElementById('__play_btn');
        if (!topPlay && !playBtn) {
            playBtn = document.createElement('button');
            playBtn.id = '__play_btn';
            playBtn.type = 'button';
            playBtn.className = 'fallback-play-btn';
            setPlayStopButtonIcon(playBtn, false);
            playBtn.addEventListener('click', () => {
                if (isPlaying) {
                    stopPlay();
                    setPlayStopButtonIcon(playBtn, false);
                } else {
                    startPlay();
                    setPlayStopButtonIcon(playBtn, true);
                }
            });
            wrapper.style.position = 'relative';
            wrapper.appendChild(playBtn);
        }
    } catch (_) {}
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// Prompt when closing the tab/window (browsers show their own generic wording, not custom text)
if (!window.__leavePagePromptBound) {
    window.__leavePagePromptBound = true;
    window.addEventListener('beforeunload', (e) => {
        e.preventDefault();
        e.returnValue = '';
    });
}

// Update canvas size on window resize
window.addEventListener("resize", () => {
    drawConnections();
});
/** Coalesce multiple triggers in one frame (e.g. save path) to avoid stacked compositor work. */
let _gameSpriteRaf = null;
function scheduleRenderGameWindowSprite() {
    if (_gameSpriteRaf != null) return;
    _gameSpriteRaf = requestAnimationFrame(() => {
        _gameSpriteRaf = null;
        renderGameWindowSprite();
    });
}

// Render runtime instances during play; otherwise show object previews
function renderGameWindowSprite() {
    const canvas = document.getElementById('game-window');
    if (!canvas) return;
    const gctx = canvas.getContext('2d');
    if (!gctx) return;
    const rect = canvas.getBoundingClientRect();
    const rw = Math.max(1, Math.round(rect.width));
    const rh = Math.max(1, Math.round(rect.height));
    const useFixedStage = projectStageWidth != null && projectStageHeight != null
        && projectStageWidth > 0 && projectStageHeight > 0;
    const bw = useFixedStage ? projectStageWidth : rw;
    const bh = useFixedStage ? projectStageHeight : rh;
    if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
    }
    if (useFixedStage) {
        canvas.style.width = rw + 'px';
        canvas.style.height = rh + 'px';
    } else {
        canvas.style.width = '';
        canvas.style.height = '';
    }
    // background
    gctx.clearRect(0, 0, canvas.width, canvas.height);
    gctx.fillStyle = '#777';
    gctx.fillRect(0, 0, canvas.width, canvas.height);
    // Nearest-neighbor scaling (pixel art; no blur when sprites are scaled)
    gctx.imageSmoothingEnabled = false;

    // Draw game content. In play (or frozen after stop), draw runtime instances; otherwise empty stage.
    const drawRuntimeLayout = isPlaying || runtimeInstances.length > 0;
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    let visibleEntries;
    if (drawRuntimeLayout) {
        visibleEntries = [];
        for (let i = 0; i < runtimeInstances.length; i++) {
            const inst = runtimeInstances[i];
            const tmpl = objectById[inst.templateId];
            const perInst = runtimePositions[inst.instanceId] || {};
            const path = perInst.spritePath
                || (tmpl && tmpl.media && tmpl.media[0] && tmpl.media[0].path ? tmpl.media[0].path : null);
            if (path) visibleEntries.push({ inst, tmpl, path });
        }
        // Sort by layer (lower layer numbers render first, higher numbers render on top)
        visibleEntries.sort((a, b) => {
            const layerA = (runtimePositions[a.inst.instanceId] && typeof runtimePositions[a.inst.instanceId].layer === 'number') ? runtimePositions[a.inst.instanceId].layer : 0;
            const layerB = (runtimePositions[b.inst.instanceId] && typeof runtimePositions[b.inst.instanceId].layer === 'number') ? runtimePositions[b.inst.instanceId].layer : 0;
            return layerA - layerB;
        });
    } else {
        visibleEntries = [];
    }
    visibleEntries.forEach((entry, index) => {
        const mediaPath = entry.path;
        let img = imageCache[mediaPath];
        if (!img) {
            img = new Image();
            // Allow cross-origin-safe drawing when assets are served from CDN or different origin
            img.crossOrigin = 'anonymous';
            imageCache[mediaPath] = img;
            // Set handlers before src to ensure we catch events
            img.onerror = function(){ img._broken = true; try { console.warn('Image failed to load', mediaPath); } catch(e){} };
            // Presence of onload is used as readiness indicator; actual draw is gated below
            img.onload = function(){ /* readiness indicated via img.complete */ };
            img.src = mediaPath;
        }
        // Draw immediately if image is ready; otherwise skip this frame.
        const drawIfReady = () => {
            if (!img.complete || img._broken || !(img.naturalWidth > 0 && img.naturalHeight > 0)) return;
            let scale = 1;
            if (drawRuntimeLayout && entry.inst && runtimePositions[entry.inst.instanceId] && typeof runtimePositions[entry.inst.instanceId].scale === 'number') {
                scale = Math.max(0, runtimePositions[entry.inst.instanceId].scale || 1);
            }
            const dw = img.width * scale;
            const dh = img.height * scale;
            let drawX, drawY;
            if (drawRuntimeLayout && entry.inst && runtimePositions[entry.inst.instanceId]) {
                const p = worldToCanvas(runtimePositions[entry.inst.instanceId].x, runtimePositions[entry.inst.instanceId].y, canvas);
                drawX = Math.round(p.x - dw / 2);
                drawY = Math.round(p.y - dh / 2);
            } else {
                const angle = index === 0 ? 0 : (index / Math.max(1, visibleEntries.length)) * Math.PI * 2;
                const radius = index === 0 ? 0 : Math.min(canvas.width, canvas.height) * 0.04 * index;
                const offsetX = Math.cos(angle) * radius;
                const offsetY = Math.sin(angle) * radius;
                drawX = Math.round(centerX - dw / 2 + offsetX);
                drawY = Math.round(centerY - dh / 2 + offsetY);
            }
            // Simple AABB culling to skip fully offscreen sprites
            if (drawX + dw < 0 || drawY + dh < 0 || drawX > canvas.width || drawY > canvas.height) return;
            const alpha = (drawRuntimeLayout && entry.inst && typeof runtimePositions[entry.inst.instanceId]?.alpha === 'number') ? Math.max(0, Math.min(1, runtimePositions[entry.inst.instanceId].alpha)) : 1;
            if (drawRuntimeLayout && entry.inst && runtimePositions[entry.inst.instanceId] && typeof runtimePositions[entry.inst.instanceId].rot === 'number') {
                const angleRad = (runtimePositions[entry.inst.instanceId].rot || 0) * Math.PI / 180;
                gctx.save();
                gctx.translate(drawX + dw / 2, drawY + dh / 2);
                gctx.rotate(angleRad);
                const prevAlpha = gctx.globalAlpha;
                gctx.globalAlpha = alpha;
                gctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
                gctx.globalAlpha = prevAlpha;
                gctx.restore();
            } else {
                const prevAlpha = gctx.globalAlpha;
                gctx.globalAlpha = alpha;
                gctx.drawImage(img, drawX, drawY, dw, dh);
                gctx.globalAlpha = prevAlpha;
            }
        };
        if (img.complete) drawIfReady(); else img.onload = drawIfReady;
    });
}

// Keep game window updated on selection and tab switches
document.addEventListener('click', (e) => {
    if (e.target.classList && e.target.classList.contains('box')) {
        setTimeout(renderGameWindowSprite, 30);
    }
});
window.addEventListener('resize', renderGameWindowSprite);

// Ensure object grid icons reflect first image sprite for each object
function refreshObjectGridIcons() {
    objects.forEach(obj => {
        const list = objectImages[String(obj.id)] || [];
        if (list.length > 0) {
            if (!obj.media) obj.media = [];
            if (obj.media.length === 0) obj.media.push({ id: 1, name: 'sprite', type: 'image', path: list[0].src });
            else obj.media[0].path = list[0].src;
            const box = document.querySelector(`.box[data-id="${obj.id}"]`);
            if (box) {
                let img = box.querySelector('img');
                if (!img) {
                    img = document.createElement('img');
                    box.insertBefore(img, box.firstChild);
                }
                img.src = list[0].src;
                img.alt = obj.name;
            }
        } else {
            // remove grid icon if no images for this object
            const box = document.querySelector(`.box[data-id="${obj.id}"]`);
            if (box) {
                const img = box.querySelector('img');
                if (img) img.remove();
            }
            if (obj.media && obj.media[0]) {
                obj.media = [];
            }
        }
    });
}
// =========================
// Image Editor Implementation
// =========================
function initializeImageEditor(params) {
    const onCanvasSizeChange = typeof params.onCanvasSizeChange === 'function' ? params.onCanvasSizeChange : null;
    const canvas = params.editorCanvas;
    // Default (sync) 2D path: Firefox WebRender + desynchronized:true spiked ASYNC_IMAGE / composite time in profiling.
    const _editor2dOpts = { alpha: true, willReadFrequently: false };
    const ctx = canvas.getContext('2d', _editor2dOpts) || canvas.getContext('2d');
    try { ctx.imageSmoothingEnabled = false; } catch (_) {}
    const wrapper = params.canvasWrapper;
    /** Pan+zoom applied here only; canvas + overlay are children (single composited scale, not two identical transforms). */
    const viewTransformHost = params.viewTransformHost || wrapper;
    /** Whole draw region (checker + canvas + margins); wheel/pan attach here so empty areas and zoom controls behave. */
    const previewHost = params.previewContainer || wrapper;

    const state = {
        tool: 'brush',
        color: { r: 255, g: 0, b: 0, a: 1 },
        brushSize: 16,
        fill: true,
        symmetry: 'none', // 'none' | 'x' | 'y' | 'xy'
        isDrawing: false,
        startX: 0,
        startY: 0,
        lastX: 0,
        lastY: 0,
        selection: null, // { cx, cy, w, h, angle, layerCanvas, ... }
        zoom: 1.0,
        panX: 0, // screen px; positive moves canvas right
        panY: 0, // screen px; positive moves canvas down
        isPanning: false,
        panPointerId: null,
        _lastPanClientX: 0,
        _lastPanClientY: 0,
        undoStack: [],
        redoStack: [],
        /** Right-drag brush: temporarily force erase; restored on pointerup */
        brushEraseDrag: false,
        _brushSavedA: 1,
        _brushErasePointerId: null,
        /** Cached canvas.getBoundingClientRect() during a brush stroke — avoids layout thrash every pointermove when zoomed */
        _brushScreenRect: null,
    };

    /** Batched brush: merge pointer samples to one applyBrushPolylineFrame per rAF (fewer GPU texture uploads / ASYNC_IMAGE). */
    let brushStrokeRaf = null;
    let brushStrokeAccum = null;
    /** Incremented on each loadImage(); stale img.onload handlers must not touch the canvas or undo state. */
    let loadImageGeneration = 0;
    function mergeBrushPolylineChunk(accum, pts) {
        if (!pts || pts.length < 4) return accum;
        if (!accum || accum.length < 2) return Float64Array.from(pts);
        const lx = accum[accum.length - 2];
        const ly = accum[accum.length - 1];
        let start = 0;
        if (Math.abs(pts[0] - lx) < 1e-6 && Math.abs(pts[1] - ly) < 1e-6) start = 2;
        if (start >= pts.length) return accum;
        const out = new Float64Array(accum.length + pts.length - start);
        out.set(accum, 0);
        let o = accum.length;
        for (let i = start; i < pts.length; i++) out[o++] = pts[i];
        return out;
    }
    function flushBrushStrokeBatch() {
        brushStrokeRaf = null;
        const acc = brushStrokeAccum;
        brushStrokeAccum = null;
        if (acc && acc.length >= 4) applyBrushPolylineFrame(acc);
    }
    function scheduleBrushStrokePolyline(pts) {
        brushStrokeAccum = mergeBrushPolylineChunk(brushStrokeAccum, pts);
        if (brushStrokeRaf == null) {
            brushStrokeRaf = requestAnimationFrame(flushBrushStrokeBatch);
        }
    }
    function flushBrushStrokeNow() {
        if (brushStrokeRaf != null) {
            cancelAnimationFrame(brushStrokeRaf);
            brushStrokeRaf = null;
        }
        flushBrushStrokeBatch();
    }

    /** Logical canvas → bitmap: use DPR only. Zoom is CSS scale on viewTransformHost; overlay bitmap stays logical×DPR. */
    function overlayViewScale() {
        return window.devicePixelRatio || 1;
    }

    function syncOverlayBitmapResolution(overlayEl) {
        if (!overlayEl || !canvas) return;
        const s = overlayViewScale();
        const zw = Math.max(1, Math.round(canvas.width * s));
        const zh = Math.max(1, Math.round(canvas.height * s));
        if (overlayEl.width !== zw || overlayEl.height !== zh) {
            overlayEl.width = zw;
            overlayEl.height = zh;
        }
    }

    /** Map logical canvas coords to overlay bitmap so edges line up with image pixels (avoids drift from round(w*s) vs w*s). */
    function applyOverlayLogicalTransform(octx) {
        const el = octx.canvas;
        const sx = el.width / canvas.width;
        const sy = el.height / canvas.height;
        octx.setTransform(sx, 0, 0, sy, 0, 0);
    }

    /** ~1 device-pixel stroke in both axes (uses average scale when x/y differ slightly). */
    function overlayHairlineWidth(octx) {
        const el = octx.canvas;
        const sx = el.width / canvas.width;
        const sy = el.height / canvas.height;
        return 2 / (sx + sy);
    }

    /** Dashed preview: ~6px / ~4px on screen at any zoom / DPR. */
    function overlayDashPattern(octx) {
        const el = octx.canvas;
        const sx = el.width / canvas.width;
        return [6 / sx, 4 / sx];
    }

    /** Snap drag bounds to integer canvas pixels so rect/circle previews align with committed strokes. */
    function snapPreviewBounds(x0, y0, x1, y1) {
        const xMin = Math.min(x0, x1);
        const xMax = Math.max(x0, x1);
        const yMin = Math.min(y0, y1);
        const yMax = Math.max(y0, y1);
        return [
            Math.floor(xMin),
            Math.floor(yMin),
            Math.ceil(xMax),
            Math.ceil(yMax),
        ];
    }

    function syncOverlayDomTransform(overlayEl) {
        if (!overlayEl || !canvas) return;
        const w = canvas.width;
        const h = canvas.height;
        overlayEl.style.position = 'absolute';
        overlayEl.style.left = '0';
        overlayEl.style.top = '0';
        overlayEl.style.width = `${w}px`;
        overlayEl.style.height = `${h}px`;
        overlayEl.style.marginLeft = '0';
        overlayEl.style.marginTop = '0';
        overlayEl.style.transform = '';
        overlayEl.style.transformOrigin = 'center center';
        overlayEl.style.pointerEvents = 'none';
        overlayEl.style.zIndex = '2';
    }

    /** translate3d keeps pan+zoom on one compositor-friendly layer. */
    function buildViewTransformCss() {
        const z = state.zoom;
        return `translate3d(${state.panX}px, ${state.panY}px, 0) scale(${z})`;
    }

    /** Pan only changes translation — avoid re-writing canvas/overlay styles every move (major win for trackpad + MMB pan). */
    function applyPanOnlyTransform() {
        viewTransformHost.style.transform = buildViewTransformCss();
        state._brushScreenRect = null;
    }

    function updateViewTransform() {
        const z = state.zoom;
        const w = canvas.width;
        const h = canvas.height;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        canvas.style.display = 'block';
        canvas.style.position = 'relative';
        canvas.style.margin = '0';
        canvas.style.transform = '';
        canvas.style.zIndex = '1';
        viewTransformHost.style.position = 'relative';
        viewTransformHost.style.width = `${w}px`;
        viewTransformHost.style.height = `${h}px`;
        viewTransformHost.style.flexShrink = '0';
        viewTransformHost.style.transform = buildViewTransformCss();
        viewTransformHost.style.transformOrigin = 'center center';
        state._brushScreenRect = null;
        const overlay = viewTransformHost.querySelector('canvas.__overlay');
        syncOverlayDomTransform(overlay);
    }

    function rgbaString() {
        const c = state.color;
        return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
    }

    /** Refresh the node grid sprite from the editor canvas. Pass `existingDataUrl` when the caller already encoded (e.g. saveToDisk) to avoid a second toDataURL. */
    function updateGameObjectIcon(existingDataUrl) {
        const obj = objects.find(o => o.id == selected_object);
        if (!obj || !obj.media || obj.media.length === 0) return;

        const key = String(selected_object);
        const list = objectImages[key] || [];
        const isEditingSpriteImage = list.length > 0 && currentImageInfo === list[0];
        if (!isEditingSpriteImage) return;

        const dataUrl = existingDataUrl != null ? existingDataUrl : canvas.toDataURL('image/png');
        obj.media[0].path = dataUrl;

        const box = document.querySelector(`.box[data-id="${obj.id}"]`);
        if (box) {
            let img = box.querySelector('img');
            if (!img) {
                img = document.createElement('img');
                box.insertBefore(img, box.firstChild);
            }
            img.src = dataUrl;
            img.alt = obj.name;
            img.style.width = "75px";
            img.style.height = "75px";
        }
    }

    /** After undo/redo: keep objectImages, thumbnails, grid, and game preview in sync with the canvas (same as local save). */
    function syncCanvasToCurrentAsset() {
        const dataUrl = canvas.toDataURL('image/png');
        updateGameObjectIcon(dataUrl);
        imageRevision += 1;
        const bust = dataUrl;
        if (currentImageInfo) {
            currentImageInfo.src = bust;
            currentImageInfo.width = canvas.width;
            currentImageInfo.height = canvas.height;
        }
        const selectedThumb = document.querySelector('.image-thumbnail-item.selected img');
        if (selectedThumb) selectedThumb.src = bust;
        selectedImage = bust;
        try {
            localStorage.setItem('lastSelectedImage', bust);
            setLastSelectedImageForObject(selected_object, bust);
            lastSelectedImage = bust;
        } catch (_) {}
        scheduleRenderGameWindowSprite();
    }

    function pushUndo() {
        try {
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            state.undoStack.push(img);
            if (state.undoStack.length > 50) state.undoStack.shift();
            state.redoStack.length = 0;
        } catch (e) {
            console.warn('pushUndo failed', e);
        }
    }

    function restore(imageData) {
        if (!imageData) return;
        ctx.putImageData(imageData, 0, 0);
        // Crosshair is now on overlay, no need to redraw
    }

    function setTool(t) { state.tool = t; }
    function getTool() { return state.tool; }
    function setColor(hex, a) {
        const bigint = parseInt(hex.slice(1), 16);
        const r = (bigint >> 16) & 255;
        const g = (bigint >> 8) & 255;
        const b = bigint & 255;
        state.color = { r, g, b, a: isNaN(a) ? 1 : a };
    }
    function setBrushSize(s) { state.brushSize = Math.max(1, s|0); }
    function setFill(f) { state.fill = !!f; }
    function getFill() { return state.fill; }
    function toggleFill() { state.fill = !state.fill; return state.fill; }
    function setSymmetry(mode) {
        const m = String(mode || 'none');
        state.symmetry = (m === 'x' || m === 'y' || m === 'xy') ? m : 'none';
        // Keep overlay updated (axes/crosshair)
        try { drawCrosshair(); } catch (_) {}
    }
    function setZoom(z) {
        state.zoom = Math.max(0.1, Math.min(12, z));
        updateViewTransform();
        // Coalesce: wheel / pinch can fire many events per frame — one overlay draw per rAF.
        try { scheduleDrawCrosshair(); } catch (_) {}
    }
    function panBy(dx, dy) {
        // dx/dy are screen pixels to move the canvas by (positive right/down).
        state.panX += dx;
        state.panY += dy;
        applyPanOnlyTransform();
    }
    function zoomAboutClientPoint(clientX, clientY, newZoom) {
        const z0 = state.zoom;
        const z1 = Math.max(0.1, Math.min(12, newZoom));
        if (z1 === z0) return;
        // Compute cursor vector from current canvas center in screen pixels.
        const rect = canvas.getBoundingClientRect();
        const vx = clientX - rect.left - rect.width / 2;
        const vy = clientY - rect.top - rect.height / 2;
        // Canvas-space offset from center (use state.zoom, not rect.width — getBoundingClientRect can be subpixel-tight vs W*zoom).
        const ox = vx / z0;
        const oy = vy / z0;
        // Adjust pan so the same canvas-space point stays under the cursor after zoom.
        // New center needs to shift by -(ox*z1 - ox*z0) = -ox*(z1 - z0)
        state.panX += -ox * (z1 - z0);
        state.panY += -oy * (z1 - z0);
        state.zoom = z1;
        updateViewTransform();
        try { scheduleDrawCrosshair(); } catch (_) {}
    }

    async function saveToDisk(forceNewName) {
        try {
            // Crosshair is now on overlay, so main canvas is clean
            const dataUrl = canvas.toDataURL('image/png');
            updateGameObjectIcon(dataUrl);
            let filename = currentImageFilename;
            if (!filename || forceNewName) {
                filename = `sprite_${Date.now()}.png`;
            }
            const res = await fetch('/api/save-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ objectId: selected_object, filename, dataUrl })
            });
            const contentType = res.headers.get('content-type') || '';
            let json = null;
            if (contentType.includes('application/json')) {
                json = await res.json();
            } else {
                // If endpoint is missing (e.g., static hosting), fall back to local dataUrl
                json = null;
            }
            // Success path or graceful fallback to local dataUrl
            const persistedPath = (res.ok && json && json.ok && json.path) ? json.path : dataUrl;
            currentImageFilename = filename;
            // Update current image info and thumbnail src
            const list = getCurrentObjectImages();
            imageRevision += 1;
            const isDataPersist = typeof persistedPath === 'string' && persistedPath.startsWith('data:');
            const bust = isDataPersist ? persistedPath : `${persistedPath}?v=${imageRevision}`;
            if (currentImageInfo) {
                currentImageInfo.src = bust;
                currentImageInfo.width = canvas.width;
                currentImageInfo.height = canvas.height;
            }
            // Update only the selected thumbnail image to avoid re-render loops
            const selectedThumb = document.querySelector('.image-thumbnail-item.selected img');
            if (selectedThumb) selectedThumb.src = bust;
            selectedImage = bust;
            scheduleRenderGameWindowSprite();
        } catch (e) {
            // On network or 404, gracefully save locally via dataUrl (static hosting fallback)
            try {
                const dataUrl = canvas.toDataURL('image/png');
                updateGameObjectIcon(dataUrl);
                let filename = currentImageFilename || `sprite_${Date.now()}.png`;
                currentImageFilename = filename;
                imageRevision += 1;
                const bust = dataUrl;
                if (currentImageInfo) {
                    currentImageInfo.src = bust;
                    currentImageInfo.width = canvas.width;
                    currentImageInfo.height = canvas.height;
                }
                const selectedThumb = document.querySelector('.image-thumbnail-item.selected img');
                if (selectedThumb) selectedThumb.src = bust;
                selectedImage = bust;
                scheduleRenderGameWindowSprite();
                // Optional: small toast indicating local save
                try {
                    const old = document.getElementById('__img_save_err');
                    if (old) old.remove();
                    const toast = document.createElement('div');
                    toast.id = '__img_save_err';
                    toast.className = 'app-toast';
                    toast.textContent = 'Saved locally (no server).';
                    document.body.appendChild(toast);
                    setTimeout(() => { if (toast && toast.parentNode) toast.parentNode.removeChild(toast); }, 2000);
                } catch {}
            } catch (inner) {
                console.warn('Failed to save image locally', inner);
            }
        }
    }

    function clear(silent) {
        pushUndo();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!silent) saveToDisk();
        else updateGameObjectIcon();
    }

    function loadImage(src) {
        loadImageGeneration += 1;
        const myGen = loadImageGeneration;
        flushBrushStrokeNow();
        state.isDrawing = false;
        if (state.selection) {
            state.selection = null;
            try { clearOverlay(); } catch (_) {}
        }
        // Clear immediately so Cmd+Z cannot revert the previous image after the UI switched thumbnails.
        state.undoStack.length = 0;
        state.redoStack.length = 0;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            if (myGen !== loadImageGeneration) return;
            if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) return;
            // Match editor bitmap to saved asset pixels (avoid scaling into the default 720×720 surface).
            const nw = Math.max(1, Math.min(4096, img.naturalWidth));
            const nh = Math.max(1, Math.min(4096, img.naturalHeight));
            if (canvas.width !== nw || canvas.height !== nh) {
                canvas.width = nw;
                canvas.height = nh;
                try { ctx.imageSmoothingEnabled = false; } catch (_) {}
            }
            state.undoStack.length = 0;
            state.redoStack.length = 0;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            pushUndo();
            try { ctx.imageSmoothingEnabled = false; } catch (_) {}
            ctx.drawImage(img, 0, 0, nw, nh);
            updateViewTransform();
            try { scheduleDrawCrosshair(); } catch (_) {}
            try {
                if (typeof currentImageInfo === 'object' && currentImageInfo) {
                    currentImageInfo.width = canvas.width;
                    currentImageInfo.height = canvas.height;
                }
            } catch (_) {}
            if (onCanvasSizeChange) onCanvasSizeChange();
        };
        img.onerror = () => {
            try {
                const s = typeof src === 'string' ? src : '';
                console.warn('loadImage failed', s.length > 96 ? `${s.slice(0, 96)}…` : s);
            } catch (_) {}
        };
        img.src = src;
    }

    function getCanvasSize() {
        return { width: canvas.width, height: canvas.height };
    }

    /** Resize drawing bitmap; existing art is never scaled—center-cropped if smaller, centered with padding if larger. Clears undo/redo. */
    function setCanvasSize(nextW, nextH) {
        const w = Math.max(1, Math.min(4096, Math.round(Number(nextW))));
        const h = Math.max(1, Math.min(4096, Math.round(Number(nextH))));
        if (!Number.isFinite(w) || !Number.isFinite(h)) return;
        if (w === canvas.width && h === canvas.height) {
            if (onCanvasSizeChange) onCanvasSizeChange();
            return;
        }
        flushBrushStrokeNow();
        cancelSelection();
        const oldW = canvas.width;
        const oldH = canvas.height;
        const tmp = document.createElement('canvas');
        tmp.width = oldW;
        tmp.height = oldH;
        const tctx = tmp.getContext('2d');
        if (tctx) {
            try { tctx.imageSmoothingEnabled = false; } catch (_) {}
            try { tctx.drawImage(canvas, 0, 0); } catch (_) {}
        }
        canvas.width = w;
        canvas.height = h;
        try { ctx.imageSmoothingEnabled = false; } catch (_) {}
        ctx.clearRect(0, 0, w, h);
        if (tctx && oldW > 0 && oldH > 0) {
            const blitW = Math.min(oldW, w);
            const blitH = Math.min(oldH, h);
            const srcX = Math.floor((oldW - blitW) / 2);
            const srcY = Math.floor((oldH - blitH) / 2);
            const dstX = Math.floor((w - blitW) / 2);
            const dstY = Math.floor((h - blitH) / 2);
            try {
                ctx.drawImage(tmp, srcX, srcY, blitW, blitH, dstX, dstY, blitW, blitH);
            } catch (_) {}
        }
        state.undoStack.length = 0;
        state.redoStack.length = 0;
        updateViewTransform();
        drawCrosshair();
        updateGameObjectIcon();
        saveToDisk();
        if (onCanvasSizeChange) onCanvasSizeChange();
    }

    function symmetrySegmentsForLine(x0, y0, x1, y1) {
        const mx = (x) => (canvas.width - 1) - x;
        const my = (y) => (canvas.height - 1) - y;
        const segs = [];
        const seen = new Set();
        const push = (a,b,c,d) => {
            const key = `${a},${b},${c},${d}`;
            if (!seen.has(key)) { seen.add(key); segs.push([a,b,c,d]); }
        };
        push(x0, y0, x1, y1);
        if (state.symmetry === 'x' || state.symmetry === 'xy') push(mx(x0), y0, mx(x1), y1);
        if (state.symmetry === 'y' || state.symmetry === 'xy') push(x0, my(y0), x1, my(y1));
        if (state.symmetry === 'xy') push(mx(x0), my(y0), mx(x1), my(y1));
        return segs;
    }

    /** Axis-aligned bounds (min/max) mirrored the same way as brush strokes; deduped. */
    function symmetryRectsForBounds(x0, y0, x1, y1) {
        const mx = (x) => (canvas.width - 1) - x;
        const my = (y) => (canvas.height - 1) - y;
        const norm = (a, b, c, d) => [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
        const rects = [];
        const seen = new Set();
        const push = (a, b, c, d) => {
            const [rx0, ry0, rx1, ry1] = norm(a, b, c, d);
            const key = `${rx0},${ry0},${rx1},${ry1}`;
            if (!seen.has(key)) {
                seen.add(key);
                rects.push([rx0, ry0, rx1, ry1]);
            }
        };
        push(x0, y0, x1, y1);
        if (state.symmetry === 'x' || state.symmetry === 'xy') {
            push(mx(x1), y0, mx(x0), y1);
        }
        if (state.symmetry === 'y' || state.symmetry === 'xy') {
            push(x0, my(y1), x1, my(y0));
        }
        if (state.symmetry === 'xy') {
            push(mx(x1), my(y1), mx(x0), my(y0));
        }
        return rects;
    }

    /** Integer-aligned 1×1 pixels (avoids antialiased strokes and round-cap bleed from canvas stroke()). */
    function fillBrushLinePixels(x0, y0, x1, y1) {
        const snap = (v, max) => Math.max(0, Math.min(max - 1, Math.floor(v)));
        let xi = snap(x0, canvas.width);
        let yi = snap(y0, canvas.height);
        const x1i = snap(x1, canvas.width);
        const y1i = snap(y1, canvas.height);
        const dx = Math.abs(x1i - xi);
        const dy = Math.abs(y1i - yi);
        const sx = xi < x1i ? 1 : -1;
        const sy = yi < y1i ? 1 : -1;
        let err = dx - dy;
        ctx.beginPath();
        for (;;) {
            ctx.rect(xi, yi, 1, 1);
            if (xi === x1i && yi === y1i) break;
            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                xi += sx;
            }
            if (e2 < dx) {
                err += dx;
                yi += sy;
            }
        }
        ctx.fill();
    }

    /** Bresenham 1×1 px into current path (caller fills). */
    function addBresenhamRectsToPath(x0, y0, x1, y1) {
        const w = canvas.width;
        const h = canvas.height;
        const snap = (v, max) => Math.max(0, Math.min(max - 1, Math.floor(v)));
        let xi = snap(x0, w);
        let yi = snap(y0, h);
        const x1i = snap(x1, w);
        const y1i = snap(y1, h);
        const dx = Math.abs(x1i - xi);
        const dy = Math.abs(y1i - yi);
        const sx = xi < x1i ? 1 : -1;
        const sy = yi < y1i ? 1 : -1;
        let err = dx - dy;
        for (;;) {
            ctx.rect(xi, yi, 1, 1);
            if (xi === x1i && yi === y1i) break;
            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                xi += sx;
            }
            if (e2 < dx) {
                err += dx;
                yi += sy;
            }
        }
    }

    /** Bresenham line: invoke fn(xi, yi) for each pixel on the line (same grid as 1px brush). */
    function forEachBresenhamPixel(x0, y0, x1, y1, w, h, fn) {
        const snap = (v, max) => Math.max(0, Math.min(max - 1, Math.floor(v)));
        let xi = snap(x0, w);
        let yi = snap(y0, h);
        const x1i = snap(x1, w);
        const y1i = snap(y1, h);
        const dx = Math.abs(x1i - xi);
        const dy = Math.abs(y1i - yi);
        const sx = xi < x1i ? 1 : -1;
        const sy = yi < y1i ? 1 : -1;
        let err = dx - dy;
        for (;;) {
            fn(xi, yi);
            if (xi === x1i && yi === y1i) break;
            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                xi += sx;
            }
            if (e2 < dx) {
                err += dx;
                yi += sy;
            }
        }
    }

    /** Integer disk (diameter = brush size); adds "x,y" keys — no antialiased fringe colors. */
    function addDiskPixelsToSet(cx, cy, diameter, w, h, set) {
        const r = diameter / 2;
        const r2 = r * r;
        const ix = Math.round(cx);
        const iy = Math.round(cy);
        const ri = Math.max(0, Math.ceil(r - 1e-9));
        for (let dy = -ri; dy <= ri; dy++) {
            for (let dx = -ri; dx <= ri; dx++) {
                if (dx * dx + dy * dy <= r2 + 1e-9) {
                    const x = ix + dx;
                    const y = iy + dy;
                    if (x >= 0 && x < w && y >= 0 && y < h) set.add(`${x},${y}`);
                }
            }
        }
    }

    function symmetryPolylineCopies(points) {
        const mx = (x) => (canvas.width - 1) - x;
        const my = (y) => (canvas.height - 1) - y;
        if (state.symmetry === 'none') return [points];
        const out = [points];
        if (state.symmetry === 'x' || state.symmetry === 'xy') {
            const copy = new Float64Array(points.length);
            for (let i = 0; i < points.length; i += 2) {
                copy[i] = mx(points[i]);
                copy[i + 1] = points[i + 1];
            }
            out.push(copy);
        }
        if (state.symmetry === 'y' || state.symmetry === 'xy') {
            const copy = new Float64Array(points.length);
            for (let i = 0; i < points.length; i += 2) {
                copy[i] = points[i];
                copy[i + 1] = my(points[i + 1]);
            }
            out.push(copy);
        }
        if (state.symmetry === 'xy') {
            const copy = new Float64Array(points.length);
            for (let i = 0; i < points.length; i += 2) {
                copy[i] = mx(points[i]);
                copy[i + 1] = my(points[i + 1]);
            }
            out.push(copy);
        }
        return out;
    }

    function dedupeConsecutivePolylinePoints(points) {
        if (points.length < 4) return points;
        const out = [points[0], points[1]];
        for (let i = 2; i < points.length; i += 2) {
            const ox = out[out.length - 2];
            const oy = out[out.length - 1];
            if (points[i] !== ox || points[i + 1] !== oy) {
                out.push(points[i], points[i + 1]);
            }
        }
        return Float64Array.from(out);
    }

    /** One pointermove worth of samples: one merged stroke per symmetry (fast) vs many applyBrushLine calls. */
    function applyBrushPolylineFrame(points) {
        const pts = dedupeConsecutivePolylinePoints(points);
        if (pts.length < 4) return;
        const polys = symmetryPolylineCopies(pts);
        ctx.save();
        const isErase = state.color.a <= 0.01;
        ctx.globalCompositeOperation = isErase ? 'destination-out' : 'source-over';
        if (state.brushSize === 1) {
            ctx.fillStyle = isErase ? 'rgba(0,0,0,1)' : rgbaString();
            for (let pi = 0; pi < polys.length; pi++) {
                const poly = polys[pi];
                ctx.beginPath();
                for (let i = 0; i < poly.length - 2; i += 2) {
                    addBresenhamRectsToPath(poly[i], poly[i + 1], poly[i + 2], poly[i + 3]);
                }
                ctx.fill();
            }
        } else {
            const w = canvas.width;
            const h = canvas.height;
            const d = state.brushSize;
            ctx.fillStyle = isErase ? 'rgba(0,0,0,1)' : rgbaString();
            for (let pi = 0; pi < polys.length; pi++) {
                const poly = polys[pi];
                const pixelSet = new Set();
                for (let i = 0; i < poly.length - 2; i += 2) {
                    forEachBresenhamPixel(
                        poly[i], poly[i + 1], poly[i + 2], poly[i + 3],
                        w, h,
                        (cx, cy) => { addDiskPixelsToSet(cx, cy, d, w, h, pixelSet); }
                    );
                }
                ctx.beginPath();
                for (const key of pixelSet) {
                    const comma = key.indexOf(',');
                    ctx.rect(+key.slice(0, comma), +key.slice(comma + 1), 1, 1);
                }
                ctx.fill();
            }
        }
        ctx.restore();
    }

    function applyBrushLine(x0, y0, x1, y1) {
        const segs = symmetrySegmentsForLine(x0, y0, x1, y1);
        ctx.save();
        const isErase = state.color.a <= 0.01;
        ctx.globalCompositeOperation = isErase ? 'destination-out' : 'source-over';
        if (state.brushSize === 1) {
            ctx.fillStyle = isErase ? 'rgba(0,0,0,1)' : rgbaString();
            for (let s = 0; s < segs.length; s++) {
                const [a, b, c, d] = segs[s];
                fillBrushLinePixels(a, b, c, d);
            }
        } else {
            const w = canvas.width;
            const h = canvas.height;
            const d = state.brushSize;
            ctx.fillStyle = isErase ? 'rgba(0,0,0,1)' : rgbaString();
            for (let s = 0; s < segs.length; s++) {
                const [a, b, c, d_] = segs[s];
                const pixelSet = new Set();
                forEachBresenhamPixel(a, b, c, d_, w, h, (cx, cy) => {
                    addDiskPixelsToSet(cx, cy, d, w, h, pixelSet);
                });
                ctx.beginPath();
                for (const key of pixelSet) {
                    const comma = key.indexOf(',');
                    ctx.rect(+key.slice(0, comma), +key.slice(comma + 1), 1, 1);
                }
                ctx.fill();
            }
        }
        ctx.restore();
        // Crosshair is on overlay; grid icon updates once in saveToDisk (pointerup), not per segment.
    }

    function ensureOverlay() {
        let overlay = viewTransformHost.querySelector('canvas.__overlay');
        if (!overlay) {
            overlay = document.createElement('canvas');
            overlay.className = '__overlay';
            viewTransformHost.appendChild(overlay);
            syncOverlayDomTransform(overlay);
        }
        syncOverlayBitmapResolution(overlay);
        return overlay;
    }

    function clearOverlay() {
        const overlay = viewTransformHost.querySelector('canvas.__overlay');
        if (overlay) {
            const octx = overlay.getContext('2d', _editor2dOpts) || overlay.getContext('2d');
            octx.setTransform(1, 0, 0, 1, 0, 0);
            octx.clearRect(0, 0, overlay.width, overlay.height);
            // Redraw crosshair after clearing overlay
            flushDrawCrosshair();
        }
    }

    function drawCrosshair() {
        // Draw crosshair on a separate overlay that doesn't affect main canvas
        const overlay = ensureOverlay();
        const octx = overlay.getContext('2d', _editor2dOpts) || overlay.getContext('2d');
        try { octx.imageSmoothingEnabled = false; } catch (_) {}

        octx.setTransform(1, 0, 0, 1, 0, 0);
        // If a selection overlay exists, draw it first (so crosshair/axes sit on top).
        if (state.selection) drawSelectionOverlay(octx);
        else octx.clearRect(0, 0, overlay.width, overlay.height);

        applyOverlayLogicalTransform(octx);
        octx.setLineDash([]);
        octx.shadowBlur = 0;
        octx.shadowColor = 'transparent';

        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        const size = 12; // Smaller size of crosshair arms
        const hw = overlayHairlineWidth(octx);

        octx.save();
        // Symmetry axes (subtle)
        if (state.symmetry === 'x' || state.symmetry === 'xy') {
            octx.strokeStyle = '#00ffcc';
            octx.lineWidth = hw;
            octx.globalAlpha = 0.22;
            octx.beginPath();
            octx.moveTo(centerX + 0.5, 0);
            octx.lineTo(centerX + 0.5, canvas.height);
            octx.stroke();
        }
        if (state.symmetry === 'y' || state.symmetry === 'xy') {
            octx.strokeStyle = '#00ffcc';
            octx.lineWidth = hw;
            octx.globalAlpha = 0.22;
            octx.beginPath();
            octx.moveTo(0, centerY + 0.5);
            octx.lineTo(canvas.width, centerY + 0.5);
            octx.stroke();
        }

        // Crosshair center marker (no shadowBlur — that forces an expensive blur pass every redraw)
        octx.strokeStyle = '#ffffff';
        octx.lineWidth = hw;
        octx.globalAlpha = 0.48;

        // Draw horizontal line
        octx.beginPath();
        octx.moveTo(centerX - size, centerY);
        octx.lineTo(centerX + size, centerY);
        octx.stroke();

        // Draw vertical line
        octx.beginPath();
        octx.moveTo(centerX, centerY - size);
        octx.lineTo(centerX, centerY + size);
        octx.stroke();

        octx.restore();
    }

    let overlayDrawRaf = null;
    function scheduleDrawCrosshair() {
        if (overlayDrawRaf != null) return;
        overlayDrawRaf = requestAnimationFrame(() => {
            overlayDrawRaf = null;
            drawCrosshair();
        });
    }
    function flushDrawCrosshair() {
        if (overlayDrawRaf != null) {
            cancelAnimationFrame(overlayDrawRaf);
            overlayDrawRaf = null;
        }
        drawCrosshair();
    }

    function paintPreviewRectOn(octx, x0, y0, x1, y1) {
        octx.lineJoin = 'miter';
        octx.lineCap = 'butt';
        octx.setLineDash(overlayDashPattern(octx));
        octx.strokeStyle = '#00ffcc';
        octx.lineWidth = overlayHairlineWidth(octx);
        const rw = x1 - x0;
        const rh = y1 - y0;
        if (state.fill) {
            octx.strokeRect(x0, y0, rw, rh);
        } else {
            const lw = Math.max(1, state.brushSize);
            const iw = Math.max(0, rw - lw);
            const ih = Math.max(0, rh - lw);
            if (iw > 0 && ih > 0) octx.strokeRect(x0 + lw / 2, y0 + lw / 2, iw, ih);
        }
    }

    function paintPreviewCircleOn(octx, x0, y0, x1, y1) {
        const rx = (x1 - x0) / 2;
        const ry = (y1 - y0) / 2;
        const cx = x0 + rx;
        const cy = y0 + ry;
        octx.lineJoin = 'miter';
        octx.lineCap = 'butt';
        octx.setLineDash(overlayDashPattern(octx));
        octx.strokeStyle = '#00ffcc';
        octx.lineWidth = overlayHairlineWidth(octx);
        octx.beginPath();
        if (state.fill) {
            octx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
        } else {
            const lw = Math.max(1, state.brushSize);
            const rxIn = Math.max(0, Math.abs(rx) - lw / 2);
            const ryIn = Math.max(0, Math.abs(ry) - lw / 2);
            if (rxIn > 0 && ryIn > 0) octx.ellipse(cx, cy, rxIn, ryIn, 0, 0, Math.PI * 2);
        }
        octx.stroke();
    }

    function previewShapeTools(tool, minX, minY, maxX, maxY) {
        const rects = symmetryRectsForBounds(minX, minY, maxX, maxY);
        const overlay = ensureOverlay();
        const octx = overlay.getContext('2d', _editor2dOpts) || overlay.getContext('2d');
        try { octx.imageSmoothingEnabled = false; } catch (_) {}
        octx.setTransform(1, 0, 0, 1, 0, 0);
        octx.clearRect(0, 0, overlay.width, overlay.height);
        applyOverlayLogicalTransform(octx);
        rects.forEach(([x0, y0, x1, y1]) => {
            const [sx0, sy0, sx1, sy1] = snapPreviewBounds(x0, y0, x1, y1);
            if (sx1 <= sx0 || sy1 <= sy0) return;
            if (tool === 'rect') paintPreviewRectOn(octx, sx0, sy0, sx1, sy1);
            else paintPreviewCircleOn(octx, sx0, sy0, sx1, sy1);
        });
        octx.setLineDash([]);
    }

    function commitRect(x0, y0, x1, y1) {
        const w = x1 - x0;
        const h = y1 - y0;
        ctx.save();
        const isErase = state.color.a <= 0.01;
        ctx.globalCompositeOperation = isErase ? 'destination-out' : 'source-over';
        ctx.strokeStyle = isErase ? 'rgba(0,0,0,1)' : rgbaString();
        ctx.fillStyle = rgbaString();
        if (state.fill && !isErase) ctx.fillRect(x0, y0, w, h);
        else {
            const lw = Math.max(1, state.brushSize);
            ctx.lineWidth = lw;
            const iw = Math.max(0, w - lw);
            const ih = Math.max(0, h - lw);
            if (iw > 0 && ih > 0) ctx.strokeRect(x0 + lw / 2, y0 + lw / 2, iw, ih);
        }
        if (isErase && state.fill) ctx.clearRect(x0, y0, w, h);
        ctx.restore();
        // Crosshair is on overlay, no need to redraw
    }

    function commitCircle(x0, y0, x1, y1) {
        const rx = (x1 - x0) / 2;
        const ry = (y1 - y0) / 2;
        const cx = x0 + rx;
        const cy = y0 + ry;
        ctx.save();
        const isErase = state.color.a <= 0.01;
        ctx.globalCompositeOperation = isErase ? 'destination-out' : 'source-over';
        if (state.fill && !isErase) {
            ctx.beginPath();
            ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
            ctx.fillStyle = rgbaString();
            ctx.fill();
        } else if (isErase && state.fill) {
            ctx.beginPath();
            ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
            ctx.clip();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        } else {
            const lw = Math.max(1, state.brushSize);
            ctx.lineWidth = lw;
            ctx.strokeStyle = isErase ? 'rgba(0,0,0,1)' : rgbaString();
            const rxIn = Math.max(0, Math.abs(rx) - lw / 2);
            const ryIn = Math.max(0, Math.abs(ry) - lw / 2);
            ctx.beginPath();
            if (rxIn > 0 && ryIn > 0) {
                ctx.ellipse(cx, cy, rxIn, ryIn, 0, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.restore();
        // Crosshair is on overlay, no need to redraw
    }

    function bucketFillAt(x, y) {
        pushUndo();
        const ix = Math.max(0, Math.min(canvas.width - 1, Math.floor(x)));
        const iy = Math.max(0, Math.min(canvas.height - 1, Math.floor(y)));
        const target = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const { data, width, height } = target;
        const idx = (iy * width + ix) * 4;
        const tr = data[idx], tg = data[idx+1], tb = data[idx+2], ta = data[idx+3];
        const newR = state.color.r, newG = state.color.g, newB = state.color.b, newA = Math.round(state.color.a * 255);
        if (tr === newR && tg === newG && tb === newB && ta === newA) return;
        const stack = [[ix, iy]];
        const match = (i) => data[i] === tr && data[i+1] === tg && data[i+2] === tb && data[i+3] === ta;
        while (stack.length) {
            const [px, py] = stack.pop();
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const i = (py * width + px) * 4;
            if (!match(i)) continue;
            data[i] = newR; data[i+1] = newG; data[i+2] = newB; data[i+3] = newA;
            stack.push([px+1, py]);
            stack.push([px-1, py]);
            stack.push([px, py+1]);
            stack.push([px, py-1]);
        }
        ctx.putImageData(target, 0, 0);
        // Crosshair is on overlay, no need to redraw; saveToDisk on bucket pointerup updates grid.
    }

    /** Handles/tether: constant on-screen size — canvas uses CSS scale(zoom), so logical = screenPx / zoom. */
    const SEL_HANDLE_SCREEN_PX = 6;
    const SEL_ROT_OFFSET_SCREEN_PX = 22;
    function selectionHandleRadiusLogical() {
        const z = Math.max(0.05, state.zoom);
        return SEL_HANDLE_SCREEN_PX / z;
    }
    function selectionRotOffsetLogical() {
        const z = Math.max(0.05, state.zoom);
        return SEL_ROT_OFFSET_SCREEN_PX / z;
    }

    function worldToLocal(px, py, cx, cy, angle) {
        const dx = px - cx;
        const dy = py - cy;
        const c = Math.cos(-angle);
        const s = Math.sin(-angle);
        return { lx: dx * c - dy * s, ly: dx * s + dy * c };
    }

    function localToWorld(lx, ly, cx, cy, angle) {
        return {
            x: cx + lx * Math.cos(angle) - ly * Math.sin(angle),
            y: cy + lx * Math.sin(angle) + ly * Math.cos(angle),
        };
    }

    function cornersWorld(cx, cy, w, h, angle) {
        const hw = w / 2;
        const hh = h / 2;
        const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
        return pts.map(([lx, ly]) => localToWorld(lx, ly, cx, cy, angle));
    }

    function clampCenterInCanvas(cx, cy, w, h, angle) {
        let c = { cx, cy };
        for (let iter = 0; iter < 10; iter++) {
            const pts = cornersWorld(c.cx, c.cy, w, h, angle);
            let ox = 0;
            let oy = 0;
            for (const p of pts) {
                if (p.x < 0) ox = Math.max(ox, -p.x);
                if (p.x > canvas.width) ox = Math.min(ox, canvas.width - p.x);
                if (p.y < 0) oy = Math.max(oy, -p.y);
                if (p.y > canvas.height) oy = Math.min(oy, canvas.height - p.y);
            }
            if (Math.abs(ox) < 1e-4 && Math.abs(oy) < 1e-4) break;
            c.cx += ox;
            c.cy += oy;
        }
        return c;
    }

    function pointInSelection(px, py) {
        const s = state.selection;
        if (!s || s.w <= 0 || s.h <= 0) return false;
        const ang = s.angle || 0;
        const { lx, ly } = worldToLocal(px, py, s.cx, s.cy, ang);
        return lx >= -s.w / 2 && lx <= s.w / 2 && ly >= -s.h / 2 && ly <= s.h / 2;
    }

    function getSelectionHandles() {
        const s = state.selection;
        if (!s || s.w <= 0 || s.h <= 0) return [];
        const ang = s.angle || 0;
        const hw = s.w / 2;
        const hh = s.h / 2;
        const localPts = [
            { name: 'nw', lx: -hw, ly: -hh },
            { name: 'n', lx: 0, ly: -hh },
            { name: 'ne', lx: hw, ly: -hh },
            { name: 'e', lx: hw, ly: 0 },
            { name: 'se', lx: hw, ly: hh },
            { name: 's', lx: 0, ly: hh },
            { name: 'sw', lx: -hw, ly: hh },
            { name: 'w', lx: -hw, ly: 0 },
        ];
        if (s.layerCanvas) {
            localPts.push({ name: 'rotate', lx: 0, ly: -hh - selectionRotOffsetLogical() });
        }
        const hr = selectionHandleRadiusLogical();
        return localPts.map((p) => {
            const wpt = localToWorld(p.lx, p.ly, s.cx, s.cy, ang);
            return { name: p.name, x: wpt.x, y: wpt.y, r: hr };
        });
    }

    function hitTestHandle(px, py) {
        if (!state.selection) return null;
        const handles = getSelectionHandles();
        let best = null;
        let bestD = Infinity;
        for (let i = 0; i < handles.length; i++) {
            const h = handles[i];
            const dx = px - h.x;
            const dy = py - h.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d <= h.r + 2 && d < bestD) {
                bestD = d;
                best = h.name;
            }
        }
        return best;
    }

    function computeResizeFromLocal(orig, handle, lx, ly, shiftKey) {
        const w0 = orig.w;
        const h0 = orig.h;
        const minSize = 1;
        const hh = w0 / 2;
        const hv = h0 / 2;
        let nxmin;
        let nxmax;
        let nymin;
        let nymax;
        if (handle === 'nw') {
            nxmin = Math.min(lx, hh - minSize); nymin = Math.min(ly, hv - minSize);
            nxmax = hh; nymax = hv;
        } else if (handle === 'ne') {
            nxmin = -hh; nxmax = Math.max(lx, -hh + minSize);
            nymin = ly; nymax = hv;
        } else if (handle === 'se') {
            nxmin = -hh; nxmax = Math.max(lx, -hh + minSize);
            nymin = -hv; nymax = Math.max(ly, -hv + minSize);
        } else if (handle === 'sw') {
            nxmin = Math.min(lx, hh - minSize); nxmax = hh;
            nymin = -hv; nymax = Math.max(ly, -hv + minSize);
        } else if (handle === 'n') {
            nxmin = -hh; nxmax = hh; nymin = Math.min(ly, hv - minSize); nymax = hv;
        } else if (handle === 's') {
            nxmin = -hh; nxmax = hh; nymin = -hv; nymax = Math.max(ly, -hv + minSize);
        } else if (handle === 'e') {
            nxmin = -hh; nxmax = Math.max(lx, -hh + minSize); nymin = -hv; nymax = hv;
        } else if (handle === 'w') {
            nxmin = Math.min(lx, hh - minSize); nxmax = hh; nymin = -hv; nymax = hv;
        } else {
            return null;
        }
        let wNew = nxmax - nxmin;
        let hNew = nymax - nymin;
        if (shiftKey && (handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw')) {
            const size = Math.max(wNew, hNew);
            if (handle === 'nw') {
                nxmin = hh - size; nymin = hv - size; nxmax = hh; nymax = hv;
            } else if (handle === 'ne') {
                nxmax = -hh + size; nymin = hv - size; nxmin = -hh; nymax = hv;
            } else if (handle === 'se') {
                nxmax = -hh + size; nymax = -hv + size; nxmin = -hh; nymin = -hv;
            } else if (handle === 'sw') {
                nxmin = hh - size; nymax = -hv + size; nxmax = hh; nymin = -hv;
            }
            wNew = nxmax - nxmin;
            hNew = nymax - nymin;
        }
        wNew = Math.max(minSize, wNew);
        hNew = Math.max(minSize, hNew);
        const cxLoc = (nxmin + nxmax) / 2;
        const cyLoc = (nymin + nymax) / 2;
        const a = orig.angle || 0;
        return {
            cx: orig.cx + cxLoc * Math.cos(a) - cyLoc * Math.sin(a),
            cy: orig.cy + cxLoc * Math.sin(a) + cyLoc * Math.cos(a),
            w: wNew,
            h: hNew,
        };
    }

    function beginSelection(x, y) {
        if (state.selection && state.selection.layerCanvas) commitSelection();
        state.selection = { cx: x, cy: y, w: 0, h: 0, angle: 0, layerCanvas: null, dragging: false, offsetX: 0, offsetY: 0, resizing: null };
    }
    function finalizeSelectionRect(x, y, shiftKey) {
        if (!state.selection) return;
        let x0 = Math.min(state.startX, x);
        let y0 = Math.min(state.startY, y);
        let x1 = Math.max(state.startX, x);
        let y1 = Math.max(state.startY, y);
        if (shiftKey) {
            const size = Math.max(x1 - x0, y1 - y0);
            x1 = x0 + size;
            y1 = y0 + size;
        }
        const [bx0, by0, bx1, by1] = snapPreviewBounds(x0, y0, x1, y1);
        const sx0 = Math.max(0, bx0);
        const sy0 = Math.max(0, by0);
        const sx1 = Math.min(canvas.width, bx1);
        const sy1 = Math.min(canvas.height, by1);
        const w = sx1 - sx0;
        const h = sy1 - sy0;
        if (w === 0 || h === 0) { state.selection = null; drawCrosshair(); return; }
        pushUndo();
        const layer = document.createElement('canvas');
        layer.width = w; layer.height = h;
        const lctx = layer.getContext('2d');
        const imageData = ctx.getImageData(sx0, sy0, w, h);
        lctx.putImageData(imageData, 0, 0);
        ctx.clearRect(sx0, sy0, w, h);
        state.selection = {
            cx: sx0 + w / 2,
            cy: sy0 + h / 2,
            w,
            h,
            angle: 0,
            layerCanvas: layer,
            dragging: false,
            offsetX: 0,
            offsetY: 0,
            resizing: null,
            _orig: null,
            _initial: { x: sx0, y: sy0, w, h },
            _cutFromCanvas: true,
        };
        drawCrosshair();
    }
    /** Caller provides octx from drawCrosshair (avoids double ensureOverlay + getContext). */
    function drawSelectionOverlay(octx) {
        if (!state.selection) return;
        octx.setTransform(1, 0, 0, 1, 0, 0);
        octx.clearRect(0, 0, octx.canvas.width, octx.canvas.height);
        applyOverlayLogicalTransform(octx);
        const s = state.selection;
        if (s.w <= 0 || s.h <= 0) return;
        const cx = s.cx;
        const cy = s.cy;
        const w = s.w;
        const h = s.h;
        const ang = s.angle || 0;
        const hw = overlayHairlineWidth(octx);
        const hr = selectionHandleRadiusLogical();
        const rotOff = selectionRotOffsetLogical();
        octx.imageSmoothingEnabled = false;
        octx.save();
        octx.translate(cx, cy);
        octx.rotate(ang);
        if (s.layerCanvas) {
            octx.drawImage(s.layerCanvas, -w / 2, -h / 2, w, h);
        } else {
            octx.fillStyle = 'rgba(0, 255, 204, 0.09)';
            octx.fillRect(-w / 2, -h / 2, w, h);
        }
        octx.lineJoin = 'miter';
        octx.lineCap = 'butt';
        octx.setLineDash(overlayDashPattern(octx));
        octx.lineDashOffset = 0;
        octx.strokeStyle = '#00ffcc';
        octx.lineWidth = hw;
        octx.strokeRect(-w / 2, -h / 2, w, h);
        if (s.layerCanvas) {
            octx.setLineDash([]);
            octx.strokeStyle = 'rgba(0, 255, 204, 0.55)';
            octx.lineWidth = hw;
            octx.beginPath();
            octx.moveTo(0, -h / 2);
            octx.lineTo(0, -h / 2 - rotOff);
            octx.stroke();
        }
        octx.restore();
        const handles = getSelectionHandles();
        octx.setLineDash([]);
        for (let i = 0; i < handles.length; i++) {
            const hd = handles[i];
            octx.beginPath();
            octx.arc(hd.x, hd.y, hr, 0, Math.PI * 2);
            octx.fillStyle = '#00ffcc';
            octx.fill();
            octx.strokeStyle = 'rgba(0, 0, 0, 0.42)';
            octx.lineWidth = hw;
            octx.stroke();
        }
    }
    function commitSelection() {
        if (!state.selection || !state.selection.layerCanvas) return;
        // If this selection came from the select tool (cut-out), undo was already pushed when we cleared the canvas.
        if (!state.selection._cutFromCanvas) pushUndo();
        const s = state.selection;
        const c = clampCenterInCanvas(s.cx, s.cy, s.w, s.h, s.angle || 0);
        s.cx = c.cx;
        s.cy = c.cy;
        ctx.save();
        try { ctx.imageSmoothingEnabled = false; } catch (_) {}
        ctx.translate(s.cx, s.cy);
        ctx.rotate(s.angle || 0);
        ctx.drawImage(s.layerCanvas, -s.w / 2, -s.h / 2, s.w, s.h);
        ctx.restore();
        state.selection = null;
        // Clear selection overlay but keep crosshair/axes visible
        clearOverlay();
        saveToDisk();
    }

    function cancelSelection() {
        if (!state.selection) return;
        state.isDrawing = false;
        if (state.selection.layerCanvas && state.selection._cutFromCanvas && state.selection._initial) {
            const init = state.selection._initial;
            ctx.drawImage(state.selection.layerCanvas, init.x, init.y, init.w, init.h);
            saveToDisk();
        }
        state.selection = null;
        clearOverlay();
    }

    function deleteSelectionContents() {
        if (!state.selection || !state.selection.layerCanvas) return;
        const empty = document.createElement('canvas');
        empty.width = Math.max(1, state.selection.layerCanvas.width);
        empty.height = Math.max(1, state.selection.layerCanvas.height);
        state.selection.layerCanvas = empty;
        drawCrosshair();
    }

    // Internal clipboard for the image editor (keeps this fast + works without OS clipboard permissions)
    let clipboardCanvas = null;
    function copySelectionToClipboard() {
        const src = (state.selection && state.selection.layerCanvas) ? state.selection.layerCanvas : canvas;
        const clip = document.createElement('canvas');
        clip.width = Math.max(1, src.width);
        clip.height = Math.max(1, src.height);
        clip.getContext('2d').drawImage(src, 0, 0);
        clipboardCanvas = clip;
    }
    function cutSelectionToClipboard() {
        if (!state.selection || !state.selection.layerCanvas) return;
        copySelectionToClipboard();
        deleteSelectionContents();
    }
    function pasteFromClipboard() {
        if (!clipboardCanvas) return;
        if (state.selection && state.selection.layerCanvas) commitSelection();
        const layer = document.createElement('canvas');
        layer.width = clipboardCanvas.width;
        layer.height = clipboardCanvas.height;
        layer.getContext('2d').drawImage(clipboardCanvas, 0, 0);
        const x0 = Math.floor((canvas.width - layer.width) / 2);
        const y0 = Math.floor((canvas.height - layer.height) / 2);
        const sx = Math.max(0, x0), sy = Math.max(0, y0);
        const sw = Math.min(canvas.width, layer.width), sh = Math.min(canvas.height, layer.height);
        state.selection = {
            cx: sx + sw / 2,
            cy: sy + sh / 2,
            w: sw,
            h: sh,
            angle: 0,
            layerCanvas: layer,
            dragging: false,
            offsetX: 0,
            offsetY: 0,
            resizing: null,
            _orig: null,
            _initial: { x: sx, y: sy, w: sw, h: sh },
            _cutFromCanvas: false,
        };
        drawCrosshair();
    }
    function selectAll() {
        if (state.selection && state.selection.layerCanvas) commitSelection();
        pushUndo();
        const layer = document.createElement('canvas');
        layer.width = canvas.width;
        layer.height = canvas.height;
        layer.getContext('2d').drawImage(canvas, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        state.selection = {
            cx: canvas.width / 2,
            cy: canvas.height / 2,
            w: canvas.width,
            h: canvas.height,
            angle: 0,
            layerCanvas: layer,
            dragging: false,
            offsetX: 0,
            offsetY: 0,
            resizing: null,
            _orig: null,
            _initial: { x: 0, y: 0, w: canvas.width, h: canvas.height },
            _cutFromCanvas: true,
        };
        drawCrosshair();
    }

    /** Map client coords to canvas bitmap using a cached getBoundingClientRect (same math as canvasToLocalFromClientRect; includes ancestor scale). */
    function canvasCoordsFromClientRect(clientX, clientY, rect) {
        const rw = rect.width || 1;
        const rh = rect.height || 1;
        const x = (clientX - rect.left) / rw * canvas.width;
        const y = (clientY - rect.top) / rh * canvas.height;
        // getBoundingClientRect + compositor snapping can bias pointer→canvas mapping slightly
        // positive in both axes (~¼ logical px at high zoom). Nudge back so 1px brush aligns.
        const bias = 0.25;
        const nx = x - bias;
        const ny = y - bias;
        return {
            x: Math.max(0, Math.min(canvas.width, nx)),
            y: Math.max(0, Math.min(canvas.height, ny)),
        };
    }

    /** Map pointer to canvas bitmap coords (pan + zoom are CSS transform on an ancestor). */
    function canvasToLocalFromClientRect(evt) {
        const rect = canvas.getBoundingClientRect();
        return canvasCoordsFromClientRect(evt.clientX, evt.clientY, rect);
    }

    function canvasToLocal(evt) {
        // Always use clientX/Y + getBoundingClientRect(). offsetX/offsetY are in the element's
        // pre-transform layout space; zoom is applied via scale() on viewTransformHost, so mixing
        // offset coords with rect-based math skews ~½px (very visible at high zoom / 1px brush).
        return canvasToLocalFromClientRect(evt);
    }

    function onPointerDown(e) {
        const isRightBrushErase = e.button === 2 && state.tool === 'brush';
        if (e.button !== 0 && !isRightBrushErase) return;
        if (isRightBrushErase) {
            e.preventDefault();
            state.brushEraseDrag = true;
            state._brushSavedA = state.color.a;
            state.color.a = 0;
            state._brushErasePointerId = e.pointerId;
        } else {
            if (state.brushEraseDrag) {
                state.color.a = state._brushSavedA;
                state.brushEraseDrag = false;
                state._brushErasePointerId = null;
            }
        }
        try {
            if (typeof e.pointerId === 'number') canvas.setPointerCapture(e.pointerId);
        } catch (_) {}
        const p = canvasToLocal(e);
        state.isDrawing = (state.tool !== 'select');
        state.startX = state.lastX = p.x;
        state.startY = state.lastY = p.y;
        if (state.tool === 'brush') {
            state._brushScreenRect = canvas.getBoundingClientRect();
            pushUndo();
            applyBrushLine(p.x, p.y, p.x, p.y);
        } else if (state.tool === 'bucket') {
            bucketFillAt(p.x, p.y);
            state.isDrawing = false;
            // Persist bucket fill immediately
            saveToDisk();
        } else if (state.tool === 'select') {
            if (state.selection) {
                const handle = hitTestHandle(p.x, p.y);
                if (handle) {
                    const s = state.selection;
                    s.resizing = handle;
                    s._orig = { cx: s.cx, cy: s.cy, w: s.w, h: s.h, angle: s.angle || 0 };
                    if (handle === 'rotate') {
                        s._rotateStart = Math.atan2(p.y - s.cy, p.x - s.cx);
                        s._angleStart = s.angle || 0;
                    }
                    state.isDrawing = false;
                    return;
                }
                if (pointInSelection(p.x, p.y)) {
                    state.selection.dragging = true;
                    state.selection.offsetX = p.x - state.selection.cx;
                    state.selection.offsetY = p.y - state.selection.cy;
                } else {
                    beginSelection(p.x, p.y);
                    state.isDrawing = true;
                }
            } else {
                beginSelection(p.x, p.y);
                state.isDrawing = true;
            }
        } else if (state.tool === 'rect' || state.tool === 'circle') {
            // Prepare overlay preview
            clearOverlay();
        }
    }
    function onPointerMove(e) {
        if (activeTab !== 'images') {
            if (!state.isDrawing && !(state.selection && (state.selection.dragging || state.selection.resizing))) return;
        } else {
            // Avoid running this handler on every global pointermove while idle on the Images tab.
            if (!state.isDrawing && !(state.selection && (state.selection.dragging || state.selection.resizing))) {
                if (!(state.tool === 'select' && e.target === canvas)) return;
            }
        }
        if (!state.isDrawing) {
            // Cursor polish for selection tool (handles + move)
            if (activeTab === 'images' && state.tool === 'select') {
                if (e.target !== canvas) {
                    wrapper.style.cursor = '';
                } else {
                    try {
                        const p = canvasToLocal(e);
                        if (!state.selection) {
                            wrapper.style.cursor = 'crosshair';
                        } else if (!state.selection.dragging && !state.selection.resizing) {
                            const handle = hitTestHandle(p.x, p.y);
                            const inside = pointInSelection(p.x, p.y);
                            const cursors = {
                                nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
                                n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', rotate: 'grab',
                            };
                            wrapper.style.cursor = handle ? (cursors[handle] || 'default') : (inside ? 'move' : 'crosshair');
                        }
                    } catch (_) {}
                }
            }
            if (state.selection && state.selection.resizing === 'rotate') {
                const p = canvasToLocal(e);
                const s = state.selection;
                const cur = Math.atan2(p.y - s.cy, p.x - s.cx);
                let ang = s._angleStart + (cur - s._rotateStart);
                if (e.shiftKey) {
                    const step = Math.PI / 4;
                    ang = Math.round(ang / step) * step;
                }
                s.angle = ang;
                scheduleDrawCrosshair();
            } else if (state.selection && state.selection.resizing) {
                const p = canvasToLocal(e);
                const s = state.selection;
                const o = s._orig;
                const { lx, ly } = worldToLocal(p.x, p.y, o.cx, o.cy, o.angle);
                const res = computeResizeFromLocal(o, s.resizing, lx, ly, e.shiftKey);
                if (res) {
                    const cc = clampCenterInCanvas(res.cx, res.cy, res.w, res.h, o.angle);
                    s.cx = cc.cx;
                    s.cy = cc.cy;
                    s.w = res.w;
                    s.h = res.h;
                }
                scheduleDrawCrosshair();
            } else if (state.selection && state.selection.dragging) {
                const p = canvasToLocal(e);
                const s = state.selection;
                let ncx = p.x - s.offsetX;
                let ncy = p.y - s.offsetY;
                const cc = clampCenterInCanvas(ncx, ncy, s.w, s.h, s.angle || 0);
                s.cx = cc.cx;
                s.cy = cc.cy;
                const snapDist = 8;
                if (Math.abs(s.cx - canvas.width / 2) <= snapDist) s.cx = canvas.width / 2;
                if (Math.abs(s.cy - canvas.height / 2) <= snapDist) s.cy = canvas.height / 2;
                scheduleDrawCrosshair();
            }
            return;
        }
        if (state.tool === 'brush') {
            // Paint synchronously (rAF deferred ink by ~1+ frames and felt like ~100ms lag).
            // Read coalesced samples here only — never use PointerEvent after this handler returns.
            let rect = state._brushScreenRect;
            if (!rect) {
                rect = canvas.getBoundingClientRect();
                state._brushScreenRect = rect;
            }
            const shift = e.shiftKey;
            let events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
            if (!events || events.length === 0) events = [e];
            const pts = [state.lastX, state.lastY];
            for (let i = 0; i < events.length; i++) {
                const ev = events[i];
                let { x: cx, y: cy } = canvasCoordsFromClientRect(ev.clientX, ev.clientY, rect);
                if (shift) {
                    const dx = cx - state.startX;
                    const dy = cy - state.startY;
                    if (Math.abs(dx) > Math.abs(dy)) cy = state.startY; else cx = state.startX;
                }
                pts.push(cx, cy);
            }
            const n = pts.length;
            state.lastX = pts[n - 2];
            state.lastY = pts[n - 1];
            if (n >= 4) {
                scheduleBrushStrokePolyline(pts);
            }
            return;
        }
        const p = canvasToLocal(e);
        if (state.tool === 'rect' || state.tool === 'circle') {
            let x0 = state.startX, y0 = state.startY, x1 = p.x, y1 = p.y;
            if (e.shiftKey) {
                const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
                x1 = x0 + Math.sign(x1 - x0) * size;
                y1 = y0 + Math.sign(y1 - y0) * size;
            }
            previewShapeTools(state.tool, Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1));
        }
        if (state.tool === 'select' && state.selection && !state.selection.layerCanvas && !state.selection.dragging) {
            let x0 = state.startX, y0 = state.startY, x1 = p.x, y1 = p.y;
            if (e.shiftKey) {
                const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
                x1 = x0 + Math.sign(x1 - x0) * size;
                y1 = y0 + Math.sign(y1 - y0) * size;
            }
            let rx0 = Math.min(x0, x1), ry0 = Math.min(y0, y1);
            let rx1 = Math.max(x0, x1), ry1 = Math.max(y0, y1);
            rx0 = Math.max(0, rx0); ry0 = Math.max(0, ry0);
            rx1 = Math.min(canvas.width, rx1); ry1 = Math.min(canvas.height, ry1);
            const rw = Math.max(0, rx1 - rx0);
            const rh = Math.max(0, ry1 - ry0);
            state.selection.cx = rx0 + rw / 2;
            state.selection.cy = ry0 + rh / 2;
            state.selection.w = rw;
            state.selection.h = rh;
            state.selection.angle = 0;
            scheduleDrawCrosshair();
        }
    }
    function onPointerUp(e) {
        if (!state.isDrawing) {
            if (
                state.brushEraseDrag
                && (e.type === 'pointercancel' || e.button === 2)
                && (state._brushErasePointerId == null
                    || e.pointerId == null
                    || e.pointerId === state._brushErasePointerId)
            ) {
                state.color.a = state._brushSavedA;
                state.brushEraseDrag = false;
                state._brushErasePointerId = null;
            }
            if (state.selection && state.selection.dragging) {
                state.selection.dragging = false;
                flushDrawCrosshair();
            } else if (state.selection && state.selection.resizing) {
                state.selection.resizing = null;
                state.selection._orig = null;
                flushDrawCrosshair();
            }
            return;
        }
        state.isDrawing = false;
        state._brushScreenRect = null;
        const p = canvasToLocal(e);
        if (state.tool === 'rect') {
            let x0 = state.startX, y0 = state.startY, x1 = p.x, y1 = p.y;
            if (e.shiftKey) {
                const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
                x1 = x0 + Math.sign(x1 - x0) * size;
                y1 = y0 + Math.sign(y1 - y0) * size;
            }
            const [bx0, by0, bx1, by1] = snapPreviewBounds(x0, y0, x1, y1);
            const rw = bx1 - bx0, rh = by1 - by0;
            if (rw < 1 || rh < 1) {
                clearOverlay();
                return;
            }
            pushUndo();
            symmetryRectsForBounds(bx0, by0, bx1, by1).forEach(([a, b, c, d]) => commitRect(a, b, c, d));
            clearOverlay();
            saveToDisk();
        } else if (state.tool === 'circle') {
            let x0 = state.startX, y0 = state.startY, x1 = p.x, y1 = p.y;
            if (e.shiftKey) {
                const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
                x1 = x0 + Math.sign(x1 - x0) * size;
                y1 = y0 + Math.sign(y1 - y0) * size;
            }
            const [cx0, cy0, cx1, cy1] = snapPreviewBounds(x0, y0, x1, y1);
            const cw = cx1 - cx0, ch = cy1 - cy0;
            if (cw < 1 || ch < 1) {
                clearOverlay();
                return;
            }
            pushUndo();
            symmetryRectsForBounds(cx0, cy0, cx1, cy1).forEach(([a, b, c, d]) => commitCircle(a, b, c, d));
            clearOverlay();
            saveToDisk();
        } else if (state.tool === 'brush') {
            flushBrushStrokeNow();
            // Persist brush stroke when mouse is released
            saveToDisk();
            if (
                state.brushEraseDrag
                && (state._brushErasePointerId == null
                    || e.pointerId == null
                    || e.pointerId === state._brushErasePointerId)
            ) {
                state.color.a = state._brushSavedA;
                state.brushEraseDrag = false;
                state._brushErasePointerId = null;
            }
            // Crosshair remains on overlay
        } else if (state.tool === 'select') {
            if (state.selection && !state.selection.layerCanvas) {
                const dx = p.x - state.startX;
                const dy = p.y - state.startY;
                const MIN_MARQUEE_DRAG = 3;
                if (Math.hypot(dx, dy) < MIN_MARQUEE_DRAG) {
                    state.selection = null;
                    drawCrosshair();
                } else {
                    finalizeSelectionRect(p.x, p.y, e.shiftKey);
                }
            }
        }
    }
    function onPointerLeave() {
        // Intentionally empty: pointerleave still fires while pointer is captured for drawing,
        // and clearing isDrawing here would skip pointerup — so rect/circle/brush strokes never committed.
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('contextmenu', (e) => {
        if (state.tool === 'brush') e.preventDefault();
    });
    // Commit selection when clicking outside selection on canvas
    canvas.addEventListener('click', (e) => {
        if (!state.selection) return;
        const p = canvasToLocal(e);
        const onHandle = hitTestHandle(p.x, p.y);
        const inside = pointInSelection(p.x, p.y);
        if (!inside && !onHandle && !state.isDrawing) {
            commitSelection();
        }
    });

    // Pan/zoom controls:
    // - Trackpad: two-finger pan (wheel deltaX/deltaY), pinch zoom (wheel + ctrlKey on macOS)
    // - Mouse: wheel zoom, middle-button drag pan
    // Tunables
    // - Trackpad pan: lower = slower
    // - Mouse wheel zoom: larger step = more aggressive per notch
    const TRACKPAD_PAN_SPEED = 0.85;
    const MOUSE_WHEEL_ZOOM_STEP_IN = 1.18;
    const MOUSE_WHEEL_ZOOM_STEP_OUT = 0.85;
    function isLikelyTrackpadWheel(e) {
        // Heuristic: trackpads tend to emit pixel deltas (deltaMode=0) with small/fractional deltas,
        // often with both deltaX and deltaY. Mouse wheels are commonly larger/step-like.
        if (e.deltaMode !== 0) return false;
        const ax = Math.abs(e.deltaX || 0);
        const ay = Math.abs(e.deltaY || 0);
        if (ax > 0 && ay > 0) return true;
        if (ay > 0 && ay < 50) return true;
        if (ax > 0 && ax < 50) return true;
        return false;
    }

    let trackpadPanWheelRaf = null;
    let trackpadPanAccX = 0;
    let trackpadPanAccY = 0;
    function flushPendingTrackpadPan() {
        if (trackpadPanWheelRaf != null) {
            cancelAnimationFrame(trackpadPanWheelRaf);
            trackpadPanWheelRaf = null;
        }
        if (trackpadPanAccX !== 0 || trackpadPanAccY !== 0) {
            state.panX += trackpadPanAccX;
            state.panY += trackpadPanAccY;
            trackpadPanAccX = 0;
            trackpadPanAccY = 0;
            applyPanOnlyTransform();
        }
    }

    previewHost.addEventListener('wheel', (e) => {
        // Keep the editor from scrolling the page/panels while interacting.
        e.preventDefault();
        e.stopPropagation();

        // Pinch zoom (macOS trackpad commonly reports this as wheel with ctrlKey=true)
        if (e.ctrlKey) {
            flushPendingTrackpadPan();
            // Smooth exponential zoom; deltaY sign: negative -> zoom in, positive -> zoom out
            const factor = Math.exp(-e.deltaY * 0.01);
            zoomAboutClientPoint(e.clientX, e.clientY, state.zoom * factor);
            imageZoom = state.zoom;
            return;
        }

        // Two-finger trackpad pan — accumulate deltas; one transform apply per animation frame.
        if (isLikelyTrackpadWheel(e)) {
            trackpadPanAccX += -(e.deltaX || 0) * TRACKPAD_PAN_SPEED;
            trackpadPanAccY += -(e.deltaY || 0) * TRACKPAD_PAN_SPEED;
            if (trackpadPanWheelRaf == null) {
                trackpadPanWheelRaf = requestAnimationFrame(() => {
                    trackpadPanWheelRaf = null;
                    if (trackpadPanAccX !== 0 || trackpadPanAccY !== 0) {
                        state.panX += trackpadPanAccX;
                        state.panY += trackpadPanAccY;
                        trackpadPanAccX = 0;
                        trackpadPanAccY = 0;
                        applyPanOnlyTransform();
                    }
                });
            }
            return;
        }

        flushPendingTrackpadPan();

        // Mouse wheel zoom (discrete)
        const step = e.deltaY < 0 ? MOUSE_WHEEL_ZOOM_STEP_IN : MOUSE_WHEEL_ZOOM_STEP_OUT;
        zoomAboutClientPoint(e.clientX, e.clientY, state.zoom * step);
        imageZoom = state.zoom;
    }, { passive: false });

    function onPanPointerDown(e) {
        // Middle mouse button drag to pan
        if (e.pointerType !== 'mouse') return;
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        flushPendingTrackpadPan();
        state.isPanning = true;
        state.panPointerId = e.pointerId;
        state._lastPanClientX = e.clientX;
        state._lastPanClientY = e.clientY;
        try { previewHost.setPointerCapture(e.pointerId); } catch (_) {}
        previewHost.style.cursor = 'grabbing';
    }
    function onPanPointerMove(e) {
        if (!state.isPanning) return;
        if (state.panPointerId != null && e.pointerId !== state.panPointerId) return;
        e.preventDefault();
        const dx = e.clientX - state._lastPanClientX;
        const dy = e.clientY - state._lastPanClientY;
        state._lastPanClientX = e.clientX;
        state._lastPanClientY = e.clientY;
        panBy(dx, dy);
    }
    function endPan(e) {
        if (!state.isPanning) return;
        if (state.panPointerId != null && e && e.pointerId != null && e.pointerId !== state.panPointerId) return;
        state.isPanning = false;
        state.panPointerId = null;
        previewHost.style.cursor = '';
    }
    previewHost.addEventListener('pointerdown', onPanPointerDown);
    previewHost.addEventListener('pointermove', onPanPointerMove);
    previewHost.addEventListener('pointerup', endPan);
    previewHost.addEventListener('pointercancel', endPan);

    // Keyboard shortcuts for undo/redo + selection editing
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const ctxMenu = document.getElementById('__image_asset_ctx_menu');
            if (ctxMenu) { e.preventDefault(); removeImageAssetContextMenu(); return; }
            const sndMenu = document.getElementById('__sound_asset_ctx_menu');
            if (sndMenu) { e.preventDefault(); removeSoundAssetContextMenu(); return; }
            const codeCtxMenu = document.getElementById('__code_block_ctx_menu');
            if (codeCtxMenu) { e.preventDefault(); removeCodeBlockContextMenu(); return; }
        }
        if (activeTab !== 'images') return;
        // Don't steal shortcuts while typing in inputs.
        const t = e.target;
        const tag = t && t.tagName ? String(t.tagName).toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;

        const isMeta = e.ctrlKey || e.metaKey;
        if (isMeta && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) {
                redo();
            } else if (!tryUndoImageDeletion()) {
                undo();
            }
            return;
        }

        // Copy/Cut/Paste/Select All
        if (isMeta && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelectionToClipboard(); return; }
        if (isMeta && e.key.toLowerCase() === 'x') { e.preventDefault(); cutSelectionToClipboard(); return; }
        if (isMeta && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteFromClipboard(); return; }
        if (isMeta && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }

        if (e.key === 'Escape') {
            if (state.selection) { e.preventDefault(); cancelSelection(); }
            return;
        }
        if (e.key === 'Enter') {
            if (state.selection && state.selection.layerCanvas) { e.preventDefault(); commitSelection(); }
            return;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
            if (state.selection && state.selection.layerCanvas) { e.preventDefault(); deleteSelectionContents(); }
            return;
        }

        // Nudge selection with arrow keys
        if (state.selection && state.selection.layerCanvas && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
            e.preventDefault();
            const step = e.shiftKey ? 10 : 1;
            let dx = 0, dy = 0;
            if (e.key === 'ArrowUp') dy = -step;
            if (e.key === 'ArrowDown') dy = step;
            if (e.key === 'ArrowLeft') dx = -step;
            if (e.key === 'ArrowRight') dx = step;
            state.selection.cx += dx;
            state.selection.cy += dy;
            const cc = clampCenterInCanvas(state.selection.cx, state.selection.cy, state.selection.w, state.selection.h, state.selection.angle || 0);
            state.selection.cx = cc.cx;
            state.selection.cy = cc.cy;
            drawCrosshair();
            return;
        }
    });

    function undo() {
        if (state.undoStack.length === 0) return;
        const current = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const prev = state.undoStack.pop();
        state.redoStack.push(current);
        restore(prev);
        syncCanvasToCurrentAsset();
    }
    function redo() {
        if (state.redoStack.length === 0) return;
        const current = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const next = state.redoStack.pop();
        state.undoStack.push(current);
        restore(next);
        syncCanvasToCurrentAsset();
    }

    // Zoom buttons are wired in createImagesInterface via createZoomControlStrip (zoomImage / resetZoom → setZoom)

    // Public API
    const api = {
        setTool, getTool, setColor, setBrushSize, setFill, getFill, toggleFill, setSymmetry, setZoom, clear, loadImage, getCanvasSize, setCanvasSize, undo, redo, drawCrosshair,
        // Used by Edit menu in the Images tab
        cut: cutSelectionToClipboard,
        copy: copySelectionToClipboard,
        paste: pasteFromClipboard,
        selectAll,
        commitSelection,
        cancelSelection,
    };
    // Defaults
    setColor('#ff0000', 1);
    setBrushSize(16);
    setZoom(imageZoom);
    // Draw initial crosshair
    drawCrosshair();
    return api;
}