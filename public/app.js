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
let draggedBlock = null;
let touchOffsetX = 0;
let touchOffsetY = 0;
let dragStartX = 0;
let dragStartY = 0;
let blockStartX = 0;
let blockStartY = 0;
let isDragging = false;

// Tab system variables
let activeTab = 'code'; // Default to code tab
const tabs = ['images', 'code', 'sound', 'threed'];

// ===== Runtime/Play State =====
let isPlaying = false;
let runtimePositions = {}; // world coords centered at (0,0): { [objectId]: { x, y, rot, scale, alpha, spritePath, layer } }
let runtimeExecState = {}; // per object execution state
let runtimeVariables = {}; // per instance variables: { [instanceId]: { [name]: any } }
let runtimeGlobalVariables = {}; // shared public variables across all instances: { [name]: any }
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
const TIME_BUDGET_MS = 6;               // soft time budget for interpreter per frame
const LOOP_YIELD_MS = 1000 / 60;        // yield when repeat/forever has no runnable body (avoids freezing the tab)
// Outer repeat continuation must not use `steps` — action blocks never increment `steps` (only non-actions do).
const MAX_REPEAT_OUTER_PASSES = Math.max(MAX_TOTAL_STEPS_PER_FRAME, 50000);
let rrInstanceStartIndex = 0;           // round-robin start index for fairness
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
let instancesPendingCreation = [];
// Pool freed instance ids per template to reduce GC/alloc churn when cloning/deleting many instances
let freeInstancesByTemplate = {};
// Safety cap for how many instances are fully created per frame; excess are queued to subsequent frames
const MAX_CREATES_PER_FRAME = 200;

