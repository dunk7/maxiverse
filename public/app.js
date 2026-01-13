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
let rrInstanceStartIndex = 0;           // round-robin start index for fairness
// Default delay between loop iterations (approx 60 FPS)
const LOOP_FRAME_WAIT_MS = 1000 / 60;
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
document.addEventListener('keydown', (e) => { const k = normalizeKeyName(e.key); runtimeKeys[k] = true; });
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
                    const dx = Number(resolveInput(block, 'input_a') ?? block.val_a ?? 0);
                    const dy = Number(resolveInput(block, 'input_b') ?? block.val_b ?? 0);
                    if (!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId] = { x: 0, y: 0 };
                    runtimePositions[inst.instanceId].x += dx;
                    runtimePositions[inst.instanceId].y += dy;
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
                    // Default 60fps pacing for loop iterations
                    exec.waitMs = LOOP_FRAME_WAIT_MS;
                    exec.waitingBlockId = block.id;
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
                    // Default 60fps pacing for loop iterations
                    exec.waitMs = LOOP_FRAME_WAIT_MS;
                    exec.waitingBlockId = block.id;
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

        // If we reached end of a chain, check repeat stack
        if (exec.pc == null && exec.repeatStack.length > 0) {
            const frame = exec.repeatStack[exec.repeatStack.length - 1];
            frame.timesRemaining -= 1;
            if (frame.timesRemaining > 0) {
                // Repeat body again
                const repeatBlock = codeMap ? codeMap[frame.repeatBlockId] : code.find(b => b && b.id === frame.repeatBlockId);
                exec.pc = repeatBlock && (typeof repeatBlock.next_block_a === 'number') ? repeatBlock.next_block_a : null;
                // Add default frame delay between loop iterations
                exec.waitMs = LOOP_FRAME_WAIT_MS;
                exec.waitingBlockId = repeatBlock ? repeatBlock.id : null;
            } else {
                // Done repeating. Continue after repeat
                exec.repeatStack.pop();
                exec.pc = frame.afterId != null ? frame.afterId : null;
            }
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
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;';
        const panel = document.createElement('div');
        panel.style.cssText = 'background:#2a2a2a;border:1px solid #444;border-radius:8px;padding:16px;min-width:320px;color:#eee;';
        const title = document.createElement('div');
        title.textContent = titleText;
        title.style.cssText = 'font-weight:700;margin-bottom:8px;';
        const nameLabel = document.createElement('div');
        nameLabel.textContent = 'Name';
        nameLabel.style.cssText = 'font-size:12px;color:#bbb;margin-bottom:4px;';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'score';
        nameInput.style.cssText = 'width:100%;padding:8px;border-radius:6px;border:1px solid #555;background:#1e1e1e;color:#eee;';
        const scopeRow = document.createElement('label');
        scopeRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px;';
        const scopeCb = document.createElement('input');
        scopeCb.type = 'checkbox';
        const scopeText = document.createElement('span');
        scopeText.textContent = 'For this instance only';
        scopeRow.appendChild(scopeCb); scopeRow.appendChild(scopeText);
        if (hideInstanceToggle) scopeRow.style.display = 'none';
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'padding:6px 10px;border:1px solid #555;background:#333;color:#eee;border-radius:6px;';
        const createBtn = document.createElement('button');
        createBtn.textContent = 'Create';
        createBtn.style.cssText = 'padding:6px 10px;border:1px solid #0aa;background:#00ffcc;color:#1a1a1a;border-radius:6px;';
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
    addItem('Move By (dx, dy)', 'move_xy');
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
    addItem('Create Instance', 'instantiate');
    addItem('Delete Instance', 'delete_instance');
    // Debug
    addItem('Print', 'print');
    console.log('Menu items added, menu children:', menu.children.length);
    // Position: append within block so CSS absolute positioning can anchor it
    if (customPosition) {
        // For drag-opened: show near mouse using fixed positioning, without changing size
        const nodeWindow = document.getElementById('node-window');
        const nodeRect = nodeWindow.getBoundingClientRect();
        const absoluteX = nodeRect.left + (customPosition.x - (nodeWindow.scrollLeft || 0));
        const absoluteY = nodeRect.top + (customPosition.y - (nodeWindow.scrollTop || 0));

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
        const nodeWindow = document.getElementById('node-window');
        const nodeRect = nodeWindow.getBoundingClientRect();
        const absoluteX = nodeRect.left + (customPosition.x - (nodeWindow.scrollLeft || 0));
        const absoluteY = nodeRect.top + (customPosition.y - (nodeWindow.scrollTop || 0));

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
    // customPosition is already in node-window content coordinates when provided

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
        position: customPosition ? { x: customPosition.x, y: customPosition.y } : { x: basePosition.x, y: basePosition.y + 60 }
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
    if (customPosition) {
        // Create a temporary block to get its dimensions
        const tempBlock = createNodeBlock(newBlock, 0, 0);
        tempBlock.style.visibility = 'hidden';
        tempBlock.style.position = 'absolute';
        document.body.appendChild(tempBlock);

        const blockWidth = tempBlock.offsetWidth;
        const blockHeight = tempBlock.offsetHeight;

        // Center the block on the mouse position
        newBlock.position.x = customPosition.x - (blockWidth / 2);
        newBlock.position.y = customPosition.y - (blockHeight / 2);

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
    // customPosition is already in node-window content coordinates when provided

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
        position: customPosition ? { x: customPosition.x, y: customPosition.y } : { x: basePosition.x, y: basePosition.y - 60 }
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
    if (customPosition) {
        // Create a temporary block to get its dimensions
        const tempBlock = createNodeBlock(newBlock, 0, 0);
        tempBlock.style.visibility = 'hidden';
        tempBlock.style.position = 'absolute';
        document.body.appendChild(tempBlock);

        const blockWidth = tempBlock.offsetWidth;
        const blockHeight = tempBlock.offsetHeight;

        // Center the block on the mouse position
        newBlock.position.x = customPosition.x - (blockWidth / 2);
        newBlock.position.y = customPosition.y - (blockHeight / 2);

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

    const newX = blockStartX + dx;
    const newY = blockStartY + dy;

    draggedBlock.style.left = `${newX}px`;
    draggedBlock.style.top = `${newY}px`;
    autoScrollIfNearEdge(e.clientX, e.clientY);
    drawConnections();
}

function handleMouseUp(e) {
    if (!isDragging || !draggedBlock) return;

    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    const finalX = blockStartX + dx;
    const finalY = blockStartY + dy;

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

    const newX = blockStartX + dx;
    const newY = blockStartY + dy;

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
        finalX = blockStartX + dx;
        finalY = blockStartY + dy;
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

// Canvas for drawing connections
const connectionCanvas = document.createElement("canvas");
connectionCanvas.style.position = "sticky";
connectionCanvas.style.top = "0";
connectionCanvas.style.left = "0";
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

function autoScrollIfNearEdge(clientX, clientY) {
    const nodeWindow = document.getElementById('node-window');
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
    let spacer = nodeWindow.querySelector('#node-spacer');
    if (!spacer) {
        spacer = document.createElement('div');
        spacer.id = 'node-spacer';
        spacer.style.position = 'relative';
        spacer.style.pointerEvents = 'none';
        spacer.style.border = 'none';
        nodeWindow.appendChild(spacer);
    }
    const nodeRect = nodeWindow.getBoundingClientRect();
    let maxRight = nodeRect.width;
    let maxBottom = nodeRect.height;
    const blocks = nodeWindow.querySelectorAll('.node-block');
    blocks.forEach(el => {
        const br = el.getBoundingClientRect();
        const right = br.right - nodeRect.left;
        const bottom = br.bottom - nodeRect.top;
        if (right > maxRight) maxRight = right;
        if (bottom > maxBottom) maxBottom = bottom;
    });
    const w = Math.max(BASE_SPACER_SIZE_PX, Math.ceil(maxRight + EXTRA_SPACER_PADDING_PX));
    const h = Math.max(BASE_SPACER_SIZE_PX, Math.ceil(maxBottom + EXTRA_SPACER_PADDING_PX));
    spacer.style.width = w + 'px';
    spacer.style.height = h + 'px';
}

function ensureScrollableWorkspace() {
    const nodeWindow = document.getElementById('node-window');
    if (!nodeWindow || activeTab !== 'code') return;
    // Enable both-axis scrolling and layering
    nodeWindow.style.overflow = 'auto';
    if (!nodeWindow.style.position) nodeWindow.style.position = 'relative';
    // Subtle grid background for polish
    nodeWindow.style.backgroundImage = `
        linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px)`;
    nodeWindow.style.backgroundSize = '24px 24px';
    nodeWindow.style.backgroundColor = nodeWindow.style.backgroundColor || '#1e1e1e';

    // Ensure spacer exists and is sized after layout
    requestAnimationFrame(updateSpacerFromBlocks);

    if (!nodeWindowListenersAttached) {
        nodeWindow.addEventListener('scroll', () => {
            drawConnections();
        });
        window.addEventListener('resize', () => {
            drawConnections();
            requestAnimationFrame(updateSpacerFromBlocks);
        });
        nodeWindowListenersAttached = true;
    }
}

// Zoom state for code viewport
// Zoom disabled

// Drag-to-connect state
let isConnecting = false;
let connectFromBlockId = null;
let connectMouse = { x: 0, y: 0 };
let connectFromInput = null; // { blockId, which }
let connectFromNext = null; // { blockId, which }
let lastConnectEndedAt = 0;
let connectStartTime = 0;

// Convert content-space point to viewport-space (node-window visible area)
function contentToViewport(nodeWindow, point) {
    const sl = nodeWindow ? (nodeWindow.scrollLeft || 0) : 0;
    const st = nodeWindow ? (nodeWindow.scrollTop || 0) : 0;
    return { x: point.x - sl, y: point.y - st };
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
    const container = document.getElementById('node-window');
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
            const container = document.getElementById('node-window');
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

// Resize canvas to match node window
function resizeConnectionCanvas() {
    const viewport = document.getElementById('code-viewport') || document.getElementById('node-window');
    const r = viewport.getBoundingClientRect();
    connectionCanvas.width = Math.max(1, Math.floor(r.width));
    connectionCanvas.height = Math.max(1, Math.floor(r.height));
}
// Draw connections between blocks
function drawConnections() {
    // Base off the unscaled node window to keep lines crisp
    const nodeWindow = document.getElementById('node-window');
    const vr = nodeWindow.getBoundingClientRect();
    // Keep the overlay canvas sized to the visible viewport for crisp lines
    connectionCanvas.width = Math.max(1, Math.floor(vr.width));
    connectionCanvas.height = Math.max(1, Math.floor(vr.height));
    connectionCanvas.style.width = vr.width + 'px';
    connectionCanvas.style.height = vr.height + 'px';
    connectionCtx.setTransform(1, 0, 0, 1, 0, 0);
    connectionCtx.clearRect(0, 0, connectionCanvas.width, connectionCanvas.height);
    
    const selectedObj = objects.find(obj => obj.id == selected_object);
    if (!selectedObj) return;

    selectedObj.code.forEach(code => {
        const startBlock = nodeWindow.querySelector(`.node-block[data-code-id="${code.id}"]`);
        if (!startBlock) return;
        const startRect = startBlock.getBoundingClientRect();
        const nodeWindowRect = vr;
        const containerEl0 = document.getElementById('node-window');
        const plusA = startBlock.querySelector('.node-plus-btn-a');
        const plusB = startBlock.querySelector('.node-plus-btn-b');
        const startX_A = plusA ? (plusA.getBoundingClientRect().left - nodeWindowRect.left + plusA.offsetWidth / 2) : (startRect.left - nodeWindowRect.left + startRect.width * 0.45);
        const startX_B = plusB ? (plusB.getBoundingClientRect().left - nodeWindowRect.left + plusB.offsetWidth / 2) : (startRect.left - nodeWindowRect.left + startRect.width * 0.55);
        const startY_A = plusA ? (plusA.getBoundingClientRect().bottom - nodeWindowRect.top) : (startRect.bottom - nodeWindowRect.top);
        const startY_B = plusB ? (plusB.getBoundingClientRect().bottom - nodeWindowRect.top) : (startRect.bottom - nodeWindowRect.top);

        const drawArrow = (targetId, color, useB) => {
            if (targetId === null || typeof targetId === 'undefined') return;
            const endBlock = nodeWindow.querySelector(`.node-block[data-code-id="${targetId}"]`);
            if (!endBlock) return;
            const endRect = endBlock.getBoundingClientRect();
            // Aim to the block's top anchor circle (aligned with ::before)
            const endX = endRect.left - nodeWindowRect.left + 18 + 5; // left + offset + radius
            const endY = endRect.top - nodeWindowRect.top - 1; // just above top edge
            connectionCtx.beginPath();
            const pStart = { x: (useB ? startX_B : startX_A), y: (useB ? startY_B : startY_A) };
            const pEnd = { x: endX, y: endY };
            // These are already in node-window viewport space
            connectionCtx.moveTo(pStart.x, pStart.y);
            connectionCtx.lineTo(pEnd.x, pEnd.y);
            connectionCtx.strokeStyle = color;
            connectionCtx.lineWidth = 2;
            connectionCtx.stroke();
        };

        drawArrow(code.next_block_a, "#4da3ff", false); // blue-ish for A
        drawArrow(code.next_block_b, "#ffb84d", true); // orange-ish for B

        // Input connections (from top input plus buttons to value blocks)
        const inputPlusA = startBlock.querySelector('.node-input-plus-btn-a');
        const inputPlusB = startBlock.querySelector('.node-input-plus-btn-b');
        const getInputStart = (btnEl) => {
            if (!btnEl) return null;
            const r = btnEl.getBoundingClientRect();
            // Project to viewport space of node-window (canvas coords)
            const containerEl = document.getElementById('node-window');
            const containerRect = containerEl.getBoundingClientRect();
            return {
                x: (r.left - containerRect.left) + r.width / 2,
                y: (r.top - containerRect.top)
            };
        };
        const drawInputArrow = (targetId, btnEl, color) => {
            if (targetId === null || typeof targetId === 'undefined' || !btnEl) return;
            const endBlock = nodeWindow.querySelector(`.node-block[data-code-id="${targetId}"]`);
            if (!endBlock) return;
            const outAnchor = endBlock.querySelector('.node-output-anchor');
            const outRect = outAnchor ? outAnchor.getBoundingClientRect() : endBlock.getBoundingClientRect();
            const start = getInputStart(btnEl);
            if (!start) return;
            // Start at consumer's input plus (top), end at provider's bottom-center output anchor
            const containerEl2 = document.getElementById('node-window');
            const containerRect2 = containerEl2.getBoundingClientRect();
            const endX = (outRect.left - containerRect2.left) + outRect.width / 2;
            const endY = (outRect.top - containerRect2.top) + outRect.height / 2;
            connectionCtx.beginPath();
            connectionCtx.moveTo(start.x, start.y);
            connectionCtx.lineTo(endX, endY);
            connectionCtx.strokeStyle = color;
            connectionCtx.lineWidth = 2;
            connectionCtx.stroke();
        };

        // While connecting, draw a provisional line
        if (isConnecting && connectFromBlockId != null) {
            const fromBlock = nodeWindow.querySelector(`.node-block[data-code-id="${connectFromBlockId}"]`);
            if (fromBlock) {
                const anchor = fromBlock.querySelector('.node-output-anchor');
                if (anchor) {
                    const ar = anchor.getBoundingClientRect();
                    const containerEl3 = document.getElementById('node-window');
                    const containerRect3 = containerEl3.getBoundingClientRect();
                    const sx = (ar.left - containerRect3.left) + ar.width / 2;
                    const sy = (ar.top - containerRect3.top) + ar.height / 2;
                    connectionCtx.beginPath();
                    connectionCtx.moveTo(sx, sy);
                    const p2 = contentToViewport(containerEl3, connectMouse);
                    connectionCtx.lineTo(p2.x, p2.y);
                    connectionCtx.strokeStyle = '#66ff99';
                    connectionCtx.lineWidth = 2;
                    connectionCtx.setLineDash([6, 4]);
                    connectionCtx.stroke();
                    connectionCtx.setLineDash([]);
                }
            }
        }

        // While connecting from input, draw preview from input-plus to mouse
        if (isConnecting && connectFromInput) {
            const startBlock = nodeWindow.querySelector(`.node-block[data-code-id="${connectFromInput.blockId}"]`);
            if (startBlock) {
                const btnEl = startBlock.querySelector(connectFromInput.which === 'b' ? '.node-input-plus-btn-b' : '.node-input-plus-btn-a');
                if (btnEl) {
                    const start = getInputStart(btnEl);
                    if (start) {
                        connectionCtx.beginPath();
                        connectionCtx.moveTo(start.x, start.y);
                        // connectMouse is in content coordinates; convert to viewport for drawing
                        const containerElPreview = document.getElementById('node-window');
                        const p = contentToViewport(containerElPreview, connectMouse);
                        connectionCtx.lineTo(p.x, p.y);
                        connectionCtx.strokeStyle = '#66ff99';
                        connectionCtx.lineWidth = 2;
                        connectionCtx.setLineDash([6, 4]);
                        connectionCtx.stroke();
                        connectionCtx.setLineDash([]);
                    }
                }
            }
        }

        // While connecting from next (A/B), draw preview from bottom plus to mouse
        if (isConnecting && connectFromNext) {
            const startBlockEl = nodeWindow.querySelector(`.node-block[data-code-id="${connectFromNext.blockId}"]`);
            if (startBlockEl) {
                const btnEl = startBlockEl.querySelector(connectFromNext.which === 'b' ? '.node-plus-btn-b' : '.node-plus-btn-a');
                const r = btnEl && btnEl.getBoundingClientRect();
                if (r) {
                    const containerEl4 = document.getElementById('node-window');
                    const containerRect4 = containerEl4.getBoundingClientRect();
                    const sx = (r.left - containerRect4.left) + r.width / 2;
                    const sy = (r.bottom - containerRect4.top);
                    connectionCtx.beginPath();
                    connectionCtx.moveTo(sx, sy);
                    // connectMouse is in content space; convert to viewport for drawing
                    const p = contentToViewport(containerEl4, connectMouse);
                    connectionCtx.lineTo(p.x, p.y);
                    connectionCtx.strokeStyle = '#4da3ff';
                    connectionCtx.lineWidth = 2;
                    connectionCtx.setLineDash([6, 4]);
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
    const thumbnailsContainer = document.querySelector('.images-left-panel > div');
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
// Update workspace with node blocks or images interface
function updateWorkspace() {
    const nodeWindow = document.getElementById('node-window');

    // Preserve scroll position across re-render
    const prevScrollLeft = nodeWindow ? nodeWindow.scrollLeft : 0;
    const prevScrollTop = nodeWindow ? nodeWindow.scrollTop : 0;

    // Clear existing content
    nodeWindow.innerHTML = '';

    // Only show code blocks and connections if code tab is active
    if (activeTab === 'code') {
        // Overlay connection canvas on node window
        nodeWindow.appendChild(connectionCanvas);

        const selectedObj = objects.find(obj => obj.id == selected_object);
        if (!selectedObj) return;

        selectedObj.code.forEach(codeData => {
            const block = createNodeBlock(
                codeData,
                codeData.position.x,
                codeData.position.y
            );
            nodeWindow.appendChild(block);
        });

        ensureScrollableWorkspace();
        updateSpacerFromBlocks();
        // Restore scroll after layout so it doesn't jump to top
        requestAnimationFrame(() => {
            try {
                nodeWindow.scrollLeft = prevScrollLeft;
                nodeWindow.scrollTop = prevScrollTop;
            } catch(_) {}
            // One more frame to ensure spacer and layout have settled
            requestAnimationFrame(() => {
                try {
                    nodeWindow.scrollLeft = prevScrollLeft;
                    nodeWindow.scrollTop = prevScrollTop;
                } catch(_) {}
                drawConnections();
            });
        });
        // Zoom disabled for now
    } else if (activeTab === 'images') {
        // Create images tab interface
        createImagesInterface(nodeWindow);
        // Draw crosshair when switching to images tab
        if (imageEditor) {
            setTimeout(() => imageEditor.drawCrosshair && imageEditor.drawCrosshair(), 100);
        }
    } else {
        // Show a message for non-code tabs (no canvas, no connections)
        const message = document.createElement('div');
        message.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: #ccc;
            font-size: 18px;
            text-align: center;
            pointer-events: none;
            z-index: 1;
        `;
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
    editingPanel.style.cssText = `
        height: 60px;
        display: flex;
        align-items: center;
    `;

    // Drawing tools toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'images-toolbar';

    function setIcon(el, iconNameOrNames, fallbackText) {
        const names = Array.isArray(iconNameOrNames) ? iconNameOrNames : [iconNameOrNames];
        // Prefer programmatic SVG rendering when available (gives us a reliable fallback).
        const lucide = window.lucide;
        if (lucide && lucide.icons) {
            const found = names.find(n => lucide.icons && lucide.icons[n]);
            const iconDef = found ? lucide.icons[found] : null;
            if (iconDef && typeof iconDef.toSvg === 'function') {
                el.innerHTML = iconDef.toSvg({ width: 18, height: 18 });
                return;
            }
        }
        // Fallback to createIcons() + data-lucide if that's all we have.
        if (lucide && typeof lucide.createIcons === 'function') {
            const primary = names[0];
            el.innerHTML = `<i data-lucide="${primary}"></i>`;
            return;
        }
        el.textContent = fallbackText || '';
    }

    function refreshLucideIcons() {
        try { window.lucide && window.lucide.createIcons && window.lucide.createIcons(); } catch (_) {}
    }

    const toolNames = [
        { id: 'brush', icon: ['brush', 'paintbrush'], fallback: 'B', title: 'Brush' },
        { id: 'rect', icon: ['square', 'square-dashed'], fallback: '▭', title: 'Rectangle' },
        { id: 'circle', icon: ['circle'], fallback: '◯', title: 'Circle' },
        { id: 'bucket', icon: ['paint-bucket', 'bucket'], fallback: 'F', title: 'Fill (Bucket)' },
        { id: 'select', icon: ['lasso-select', 'lasso', 'selection'], fallback: 'S', title: 'Select' },
    ];
    const toolButtons = {};
    toolNames.forEach(t => {
        const btn = document.createElement('button');
        setIcon(btn, t.icon, t.fallback);
        btn.className = 'image-edit-tool';
        btn.dataset.tool = t.id;
        btn.title = t.title;
        btn.addEventListener('click', () => {
            if (imageEditor) imageEditor.setTool(t.id);
            Object.values(toolButtons).forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
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

    // Color picker + Transparency toggle
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = '#ff0000';
    colorInput.title = 'Color';
    colorInput.className = 'image-color';
    colorInput.style.width = '36px';
    colorInput.style.height = '36px';
    colorInput.style.borderRadius = '6px';
    colorInput.style.padding = '0';
    const transparencyToggle = document.createElement('label');
    transparencyToggle.className = 'image-toggle';
    transparencyToggle.title = 'Transparency: Off';
    const transparencyCheckbox = document.createElement('input');
    transparencyCheckbox.type = 'checkbox';
    transparencyCheckbox.checked = false;
    transparencyCheckbox.className = 'image-toggle-input';
    const transparencySwitch = document.createElement('span');
    transparencySwitch.className = 'image-toggle-switch';
    const transparencyText = document.createElement('span');
    transparencyText.className = 'image-toggle-label';
    transparencyText.textContent = 'Transparent';
    transparencyToggle.appendChild(transparencyCheckbox);
    transparencyToggle.appendChild(transparencySwitch);
    transparencyToggle.appendChild(transparencyText);

    // Brush size
    const sizeLabel = document.createElement('div');
    sizeLabel.textContent = 'Size';
    sizeLabel.className = 'image-control-label';
    const sizeInput = document.createElement('input');
    sizeInput.type = 'range';
    sizeInput.min = '1';
    sizeInput.max = '100';
    sizeInput.value = '16';
    sizeInput.title = 'Brush Size';
    sizeInput.className = 'image-range image-range-size';
    const sizeValue = document.createElement('div');
    sizeValue.className = 'image-value-pill';
    sizeValue.textContent = sizeInput.value;
    const sizeMinusBtn = document.createElement('button');
    sizeMinusBtn.className = 'image-step-btn';
    sizeMinusBtn.type = 'button';
    setIcon(sizeMinusBtn, ['minus', 'minus-circle'], '−');
    sizeMinusBtn.title = 'Smaller brush';
    const sizePlusBtn = document.createElement('button');
    sizePlusBtn.className = 'image-step-btn';
    sizePlusBtn.type = 'button';
    setIcon(sizePlusBtn, ['plus', 'plus-circle'], '+');
    sizePlusBtn.title = 'Larger brush';

    function getBrushSizeFromUI() {
        const n = parseInt(sizeInput.value, 10);
        return Number.isFinite(n) ? Math.max(1, Math.min(100, n)) : 16;
    }
    function setBrushSizeUI(next) {
        const clamped = Math.max(1, Math.min(100, next | 0));
        sizeInput.value = String(clamped);
        sizeValue.textContent = String(clamped);
        if (imageEditor) imageEditor.setBrushSize(clamped);
    }
    sizeInput.addEventListener('input', () => setBrushSizeUI(getBrushSizeFromUI()));
    sizeMinusBtn.addEventListener('click', () => setBrushSizeUI(getBrushSizeFromUI() - (window.event && window.event.shiftKey ? 10 : 1)));
    sizePlusBtn.addEventListener('click', () => setBrushSizeUI(getBrushSizeFromUI() + (window.event && window.event.shiftKey ? 10 : 1)));

    // Fill toggle for shapes
    const fillLabel = document.createElement('label');
    fillLabel.className = 'image-toggle';
    const fillCheckbox = document.createElement('input');
    fillCheckbox.type = 'checkbox';
    fillCheckbox.checked = true;
    fillCheckbox.className = 'image-toggle-input';
    fillCheckbox.title = 'Fill shapes';
    const fillSwitch = document.createElement('span');
    fillSwitch.className = 'image-toggle-switch';
    const fillText = document.createElement('span');
    fillText.textContent = 'Fill';
    fillText.className = 'image-toggle-label';
    fillLabel.appendChild(fillCheckbox);
    fillLabel.appendChild(fillSwitch);
    fillLabel.appendChild(fillText);
    fillCheckbox.addEventListener('change', () => imageEditor && imageEditor.setFill(fillCheckbox.checked));

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

    // Wire color + transparency toggle (acts like "transparent paint"/eraser mode)
    function currentAlpha() { return transparencyCheckbox.checked ? 0 : 1; }
    function applyColorFromUI() {
        if (!imageEditor) return;
        imageEditor.setColor(colorInput.value, currentAlpha());
    }
    colorInput.addEventListener('input', applyColorFromUI);
    transparencyCheckbox.addEventListener('change', () => {
        transparencyToggle.title = transparencyCheckbox.checked ? 'Transparency: On (draw transparent)' : 'Transparency: Off';
        transparencyToggle.classList.toggle('active', transparencyCheckbox.checked);
        applyColorFromUI();
    });

    const colorWrap = document.createElement('div');
    colorWrap.className = 'image-color-wrap';
    const colorIcon = document.createElement('span');
    colorIcon.className = 'image-color-icon';
    setIcon(colorIcon, ['palette', 'droplet'], '');
    colorWrap.title = 'Color';
    colorWrap.appendChild(colorIcon);
    colorWrap.appendChild(colorInput);
    toolbar.appendChild(colorWrap);
    toolbar.appendChild(transparencyToggle);

    const sizeGroup = document.createElement('div');
    sizeGroup.className = 'image-control-group';
    const sizeRow = document.createElement('div');
    sizeRow.className = 'image-control-row';
    sizeRow.appendChild(sizeMinusBtn);
    sizeRow.appendChild(sizeInput);
    sizeRow.appendChild(sizePlusBtn);
    sizeRow.appendChild(sizeValue);
    sizeGroup.appendChild(sizeLabel); sizeGroup.appendChild(sizeRow);
    toolbar.appendChild(sizeGroup);
    toolbar.appendChild(fillLabel);
    toolbar.appendChild(undoBtn);
    toolbar.appendChild(redoBtn);
    toolbar.appendChild(clearBtn);
    editingPanel.appendChild(toolbar);

    // Create main content area (split view)
    const contentArea = document.createElement('div');
    contentArea.className = 'images-content';
    contentArea.style.cssText = `
        flex: 1;
        display: flex;
        overflow: hidden;
    `;

    // Left scroll view for image thumbnails
    const leftPanel = document.createElement('div');
    leftPanel.className = 'images-left-panel';
    leftPanel.style.cssText = `
        width: 140px;
        background: #222;
        border-right: 1px solid #444;
        overflow-y: hidden;
        overflow-x: hidden;
        padding: 10px;
        display: flex;
        flex-direction: column;
        position: relative;
    `;

    // Create thumbnails container
    const thumbnailsContainer = document.createElement('div');
    thumbnailsContainer.style.cssText = `
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        padding-bottom: 48px;
        margin-right: 0;
        padding-right: 0;
        width: 100%;
        box-sizing: border-box;
    `;

    // Load and display images from ./images/0/
    loadImagesFromDirectory(thumbnailsContainer);

    // Add action buttons row at bottom (Add + Upload)
    const actionsRow = document.createElement('div');
    actionsRow.style.cssText = `
        display: flex;
        gap: 8px;
        position: absolute;
        left: 10px;
        right: 10px;
        bottom: 10px;
    `;

    const addBtn = document.createElement('button');
    addBtn.className = 'add-image-btn';
    setIcon(addBtn, 'plus', '+');
    addBtn.style.cssText = `
        flex: 1 1 0;
        height: 32px;
        background: #00ffcc;
        border: none;
        color: #1a1a1a;
        border-radius: 6px;
        cursor: pointer;
        font-size: 18px;
        font-weight: bold;
        transition: background 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
    `;
    addBtn.title = 'Add new image';
    addBtn.addEventListener('mouseover', () => addBtn.style.background = '#00cccc');
    addBtn.addEventListener('mouseout', () => addBtn.style.background = '#00ffcc');
    addBtn.addEventListener('click', () => createNewImage());

    const uploadBtn = document.createElement('button');
    uploadBtn.className = 'add-image-btn';
    setIcon(uploadBtn, 'upload', 'Upload');
    uploadBtn.style.cssText = `
        flex: 1 1 0;
        height: 32px;
        background: #00ffcc;
        border: none;
        color: #1a1a1a;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 600;
        transition: background 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
    `;
    uploadBtn.title = 'Upload image file';
    uploadBtn.addEventListener('mouseover', () => uploadBtn.style.background = '#00cccc');
    uploadBtn.addEventListener('mouseout', () => uploadBtn.style.background = '#00ffcc');
    uploadBtn.addEventListener('click', () => triggerUploadImage());

    actionsRow.appendChild(addBtn);
    actionsRow.appendChild(uploadBtn);

    leftPanel.appendChild(thumbnailsContainer);
    leftPanel.appendChild(actionsRow);

    // Right preview area
    const rightPanel = document.createElement('div');
    rightPanel.className = 'images-right-panel';
    rightPanel.style.cssText = `
        flex: 1;
        background: #1a1a1a;
        display: flex;
        flex-direction: column;
        position: relative;
    `;

    // Image preview container
    const previewContainer = document.createElement('div');
    previewContainer.className = 'image-preview-container';
    previewContainer.style.cssText = `
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        position: relative;
    `;

    // Zoom controls (bottom right)
    const zoomControls = document.createElement('div');
    zoomControls.className = 'zoom-controls';
    zoomControls.style.cssText = `
        position: absolute;
        bottom: 20px;
        right: 20px;
        display: flex;
        gap: 10px;
        z-index: 10;
    `;

    const zoomInBtn = document.createElement('button');
    setIcon(zoomInBtn, ['zoom-in', 'search-plus', 'plus'], '+');
    zoomInBtn.className = 'zoom-btn';
    zoomInBtn.title = 'Zoom In';
    zoomInBtn.style.cssText = `
        width: 40px;
        height: 40px;
        background: #333;
        border: 1px solid #555;
        color: #fff;
        border-radius: 50%;
        cursor: pointer;
        font-size: 18px;
        font-weight: bold;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
    `;

    const zoomOutBtn = document.createElement('button');
    setIcon(zoomOutBtn, ['zoom-out', 'search-minus', 'minus'], '−');
    zoomOutBtn.className = 'zoom-btn';
    zoomOutBtn.title = 'Zoom Out';
    zoomOutBtn.style.cssText = zoomInBtn.style.cssText;

    const zoomResetBtn = document.createElement('button');
    setIcon(zoomResetBtn, ['rotate-ccw', 'refresh-ccw', 'rotateCcw'], '=');
    zoomResetBtn.className = 'zoom-btn';
    zoomResetBtn.title = 'Reset Zoom';
    zoomResetBtn.style.cssText = zoomInBtn.style.cssText;

    zoomInBtn.addEventListener('click', () => zoomImage(1.2));
    zoomOutBtn.addEventListener('click', () => zoomImage(0.8));
    zoomResetBtn.addEventListener('click', () => resetZoom());

    zoomControls.appendChild(zoomOutBtn);
    zoomControls.appendChild(zoomResetBtn);
    zoomControls.appendChild(zoomInBtn);

    // Editor canvas wrapper with checkerboard and 720x720 canvas
    const canvasWrapper = document.createElement('div');
    canvasWrapper.style.cssText = `
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        width: 100%;
        height: 100%;
    `;
    const checker = document.createElement('div');
    checker.style.cssText = `
        position: absolute;
        width: 1000px;
        height: 1000px;
        background: repeating-conic-gradient(#999 0% 25%, #777 0% 50%) 0 / 20px 20px;
        opacity: 0.4;
        pointer-events: none;
        transform: translateZ(0);
    `;
    const editorCanvas = document.createElement('canvas');
    editorCanvas.width = 720;
    editorCanvas.height = 720;
    editorCanvas.style.cssText = `
        image-rendering: pixelated;
        box-shadow: 0 0 0 1px #000 inset;
        transform-origin: center;
        background: transparent;
    `;
    canvasWrapper.appendChild(checker);
    canvasWrapper.appendChild(editorCanvas);

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
        zoomInBtn,
        zoomOutBtn,
        zoomResetBtn,
        setDefaultUI: () => {},
    });

    // Defaults for toolbar state
    toolButtons.brush && toolButtons.brush.classList.add('active');
    applySymmetryMode('none');
    refreshLucideIcons();
    setBrushSizeUI(getBrushSizeFromUI());
    applyColorFromUI();

    // After initializing the editor, ensure an image is shown immediately
    setTimeout(() => {
        if (!imageEditor) return;
        if (imageEditor.drawCrosshair) imageEditor.drawCrosshair();
        if (selectedImage) {
            imageEditor.loadImage(selectedImage);
        } else {
            const containerEl = document.querySelector('.images-left-panel > div');
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
        imageItem.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            margin-bottom: 10px;
            padding: 6px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s;
            border: 1px solid transparent;
            user-select: none;
        `;

        const thumbnail = document.createElement('img');
        thumbnail.src = imgInfo.src;
        thumbnail.alt = imgInfo.name;
        thumbnail.style.cssText = `
            width: 100px;
            height: 100px;
            object-fit: cover;
            border-radius: 4px;
            margin-bottom: 5px;
            pointer-events: none;
        `;

        const label = document.createElement('span');
        label.textContent = imgInfo.name;
        label.className = 'image-label';
        label.style.cssText = `
            font-size: 10px;
            color: #ccc;
            text-align: center;
            word-break: break-all;
            max-width: 100px;
            line-height: 1.2;
            pointer-events: none;
        `;

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
    const container = document.querySelector('.images-left-panel > div');
    if (!container) return;

    const restored = { id: Date.now(), name: lastDeleted.filename, src: lastDeleted.src };
    const list = getCurrentObjectImages();
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

// Handle edit menu actions
function handleEditAction(action) {
    console.log('Edit action triggered:', action);

    switch(action) {
        case 'undo':
            undoLastDeletion();
            break;
        case 'cut':
            console.log('Cut action - not implemented yet');
            break;
        case 'copy':
            console.log('Copy action - not implemented yet');
            break;
        case 'paste':
            console.log('Paste action - not implemented yet');
            break;
        case 'selectAll':
            console.log('Select All action - not implemented yet');
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
    const thumbnailsContainer = document.querySelector('.images-left-panel > div');
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
                const thumbnailsContainer = document.querySelector('.images-left-panel > div');
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
    input.style.cssText = `
        font-size: 10px;
        color: #fff;
        background: #444;
        border: 1px solid #00ffcc;
        border-radius: 3px;
        text-align: center;
        width: 100px;
        outline: none;
        padding: 2px 4px;
    `;

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
    });

    // Add active class to selected tab
    const selectedTab = document.querySelector(`.${tabName}-tab`);
    if (selectedTab) {
        selectedTab.classList.add('active');
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
    input.style.cssText = `
        width: 100%;
        padding: 2px 4px;
        border: 1px solid #00ffcc;
        border-radius: 3px;
        background: #333;
        color: #fff;
        font-size: 0.9rem;
        text-align: center;
        outline: none;
    `;

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

    // Set default active tab (Code)
    switchTab('code');
}

// Initialize workspace (will be handled by tab initialization)

// Simple function to toggle the edit menu (called from HTML onclick)
function toggleEditMenu() {
    console.log('🎯 toggleEditMenu called from HTML onclick');
    const editBtn = document.querySelector('.edit-menu-btn');
    const undoMenu = document.getElementById('edit-dropdown');

    if (editBtn && undoMenu) {
        const isActive = editBtn.classList.contains('active');
        console.log('Menu currently active:', isActive);

        if (isActive) {
            editBtn.classList.remove('active');
            undoMenu.style.display = 'none';
            console.log('Menu closed');
        } else {
            editBtn.classList.add('active');
            undoMenu.style.display = 'block';
            console.log('Menu opened');
        }
    } else {
        console.log('Elements not found:', { editBtn: !!editBtn, undoMenu: !!undoMenu });
    }
}
// Initialize Edit menu dropdown
function initializeEditMenu() {
    if (window.__editMenuSetupDone) {
        return;
    }
    window.__editMenuSetupDone = true;
    console.log('=== Initializing edit menu ===');
    const editMenuContainer = document.querySelector('.edit-menu-container');
    const editBtn = document.querySelector('.edit-menu-btn');
    const undoMenu = document.getElementById('edit-dropdown');

    console.log('Elements found:', {
        container: editMenuContainer,
        button: editBtn,
        menu: undoMenu
    });

    if (editMenuContainer && editBtn && undoMenu) {
        console.log('✅ All elements found, setting up additional event listeners');

        // Initialize undo menu state
        updateUndoMenu();

        // Ensure menu starts hidden
        undoMenu.style.display = 'none';
        console.log('Menu display set to none initially');

        // Add additional event listeners for better UX
        editBtn.addEventListener('mouseenter', () => {
            console.log('🖱️ Mouse entered Edit button');
        });

        editBtn.addEventListener('mouseleave', () => {
            console.log('👋 Mouse left Edit button');
        });

        // Close menu when clicking elsewhere (attach once)
        document.addEventListener('click', function(e) {
            if (!editMenuContainer.contains(e.target)) {
                console.log('Click outside menu, closing...');
                editBtn.classList.remove('active');
                undoMenu.style.display = 'none';
            }
        });

        console.log('✅ Additional event listeners attached');

    } else {
        console.log('❌ Some elements not found, edit menu initialization failed');
        console.log('Missing elements:', {
            container: !editMenuContainer,
            button: !editBtn,
            menu: !undoMenu
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
	} else {
		fileBtn.classList.add('active');
		fileMenu.style.display = 'block';
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
						const thumbnailsContainer = document.querySelector('.images-left-panel > div');
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
	// Match editor default pacing (approx 60 FPS)
	const LOOP_FRAME_WAIT_MS = 1000 / 60;
	// Match editor fairness/time budget
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
	    while (exec.pc!=null && steps++<maxStepsPerObject){
	      const block = code.find(b=>b&&b.id===exec.pc); if(!block){ exec.pc=null; break; }
	      const coerceScalarLiteral=(v)=>{ if(typeof v==='number') return v; if(typeof v==='string'){ const s=v.trim(); if(s==='') return ''; const n=Number(s); return Number.isFinite(n)?n:v; } return v; };
	      const getArrayRef=(varName,instanceOnly)=>{ const name=varName||''; const store=instanceOnly ? (runtimeVariables[inst.instanceId] || (runtimeVariables[inst.instanceId]={})) : runtimeGlobalVariables; let arr=store[name]; if(!Array.isArray(arr)){ arr=[]; store[name]=arr; } return arr; };
	      const resolveInput=(blockRef,key)=>{ const inputId=blockRef[key]; if(inputId==null) return null; const node=code.find(b=>b&&b.id===inputId); if(!node) return null; if(node.content==='mouse_x') return runtimeMouse.x; if(node.content==='mouse_y') return runtimeMouse.y; if(node.content==='window_width'){ const c=document.getElementById('game'); return c? c.width : window.innerWidth; } if(node.content==='window_height'){ const c=document.getElementById('game'); return c? c.height : window.innerHeight; } if(node.content==='object_x'){ const pos=runtimePositions[inst.instanceId]||{x:0,y:0}; return typeof pos.x==='number'?pos.x:0;} if(node.content==='object_y'){ const pos=runtimePositions[inst.instanceId]||{y:0}; return typeof pos.y==='number'?pos.y:0;} if(node.content==='rotation'){ const pos=runtimePositions[inst.instanceId]||{rot:0}; return typeof pos.rot==='number'?pos.rot:0;} if(node.content==='size'){ const pos=runtimePositions[inst.instanceId]||{scale:1}; return typeof pos.scale==='number'?pos.scale:1;} if(node.content==='mouse_pressed') return runtimeMousePressed?1:0; if(node.content==='key_pressed') return runtimeKeys[node.key_name]?1:0; if(node.content==='distance_to'){ const pos=runtimePositions[inst.instanceId]||{x:0,y:0}; const tx=Number((node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0)); const ty=Number((node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0)); const dx=(typeof pos.x==='number'?pos.x:0)-tx; const dy=(typeof pos.y==='number'?pos.y:0)-ty; return Math.hypot(dx,dy);} if(node.content==='pixel_is_rgb'){ const c=document.getElementById('game'); if(!c) return 0; const xw=Number((node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0)); const yw=Number((node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0)); const p=worldToCanvas(xw,yw,c); const px=Math.round(p.x); const py=Math.round(p.y); if(!Number.isFinite(px)||!Number.isFinite(py)) return 0; if(px<0||py<0||px>=c.width||py>=c.height) return 0; const cctx=c.getContext('2d'); if(!cctx) return 0; let data; try{ data=cctx.getImageData(px,py,1,1).data; }catch(_){ return 0; } const r=data[0], g=data[1], b=data[2]; const tr=Math.max(0, Math.min(255, Math.round(Number(node.rgb_r ?? 0) || 0))); const tg=Math.max(0, Math.min(255, Math.round(Number(node.rgb_g ?? 0) || 0))); const tb=Math.max(0, Math.min(255, Math.round(Number(node.rgb_b ?? 0) || 0))); return (r===tr && g===tg && b===tb) ? 1 : 0; } if(node.content==='random_int'){ let a=Number((node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0)); let b=Number((node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0)); if(Number.isNaN(a)) a=0; if(Number.isNaN(b)) b=0; if(a>b){ const t=a; a=b; b=t; } return Math.floor(Math.random()*(b-a+1))+a; } if(node.content==='operation'){ const xVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.op_x ?? 0):(node.op_x ?? 0); const yVal=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.op_y ?? 0):(node.op_y ?? 0); switch(node.val_a){ case '+': return xVal + yVal; case '-': return xVal - yVal; case '*': return xVal * yVal; case '/': return (yVal===0)?0:(xVal / yVal); case '^': return Math.pow(xVal, yVal); default: return xVal + yVal; } } if(node.content==='not'){ const v=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const num=Number(v)||0; return num?0:1; } if(node.content==='equals'){ const aVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const bVal=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0); const A=(aVal==null)?'':aVal; const B=(bVal==null)?'':bVal; return (A==B)?1:0; } if(node.content==='less_than'){ const aVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const bVal=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0); let A=Number(aVal); let B=Number(bVal); if(Number.isNaN(A)) A=0; if(Number.isNaN(B)) B=0; return (A<B)?1:0; } if(node.content==='and'){ const aVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const bVal=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0); const A=Number(aVal)||0; const B=Number(bVal)||0; return (A!==0 && B!==0)?1:0; } if(node.content==='or'){ const aVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const bVal=(node.input_b!=null)?(resolveInput(node,'input_b') ?? node.val_b ?? 0):(node.val_b ?? 0); const A=Number(aVal)||0; const B=Number(bVal)||0; return (A!==0 || B!==0)?1:0; } if(node.content==='variable'){ const varName=node.var_name||''; if(node.var_instance_only){ const vars=runtimeVariables[inst.instanceId] || (runtimeVariables[inst.instanceId]={}); const v=vars[varName]; return (typeof v==='number')?v:0; } else { const v=runtimeGlobalVariables[varName]; return (typeof v==='number')?v:0; } } if(node.content==='array_get'){ const arr=getArrayRef(node.var_name||'', !!node.var_instance_only); const idxVal=(node.input_a!=null)?(resolveInput(node,'input_a') ?? node.val_a ?? 0):(node.val_a ?? 0); const idx=Math.floor(Number(idxVal)); if(!Number.isFinite(idx) || idx<0 || idx>=arr.length) return ''; return arr[idx]; } if(node.content==='array_length'){ const arr=getArrayRef(node.var_name||'', !!node.var_instance_only); return arr.length; } return null; };
	      if (block.type==='action'){
	        if (block.content==='move_xy'){ const dx=Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); const dy=Number(resolveInput(block,'input_b') ?? block.val_b ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,layer:0}; runtimePositions[inst.instanceId].x += dx; runtimePositions[inst.instanceId].y += dy; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='move_forward'){ const distance=Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,rot:0}; const rotDeg=runtimePositions[inst.instanceId].rot || 0; const rotRad=(rotDeg)*Math.PI/180; runtimePositions[inst.instanceId].x += Math.sin(rotRad)*distance; runtimePositions[inst.instanceId].y += Math.cos(rotRad)*distance; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='rotate'){ if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,rot:0}; runtimePositions[inst.instanceId].rot = (runtimePositions[inst.instanceId].rot||0) + Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='set_rotation'){ if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,rot:0}; runtimePositions[inst.instanceId].rot = Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='set_size'){ const s=Number(resolveInput(block,'input_a') ?? block.val_a ?? 1); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,scale:1,layer:0}; runtimePositions[inst.instanceId].scale = Math.max(0,s); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='set_layer'){ const layer=Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,layer:0}; runtimePositions[inst.instanceId].layer = layer; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='point_towards'){ if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,rot:0}; const pos=runtimePositions[inst.instanceId]; const tx=Number((block.input_a!=null)?(resolveInput(block,'input_a') ?? block.val_a ?? 0):(block.val_a ?? 0)); const ty=Number((block.input_b!=null)?(resolveInput(block,'input_b') ?? block.val_b ?? 0):(block.val_b ?? 0)); const dx=tx-(typeof pos.x==='number'?pos.x:0); const dy=ty-(typeof pos.y==='number'?pos.y:0); const ang=90 - (Math.atan2(dy,dx)*180/Math.PI); pos.rot = ang; exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='change_size'){ const ds=Number(resolveInput(block,'input_a') ?? block.val_a ?? 0); if(!runtimePositions[inst.instanceId]) runtimePositions[inst.instanceId]={x:0,y:0,scale:1}; const cur=runtimePositions[inst.instanceId].scale||1; runtimePositions[inst.instanceId].scale=Math.max(0,cur+ds); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; }
	        if (block.content==='wait'){ const seconds=Math.max(0, parseFloat(resolveInput(block,'input_a') ?? block.val_a ?? 0)); if(seconds>0){ exec.waitMs = seconds*1000; exec.waitingBlockId = block.id; exec.pc = null; } else { exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; } break; }
	        if (block.content==='repeat'){ const times=Math.max(0, Number(block.val_a||0)); if(times<=0){ exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; continue; } exec.repeatStack.push({ repeatBlockId:block.id, timesRemaining:times, afterId:(typeof block.next_block_b==='number')?block.next_block_b:null }); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; exec.waitMs = LOOP_FRAME_WAIT_MS; exec.waitingBlockId = block.id; continue; }
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
	        if (block.content==='forever'){ exec.repeatStack.push({ repeatBlockId:block.id, timesRemaining:Infinity, afterId:(typeof block.next_block_b==='number')?block.next_block_b:null }); exec.pc=(typeof block.next_block_a==='number')?block.next_block_a:null; exec.waitMs = LOOP_FRAME_WAIT_MS; exec.waitingBlockId = block.id; continue; }
	      }
	      exec.pc = (typeof block.next_block_a==='number') ? block.next_block_a : null;
	      totalStepsThisFrame += 1;
	      if (typeof MAX_TOTAL_STEPS_PER_FRAME === 'number' && totalStepsThisFrame >= MAX_TOTAL_STEPS_PER_FRAME) break;
	      if (typeof TIME_BUDGET_MS === 'number' && (performance.now() - startTime) >= TIME_BUDGET_MS) break;
	    }
	    if (exec.pc==null && exec.repeatStack.length>0){ const frame=exec.repeatStack[exec.repeatStack.length-1]; frame.timesRemaining-=1; if(frame.timesRemaining>0){ const repeatBlock=code.find(b=>b&&b.id===frame.repeatBlockId); exec.pc = repeatBlock && (typeof repeatBlock.next_block_a==='number') ? repeatBlock.next_block_a : null; exec.waitMs = LOOP_FRAME_WAIT_MS; exec.waitingBlockId = repeatBlock ? repeatBlock.id : null; } else { exec.repeatStack.pop(); exec.pc = frame.afterId != null ? frame.afterId : null; } }
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
	document.addEventListener('keydown',(e)=>{ const k=normalizeKeyName(e.key); runtimeKeys[k]=true;});
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

// Initialize tabs after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 DOM Content Loaded - Initializing app...');
    // Seed default blank images so every object starts with image-1
    initializeDefaultImages();
    initializeTabs();
    initializeEditMenu();
    initializeFileMenu();
    setTimeout(() => refreshObjectGridIcons(), 50);
    console.log('✅ App initialization complete');
    // Wire top-bar play/stop buttons if present, else add overlay fallback
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
        const wrapper = canvas.parentElement || document.body;
        let playBtn = document.getElementById('__play_btn');
        if (!topPlay && !playBtn) {
            playBtn = document.createElement('button');
            playBtn.id = '__play_btn';
            playBtn.textContent = '▶';
            playBtn.style.position = 'absolute';
            playBtn.style.top = '12px';
            playBtn.style.right = '12px';
            playBtn.style.zIndex = '20';
            playBtn.style.padding = '8px 12px';
            playBtn.style.borderRadius = '6px';
            playBtn.style.border = '1px solid #333';
            playBtn.style.background = '#00ffcc';
            playBtn.style.color = '#1a1a1a';
            playBtn.style.cursor = 'pointer';
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
    } catch {}
});

// Fallback initialization in case DOMContentLoaded already fired
if (document.readyState === 'loading') {
    // DOM not yet loaded
} else {
    // DOM already loaded
    setTimeout(() => {
        initializeTabs();
        initializeEditMenu();
        initializeFileMenu();
    }, 10); // Small delay to ensure DOM is fully ready
}

// Update canvas size on window resize
window.addEventListener("resize", () => {
    drawConnections();
});
// Render runtime instances during play; otherwise show object previews
function renderGameWindowSprite() {
    const canvas = document.getElementById('game-window');
    const gctx = canvas.getContext('2d');
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
    const ctx = canvas.getContext('2d');
    const wrapper = params.canvasWrapper;

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
        selection: null, // { x, y, w, h, layerCanvas, offsetX, offsetY, dragging }
        zoom: 1.0,
        undoStack: [],
        redoStack: [],
    };

    function rgbaString() {
        const c = state.color;
        return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
    }

    function updateGameObjectIcon() {
        // Update the selected object's icon in the grid immediately
        const obj = objects.find(o => o.id == selected_object);
        if (obj && obj.media && obj.media.length > 0) {
            // Get the current canvas data URL
            const dataUrl = canvas.toDataURL('image/png');

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
    function setColor(hex, a) {
        const bigint = parseInt(hex.slice(1), 16);
        const r = (bigint >> 16) & 255;
        const g = (bigint >> 8) & 255;
        const b = bigint & 255;
        state.color = { r, g, b, a: isNaN(a) ? 1 : a };
    }
    function setBrushSize(s) { state.brushSize = Math.max(1, s|0); }
    function setFill(f) { state.fill = !!f; }
    function setSymmetry(mode) {
        const m = String(mode || 'none');
        state.symmetry = (m === 'x' || m === 'y' || m === 'xy') ? m : 'none';
        // Keep overlay updated (axes/crosshair)
        try { drawCrosshair(); } catch (_) {}
    }
    function setZoom(z) {
        state.zoom = Math.max(0.1, Math.min(8, z));
        canvas.style.transform = `scale(${state.zoom})`;
        const overlay = wrapper.querySelector('canvas.__overlay');
        if (overlay) {
            overlay.style.setProperty('--zoom', state.zoom);
        }
        // Crosshair is automatically scaled with overlay
    }

    async function saveToDisk(forceNewName) {
        try {
            // Crosshair is now on overlay, so main canvas is clean
            const dataUrl = canvas.toDataURL('image/png');
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
            renderGameWindowSprite();
        } catch (e) {
            // On network or 404, gracefully save locally via dataUrl (static hosting fallback)
            try {
                const dataUrl = canvas.toDataURL('image/png');
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
                renderGameWindowSprite();
                // Optional: small toast indicating local save
                try {
                    const old = document.getElementById('__img_save_err');
                    if (old) old.remove();
                    const toast = document.createElement('div');
                    toast.id = '__img_save_err';
                    toast.textContent = 'Saved locally (no server).';
                    toast.style.cssText = 'position:fixed;bottom:16px;left:16px;background:#2e7d32;color:#fff;padding:8px 12px;border-radius:6px;font-size:12px;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,0.3)';
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
        updateGameObjectIcon();
        if (!silent) saveToDisk();
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

    function applyBrushLineRaw(x0, y0, x1, y1) {
        ctx.save();
        const isErase = state.color.a <= 0.01;
        ctx.globalCompositeOperation = isErase ? 'destination-out' : 'source-over';
        ctx.strokeStyle = isErase ? 'rgba(0,0,0,1)' : rgbaString();
        ctx.lineWidth = state.brushSize;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.restore();
    }

    function applyBrushLine(x0, y0, x1, y1) {
        const segs = symmetrySegmentsForLine(x0, y0, x1, y1);
        segs.forEach(([a,b,c,d]) => applyBrushLineRaw(a,b,c,d));
        // Crosshair is on overlay, no need to redraw
        updateGameObjectIcon();
    }

    function ensureOverlay() {
        let overlay = wrapper.querySelector('canvas.__overlay');
        if (!overlay) {
            overlay = document.createElement('canvas');
            overlay.className = '__overlay';
            overlay.width = canvas.width;
            overlay.height = canvas.height;
            overlay.style.position = 'absolute';
            overlay.style.pointerEvents = 'none';
            overlay.style.top = '50%';
            overlay.style.left = '50%';
            overlay.style.setProperty('--zoom', state.zoom);
            overlay.style.transformOrigin = 'center';
            wrapper.appendChild(overlay);
        }
        return overlay;
    }

    function clearOverlay() {
        const overlay = wrapper.querySelector('canvas.__overlay');
        if (overlay) {
            overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
            // Redraw crosshair after clearing overlay
            drawCrosshair();
        }
    }

    function drawCrosshair() {
        // Draw crosshair on a separate overlay that doesn't affect main canvas
        const overlay = ensureOverlay();
        const octx = overlay.getContext('2d');

        // If a selection overlay exists, draw it first (so crosshair/axes sit on top).
        if (state.selection) drawSelectionOverlay();
        else octx.clearRect(0, 0, overlay.width, overlay.height);

        const centerX = overlay.width / 2;
        const centerY = overlay.height / 2;
        const size = 12; // Smaller size of crosshair arms

        octx.save();
        // Symmetry axes (subtle)
        if (state.symmetry === 'x' || state.symmetry === 'xy') {
            octx.strokeStyle = '#00ffcc';
            octx.lineWidth = 1;
            octx.globalAlpha = 0.22;
            octx.beginPath();
            octx.moveTo(centerX + 0.5, 0);
            octx.lineTo(centerX + 0.5, overlay.height);
            octx.stroke();
        }
        if (state.symmetry === 'y' || state.symmetry === 'xy') {
            octx.strokeStyle = '#00ffcc';
            octx.lineWidth = 1;
            octx.globalAlpha = 0.22;
            octx.beginPath();
            octx.moveTo(0, centerY + 0.5);
            octx.lineTo(overlay.width, centerY + 0.5);
            octx.stroke();
        }

        // Crosshair center marker
        octx.strokeStyle = '#ffffff';
        octx.lineWidth = 1;
        octx.globalAlpha = 0.7;
        octx.shadowColor = '#000000';
        octx.shadowBlur = 1;

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

    function previewRect(x0, y0, x1, y1) {
        const overlay = ensureOverlay();
        const octx = overlay.getContext('2d');
        octx.clearRect(0, 0, overlay.width, overlay.height);
        octx.setLineDash([6, 4]);
        octx.strokeStyle = '#00ffcc';
        octx.lineWidth = 1;
        octx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
    }

    function previewCircle(x0, y0, x1, y1) {
        const overlay = ensureOverlay();
        const octx = overlay.getContext('2d');
        octx.clearRect(0, 0, overlay.width, overlay.height);
        const rx = (x1 - x0) / 2;
        const ry = (y1 - y0) / 2;
        const cx = x0 + rx;
        const cy = y0 + ry;
        octx.setLineDash([6, 4]);
        octx.strokeStyle = '#00ffcc';
        octx.lineWidth = 1;
        octx.beginPath();
        octx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
        octx.stroke();
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
            ctx.lineWidth = Math.max(1, state.brushSize);
            ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
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
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
        if (state.fill && !isErase) {
            ctx.fillStyle = rgbaString();
            ctx.fill();
        } else {
            ctx.lineWidth = Math.max(1, state.brushSize);
            ctx.strokeStyle = isErase ? 'rgba(0,0,0,1)' : rgbaString();
            ctx.stroke();
        }
        if (isErase && state.fill) {
            ctx.clip();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        ctx.restore();
        // Crosshair is on overlay, no need to redraw
    }

    function bucketFillAt(x, y) {
        pushUndo();
        const target = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const { data, width, height } = target;
        const idx = (y * width + x) * 4;
        const tr = data[idx], tg = data[idx+1], tb = data[idx+2], ta = data[idx+3];
        const newR = state.color.r, newG = state.color.g, newB = state.color.b, newA = Math.round(state.color.a * 255);
        if (tr === newR && tg === newG && tb === newB && ta === newA) return;
        const stack = [[x, y]];
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
        // Crosshair is on overlay, no need to redraw
        updateGameObjectIcon();
    }

    function beginSelection(x, y) {
        if (state.selection && state.selection.layerCanvas) commitSelection();
        state.selection = { x, y, w: 0, h: 0, layerCanvas: null, dragging: false, offsetX: 0, offsetY: 0 };
    }
    function finalizeSelectionRect(x, y) {
        if (!state.selection) return;
        const x0 = Math.min(state.selection.x, x);
        const y0 = Math.min(state.selection.y, y);
        const x1 = Math.max(state.selection.x, x);
        const y1 = Math.max(state.selection.y, y);
        const w = x1 - x0;
        const h = y1 - y0;
        if (w === 0 || h === 0) { state.selection = null; return; }
        pushUndo();
        const layer = document.createElement('canvas');
        layer.width = w; layer.height = h;
        const lctx = layer.getContext('2d');
        const imageData = ctx.getImageData(x0, y0, w, h);
        lctx.putImageData(imageData, 0, 0);
        ctx.clearRect(x0, y0, w, h);
        state.selection = { x: x0, y: y0, w, h, layerCanvas: layer, dragging: false, offsetX: 0, offsetY: 0 };
        drawSelectionOverlay();
    }
    function drawSelectionOverlay() {
        if (!state.selection) return;
        let overlay = wrapper.querySelector('canvas.__overlay');
        if (!overlay) {
            overlay = document.createElement('canvas');
            overlay.className = '__overlay';
            overlay.width = canvas.width;
            overlay.height = canvas.height;
            overlay.style.position = 'absolute';
            overlay.style.pointerEvents = 'none';
            overlay.style.top = '50%';
            overlay.style.left = '50%';
            overlay.style.setProperty('--zoom', state.zoom);
            overlay.style.transformOrigin = 'center';
            wrapper.appendChild(overlay);
        } else {
            overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
            overlay.style.setProperty('--zoom', state.zoom);
        }
        const octx = overlay.getContext('2d');
        octx.clearRect(0, 0, overlay.width, overlay.height);
        // draw floating layer if present (scaled to current w/h)
        if (state.selection.layerCanvas) {
            octx.drawImage(state.selection.layerCanvas, state.selection.x, state.selection.y, state.selection.w, state.selection.h);
        }
        // marching ants bounding box
        octx.setLineDash([6, 4]);
        octx.strokeStyle = '#00ffcc';
        octx.lineWidth = 1;
        octx.strokeRect(state.selection.x + 0.5, state.selection.y + 0.5, state.selection.w, state.selection.h);
        // resize handles
        const hs = 6; // handle size
        const handles = getSelectionHandles(hs);
        octx.setLineDash([]);
        octx.fillStyle = '#00ffcc';
        handles.forEach(h => {
            octx.fillRect(h.x, h.y, h.w, h.h);
        });
    }
    function commitSelection() {
        if (!state.selection || !state.selection.layerCanvas) return;
        pushUndo();
        // Clamp selection position to canvas bounds
        state.selection.x = Math.max(0, Math.min(canvas.width - state.selection.w, state.selection.x));
        state.selection.y = Math.max(0, Math.min(canvas.height - state.selection.h, state.selection.y));
        // draw scaled to current width/height
        ctx.drawImage(state.selection.layerCanvas, state.selection.x, state.selection.y, state.selection.w, state.selection.h);
        state.selection = null;
        // Crosshair is on overlay, no need to redraw
        const overlay = wrapper.querySelector('canvas.__overlay');
        if (overlay) overlay.remove();
        updateGameObjectIcon();
        saveToDisk();
        // Crosshair will be redrawn when overlay is recreated
    }
    function getSelectionHandles(handleSize) {
        const s = state.selection;
        const hs = handleSize || 6;
        const half = Math.floor(hs / 2);
        const x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
        const cx = s.x + Math.floor(s.w / 2), cy = s.y + Math.floor(s.h / 2);
        return [
            { name: 'nw', x: x0 - half, y: y0 - half, w: hs, h: hs },
            { name: 'n',  x: cx - half, y: y0 - half, w: hs, h: hs },
            { name: 'ne', x: x1 - half, y: y0 - half, w: hs, h: hs },
            { name: 'e',  x: x1 - half, y: cy - half, w: hs, h: hs },
            { name: 'se', x: x1 - half, y: y1 - half, w: hs, h: hs },
            { name: 's',  x: cx - half, y: y1 - half, w: hs, h: hs },
            { name: 'sw', x: x0 - half, y: y1 - half, w: hs, h: hs },
            { name: 'w',  x: x0 - half, y: cy - half, w: hs, h: hs },
        ];
    }
    function hitTestHandle(px, py) {
        if (!state.selection) return null;
        const handles = getSelectionHandles(8);
        for (let i = 0; i < handles.length; i++) {
            const h = handles[i];
            if (px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h) {
                return h.name;
            }
        }
        return null;
    }

    function canvasToLocal(evt) {
        const rect = canvas.getBoundingClientRect();
        const cx = evt.clientX - rect.left - rect.width/2;
        const cy = evt.clientY - rect.top - rect.height/2;
        const x = Math.round(canvas.width/2 + cx / state.zoom);
        const y = Math.round(canvas.height/2 + cy / state.zoom);
        return { x: Math.max(0, Math.min(canvas.width-1, x)), y: Math.max(0, Math.min(canvas.height-1, y)) };
    }
    function onMouseDown(e) {
        if (e.button !== 0) return;
        const p = canvasToLocal(e);
        state.isDrawing = (state.tool !== 'select');
        state.startX = state.lastX = p.x;
        state.startY = state.lastY = p.y;
        if (state.tool === 'brush') {
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
                    state.selection.resizing = handle;
                    state.selection._orig = { x: state.selection.x, y: state.selection.y, w: state.selection.w, h: state.selection.h };
                    state.isDrawing = false;
                    return;
                }
                if (p.x >= state.selection.x && p.x < state.selection.x + state.selection.w && p.y >= state.selection.y && p.y < state.selection.y + state.selection.h) {
                    state.selection.dragging = true;
                    state.selection.offsetX = p.x - state.selection.x;
                    state.selection.offsetY = p.y - state.selection.y;
                } else {
                    beginSelection(p.x, p.y);
                }
            } else {
                beginSelection(p.x, p.y);
            }
        } else if (state.tool === 'rect' || state.tool === 'circle') {
            // Prepare overlay preview
            clearOverlay();
        }
    }
    function onMouseMove(e) {
        if (!state.isDrawing) {
            if (state.selection && state.selection.resizing) {
                const p = canvasToLocal(e);
                const s = state.selection;
                const minSize = 1;
                let nx = s.x, ny = s.y, nw = s.w, nh = s.h;
                const h = s.resizing;
                const keepSquare = e.shiftKey;
                const endX = p.x, endY = p.y;
                const orig = s._orig || { x: s.x, y: s.y, w: s.w, h: s.h };
                // compute new rect based on handle
                const right = orig.x + orig.w;
                const bottom = orig.y + orig.h;
                if (h === 'nw') { nx = Math.min(endX, right - minSize); ny = Math.min(endY, bottom - minSize); nw = right - nx; nh = bottom - ny; }
                if (h === 'n')  { ny = Math.min(endY, bottom - minSize); nh = bottom - ny; }
                if (h === 'ne') { ny = Math.min(endY, bottom - minSize); nw = Math.max(minSize, Math.min(canvas.width - orig.x, endX - orig.x)); nh = bottom - ny; nx = right - nw; }
                if (h === 'e')  { nw = Math.max(minSize, Math.min(canvas.width - orig.x, endX - orig.x)); nx = orig.x; ny = orig.y; nh = orig.h; }
                if (h === 'se') { nw = Math.max(minSize, endX - orig.x); nh = Math.max(minSize, endY - orig.y); nx = orig.x; ny = orig.y; }
                if (h === 's')  { nh = Math.max(minSize, endY - orig.y); nx = orig.x; ny = orig.y; nw = orig.w; }
                if (h === 'sw') { nx = Math.min(endX, right - minSize); nw = right - nx; nh = Math.max(minSize, endY - orig.y); ny = orig.y; }
                if (h === 'w')  { nx = Math.min(endX, right - minSize); nw = right - nx; ny = orig.y; nh = orig.h; }
                if (keepSquare) {
                    const size = Math.max(nw, nh);
                    // adjust based on handle anchor
                    if (h === 'nw') { nx = right - size; ny = bottom - size; }
                    if (h === 'ne') { ny = bottom - size; }
                    if (h === 'se') { /* anchored at orig.x,orig.y */ }
                    if (h === 'sw') { nx = right - size; }
                    nw = nh = size;
                }
                // clamp to canvas bounds
                nx = Math.max(0, Math.min(canvas.width - minSize, nx));
                ny = Math.max(0, Math.min(canvas.height - minSize, ny));
                nw = Math.max(minSize, Math.min(canvas.width - nx, nw));
                nh = Math.max(minSize, Math.min(canvas.height - ny, nh));
                s.x = nx; s.y = ny; s.w = nw; s.h = nh;
                drawSelectionOverlay();
            } else if (state.selection && state.selection.dragging) {
                const p = canvasToLocal(e);
                let nx = Math.max(0, Math.min(canvas.width - state.selection.w, p.x - state.selection.offsetX));
                let ny = Math.max(0, Math.min(canvas.height - state.selection.h, p.y - state.selection.offsetY));
                // Snap to canvas center if near
                const centerX = Math.round((canvas.width - state.selection.w) / 2);
                const centerY = Math.round((canvas.height - state.selection.h) / 2);
                const snapDist = 8;
                if (Math.abs(nx - centerX) <= snapDist) nx = centerX;
                if (Math.abs(ny - centerY) <= snapDist) ny = centerY;
                state.selection.x = nx;
                state.selection.y = ny;
                drawSelectionOverlay();
            }
            return;
        }
        const p = canvasToLocal(e);
        if (state.tool === 'brush') {
            const shift = e.shiftKey;
            let cx = p.x, cy = p.y;
            if (shift) {
                const dx = p.x - state.startX;
                const dy = p.y - state.startY;
                if (Math.abs(dx) > Math.abs(dy)) cy = state.startY; else cx = state.startX;
            }
            applyBrushLine(state.lastX, state.lastY, cx, cy);
            state.lastX = cx; state.lastY = cy;
        }
        if (state.tool === 'rect' || state.tool === 'circle') {
            let x0 = state.startX, y0 = state.startY, x1 = p.x, y1 = p.y;
            if (e.shiftKey) {
                const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
                x1 = x0 + Math.sign(x1 - x0) * size;
                y1 = y0 + Math.sign(y1 - y0) * size;
            }
            if (state.tool === 'rect') previewRect(Math.min(x0,x1), Math.min(y0,y1), Math.max(x0,x1), Math.max(y0,y1));
            else previewCircle(Math.min(x0,x1), Math.min(y0,y1), Math.max(x0,x1), Math.max(y0,y1));
        }
        if (state.tool === 'select' && state.selection && !state.selection.dragging) {
            state.selection.w = Math.abs(p.x - state.startX);
            state.selection.h = Math.abs(p.y - state.startY);
            state.selection.x = Math.min(state.startX, p.x);
            state.selection.y = Math.min(state.startY, p.y);
            drawSelectionOverlay();
        }
    }
    function onMouseUp(e) {
        if (!state.isDrawing) {
            if (state.selection && state.selection.dragging) {
                state.selection.dragging = false;
                drawSelectionOverlay();
            } else if (state.selection && state.selection.resizing) {
                state.selection.resizing = null;
                state.selection._orig = null;
                drawSelectionOverlay();
            }
            return;
        }
        state.isDrawing = false;
        const p = canvasToLocal(e);
        if (state.tool === 'rect') {
            let x0 = state.startX, y0 = state.startY, x1 = p.x, y1 = p.y;
            if (e.shiftKey) {
                const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
                x1 = x0 + Math.sign(x1 - x0) * size;
                y1 = y0 + Math.sign(y1 - y0) * size;
            }
            const rx0 = Math.min(x0,x1), ry0 = Math.min(y0,y1), rx1 = Math.max(x0,x1), ry1 = Math.max(y0,y1);
            const rw = rx1 - rx0, rh = ry1 - ry0;
            // If transparency/eraser mode is on, commit directly to the main canvas (like the brush tool).
            // Offscreen "selection layer" compositing can't erase the destination canvas when later drawn via drawImage.
            if (state.color.a <= 0.01) {
                pushUndo();
                commitRect(rx0, ry0, rx1, ry1);
                clearOverlay();
                updateGameObjectIcon();
                saveToDisk();
                return;
            }
            // create floating selection layer with the rect drawn on it
            const layer = document.createElement('canvas');
            layer.width = Math.max(1, rw); layer.height = Math.max(1, rh);
            const lctx = layer.getContext('2d');
            lctx.save();
            lctx.globalCompositeOperation = 'source-over';
            if (state.fill) {
                lctx.fillStyle = rgbaString();
                lctx.fillRect(0, 0, rw, rh);
            } else {
                lctx.lineWidth = Math.max(1, state.brushSize);
                lctx.strokeStyle = rgbaString();
                lctx.strokeRect(0.5, 0.5, rw, rh);
            }
            lctx.restore();
            // floating selection (draggable/resizable)
            state.selection = { x: rx0, y: ry0, w: rw, h: rh, layerCanvas: layer, dragging: false, offsetX: 0, offsetY: 0, resizing: null };
            drawSelectionOverlay();
            clearOverlay();
        } else if (state.tool === 'circle') {
            let x0 = state.startX, y0 = state.startY, x1 = p.x, y1 = p.y;
            if (e.shiftKey) {
                const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
                x1 = x0 + Math.sign(x1 - x0) * size;
                y1 = y0 + Math.sign(y1 - y0) * size;
            }
            const cx0 = Math.min(x0,x1), cy0 = Math.min(y0,y1), cx1 = Math.max(x0,x1), cy1 = Math.max(y0,y1);
            const cw = cx1 - cx0, ch = cy1 - cy0;
            // If transparency/eraser mode is on, commit directly to the main canvas (like the brush tool).
            if (state.color.a <= 0.01) {
                pushUndo();
                commitCircle(cx0, cy0, cx1, cy1);
                clearOverlay();
                updateGameObjectIcon();
                saveToDisk();
                return;
            }
            const layer = document.createElement('canvas');
            layer.width = Math.max(1, cw); layer.height = Math.max(1, ch);
            const lctx = layer.getContext('2d');
            lctx.save();
            lctx.globalCompositeOperation = 'source-over';
            lctx.beginPath();
            lctx.ellipse(cw/2, ch/2, Math.abs(cw/2), Math.abs(ch/2), 0, 0, Math.PI * 2);
            if (state.fill) {
                lctx.fillStyle = rgbaString();
                lctx.fill();
            } else {
                lctx.lineWidth = Math.max(1, state.brushSize);
                lctx.strokeStyle = rgbaString();
                lctx.stroke();
            }
            lctx.restore();
            state.selection = { x: cx0, y: cy0, w: cw, h: ch, layerCanvas: layer, dragging: false, offsetX: 0, offsetY: 0, resizing: null };
            drawSelectionOverlay();
            clearOverlay();
        } else if (state.tool === 'brush') {
            // Persist brush stroke when mouse is released
            saveToDisk();
            // Crosshair remains on overlay
        } else if (state.tool === 'select') {
            if (state.selection && !state.selection.layerCanvas) {
                finalizeSelectionRect(p.x, p.y);
            }
        }
    }
    function onMouseLeave() { if (state.isDrawing) state.isDrawing = false; }

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseLeave);
    // Commit selection when clicking outside selection on canvas
    canvas.addEventListener('click', (e) => {
        if (!state.selection) return;
        const p = canvasToLocal(e);
        const inside = p.x >= state.selection.x && p.x < state.selection.x + state.selection.w && p.y >= state.selection.y && p.y < state.selection.y + state.selection.h;
        if (!inside && !state.isDrawing) {
            commitSelection();
        }
    });

    // Mouse wheel zoom
    wrapper.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1.1 : 0.9;
        setZoom(state.zoom * delta);
        imageZoom = state.zoom;
    }, { passive: false });

    // Keyboard shortcuts for undo/redo
    document.addEventListener('keydown', (e) => {
        if (activeTab !== 'images') return;
        const isMeta = e.ctrlKey || e.metaKey;
        if (isMeta && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) redo(); else undo();
        }
        if (e.key === 'Escape') {
            if (state.selection) commitSelection();
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

    params.zoomInBtn.addEventListener('click', () => setZoom(state.zoom * 1.2));
    params.zoomOutBtn.addEventListener('click', () => setZoom(state.zoom * 0.8));
    params.zoomResetBtn.addEventListener('click', () => setZoom(1));

    // Public API
    const api = { setTool, setColor, setBrushSize, setFill, setSymmetry, setZoom, clear, loadImage, undo, redo, drawCrosshair };
    // Defaults
    setColor('#ff0000', 1);
    setBrushSize(16);
    setZoom(imageZoom);
    // Draw initial crosshair
    drawCrosshair();
    return api;
}