// Track mouse relative to game window center
const gameCanvas = document.getElementById('game-window');
if (gameCanvas) {
    gameCanvas.addEventListener('mousemove', (e) => {
        const rect = gameCanvas.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        const localY = e.clientY - rect.top;
        runtimeMouse.x = Math.round(localX - rect.width / 2);
        runtimeMouse.y = Math.round(rect.height / 2 - localY);
    });
    // Also use Pointer Events to ensure pointer updates are received during keyboard input
    gameCanvas.addEventListener('pointermove', (e) => {
        const rect = gameCanvas.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        const localY = e.clientY - rect.top;
        runtimeMouse.x = Math.round(localX - rect.width / 2);
        runtimeMouse.y = Math.round(rect.height / 2 - localY);
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
function resetRuntimePositions() {
    runtimePositions = {};
    runtimeInstances.forEach(inst => {
        runtimePositions[inst.instanceId] = { x: 0, y: 0, layer: 0 };
    });
}
function stepInterpreter(dtMs) {
    if (!isPlaying) return;
    // Fair scheduling with round-robin and budgets
    const startTime = performance.now();
    let totalStepsThisFrame = 0;
    const instanceCount = runtimeInstances.length;
    for (let offset = 0; offset < instanceCount; offset++) {
        const inst = runtimeInstances[(rrInstanceStartIndex + offset) % instanceCount];
        if (__stepOnlyInstanceIds && Array.isArray(__stepOnlyInstanceIds) && __stepOnlyInstanceIds.length > 0) {
            if (!__stepOnlyInstanceIds.includes(inst.instanceId)) continue;
        }
        const o = objectById[inst.templateId];
        const exec = runtimeExecState[inst.instanceId];
        if (!o || !exec) continue;
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
                    const tx = Number((node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0));
                    const ty = Number((node.input_b != null) ? (resolveInput(node, 'input_b') ?? node.val_b ?? 0) : (node.val_b ?? 0));
                    const dx = (typeof pos.x === 'number' ? pos.x : 0) - tx;
                    const dy = (typeof pos.y === 'number' ? pos.y : 0) - ty;
                    return Math.hypot(dx, dy);
                }
                if (node.content === 'pixel_is_rgb') {
                    const canvas = document.getElementById('game-window');
                    if (!canvas) return 0;
                    const xw = Number((node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0));
                    const yw = Number((node.input_b != null) ? (resolveInput(node, 'input_b') ?? node.val_b ?? 0) : (node.val_b ?? 0));
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
                if (node.content === 'random_int') {
                    const minVal = (node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0);
                    const maxVal = (node.input_b != null) ? (resolveInput(node, 'input_b') ?? node.val_b ?? 0) : (node.val_b ?? 0);
                    let a = Number(minVal);
                    let b = Number(maxVal);
                    if (Number.isNaN(a)) a = 0;
                    if (Number.isNaN(b)) b = 0;
                    if (a > b) { const t = a; a = b; b = t; }
                    return Math.floor(Math.random() * (b - a + 1)) + a; // inclusive
                }
                if (node.content === 'operation') {
                    const xVal = (node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.op_x ?? 0) : (node.op_x ?? 0);
                    const yVal = (node.input_b != null) ? (resolveInput(node, 'input_b') ?? node.op_y ?? 0) : (node.op_y ?? 0);
                    switch (node.val_a) {
                        case '+': return xVal + yVal;
                        case '-': return xVal - yVal;
                        case '*': return xVal * yVal;
                        case '/': return yVal === 0 ? 0 : xVal / yVal;
                        case '^': return Math.pow(xVal, yVal);
                        default: return xVal + yVal;
                    }
                }
                if (node.content === 'not') {
                    const v = (node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0);
                    const num = Number(v) || 0;
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
                    let A = Number(aVal);
                    let B = Number(bVal);
                    if (Number.isNaN(A)) A = 0;
                    if (Number.isNaN(B)) B = 0;
                    return A < B ? 1 : 0;
                }
                if (node.content === 'and') {
                    const aVal = (node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0);
                    const bVal = (node.input_b != null) ? (resolveInput(node, 'input_b') ?? node.val_b ?? 0) : (node.val_b ?? 0);
                    const A = Number(aVal) || 0;
                    const B = Number(bVal) || 0;
                    return (A !== 0 && B !== 0) ? 1 : 0;
                }
                if (node.content === 'or') {
                    const aVal = (node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0);
                    const bVal = (node.input_b != null) ? (resolveInput(node, 'input_b') ?? node.val_b ?? 0) : (node.val_b ?? 0);
                    const A = Number(aVal) || 0;
                    const B = Number(bVal) || 0;
                    return (A !== 0 || B !== 0) ? 1 : 0;
                }
                if (node.content === 'variable') {
                    const varName = node.var_name || '';
                    if (node.var_instance_only) {
                        const vars = runtimeVariables[inst.instanceId] || (runtimeVariables[inst.instanceId] = {});
                        const v = vars[varName];
                        return typeof v === 'number' ? v : 0;
                    } else {
                        const v = runtimeGlobalVariables[varName];
                        return typeof v === 'number' ? v : 0;
                    }
                }
                if (node.content === 'array_get') {
                    const arr = getArrayRef(node.var_name || '', !!node.var_instance_only);
                    const idxVal = (node.input_a != null) ? (resolveInput(node, 'input_a') ?? node.val_a ?? 0) : (node.val_a ?? 0);
                    const idx = Math.floor(Number(idxVal));
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
                    const x = Number(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    const y = Number(resolveInput(block, 'input_b') ?? block.val_b ?? 0);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    runtimePositions[inst.instanceId].x += x;
                    runtimePositions[inst.instanceId].y += y;
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'move_forward') {
                    // Move forward by distance in the direction the instance is facing (0° is up)
                    const distance = Number(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
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
                    runtimePositions[inst.instanceId].rot += Number(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'set_rotation') {
                    // Set absolute rotation
                    const absoluteDeg = Number(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    runtimePositions[inst.instanceId].rot = absoluteDeg;
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'set_size') {
                    const s = Number(resolveInput(block, 'input_a') ?? block.val_a ?? 1);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    if (runtimePositions[inst.instanceId].scale === undefined) runtimePositions[inst.instanceId].scale = 1;
                    runtimePositions[inst.instanceId].scale = Math.max(0, s);
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'set_opacity') {
                    let a = Number(resolveInput(block, 'input_a') ?? block.val_a ?? 1);
                    if (Number.isNaN(a)) a = 1;
                    a = Math.max(0, Math.min(1, a));
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0, layer: 0 };
                    runtimePositions[inst.instanceId].alpha = a;
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'set_layer') {
                    const layer = Number(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0, layer: 0 };
                    runtimePositions[inst.instanceId].layer = layer;
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'point_towards') {
                    // Compute angle from current position to (x,y) and set rot
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0, layer: 0 };
                    const pos = runtimePositions[inst.instanceId];
                    const targetX = Number((block.input_a != null ? (resolveInput(block, 'input_a') ?? block.val_a) : block.val_a) ?? 0);
                    const targetY = Number((block.input_b != null ? (resolveInput(block, 'input_b') ?? block.val_b) : block.val_b) ?? 0);
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
                    const ds = Number(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    if (runtimePositions[inst.instanceId].scale === undefined) runtimePositions[inst.instanceId].scale = 1;
                    runtimePositions[inst.instanceId].scale = Math.max(0, (runtimePositions[inst.instanceId].scale || 1) + ds);
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'wait') {
                    const seconds = Math.max(0, parseFloat(resolveInput(block, 'input_a') ?? block.val_a ?? 0));
                    // Start waiting on first encounter for THIS instance only
                    if (exec.waitMs <= 0 || exec.waitingBlockId !== block.id) {
                        exec.waitMs = seconds * 1000; // supports fractional seconds
                        exec.waitingBlockId = block.id;
                    }
                    // Stop executing further this frame
                    break;
                }
                if (block.content === 'repeat') {
                    const times = Math.max(0, Number(block.val_a || 0));
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
                    const condVal = Number(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    const isTrue = condVal ? true : false;
                    exec.pc = isTrue ? ((typeof block.next_block_b === 'number') ? block.next_block_b : null)
                                     : ((typeof block.next_block_a === 'number') ? block.next_block_a : null);
                    continue;
                }
                if (block.content === 'set_x') {
                    const x = Number(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    runtimePositions[inst.instanceId].x = x;
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'set_y') {
                    const y = Number(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    runtimePositions[inst.instanceId].y = y;
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'switch_image') {
                    const imgs = getCurrentObjectImages();
                    let found = null;
                    if (block.input_a != null) {
                        const sel = resolveInput(block, 'input_a');
                        if (typeof sel === 'string') {
                            found = imgs.find(img => img.name === sel);
                        } else {
                            found = imgs.find(img => String(img.id) === String(sel));
                        }
                    } else {
                        found = imgs.find(img => String(img.id) === String(block.val_a));
                    }
                    if (found) {
                        if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                        runtimePositions[inst.instanceId].spritePath = found.src;
                    }
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    renderGameWindowSprite();
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
                        instancesPendingCreation.push({ instanceId: instanceIdToUse, templateId: template.id });
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
                    const value = Number(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (block.var_instance_only) {
                        if (!runtimeVariables[inst.instanceId]) runtimeVariables[inst.instanceId] = {};
                        runtimeVariables[inst.instanceId][varName] = value;
                    } else {
                        runtimeGlobalVariables[varName] = value;
                    }
                    exec.pc = (typeof block.next_block_a === 'number') ? block.next_block_a : null;
                    continue;
                }
                if (block.content === 'change_variable') {
                    const varName = block.var_name || '';
                    const delta = Number(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    if (block.var_instance_only) {
                        if (!runtimeVariables[inst.instanceId]) runtimeVariables[inst.instanceId] = {};
                        const curVal = runtimeVariables[inst.instanceId][varName];
                        const current = (typeof curVal === 'number') ? curVal : 0;
                        runtimeVariables[inst.instanceId][varName] = current + delta;
                    } else {
                        const curVal = runtimeGlobalVariables[varName];
                        const current = (typeof curVal === 'number') ? curVal : 0;
                        runtimeGlobalVariables[varName] = current + delta;
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
                    let idx = Math.floor(Number(idxVal));
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
                    const idx = Math.floor(Number(idxVal));
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
            if ((performance.now() - startTime) >= TIME_BUDGET_MS) break;
        }

        // If we reached end of a chain, check repeat stack (may loop same frame)
        if (exec.pc == null && exec.repeatStack.length > 0) {
            const frame = exec.repeatStack[exec.repeatStack.length - 1];
            frame.timesRemaining -= 1;
            if (frame.timesRemaining > 0) {
                const repeatBlock = codeMap ? codeMap[frame.repeatBlockId] : code.find(b => b && b.id === frame.repeatBlockId);
                exec.pc = repeatBlock && (typeof repeatBlock.next_block_a === 'number') ? repeatBlock.next_block_a : null;
                if (exec.pc != null) {
                    continue outerInstanceLoop;
                }
                // No first block (empty repeat body): outerInstanceLoop would spin forever without advancing steps
                exec.waitMs = LOOP_YIELD_MS;
                exec.waitingBlockId = repeatBlock ? repeatBlock.id : null;
                break outerInstanceLoop;
            }
            exec.repeatStack.pop();
            exec.pc = frame.afterId != null ? frame.afterId : null;
            continue outerInstanceLoop;
        }
        break outerInstanceLoop;
        }

        if (totalStepsThisFrame >= MAX_TOTAL_STEPS_PER_FRAME) { break; }
        if ((performance.now() - startTime) >= TIME_BUDGET_MS) { break; }
    }
    // Advance the round-robin start for next frame to ensure fairness
    if (!(__stepOnlyInstanceIds && Array.isArray(__stepOnlyInstanceIds) && __stepOnlyInstanceIds.length > 0)) {
        if (runtimeInstances.length > 0) {
            rrInstanceStartIndex = (rrInstanceStartIndex + 1) % runtimeInstances.length;
        }
    }
    // Commit any instances that were requested for creation this frame (after all logic)
    if (instancesPendingCreation && instancesPendingCreation.length > 0) {
        const createCount = Math.min(MAX_CREATES_PER_FRAME, instancesPendingCreation.length);
        const createdIds = [];
        for (let i = 0; i < createCount; i++) {
            const pending = instancesPendingCreation[i];
            const template = objectById[pending.templateId];
            if (!template) continue;
            runtimeInstances.push({ instanceId: pending.instanceId, templateId: pending.templateId });
            runtimePositions[pending.instanceId] = { x: 0, y: 0, layer: 0 };
            runtimeVariables[pending.instanceId] = {};
            // Seed private array variables for this template
            try {
                const arrs = Array.isArray(template.arrayVariables) ? template.arrayVariables : [];
                arrs.forEach(name => { runtimeVariables[pending.instanceId][name] = []; });
            } catch (_) {}
            const codeT = Array.isArray(template.code) ? template.code : [];
            const startT = codeT.find(b => b.type === 'start');
            const pcT = startT && typeof startT.next_block_a === 'number' ? startT.next_block_a : null;
            runtimeExecState[pending.instanceId] = { pc: pcT, waitMs: 0, waitingBlockId: null, repeatStack: [] };
            createdIds.push(pending.instanceId);
        }
        // Remove processed items; leave remainder for next frame
        instancesPendingCreation.splice(0, createCount);
        // Immediately step newly created instances so their code runs before render
        if (createdIds.length > 0) {
            const savedFilter = __stepOnlyInstanceIds;
            __stepOnlyInstanceIds = createdIds.slice();
            try {
                // Run one mini-step without advancing rr pointer
                const now = performance.now();
                stepInterpreter(0);
            } finally {
                __stepOnlyInstanceIds = savedFilter;
            }
        }
    }
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
    instancesPendingCreation = [];
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
        runtimeExecState[instId] = { pc: pc, waitMs: 0, waitingBlockId: null, repeatStack: [] };
    } else {
        console.warn('No AppController found to start.');
    }
    resetRuntimePositions();
    playStartTime = performance.now();
    lastFrameTime = playStartTime;
    const loop = () => {
        if (!isPlaying) return;
        const now = performance.now();
        const dt = now - lastFrameTime;
        lastFrameTime = now;
        stepInterpreter(dt);
        renderGameWindowSprite();
        playLoopHandle = requestAnimationFrame(loop);
    };
    playLoopHandle = requestAnimationFrame(loop);
}
function stopPlay() {
    isPlaying = false;
    if (playLoopHandle) cancelAnimationFrame(playLoopHandle);
    playLoopHandle = null;
    renderGameWindowSprite();
}
// Create a node block
function createNodeBlock(codeData, x, y) {
    const block = document.createElement("div");
    block.className = "node-block";
    if (codeData.type === 'start') block.classList.add('node-block-start');
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
        input.addEventListener("change", () => { codeData.val_a = parseFloat(input.value) || 0; });
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
            const r = document.getElementById('node-window'); if (!r) return;
            const rect = r.getBoundingClientRect();
            connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        waitInput.type = "number";
        waitInput.min = "0";
        waitInput.step = "0.1";
        waitInput.value = (typeof codeData.val_a === 'number' ? codeData.val_a : 1);
        waitInput.addEventListener("change", () => {
            codeData.val_a = parseFloat(waitInput.value) || 0;
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
            codeData.val_a = parseInt(repeatInput.value) || 1;
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
        condInput.addEventListener('change', () => { codeData.val_a = parseInt(condInput.value) || 0; });
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
            const r = document.getElementById('node-window').getBoundingClientRect();
            connectMouse.x = e.clientX - r.left; connectMouse.y = e.clientY - r.top;
            // Ensure focus on node window and clear any lingering menu handlers
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        rotInput.addEventListener('change', () => { codeData.val_a = parseFloat(rotInput.value) || 0; });
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
            const r = document.getElementById('node-window'); if (!r) return;
            const rect = r.getBoundingClientRect();
            connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        sizeInput.addEventListener('change', () => { codeData.val_a = parseFloat(sizeInput.value) || 1; });
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
            const r = document.getElementById('node-window').getBoundingClientRect();
            connectMouse.x = e.clientX - r.left; connectMouse.y = e.clientY - r.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        sizeInput.addEventListener('change', () => { codeData.val_a = parseFloat(sizeInput.value) || 0; });
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
            const r = document.getElementById('node-window').getBoundingClientRect();
            connectMouse.x = e.clientX - r.left; connectMouse.y = e.clientY - r.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        layerInput.addEventListener('change', () => { codeData.val_a = parseFloat(layerInput.value) || 0; });
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
            const r = document.getElementById('node-window'); if (!r) return;
            const rect = r.getBoundingClientRect();
            connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        opInput.addEventListener('change', () => { let v = parseFloat(opInput.value); if (isNaN(v)) v = 1; codeData.val_a = Math.max(0, Math.min(1, v)); });
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
            const r = document.getElementById('node-window').getBoundingClientRect();
            connectMouse.x = e.clientX - r.left; connectMouse.y = e.clientY - r.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
            drawConnections();
        });
        opSpan.appendChild(btn);
        if (codeData.input_a != null) { opInput.value = '^'; opInput.readOnly = true; }
    } else if (codeData.content === 'operation') {
        // Operation block: ( X [op] Y )
        label.textContent = '';
        const leftSpan = document.createElement('span');
        leftSpan.className = 'node-input-container';
        const leftInput = document.createElement('input');
        leftInput.type = 'number';
        leftInput.step = '1';
        if (typeof codeData.op_x !== 'number') codeData.op_x = 0;
        leftInput.value = codeData.op_x;
        leftInput.addEventListener('change', () => { codeData.op_x = parseFloat(leftInput.value) || 0; });
        leftSpan.appendChild(leftInput);

        const opSelect = document.createElement('select');
        opSelect.className = 'node-op-select';
        const ops = ['+','-','*','/','^'];
        ops.forEach(sym => {
            const opt = document.createElement('option');
            opt.value = sym; opt.textContent = sym;
            opSelect.appendChild(opt);
        });
        if (!codeData.val_a) codeData.val_a = '+';
        opSelect.value = codeData.val_a;
        opSelect.addEventListener('change', () => { codeData.val_a = opSelect.value; });

        const rightSpan = document.createElement('span');
        rightSpan.className = 'node-input-container';
        const rightInput = document.createElement('input');
        rightInput.type = 'number';
        rightInput.step = '1';
        if (typeof codeData.op_y !== 'number') codeData.op_y = 0;
        rightInput.value = codeData.op_y;
        rightInput.addEventListener('change', () => { codeData.op_y = parseFloat(rightInput.value) || 0; });
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

                const container = document.getElementById('node-window');
                if (!container) return;

                const rect = container.getBoundingClientRect();
                connectMouse.x = e.clientX - rect.left;
                connectMouse.y = e.clientY - rect.top;
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true;
                connectStartTime = Date.now();
                connectFromInput = { blockId: codeData.id, which };
                document.addEventListener('mousemove', handleConnectMouseMove);
                document.addEventListener('mouseup', handleConnectMouseUp, true);
                drawConnections();
            });
            containerEl.appendChild(btn);
        };
        addOpInputPlus(leftSpan, 'a');
        addOpInputPlus(rightSpan, 'b');
        if (codeData.input_a != null) { leftInput.value = '^'; leftInput.readOnly = true; }
        if (codeData.input_b != null) { rightInput.value = '^'; rightInput.readOnly = true; }

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
        input.addEventListener('change', () => { codeData.val_a = parseFloat(input.value) || 0; });
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

            const r = document.getElementById('node-window');
            if (!r) return;

            const rect = r.getBoundingClientRect();
            connectMouse.x = e.clientX - rect.left;
            connectMouse.y = e.clientY - rect.top;
            // Ensure canvas focus and clear any lingering menu handlers
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true;
            connectStartTime = Date.now();
            connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        input.addEventListener('change', () => { codeData.val_a = parseFloat(input.value) || 0; });
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

            const r = document.getElementById('node-window');
            if (!r) return;

            const rect = r.getBoundingClientRect();
            connectMouse.x = e.clientX - rect.left;
            connectMouse.y = e.clientY - rect.top;
            // Ensure canvas focus and clear any lingering menu handlers
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true;
            connectStartTime = Date.now();
            connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        aInput.addEventListener('change', () => { codeData.val_a = parseFloat(aInput.value) || 0; });
        aSpan.appendChild(aInput);
        label.appendChild(aSpan);
        label.append(', ');
        const bSpan = document.createElement('span');
        bSpan.className = 'node-input-container';
        const bInput = document.createElement('input');
        bInput.type = 'number'; bInput.step = '1';
        if (typeof codeData.val_b !== 'number') codeData.val_b = 0;
        bInput.value = codeData.val_b;
        bInput.addEventListener('change', () => { codeData.val_b = parseFloat(bInput.value) || 0; });
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
                const container = document.getElementById('node-window'); if (!container) return;
                const rect = container.getBoundingClientRect();
                connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which };
                document.addEventListener('mousemove', handleConnectMouseMove);
                document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        xInput.addEventListener('change', () => { codeData.val_a = parseFloat(xInput.value) || 0; });
        xSpan.appendChild(xInput);
        label.appendChild(xSpan);

        label.append(', ');

        const ySpan = document.createElement('span');
        ySpan.className = 'node-input-container';
        const yInput = document.createElement('input');
        yInput.type = 'number'; yInput.step = '1';
        if (typeof codeData.val_b !== 'number') codeData.val_b = 0;
        yInput.value = codeData.val_b;
        yInput.addEventListener('change', () => { codeData.val_b = parseFloat(yInput.value) || 0; });
        ySpan.appendChild(yInput);
        label.appendChild(ySpan);

        label.append(') is rgb (');

        const rSpan = document.createElement('span');
        rSpan.className = 'node-input-container';
        const rInput = document.createElement('input');
        rInput.type = 'number'; rInput.step = '1'; rInput.min = '0'; rInput.max = '255';
        if (typeof codeData.rgb_r !== 'number') codeData.rgb_r = 0;
        rInput.value = codeData.rgb_r;
        rInput.addEventListener('change', () => { codeData.rgb_r = Math.max(0, Math.min(255, Math.round(parseFloat(rInput.value) || 0))); rInput.value = codeData.rgb_r; });
        rSpan.appendChild(rInput);
        label.appendChild(rSpan);

        label.append(', ');

        const gSpan = document.createElement('span');
        gSpan.className = 'node-input-container';
        const gInput = document.createElement('input');
        gInput.type = 'number'; gInput.step = '1'; gInput.min = '0'; gInput.max = '255';
        if (typeof codeData.rgb_g !== 'number') codeData.rgb_g = 0;
        gInput.value = codeData.rgb_g;
        gInput.addEventListener('change', () => { codeData.rgb_g = Math.max(0, Math.min(255, Math.round(parseFloat(gInput.value) || 0))); gInput.value = codeData.rgb_g; });
        gSpan.appendChild(gInput);
        label.appendChild(gSpan);

        label.append(', ');

        const bSpan = document.createElement('span');
        bSpan.className = 'node-input-container';
        const bInput = document.createElement('input');
        bInput.type = 'number'; bInput.step = '1'; bInput.min = '0'; bInput.max = '255';
        if (typeof codeData.rgb_b !== 'number') codeData.rgb_b = 0;
        bInput.value = codeData.rgb_b;
        bInput.addEventListener('change', () => { codeData.rgb_b = Math.max(0, Math.min(255, Math.round(parseFloat(bInput.value) || 0))); bInput.value = codeData.rgb_b; });
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
                const container = document.getElementById('node-window'); if (!container) return;
                const rect = container.getBoundingClientRect();
                connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which };
                document.addEventListener('mousemove', handleConnectMouseMove);
                document.addEventListener('mouseup', handleConnectMouseUp, true);
                drawConnections();
            });
            containerEl.appendChild(btn);
        };
        addInputPlus(xSpan, 'a');
        addInputPlus(ySpan, 'b');
        if (codeData.input_a != null) { xInput.value = '^'; xInput.readOnly = true; }
        if (codeData.input_b != null) { yInput.value = '^'; yInput.readOnly = true; }
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
        input.addEventListener('change', () => { codeData.val_a = parseFloat(input.value) || 0; });
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
            const r = document.getElementById('node-window'); if (!r) return;
            const rect = r.getBoundingClientRect();
            connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        input.addEventListener('change', () => { codeData.val_a = parseFloat(input.value) || 0; });
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
            const r = document.getElementById('node-window'); if (!r) return;
            const rect = r.getBoundingClientRect();
            connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
            const r = document.getElementById('node-window'); if (!r) return;
            const rect = r.getBoundingClientRect();
            connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        idxInput.addEventListener('change', () => { codeData.val_b = parseFloat(idxInput.value) || 0; });
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
            const r = document.getElementById('node-window'); if (!r) return;
            const rect = r.getBoundingClientRect();
            connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
            const r = document.getElementById('node-window'); if (!r) return;
            const rect = r.getBoundingClientRect();
            connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'b' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        idxInput.addEventListener('change', () => { codeData.val_a = parseFloat(idxInput.value) || 0; });
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
            const r = document.getElementById('node-window'); if (!r) return;
            const rect = r.getBoundingClientRect();
            connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        idxInput.addEventListener('change', () => { codeData.val_a = parseFloat(idxInput.value) || 0; });
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
            const r = document.getElementById('node-window'); if (!r) return;
            const rect = r.getBoundingClientRect();
            connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        aInput.addEventListener('change', () => { codeData.val_a = parseFloat(aInput.value) || 0; });
        aSpan.appendChild(aInput);
        label.appendChild(aSpan);
        const btn = document.createElement('button');
        btn.className = 'node-plus-btn node-input-plus-btn node-input-plus-btn-a';
        btn.textContent = '+'; btn.title = 'Add input (A)';
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showAddInputBlockMenu(block, codeData, 'a', btn); });
        btn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            if (isConnecting) return;
            const container = document.getElementById('node-window'); if (!container) return;
            const rect = container.getBoundingClientRect();
            connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
        aInput.addEventListener('change', () => { codeData.val_a = parseFloat(aInput.value) || 0; });
        aSpan.appendChild(aInput);
        label.appendChild(aSpan);
        label.append(', ');
        const bSpan = document.createElement('span');
        bSpan.className = 'node-input-container';
        const bInput = document.createElement('input');
        bInput.type = 'number'; bInput.step = '1';
        if (typeof codeData.val_b !== 'number') codeData.val_b = 0;
        bInput.value = codeData.val_b;
        bInput.addEventListener('change', () => { codeData.val_b = parseFloat(bInput.value) || 0; });
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
                const container = document.getElementById('node-window'); if (!container) return;
                const rect = container.getBoundingClientRect();
                connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which };
                document.addEventListener('mousemove', handleConnectMouseMove);
                document.addEventListener('mouseup', handleConnectMouseUp, true);
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
            const container = document.getElementById('node-window'); if (!container) return;
            const rect = container.getBoundingClientRect();
            connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
            const nodeWindow = document.getElementById('node-window');
            if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
            clearMenuDocHandlers();
            isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which: 'a' };
            document.addEventListener('mousemove', handleConnectMouseMove);
            document.addEventListener('mouseup', handleConnectMouseUp, true);
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
                : (codeData.content === 'equals' ? ' = ' : (codeData.content === 'and' ? ' AND ' : ' OR '))
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
                const container = document.getElementById('node-window'); if (!container) return;
                const rect = container.getBoundingClientRect();
                connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true; connectStartTime = Date.now(); connectFromInput = { blockId: codeData.id, which };
                document.addEventListener('mousemove', handleConnectMouseMove);
                document.addEventListener('mouseup', handleConnectMouseUp, true);
                drawConnections();
            });
            containerEl.appendChild(btn);
        };
        addInputPlus(aSpan, 'a');
        addInputPlus(bSpan, 'b');
        if (codeData.input_a != null) { aInput.value = '^'; aInput.readOnly = true; }
        if (codeData.input_b != null) { bInput.value = '^'; bInput.readOnly = true; }
        block.classList.add('node-block-compact');
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
        xInput.addEventListener('change', () => { codeData.val_a = parseFloat(xInput.value) || 0; });
        xSpan.appendChild(xInput);
        label.appendChild(xSpan);
        label.append(', ');
        const ySpan = document.createElement('span');
        ySpan.className = 'node-input-container';
        const yInput = document.createElement('input');
        yInput.type = 'number'; yInput.step = '1';
        if (typeof codeData.val_b !== 'number') codeData.val_b = 0;
        yInput.value = codeData.val_b;
        yInput.addEventListener('change', () => { codeData.val_b = parseFloat(yInput.value) || 0; });
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
                const container = document.getElementById('node-window'); if (!container) return;
                const rect = container.getBoundingClientRect();
                connectMouse.x = e.clientX - rect.left; connectMouse.y = e.clientY - rect.top;
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true; connectStartTime = Date.now();
                connectFromInput = { blockId: codeData.id, which };
                document.addEventListener('mousemove', handleConnectMouseMove);
                document.addEventListener('mouseup', handleConnectMouseUp, true);
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
            const codeIdNum = codeData.id;
            // Re-link any predecessors on branch A or B to this block's respective successor
            selectedObj.code.forEach(c => {
                if (c.next_block_a === codeIdNum) {
                    c.next_block_a = (typeof codeData.next_block_a === 'number') ? codeData.next_block_a : null;
                }
                if (c.next_block_b === codeIdNum) {
                    c.next_block_b = (typeof codeData.next_block_b === 'number') ? codeData.next_block_b : null;
                }
                // Clear any input references targeting this block
                if (c.input_a === codeIdNum) {
                    c.input_a = null;
                }
                if (c.input_b === codeIdNum) {
                    c.input_b = null;
                }
            });
            // Remove this block from the object's code list
            const idx = selectedObj.code.findIndex(c => c.id === codeIdNum);
            if (idx >= 0) {
                selectedObj.code.splice(idx, 1);
            }
            // Re-render workspace to refresh plus buttons and connections
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
            codeData.val_a = parseInt(xInput.value) || 0;
        });
        label.children[0].appendChild(xInput);
        // Y input
        const yInput = document.createElement("input");
        yInput.type = "number";
        yInput.step = "1";
        yInput.value = (typeof codeData.val_b === 'number' ? codeData.val_b : 0);
        yInput.addEventListener("change", () => {
            codeData.val_b = parseInt(yInput.value) || 0;
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

                const container = document.getElementById('node-window');
                if (!container) return;

                const rect = container.getBoundingClientRect();
                connectMouse.x = e.clientX - rect.left;
                connectMouse.y = e.clientY - rect.top;

                // Ensure canvas has focus and no lingering menu handlers intercept events
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();

                isConnecting = true;
                connectStartTime = Date.now();
                connectFromInput = { blockId: codeData.id, which };
                document.addEventListener('mousemove', handleConnectMouseMove);
                document.addEventListener('mouseup', handleConnectMouseUp, true);
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
            codeData.val_a = parseFloat(rotInput.value) || 0;
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

                const containerEl = document.getElementById('node-window');
                if (!containerEl) return;

                const rect = containerEl.getBoundingClientRect();
                connectMouse.x = e.clientX - rect.left;
                connectMouse.y = e.clientY - rect.top;
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true;
                connectStartTime = Date.now();
                connectFromInput = { blockId: codeData.id, which: 'a' };
                document.addEventListener('mousemove', handleConnectMouseMove);
                document.addEventListener('mouseup', handleConnectMouseUp, true);
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

                const containerEl = document.getElementById('node-window');
                if (!containerEl) return;

                const rect = containerEl.getBoundingClientRect();
                connectMouse.x = e.clientX - rect.left;
                connectMouse.y = e.clientY - rect.top;
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true;
                connectStartTime = Date.now();
                connectFromInput = { blockId: codeData.id, which: 'a' };
                document.addEventListener('mousemove', handleConnectMouseMove);
                document.addEventListener('mouseup', handleConnectMouseUp, true);
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

                const containerEl = document.getElementById('node-window');
                if (!containerEl) return;

                const rect = containerEl.getBoundingClientRect();
                connectMouse.x = e.clientX - rect.left;
                connectMouse.y = e.clientY - rect.top;
                const nodeWindow = document.getElementById('node-window');
                if (nodeWindow) { if (!nodeWindow.hasAttribute('tabindex')) nodeWindow.setAttribute('tabindex','0'); try { nodeWindow.focus(); } catch(_) {} }
                clearMenuDocHandlers();
                isConnecting = true;
                connectStartTime = Date.now();
                connectFromInput = { blockId: codeData.id, which: 'a' };
                document.addEventListener('mousemove', handleConnectMouseMove);
                document.addEventListener('mouseup', handleConnectMouseUp, true);
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

    // Desktop mouse events
    block.addEventListener("mousedown", (e) => {
        // Avoid starting a drag when interacting with inputs/selects/buttons inside the block
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        if (tag === 'select' || tag === 'input' || tag === 'button' || e.target.closest('select') || e.target.closest('button')) {
            return;
        }
        e.preventDefault();
        draggedBlock = block;
        isDragging = true;
        block.classList.add("dragging");
        block.style.transition = 'none';

        // Record starting positions
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        blockStartX = parseFloat(block.style.left) || 0;
        blockStartY = parseFloat(block.style.top) || 0;

        // Add global mouse move and up listeners
        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
    });

    // Mobile touch events
    block.addEventListener("touchstart", (e) => {
        // Avoid starting a drag when interacting with inputs/selects/buttons inside the block
        const t = e.target;
        const tag = (t && t.tagName) ? t.tagName.toLowerCase() : '';
        if (tag === 'select' || tag === 'input' || tag === 'button' || t.closest('select') || t.closest('button')) {
            return;
        }
        e.preventDefault();
        draggedBlock = block;
        isDragging = true;
        block.classList.add("dragging");
        block.style.transition = 'none';

        const touch = e.touches[0];
        dragStartX = touch.clientX;
        dragStartY = touch.clientY;
        blockStartX = parseFloat(block.style.left) || 0;
        blockStartY = parseFloat(block.style.top) || 0;

        // Add global touch move and end listeners
        document.addEventListener("touchmove", handleTouchMove, { passive: false });
        document.addEventListener("touchend", handleTouchEnd);
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
            insertInputBlockAbove(selectedObj, anchorCodeData, typeKey, inputKey === 'b' ? 'b' : 'a', customPosition);
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
    // Organized, consistently named inputs
    // Operators
    addItem('Operation (+, -, *, /)', 'operation');
    addItem('Equals', 'equals');
    addItem('Less Than', 'less_than');
    addItem('And', 'and');
    addItem('Or', 'or');
    addItem('Not', 'not');
    // Mouse and keyboard
    addItem('Mouse X', 'mouse_x');
    addItem('Mouse Y', 'mouse_y');
    addItem('Window Width', 'window_width');
    addItem('Window Height', 'window_height');
    addItem('Mouse Down?', 'mouse_pressed');
    addItem('Key Pressed?', 'key_pressed');
    // Object properties
    addItem('Object X', 'object_x');
    addItem('Object Y', 'object_y');
    addItem('Rotation', 'rotation');
    addItem('Size', 'size');
    // Values
    addItem('Variable', 'variable');
    addItem('Array Get Item', 'array_get');
    addItem('Array Length', 'array_length');
    addItem('Random Integer', 'random_int');
    addItem('Image Name', 'image_name');
    addItem('Distance To (x, y)', 'distance_to');
    addItem('Pixel is RGB at (x, y)', 'pixel_is_rgb');
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
function insertInputBlockAbove(selectedObj, anchorCodeData, typeKey, inputKey, customPosition = null) {
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

    // Re-render to reflect caret changes and redraw connections
    updateWorkspace();
}
// Global drag handlers
function handleMouseMove(e) {
    if (!isDragging || !draggedBlock) return;

    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    const z = codeZoom || 1;

    const newX = blockStartX + dx / z;
    const newY = blockStartY + dy / z;

    draggedBlock.style.left = `${newX}px`;
    draggedBlock.style.top = `${newY}px`;
    autoScrollIfNearEdge(e.clientX, e.clientY);
    drawConnections();
}

function handleMouseUp(e) {
    if (!isDragging || !draggedBlock) return;

    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    const z = codeZoom || 1;

    const finalX = blockStartX + dx / z;
    const finalY = blockStartY + dy / z;

    draggedBlock.style.left = `${finalX}px`;
    draggedBlock.style.top = `${finalY}px`;

    // Update the code data position
    const codeId = draggedBlock.dataset.codeId;
    const selectedObj = objects.find(obj => obj.id == selected_object);
    const codeData = selectedObj.code.find(code => code.id == codeId);
    codeData.position = { x: finalX, y: finalY };

    // Clean up
    draggedBlock.classList.remove("dragging");
    draggedBlock.style.transition = 'transform 0.1s ease-out';
    draggedBlock = null;
    isDragging = false;

    // Remove global listeners
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);

    drawConnections();
    updateSpacerFromBlocks();
}

function handleTouchMove(e) {
    if (!isDragging || !draggedBlock) return;
    e.preventDefault();

    const touch = e.touches[0];
    const dx = touch.clientX - dragStartX;
    const dy = touch.clientY - dragStartY;
    const z = codeZoom || 1;

    const newX = blockStartX + dx / z;
    const newY = blockStartY + dy / z;

    draggedBlock.style.left = `${newX}px`;
    draggedBlock.style.top = `${newY}px`;
    autoScrollIfNearEdge(touch.clientX, touch.clientY);
    drawConnections();
}

function handleTouchEnd(e) {
    if (!isDragging || !draggedBlock) return;

    let finalX = blockStartX;
    let finalY = blockStartY;

    if (e.changedTouches && e.changedTouches.length > 0) {
        const touch = e.changedTouches[0];
        const dx = touch.clientX - dragStartX;
        const dy = touch.clientY - dragStartY;
        const z = codeZoom || 1;
        finalX = blockStartX + dx / z;
        finalY = blockStartY + dy / z;
    }

    draggedBlock.style.left = `${finalX}px`;
    draggedBlock.style.top = `${finalY}px`;

    // Update the code data position
    const codeId = draggedBlock.dataset.codeId;
    const selectedObj = objects.find(obj => obj.id == selected_object);
    const codeData = selectedObj.code.find(code => code.id == codeId);
    codeData.position = { x: finalX, y: finalY };

    // Clean up
    draggedBlock.classList.remove("dragging");
    draggedBlock.style.transition = 'transform 0.1s ease-out';
    draggedBlock = null;
    isDragging = false;

    // Remove global listeners
    document.removeEventListener("touchmove", handleTouchMove);
    document.removeEventListener("touchend", handleTouchEnd);

    drawConnections();
    updateSpacerFromBlocks();
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

function setCodeZoomBtnIcon(btn, iconNameOrNames, fallbackText) {
    const names = Array.isArray(iconNameOrNames) ? iconNameOrNames : [iconNameOrNames];
    const primary = names[0];
    const lucide = window.lucide;
    const safeFallback = fallbackText == null ? '' : String(fallbackText);
    if (lucide && lucide.icons) {
        const found = names.find(n => lucide.icons && lucide.icons[n]);
        const iconDef = found ? lucide.icons[found] : null;
        if (iconDef && typeof iconDef.toSvg === 'function') {
            btn.innerHTML = `${iconDef.toSvg({ width: 18, height: 18 })}<span class="icon-fallback">${safeFallback}</span>`;
            return;
        }
    }
    if (lucide && typeof lucide.createIcons === 'function') {
        btn.innerHTML = `<i data-lucide="${primary}"></i><span class="icon-fallback">${safeFallback}</span>`;
        return;
    }
    btn.textContent = safeFallback;
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
    document.addEventListener('mousemove', handleConnectMouseMove);
    document.addEventListener('mouseup', handleConnectMouseUp, true);
}

function startConnectFromNext(blockId, which) {
    console.log('startConnectFromNext called:', { blockId, which, isConnecting });
    isConnecting = true;
    connectStartTime = Date.now();
    connectFromNext = { blockId, which: which === 'b' ? 'b' : 'a' };
    console.log('connectFromNext set to:', connectFromNext);
    document.addEventListener('mousemove', handleConnectMouseMove);
    document.addEventListener('mouseup', handleConnectMouseUp, true);
}

function handleConnectMouseMove(e) {
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

        if (!foundValidTarget && selectedObj) {
            // No input button found - create new action block at mouse position
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

        if (!foundValidTarget) {
            const anyBlock = el && (el.classList && el.classList.contains('node-block') ? el : el.closest && el.closest('.node-block'));
            if (anyBlock && selectedObj) {
                const providerId = parseInt(anyBlock.dataset.codeId, 10);
                const provider = selectedObj.code.find(c => c.id === providerId);
                if (provider && provider.type === 'value') {
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

        if (!foundValidTarget && selectedObj) {
            // No provider block found - create new block at mouse position
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

        if (!foundValidTarget && selectedObj) {
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
    isConnecting = false;
    connectStartTime = 0;
    connectFromBlockId = null;
    connectFromInput = null;
    connectFromNext = null;
    document.removeEventListener('mousemove', handleConnectMouseMove);
    document.removeEventListener('mouseup', handleConnectMouseUp, true);
    // Also clear any menu click handlers that might intercept the next drag start
    clearMenuDocHandlers();
    drawConnections();
}

function connectProviderToInput(selectedObj, targetBlock, which, providerId) {
    const key = which === 'b' ? 'input_b' : 'input_a';
    targetBlock[key] = providerId;
    // Mark value fields as caret
    if (targetBlock.content === 'move_xy') {
        if (which === 'a') targetBlock.val_a = '^'; else targetBlock.val_b = '^';
    } else if (targetBlock.content === 'wait' || targetBlock.content === 'repeat' || targetBlock.content === 'rotate' || targetBlock.content === 'set_rotation') {
        targetBlock.val_a = '^';
    } else if (targetBlock.content === 'operation') {
        if (which === 'a') targetBlock.op_x = '^'; else targetBlock.op_y = '^';
    } else if (targetBlock.content === 'set_variable' || targetBlock.content === 'change_variable') {
        targetBlock.val_a = '^';
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
        const startY_A = rectA ? rectA.bottom : st.top + st.height;
        const startY_B = rectB ? rectB.bottom : st.top + st.height;

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
            return { x: r.cx, y: r.top };
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
                    const sy = br.bottom;
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

    // Insert dragged image at target position
    images.splice(targetIndex, 0, draggedImage);

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

    const scrollHostBefore = getCodeScrollContainer();
    const prevScrollLeft = scrollHostBefore ? scrollHostBefore.scrollLeft : 0;
    const prevScrollTop = scrollHostBefore ? scrollHostBefore.scrollTop : 0;

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

        selectedObj.code.forEach(codeData => {
            const block = createNodeBlock(
                codeData,
                codeData.position.x,
                codeData.position.y
            );
            zoomLayer.appendChild(block);
        });

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
        { id: 'rect', icon: ['square', 'square-dashed'], fallback: '▭', title: 'Rectangle' },
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
            setIcon(rectBtn, fill ? ['square'] : ['square-dashed', 'square'], '▭');
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
        if (!grid || !moreBtn || !custom || !panel) return;
        grid.style.display = '';
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
                applyColorFromUI();
                pushRecentImageColor(n);
                closeColorPopup();
            });
            grid.appendChild(b);
        });
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
            requestAnimationFrame(() => positionColorPopup());
        });
        moreBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            grid.style.display = 'none';
            moreBtn.style.display = 'none';
            customPanel.removeAttribute('hidden');
            panel.classList.add('image-color-popup-panel--custom');
            syncCustomFromInput();
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
        customPanel.appendChild(nativeLink);
        panel.appendChild(grid);
        panel.appendChild(moreBtn);
        panel.appendChild(customPanel);
        backdrop.addEventListener('click', closeColorPopup);
        colorPopupRoot.appendChild(backdrop);
        colorPopupRoot.appendChild(panel);
        document.body.appendChild(colorPopupRoot);
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
    setIcon(undoBtn, ['undo-2', 'undo2', 'undo'], '↩');
    undoBtn.className = 'image-edit-tool';
    undoBtn.title = 'Undo';
    undoBtn.addEventListener('click', () => imageEditor && imageEditor.undo());
    const redoBtn = document.createElement('button');
    setIcon(redoBtn, ['redo-2', 'redo2', 'redo'], '↪');
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
    canvasWrapper.appendChild(viewTransformHost);
    viewTransformHost.appendChild(checker);
    viewTransformHost.appendChild(editorCanvas);

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
    });

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

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.textContent = '×';
        deleteBtn.title = 'Delete image';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteImage(imageItem, imgInfo.name, imgInfo);
        });

        // Make thumbnail draggable for reordering
        imageItem.draggable = true;
        imageItem.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/html', imgInfo.name);
            imageItem.classList.add('dragging');
        });

        imageItem.addEventListener('dragend', () => {
            imageItem.classList.remove('dragging');
        });

        imageItem.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            imageItem.classList.add('drag-over');
        });

        imageItem.addEventListener('dragleave', () => {
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

        imageItem.addEventListener('click', () => {
            currentImageFilename = imgInfo.name;
            currentImageInfo = imgInfo;
            selectImage(imgInfo.src, imageItem);
        });
        imageItem.addEventListener('dblclick', (e) => {
            e.preventDefault();
            startRenameImage(imageItem, imgInfo.name);
        });

        let touchTimer;
        imageItem.addEventListener('touchstart', (e) => {
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
            if (!selectedImage) {
                const firstItem = container.children[0];
                if (firstItem) {
                    currentImageFilename = images[0].name;
                    currentImageInfo = images[0];
                    selectImage(images[0].src, firstItem);
                }
            }
        } else {
            selectedImage = null;
            if (imageEditor) imageEditor.clear(true);
        }
    }, 50);
}

// Select and display an image
function selectImage(imagePath, thumbnailElement) {
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
    const info = list.find(x => x.src.split('?')[0] === imagePath.split('?')[0]);
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

    // Update selected object's first sprite and grid icon
    const obj = objects.find(o => o.id == selected_object);
    if (obj) {
        if (!obj.media) obj.media = [];
        if (obj.media.length === 0) obj.media.push({ id: 1, name: 'sprite', type: 'image', path: busted });
        else obj.media[0].path = busted;
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
        // refresh game window
        renderGameWindowSprite();
    }
}
// Zoom image in preview
function zoomImage(factor) {
    imageZoom *= factor;
    imageZoom = Math.max(0.1, Math.min(5.0, imageZoom)); // Clamp between 0.1x and 5.0x
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
            } else {
                undoLastDeletion();
            }
            break;
        case 'cut':
            if (activeTab === 'images' && imageEditor && typeof imageEditor.cut === 'function') imageEditor.cut();
            else console.log('Cut action - not available in this tab');
            break;
        case 'copy':
            if (activeTab === 'images' && imageEditor && typeof imageEditor.copy === 'function') imageEditor.copy();
            else console.log('Copy action - not available in this tab');
            break;
        case 'paste':
            if (activeTab === 'images' && imageEditor && typeof imageEditor.paste === 'function') imageEditor.paste();
            else console.log('Paste action - not available in this tab');
            break;
        case 'selectAll':
            if (activeTab === 'images' && imageEditor && typeof imageEditor.selectAll === 'function') imageEditor.selectAll();
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
    const undoMenu = document.getElementById('edit-dropdown');
    if (undoMenu) {
        const undoItems = undoMenu.querySelectorAll('.undo-menu-item');
        const undoItem = Array.from(undoItems).find(item => item.textContent.includes('Undo') || item.textContent.includes('Nothing'));

        if (undoItem) {
            if (stack.length === 0) {
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

    // Update selected object's media and grid icon
    const obj = objects.find(o => o.id == selected_object);
    if (obj) {
        if (!obj.media) obj.media = [];
        if (obj.media.length === 0) obj.media.push({ id: 1, name: 'sprite', type: 'image', path: dataUrl });
        else obj.media[0].path = dataUrl;
        const box = document.querySelector(`.box[data-id="${obj.id}"]`);
        if (box) {
            let img = box.querySelector('img');
            if (!img) { img = document.createElement('img'); box.insertBefore(img, box.firstChild); }
            img.src = dataUrl;
            img.alt = obj.name;
            img.style.width = "75px";
            img.style.height = "75px";
        }
        renderGameWindowSprite();
    }

    // Refresh thumbnails and visually select the new image
    const thumbnailsContainer = document.querySelector('.images-thumbnails-scroll');
    if (thumbnailsContainer) {
        loadImagesFromDirectory(thumbnailsContainer);
        setTimeout(() => {
            // Prefer a direct attribute lookup for the new item
            let targetEl = thumbnailsContainer.querySelector(`.image-thumbnail-item[data-filename="${newInfo.name}"]`);
            if (!targetEl) {
                const items = Array.from(thumbnailsContainer.children);
                targetEl = items[items.length - 1] || null;
            }
            if (targetEl) {
                thumbnailsContainer.scrollTop = thumbnailsContainer.scrollHeight;
                const imgEl = targetEl.querySelector('img');
                const path = imgEl ? imgEl.src : dataUrl;
                selectImage(path, targetEl);
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

                // Update selected object's media and grid icon
                const obj = objects.find(o => o.id == selected_object);
                if (obj) {
                    if (!obj.media) obj.media = [];
                    if (obj.media.length === 0) obj.media.push({ id: 1, name: 'sprite', type: 'image', path: dataUrl });
                    else obj.media[0].path = dataUrl;
                    const box = document.querySelector(`.box[data-id="${obj.id}"]`);
                    if (box) {
                        let img = box.querySelector('img');
                        if (!img) { img = document.createElement('img'); box.insertBefore(img, box.firstChild); }
                        img.src = dataUrl;
                        img.alt = obj.name;
                        img.style.width = "75px";
                        img.style.height = "75px";
                    }
                    renderGameWindowSprite();
                }

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
                            selectImage(path, targetEl);
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
    const label = imageItem.querySelector('.image-label');
    if (!label) return;

    // Create input field
    const input = document.createElement('input');
    input.type = 'text';
    input.value = oldFilename;
    input.className = 'rename-input';

    // Replace label with input
    label.parentNode.replaceChild(input, label);
    input.focus();
    input.select();

    // Handle input events
    const finishRename = () => {
        const newFilename = input.value.trim();
        if (newFilename && newFilename !== oldFilename) {
            console.log(`Renaming ${oldFilename} to ${newFilename}`);
            label.textContent = newFilename;
            imageItem.dataset.filename = newFilename;
            const list = getCurrentObjectImages();
            const found = list.find(x => x.name === oldFilename);
            if (found) found.name = newFilename;
        }

        // Replace input with label
        input.parentNode.replaceChild(label, input);
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            finishRename();
        } else if (e.key === 'Escape') {
            // Cancel rename
            input.parentNode.replaceChild(label, input);
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
    plusIcon.textContent = "+";
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
	const project = {
		version: 1,
		selected_object,
		objects: JSON.parse(JSON.stringify(objects)),
		images: {}
	};
	Object.keys(objectImages).forEach((key) => {
		project.images[key] = (objectImages[key] || []).map(img => ({ id: img.id, name: img.name, src: img.src }));
	});
	return project;
}

function saveProjectToFile() {
	try {
		const data = serializeProject();
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
					if (data.images && typeof data.images === 'object') {
						Object.keys(data.images).forEach(k => {
							const list = Array.isArray(data.images[k]) ? data.images[k] : [];
							objectImages[k] = list.map(img => ({ id: img.id, name: img.name, src: img.src }));
						});
					}
					// Migrate and ensure start blocks after load
					migrateCodeModel();
					ensureStartBlocks();
					// Ensure each object has at least a default image
					initializeDefaultImages();
					// Restore selection if present
					if (typeof data.selected_object === 'number') {
						selected_object = data.selected_object;
					} else if (objects[0]) {
						selected_object = objects[0].id;
					}
					// Refresh UI
					try { renderObjectGrid(); } catch {}
					try { refreshObjectGridIcons(); } catch {}
					// Rebuild current workspace (code or images)
					try { updateWorkspace(); } catch {}
					try {
						const thumbnailsContainer = document.querySelector('.images-thumbnails-scroll');
						if (thumbnailsContainer) loadImagesFromDirectory(thumbnailsContainer);
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
function generateStandaloneHtml(project) {
	const safeJson = JSON.stringify(project);
	// Minimal runner uses same semantics as in-editor runtime
	return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Maxiverse Export</title>
	<style>
	  html,body{margin:0;height:100%;background:#777;color:#fff}
	  body{display:flex;align-items:center;justify-content:center}
	  canvas{display:block;width:100vw;height:100vh;background:#777}
	</style>
	</head><body>
	<canvas id="game" tabindex="0"></canvas>
	<script>
	const project = ${safeJson};
	let objects = project.objects || [];
	const objectImages = project.images || {};
	// Match editor fairness/time budget
	const TIME_BUDGET_MS = 6;
	const LOOP_YIELD_MS = 1000 / 60;
	const MAX_TOTAL_STEPS_PER_FRAME = 2000;
	let rrInstanceStartIndex = 0;
	let __stepOnlyInstanceIds = null;
	let isPlaying = true;
	let runtimeInstances = [];
	let runtimeExecState = {};
	let runtimePositions = {};
	let runtimeVariables = {};
	let runtimeGlobalVariables = {};
	let nextInstanceId = 1;
	let instancesPendingRemoval = new Set();
	let instancesPendingCreation = [];
	const runtimeMouse = { x: 0, y: 0 };
	let runtimeMousePressed = false;
	const runtimeKeys = {};

	function getFirstImagePathForTemplateId(tid){
	  const list = objectImages[String(tid)]||[];
	  if (!list[0]) return null;
	  const src = list[0].src || '';
	  return src.split('?')[0];
	}

	function startPlay(){
	  runtimeInstances = [];
	  runtimeExecState = {};
	  instancesPendingRemoval = new Set();
	  instancesPendingCreation = [];
	  runtimeVariables = {};
	  runtimeGlobalVariables = {};
	  const controller = objects.find(o=>o.type==='controller' || o.name==='AppController');
	  if (controller){
	    // Seed public array variables
	    try { const pubArrs = Array.isArray(controller.arrayVariables) ? controller.arrayVariables : []; pubArrs.forEach(name => { if (!Array.isArray(runtimeGlobalVariables[name])) runtimeGlobalVariables[name] = []; }); } catch(_) {}
	    const instId = nextInstanceId++;
	    runtimeInstances.push({ instanceId: instId, templateId: controller.id });
	    runtimePositions[instId] = { x:0, y:0, layer: 0 };
	    runtimeVariables[instId] = {};
	    const start = (controller.code||[]).find(b=>b && b.type==='start');
	    runtimeExecState[instId] = { pc: start ? start.next_block_a : null, waitMs:0, waitingBlockId:null, repeatStack: [] };
	  }
	  // Match editor semantics: do not auto-instantiate non-controller objects.
	  // AppController is responsible for spawning gameplay objects in exported build.
	}

	function worldToCanvas(x,y,canvas){
	  const cx = canvas.width/2 + x;
	  const cy = canvas.height/2 - y;
	  return { x: cx, y: cy };
	}

	function stepInterpreter(dt){
	  const startTime = performance.now();
	  let totalStepsThisFrame = 0;
	  const maxStepsPerObject = 50;
	  const count = runtimeInstances.length;
	  for (let i=0; i<count; i++){
	    const inst = runtimeInstances[(rrInstanceStartIndex + i) % Math.max(1, count)];
	    if (!inst) continue;
	    if (__stepOnlyInstanceIds && Array.isArray(__stepOnlyInstanceIds) && __stepOnlyInstanceIds.length>0){ if (!__stepOnlyInstanceIds.includes(inst.instanceId)) continue; }
	    const o = objects.find(obj=>obj.id===inst.templateId);
	    const exec = runtimeExecState[inst.instanceId];
	    if (!o || !exec) continue;
	    const code = o.code || [];
	    if (exec.waitMs>0){ exec.waitMs-=dt; if (exec.waitMs>0) continue; exec.waitMs=0; if(exec.waitingBlockId!=null){ const waitingBlock=code.find(b=>b&&b.id===exec.waitingBlockId); exec.waitingBlockId=null; if(waitingBlock){ exec.pc = (typeof waitingBlock.next_block_a==='number') ? waitingBlock.next_block_a : null; } } }
	    let steps=0;
	    outerLoop: while (steps < maxStepsPerObject) {
	    while (exec.pc!=null && steps++<maxStepsPerObject){
	      const block = code.find(b=>b&&b.id===exec.pc); if(!block){ exec.pc=null; break; }
	      const coerceScalarLiteral=(v)=>{ if(typeof v==='number') return v; if(typeof v==='string'){ const s=v.trim(); if(s==='') return ''; const n=Number(s); return Number.isFinite(n)?n:v; } return v; };
	      const getArrayRef=(varName,instanceOnly)=>{ const name=varName||''; const store=instanceOnly ? (runtimeVariables[inst.instanceId] || (runtimeVariables[inst.instanceId]={})) : runtimeGlobalVariables; let arr=store[name]; if(!Array.isArray(arr)){ arr=[]; store[name]=arr; } return arr; };
	      const resolveInput=(blockRef,key)=>{ const inputId=blockRef[key]; if(inputId==null) return null; const node=code.find(b=>b&&b.id===inputId); if(!node) return null; if(node.content==='mouse_x') return runtimeMouse.x; if(node.content==='mouse_y') return runtimeMouse.y; if(node.content==='window_width'){ const c=document.getElementById('game'); return c? c.width : window.innerWidth; } if(node.content==='window_height'){ const c=document.getElementById('game'); return c? c.height : window.innerHeight; } if(node.content==='object_x'){ const pos=runtimePositions[inst.instanceId]||{x:0,y:0}; return typeof pos.x==='number'?pos.x:0;} if(node.content==='object_y'){ const pos=runtimePositions[inst.instanceId]||{y:0}; return typeof pos.y==='number'?pos.y:0;} if(node.content==='rotation'){ const pos=runtimePositions[inst.instanceId]||{rot:0}; return typeof pos.rot==='number'?pos.rot:0;} if(node.content==='size'){ const pos=runtimePositions[inst.instanceId]||{scale:1}; return typeof pos.scale==='number'?pos.scale:1;} if(node.content==='mouse_pressed') return runtimeMousePressed?1:0; if(node.content==='key_pressed') return runtimeKeys[node.key_name]?1:0; if(node.content==='distance_to'){ const pos=runtimePositions[inst.instanceId]||{x:0,y:0}; const tx=Number((node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0)); const ty=Number((node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0)); const dx=(typeof pos.x==='number'?pos.x:0)-tx; const dy=(typeof pos.y==='number'?pos.y:0)-ty; return Math.hypot(dx,dy);} if(node.content==='pixel_is_rgb'){ const c=document.getElementById('game'); if(!c) return 0; const xw=Number((node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0)); const yw=Number((node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0)); const p=worldToCanvas(xw,yw,c); const px=Math.round(p.x); const py=Math.round(p.y); if(!Number.isFinite(px)||!Number.isFinite(py)) return 0; if(px<0||py<0||px>=c.width||py>=c.height) return 0; const cctx=c.getContext('2d'); if(!cctx) return 0; let data; try{ data=cctx.getImageData(px,py,1,1).data; }catch(_){ return 0; } const r=data[0], g=data[1], b=data[2]; const tr=Math.max(0, Math.min(255, Math.round(Number(node.rgb_r ?? 0) || 0))); const tg=Math.max(0, Math.min(255, Math.round(Number(node.rgb_g ?? 0) || 0))); const tb=Math.max(0, Math.min(255, Math.round(Number(node.rgb_b ?? 0) || 0))); return (r===tr && g===tg && b===tb) ? 1 : 0; } if(node.content==='random_int'){ let a=Number((node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0)); let b=Number((node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0)); if(Number.isNaN(a)) a=0; if(Number.isNaN(b)) b=0; if(a>b){ const t=a; a=b; b=t; } return Math.floor(Math.random()*(b-a+1))+a; } if(node.content==='operation'){ const xVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.op_x ?? 0):(node.op_x ?? 0); const yVal=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.op_y ?? 0):(node.op_y ?? 0); switch(node.val_a){ case '+': return xVal + yVal; case '-': return xVal - yVal; case '*': return xVal * yVal; case '/': return (yVal===0)?0:(xVal / yVal); case '^': return Math.pow(xVal, yVal); default: return xVal + yVal; } } if(node.content==='not'){ const v=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const num=Number(v)||0; return num?0:1; } if(node.content==='equals'){ const aVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const bVal=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0); const A=(aVal==null)?'':aVal; const B=(bVal==null)?'':bVal; return (A==B)?1:0; } if(node.content==='less_than'){ const aVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const bVal=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0); let A=Number(aVal); let B=Number(bVal); if(Number.isNaN(A)) A=0; if(Number.isNaN(B)) B=0; return (A<B)?1:0; } if(node.content==='and'){ const aVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const bVal=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0); const A=Number(aVal)||0; const B=Number(bVal)||0; return (A!==0 && B!==0)?1:0; } if(node.content==='or'){ const aVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const bVal=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0); const A=Number(aVal)||0; const B=Number(bVal)||0; return (A!==0 || B!==0)?1:0; } if(node.content==='variable'){ const varName=node.var_name||''; if(node.var_instance_only){ const vars=runtimeVariables[inst.instanceId] || (runtimeVariables[inst.instanceId]={}); const v=vars[varName]; return (typeof v==='number')?v:0; } else { const v=runtimeGlobalVariables[varName]; return (typeof v==='number')?v:0; } } if(node.content==='array_get'){ const arr=getArrayRef(node.var_name||'', !!node.var_instance_only); const idxVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const idx=Math.floor(Number(idxVal)); if(!Number.isFinite(idx) || idx<0 || idx>=arr.length) return ''; return arr[idx]; } if(node.content==='array_length'){ const arr=getArrayRef(node.var_name||'', !!node.var_instance_only); return arr.length; } return null; };
	      if (block.type==='action'){
	        if (block.content==='move_xy'){ const x=Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); const y=Number(resolveInput(block,'input_b') ?? block.val_b ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,layer:0}; runtimePositions[inst.instanceId].x += x; runtimePositions[inst.instanceId].y += y; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='move_forward'){ const distance=Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,rot:0}; const rotDeg=runtimePositions[inst.instanceId].rot || 0; const rotRad=(rotDeg)*Math.PI/180; runtimePositions[inst.instanceId].x += Math.sin(rotRad)*distance; runtimePositions[inst.instanceId].y += Math.cos(rotRad)*distance; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='rotate'){ if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,rot:0}; runtimePositions[inst.instanceId].rot = (runtimePositions[inst.instanceId].rot||0) + Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='set_rotation'){ if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,rot:0}; runtimePositions[inst.instanceId].rot = Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='set_size'){ const s=Number(resolveInput(block,'input_a') ?? block.val_a ?? 1); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,scale:1,layer:0}; runtimePositions[inst.instanceId].scale = Math.max(0,s); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='set_layer'){ const layer=Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,layer:0}; runtimePositions[inst.instanceId].layer = layer; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='point_towards'){ if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,rot:0}; const pos=runtimePositions[inst.instanceId]; const tx=Number((block.input_a!=null)?(resolveInput(block,'input_a') ?? block.val_a ?? 0):(block.val_a ?? 0)); const ty=Number((block.input_b!=null)?(resolveInput(block,'input_b') ?? block.val_b ?? 0):(block.val_b ?? 0)); const dx=tx-(typeof pos.x==='number'?pos.x:0); const dy=ty-(typeof pos.y==='number'?pos.y:0); const ang=90 - (Math.atan2(dy,dx)*180/Math.PI); pos.rot = ang; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='change_size'){ const ds=Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,scale:1}; const cur=runtimePositions[inst.instanceId].scale||1; runtimePositions[inst.instanceId].scale=Math.max(0,cur+ds); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='wait'){ const seconds=Math.max(0, parseFloat(resolveInput(block,'input_a') ?? block.val_a ?? 0)); if(seconds>0){ exec.waitMs = seconds*1000; exec.waitingBlockId = block.id; exec.pc = null; } else { exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; } break; }
	        if (block.content==='repeat'){ const times=Math.max(0, Number(block.val_a||0)); if(times<=0){ exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; } exec.repeatStack.push({ repeatBlockId:block.id, timesRemaining:times, afterId:(typeof block.next_block_b==='number')?block.next_block_b:null }); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='print'){ const val=(block.input_a!=null)?(resolveInput(block,'input_a') ?? block.val_a ?? ''):(block.val_a ?? ''); try{ console.log(val);}catch(_){} exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='if'){ const condVal=Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); const isTrue = !!condVal; exec.pc = isTrue ? ((typeof block.next_block_b==='number')?block.next_block_b:null) : ((typeof block.next_block_a==='number')?block.next_block_a:null); continue; }
	        if (block.content==='set_x'){ const x=Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,layer:0}; runtimePositions[inst.instanceId].x=x; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='set_y'){ const y=Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0}; runtimePositions[inst.instanceId].y=y; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='switch_image'){ const imgs=(objectImages[String(o.id)]||[]); let found=null; if(block.input_a!=null){ const sel=resolveInput(block,'input_a'); if(typeof sel==='string'){ found=imgs.find(img=>img.name===sel);} else { found=imgs.find(img=>String(img.id)===String(sel)); } } else { found=imgs.find(img=>String(img.id)===String(block.val_a)); } if(found){ if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0}; runtimePositions[inst.instanceId].spritePath = (found.src||'').split('?')[0]; } exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='instantiate'){ const objId=parseInt(block.val_a,10); const template=objects.find(obj=>obj.id===objId); if(template){ const newId=nextInstanceId++; instancesPendingCreation.push({ instanceId:newId, templateId:template.id }); } exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='delete_instance'){ instancesPendingRemoval.add(inst.instanceId); exec.pc=null; continue; }
	        if (block.content==='set_variable'){ const varName=block.var_name||''; const value=Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(block.var_instance_only){ if(!runtimeVariables[inst.instanceId]) runtimeVariables[inst.instanceId]={}; runtimeVariables[inst.instanceId][varName]=value; } else { runtimeGlobalVariables[varName]=value; } exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='change_variable'){ const varName=block.var_name||''; const delta=Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(block.var_instance_only){ if(!runtimeVariables[inst.instanceId]) runtimeVariables[inst.instanceId]={}; const curVal=runtimeVariables[inst.instanceId][varName]; const current=(typeof curVal==='number')?curVal:0; runtimeVariables[inst.instanceId][varName]=current+delta; } else { const curVal=runtimeGlobalVariables[varName]; const current=(typeof curVal==='number')?curVal:0; runtimeGlobalVariables[varName]=current+delta; } exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='array_append'){ const varName=block.var_name||''; const raw=(block.input_a!=null)?(resolveInput(block,'input_a') ?? block.val_a ?? ''):(block.val_a ?? ''); const value=coerceScalarLiteral(raw); const arr=getArrayRef(varName, !!block.var_instance_only); arr.push(value); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='array_insert'){ const varName=block.var_name||''; const raw=(block.input_a!=null)?(resolveInput(block,'input_a') ?? block.val_a ?? ''):(block.val_a ?? ''); const value=coerceScalarLiteral(raw); const idxVal=(block.input_b!=null)?(resolveInput(block,'input_b') ?? block.val_b ?? 0):(block.val_b ?? 0); let idx=Math.floor(Number(idxVal)); if(!Number.isFinite(idx)) idx=0; const arr=getArrayRef(varName, !!block.var_instance_only); idx=Math.max(0, Math.min(arr.length, idx)); arr.splice(idx,0,value); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='array_delete'){ const varName=block.var_name||''; const idxVal=(block.input_a!=null)?(resolveInput(block,'input_a') ?? block.val_a ?? 0):(block.val_a ?? 0); const idx=Math.floor(Number(idxVal)); const arr=getArrayRef(varName, !!block.var_instance_only); if(Number.isFinite(idx) && idx>=0 && idx<arr.length){ arr.splice(idx,1); } exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='forever'){ exec.repeatStack.push({ repeatBlockId:block.id, timesRemaining:Infinity, afterId:(typeof block.next_block_b==='number')?block.next_block_b:null }); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	      }
	      exec.pc = (typeof block.next_block_a==='number') ? block.next_block_a : null;
	      totalStepsThisFrame += 1;
	      if (typeof MAX_TOTAL_STEPS_PER_FRAME === 'number' && totalStepsThisFrame >= MAX_TOTAL_STEPS_PER_FRAME) break;
	      if (typeof TIME_BUDGET_MS === 'number' && (performance.now() - startTime) >= TIME_BUDGET_MS) break;
	    }
	    if (exec.pc==null && exec.repeatStack.length>0){
	      const frame=exec.repeatStack[exec.repeatStack.length-1];
	      frame.timesRemaining-=1;
	      if(frame.timesRemaining>0){
	        const repeatBlock=code.find(b=>b&&b.id===frame.repeatBlockId);
	        exec.pc = repeatBlock && (typeof repeatBlock.next_block_a==='number') ? repeatBlock.next_block_a : null;
	        if(exec.pc!=null){ continue outerLoop; }
	        exec.waitMs = LOOP_YIELD_MS;
	        exec.waitingBlockId = repeatBlock ? repeatBlock.id : null;
	        break outerLoop;
	      }
	      exec.repeatStack.pop();
	      exec.pc = frame.afterId != null ? frame.afterId : null;
	      continue outerLoop;
	    }
	    break outerLoop;
	    }
	  }
	  if (instancesPendingCreation && instancesPendingCreation.length>0){
	    const createdIds = [];
	    for (const pending of instancesPendingCreation){ const template=objects.find(o=>o.id===pending.templateId); if(!template) continue; runtimeInstances.push({ instanceId: pending.instanceId, templateId: pending.templateId }); runtimePositions[pending.instanceId] = { x:0, y:0, layer: 0 }; runtimeVariables[pending.instanceId] = {}; try{ const arrs=Array.isArray(template.arrayVariables)?template.arrayVariables:[]; arrs.forEach(name=>{ runtimeVariables[pending.instanceId][name]=[]; }); }catch(_){} const start=(template.code||[]).find(b=>b&&b.type==='start'); const pcT = start ? start.next_block_a : null; runtimeExecState[pending.instanceId] = { pc: pcT, waitMs:0, waitingBlockId:null, repeatStack: [] }; createdIds.push(pending.instanceId); }
	    instancesPendingCreation.length=0;
	    if (createdIds.length>0){ const savedFilter = __stepOnlyInstanceIds; __stepOnlyInstanceIds = createdIds.slice(); try { stepInterpreter(0); } finally { __stepOnlyInstanceIds = savedFilter; } }
	  }
	  // Advance RR pointer when not filtering
	  if (!(__stepOnlyInstanceIds && Array.isArray(__stepOnlyInstanceIds) && __stepOnlyInstanceIds.length>0)){
	    if (runtimeInstances.length>0){ rrInstanceStartIndex = (rrInstanceStartIndex + 1) % runtimeInstances.length; }
	  }
	  if (instancesPendingRemoval && instancesPendingRemoval.size>0){
	    runtimeInstances = runtimeInstances.filter(inst=>{ if(instancesPendingRemoval.has(inst.instanceId)){ delete runtimePositions[inst.instanceId]; delete runtimeVariables[inst.instanceId]; delete runtimeExecState[inst.instanceId]; return false; } return true; });
	    instancesPendingRemoval.clear();
	  }
	}

	const canvas = document.getElementById('game');
	const gctx = canvas.getContext('2d');
	function fit(){ canvas.width = window.innerWidth; canvas.height = window.innerHeight; canvas.style.width = window.innerWidth + 'px'; canvas.style.height = window.innerHeight + 'px'; }
	window.addEventListener('resize', fit);
	fit();

	canvas.addEventListener('mousemove',(e)=>{ const rect=canvas.getBoundingClientRect(); const localX=e.clientX-rect.left; const localY=e.clientY-rect.top; const cx = canvas.width/2; const cy = canvas.height/2; runtimeMouse.x = Math.round(localX - cx); runtimeMouse.y = Math.round(cy - localY); });
	canvas.addEventListener('mousedown',()=>{ runtimeMousePressed=true; });
	canvas.addEventListener('mouseup',()=>{ runtimeMousePressed=false; });
	canvas.addEventListener('mouseleave',()=>{ runtimeMousePressed=false; });
	window.addEventListener('mouseup',()=>{ runtimeMousePressed=false; });
	function normalizeKeyName(k){ if(k===' '||k==='Spacebar') return 'Space'; return k; }
	document.addEventListener('keydown',(e)=>{ const k=normalizeKeyName(e.key); if(isPlaying&&k==='Space'){ const t=e.target; const tag=t&&t.tagName?String(t.tagName).toLowerCase():''; if(tag!=='input'&&tag!=='textarea'&&tag!=='select'&&!(t&&t.isContentEditable))e.preventDefault(); } runtimeKeys[k]=true;},true);
	document.addEventListener('keyup',(e)=>{ const k=normalizeKeyName(e.key); runtimeKeys[k]=false;});

	const imageCache = {};
	function render(){
	  gctx.clearRect(0,0,canvas.width,canvas.height);
	  gctx.fillStyle='#777';
	  gctx.fillRect(0,0,canvas.width,canvas.height);
	  const centerX=canvas.width/2, centerY=canvas.height/2;
	  const visibleEntries = runtimeInstances.map(inst=>{ const tmpl=objects.find(o=>o.id===inst.templateId); const perInst=runtimePositions[inst.instanceId]||{}; const pth = perInst.spritePath || getFirstImagePathForTemplateId(tmpl.id); const path = pth ? String(pth).split('?')[0] : null; return path ? { inst, tmpl, path } : null; }).filter(Boolean);
	  visibleEntries.forEach((entry,index)=>{
	    const mediaPath=entry.path;
	    let img=imageCache[mediaPath];
	    if(!img){ img=new Image(); imageCache[mediaPath]=img; img.src=mediaPath; img.onerror=()=>{ console.warn('Image failed to load', mediaPath); }; }
	    const drawIfReady=()=>{
	      if(!img.complete || !(img.naturalWidth>0 && img.naturalHeight>0)) return;
	      gctx.imageSmoothingEnabled=true; gctx.imageSmoothingQuality='medium';
	      let scale = 1;
	      if (runtimePositions[entry.inst.instanceId] && typeof runtimePositions[entry.inst.instanceId].scale==='number') { scale = Math.max(0, runtimePositions[entry.inst.instanceId].scale||1); }
	      const dw=img.width*scale, dh=img.height*scale;
	      let drawX, drawY;
	      if (runtimePositions[entry.inst.instanceId]){ const p=worldToCanvas(runtimePositions[entry.inst.instanceId].x||0, runtimePositions[entry.inst.instanceId].y||0, canvas); drawX=Math.round(p.x-dw/2); drawY=Math.round(p.y-dh/2); } else { drawX=Math.round(centerX-dw/2); drawY=Math.round(centerY-dh/2); }
	      const alpha = (typeof runtimePositions[entry.inst.instanceId]?.alpha === 'number') ? Math.max(0, Math.min(1, runtimePositions[entry.inst.instanceId].alpha)) : 1;
	      if (typeof runtimePositions[entry.inst.instanceId]?.rot==='number'){ const angleRad=(runtimePositions[entry.inst.instanceId].rot||0)*Math.PI/180; gctx.save(); gctx.translate(drawX+dw/2, drawY+dh/2); gctx.rotate(angleRad); const prevAlpha=gctx.globalAlpha; gctx.globalAlpha = alpha; gctx.drawImage(img, -dw/2, -dh/2, dw, dh); gctx.globalAlpha=prevAlpha; gctx.restore(); } else { const prevAlpha=gctx.globalAlpha; gctx.globalAlpha = alpha; gctx.drawImage(img, drawX, drawY, dw, dh); gctx.globalAlpha=prevAlpha; }
	    };
	    if (img.complete) drawIfReady(); else img.onload=drawIfReady;
	  });
	}

	let last=performance.now();
	function loop(now){ const dt=now-last; last=now; stepInterpreter(dt); render(); requestAnimationFrame(loop); }
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
    initializeTabs();
    initializeEditMenu();
    initializeFileMenu();
    setTimeout(() => refreshObjectGridIcons(), 50);
    console.log('✅ App initialization complete');
    try {
        const topPlay = document.getElementById('topbar-play');
        if (topPlay && !topPlay.__bound) {
            topPlay.__bound = true;
            topPlay.addEventListener('click', () => {
                if (isPlaying) {
                    stopPlay();
                    topPlay.textContent = '▶';
                    topPlay.classList.remove('active');
                } else {
                    startPlay();
                    topPlay.textContent = '■';
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
            playBtn.textContent = '▶';
            playBtn.className = 'fallback-play-btn';
            playBtn.addEventListener('click', () => {
                if (isPlaying) {
                    stopPlay();
                } else {
                    startPlay();
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
    // Fit the canvas to right pane size only when changed to avoid expensive reallocation each frame
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
    }
    // background
    gctx.clearRect(0, 0, canvas.width, canvas.height);
    gctx.fillStyle = '#777';
    gctx.fillRect(0, 0, canvas.width, canvas.height);
    // Set smoothing once per frame (medium for better performance). Disable per-sprite toggles below.
    gctx.imageSmoothingEnabled = true;
    gctx.imageSmoothingQuality = 'medium';

    // Draw game content. In play, draw runtime instances; otherwise center object previews.
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    let visibleEntries;
    if (isPlaying) {
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
        // Don't show object previews when not playing
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
            if (isPlaying && entry.inst && runtimePositions[entry.inst.instanceId] && typeof runtimePositions[entry.inst.instanceId].scale === 'number') {
                scale = Math.max(0, runtimePositions[entry.inst.instanceId].scale || 1);
            }
            const dw = img.width * scale;
            const dh = img.height * scale;
            let drawX, drawY;
            if (isPlaying && entry.inst && runtimePositions[entry.inst.instanceId]) {
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
            // Apply rotation if in play mode
            const alpha = (isPlaying && entry.inst && typeof runtimePositions[entry.inst.instanceId]?.alpha === 'number') ? Math.max(0, Math.min(1, runtimePositions[entry.inst.instanceId].alpha)) : 1;
            if (isPlaying && entry.inst && runtimePositions[entry.inst.instanceId] && typeof runtimePositions[entry.inst.instanceId].rot === 'number') {
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
        // Update the selected object's icon in the grid immediately
        const obj = objects.find(o => o.id == selected_object);
        if (obj && obj.media && obj.media.length > 0) {
            const dataUrl = existingDataUrl != null ? existingDataUrl : canvas.toDataURL('image/png');

            // Update the object's media path
            obj.media[0].path = dataUrl;

            // Update the grid icon immediately
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
        state.zoom = Math.max(0.1, Math.min(8, z));
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
        const z1 = Math.max(0.1, Math.min(8, newZoom));
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
            if (currentImageInfo) currentImageInfo.src = bust;
            // Update only the selected thumbnail image to avoid re-render loops
            const selectedThumb = document.querySelector('.image-thumbnail-item.selected img');
            if (selectedThumb) selectedThumb.src = bust;
            // Update selected and object media path
            selectedImage = bust;
            const obj = objects.find(o => o.id == selected_object);
            if (obj) {
                if (!obj.media) obj.media = [];
                if (obj.media.length === 0) obj.media.push({ id: 1, name: 'sprite', type: 'image', path: bust });
                else obj.media[0].path = bust;
            }
            // Update game window preview
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
                if (currentImageInfo) currentImageInfo.src = bust;
                const selectedThumb = document.querySelector('.image-thumbnail-item.selected img');
                if (selectedThumb) selectedThumb.src = bust;
                selectedImage = bust;
                const obj = objects.find(o => o.id == selected_object);
                if (obj) {
                    if (!obj.media) obj.media = [];
                    if (obj.media.length === 0) obj.media.push({ id: 1, name: 'sprite', type: 'image', path: bust });
                    else obj.media[0].path = bust;
                }
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
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            // Clear canvas first, then push to undo stack to avoid preserving previous content
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            pushUndo();
            const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
            const dw = Math.round(img.width * scale);
            const dh = Math.round(img.height * scale);
            const dx = Math.floor((canvas.width - dw) / 2);
            const dy = Math.floor((canvas.height - dh) / 2);
            ctx.drawImage(img, dx, dy, dw, dh);
            // Crosshair is on overlay, no need to redraw
            // Do not auto-save on image load to avoid save-load loops
        };
        img.src = src;
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
        const snap = (v, max) => Math.max(0, Math.min(max - 1, Math.round(v)));
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
        const snap = (v, max) => Math.max(0, Math.min(max - 1, Math.round(v)));
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
            ctx.strokeStyle = isErase ? 'rgba(0,0,0,1)' : rgbaString();
            ctx.lineWidth = state.brushSize;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            for (let pi = 0; pi < polys.length; pi++) {
                const poly = polys[pi];
                ctx.beginPath();
                ctx.moveTo(poly[0], poly[1]);
                for (let i = 2; i < poly.length; i += 2) {
                    ctx.lineTo(poly[i], poly[i + 1]);
                }
                ctx.stroke();
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
            ctx.strokeStyle = isErase ? 'rgba(0,0,0,1)' : rgbaString();
            ctx.lineWidth = state.brushSize;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            for (let s = 0; s < segs.length; s++) {
                const [a, b, c, d] = segs[s];
                ctx.beginPath();
                ctx.moveTo(a, b);
                ctx.lineTo(c, d);
                ctx.stroke();
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
        octx.globalAlpha = 0.85;

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
        const ix = Math.max(0, Math.min(canvas.width - 1, Math.round(x)));
        const iy = Math.max(0, Math.min(canvas.height - 1, Math.round(y)));
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

    /** Map client coords to canvas bitmap using a cached getBoundingClientRect (same math as canvasToLocalFromClientRect). */
    function canvasCoordsFromClientRect(clientX, clientY, rect) {
        const x = (clientX - rect.left) / (rect.width || 1) * canvas.width;
        const y = (clientY - rect.top) / (rect.height || 1) * canvas.height;
        return {
            x: Math.max(0, Math.min(canvas.width, x)),
            y: Math.max(0, Math.min(canvas.height, y)),
        };
    }

    /** Map pointer to canvas bitmap coords (zoom is CSS width/height + translate, no transform scale). */
    function canvasToLocalFromClientRect(evt) {
        const rect = canvas.getBoundingClientRect();
        return canvasCoordsFromClientRect(evt.clientX, evt.clientY, rect);
    }

    function canvasToLocal(evt) {
        const ow = canvas.offsetWidth || canvas.width;
        const oh = canvas.offsetHeight || canvas.height;
        const onCanvas = evt.target === canvas;
        if (onCanvas && Number.isFinite(evt.offsetX) && Number.isFinite(evt.offsetY)) {
            const x = (evt.offsetX / ow) * canvas.width;
            const y = (evt.offsetY / oh) * canvas.height;
            return {
                x: Math.max(0, Math.min(canvas.width, x)),
                y: Math.max(0, Math.min(canvas.height, y)),
            };
        }
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
    }
    function redo() {
        if (state.redoStack.length === 0) return;
        const current = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const next = state.redoStack.pop();
        state.undoStack.push(current);
        restore(next);
    }

    // Zoom buttons are wired in createImagesInterface via createZoomControlStrip (zoomImage / resetZoom → setZoom)

    // Public API
    const api = {
        setTool, getTool, setColor, setBrushSize, setFill, getFill, toggleFill, setSymmetry, setZoom, clear, loadImage, undo, redo, drawCrosshair,
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