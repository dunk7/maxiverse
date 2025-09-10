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
      { id: 0, type: "start", location: {x: 0, y: 0}, content: "start", val_a: null, val_b: null, next_block: 1, position: {x: 20, y: 20} },
    ]
  },
  {
    id: 1,
    name: "Object1",
    type: "object",
    media: [],
    code: [
        { id: 0, type: "start", location: {x: 0, y: 0}, content: "When Created", val_a: null, val_b: null, next_block: 1, position: {x: 20, y: 20} },
        { id: 1, type: "action", location: {x: 0, y: 0}, content: "move_xy", val_a: 5, val_b: 5, next_block: 2, position: {x: 20, y: 100} },
        { id: 2, type: "action", location: {x: 0, y: 0}, content: "move_xy", val_a: 10, val_b: 0, next_block: 3, position: {x: 20, y: 150} },
        { id: 3, type: "action", location: {x: 0, y: 0}, content: "move_xy", val_a: 15, val_b: -5, next_block: null, position: {x: 20, y: 200} }

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
let runtimePositions = {}; // world coords centered at (0,0): { [objectId]: { x, y } }
let playLoopHandle = null;
let playStartTime = 0;
let lastFrameTime = 0;
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
    objects.forEach(o => {
        if (o.media && o.media[0] && o.media[0].path) {
            runtimePositions[o.id] = { x: 0, y: 0 };
        }
    });
}
function stepInterpreter(dtMs) {
    // For simplicity, on play start we immediately execute the "When Created" chains once
    // and then stop further interpreting (we still animate render positions).
    if (!isPlaying) return;
}
function runWhenCreatedChains() {
    objects.forEach(o => {
        const code = Array.isArray(o.code) ? o.code : [];
        // Find a start block (content either 'start' or 'When Created')
        const start = code.find(b => b.type === 'start');
        if (!start) return;
        let currentId = start.next_block;
        let safety = 0;
        while (currentId !== null && safety++ < 1000) {
            const block = code.find(b => b.id === currentId);
            if (!block) break;
            if (block.type === 'action' && block.content === 'move_xy') {
                const dx = Number(block.val_a || 0);
                const dy = Number(block.val_b || 0);
                if (!runtimePositions[o.id]) {
                    runtimePositions[o.id] = { x: 0, y: 0 };
                }
                runtimePositions[o.id].x += dx;
                runtimePositions[o.id].y += dy;
            }
            currentId = block.next_block;
        }
    });
}
function startPlay() {
    if (isPlaying) return;
    isPlaying = true;
    resetRuntimePositions();
    runWhenCreatedChains();
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
        const ySelectSpan = document.createElement("span");
        label.appendChild(xSelectSpan);
        label.innerHTML += ", ";
        label.appendChild(ySelectSpan);
        label.innerHTML += ")";
    } else {
        label.textContent = codeData.content;
    }
    block.appendChild(label);

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
            // Re-link any predecessor to this block's successor
            const predecessor = selectedObj.code.find(c => c.next_block === codeIdNum);
            if (predecessor) {
                predecessor.next_block = codeData.next_block ?? null;
            }
            // Remove this block from the object's code list
            const idx = selectedObj.code.findIndex(c => c.id === codeIdNum);
            if (idx >= 0) {
                selectedObj.code.splice(idx, 1);
            }
            // Remove DOM element
            block.remove();
            // Redraw connections
            drawConnections();
        });
        block.appendChild(closeBtn);
    }

    // Dropdowns for move_xy
    if (codeData.content === "move_xy") {
        // X dropdown
        const xSelect = document.createElement("select");
        xSelect.name = "val_a";
        for (let i = -10; i <= 10; i++) {
            const option = document.createElement("option");
            option.value = i;
            option.textContent = i;
            if (i === codeData.val_a) option.selected = true;
            xSelect.appendChild(option);
        }
        xSelect.addEventListener("change", () => {
            codeData.val_a = parseInt(xSelect.value);
        });
        label.children[0].appendChild(xSelect);

        // Y dropdown
        const ySelect = document.createElement("select");
        ySelect.name = "val_b";
        for (let i = -10; i <= 10; i++) {
            const option = document.createElement("option");
            option.value = i;
            option.textContent = i;
            if (i === codeData.val_b) option.selected = true;
            ySelect.appendChild(option);
        }
        ySelect.addEventListener("change", () => {
            codeData.val_b = parseInt(ySelect.value);
        });
        label.children[1].appendChild(ySelect);
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

    return block;
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
}

// Canvas for drawing connections
const connectionCanvas = document.createElement("canvas");
connectionCanvas.style.position = "absolute";
connectionCanvas.style.top = "0";
connectionCanvas.style.left = "0";
connectionCanvas.style.pointerEvents = "none";
const connectionCtx = connectionCanvas.getContext("2d");

// Resize canvas to match node window
function resizeConnectionCanvas() {
    const nodeWindow = document.getElementById('node-window');
    connectionCanvas.width = nodeWindow.offsetWidth;
    connectionCanvas.height = nodeWindow.offsetHeight;
}

// Draw connections between blocks
function drawConnections() {
    resizeConnectionCanvas();
    connectionCtx.clearRect(0, 0, connectionCanvas.width, connectionCanvas.height);
    
    const selectedObj = objects.find(obj => obj.id == selected_object);
    if (!selectedObj) return;

    selectedObj.code.forEach(code => {
        if (code.next_block !== null) {
            const nodeWindow = document.getElementById('node-window');
            const startBlock = nodeWindow.querySelector(`.node-block[data-code-id="${code.id}"]`);
            const endBlock = nodeWindow.querySelector(`.node-block[data-code-id="${code.next_block}"]`);

            if (startBlock && endBlock) {
                const startRect = startBlock.getBoundingClientRect();
                const endRect = endBlock.getBoundingClientRect();
                const nodeWindowRect = nodeWindow.getBoundingClientRect();

                const startX = startRect.left - nodeWindowRect.left + startRect.width / 2;
                const startY = startRect.bottom - nodeWindowRect.top;
                const endX = endRect.left - nodeWindowRect.left + endRect.width / 2;
                const endY = endRect.top - nodeWindowRect.top;

                connectionCtx.beginPath();
                connectionCtx.moveTo(startX, startY);
                connectionCtx.lineTo(endX, endY);
                connectionCtx.strokeStyle = "blue";
                connectionCtx.lineWidth = 2;
                connectionCtx.stroke();
            }
        }
    });
}

// Global variables for images tab
let selectedImage = null; // current image src (path or data URL)
let imageZoom = 1.0;
let lastSelectedImage = localStorage.getItem('lastSelectedImage') || '';
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

function ensureDefaultImageForObject(obj) {
    const key = String(obj.id);
    if (!objectImages[key]) objectImages[key] = [];
    if (objectImages[key].length === 0) {
        const blank = generateBlankImageDataUrl();
        const imgInfo = { id: Date.now(), name: 'image-1', src: blank };
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
// No default preloaded images; objects start without images
// Editor instance
let imageEditor = null;
let currentImageFilename = null;
let currentImageInfo = null;
let imageRevision = 0; // increment to bust caches when saving

// Update workspace with node blocks or images interface
function updateWorkspace() {
    const nodeWindow = document.getElementById('node-window');

    // Clear existing content
    nodeWindow.innerHTML = '';

    // Only show code blocks and connections if code tab is active
    if (activeTab === 'code') {
        // Re-add the connection canvas for code tab
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

        drawConnections();
    } else if (activeTab === 'images') {
        // Create images tab interface
        createImagesInterface(nodeWindow);
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
    imagesContainer.style.cssText = `
        position: relative;
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        background: #2a2a2a;
    `;

    // Create top editing panel
    const editingPanel = document.createElement('div');
    editingPanel.className = 'image-editing-panel';
    editingPanel.style.cssText = `
        height: 60px;
        background: #333;
        border-bottom: 1px solid #444;
        display: flex;
        align-items: center;
        padding: 10px;
        gap: 10px;
    `;

    // Drawing tools toolbar
    const toolbar = document.createElement('div');
    toolbar.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
    `;

    const toolNames = [
        { id: 'brush', label: '🖌️' },
        { id: 'rect', label: '▭' },
        { id: 'circle', label: '◯' },
        { id: 'bucket', label: '🪣' },
        { id: 'select', label: '▦' },
    ];
    const toolButtons = {};
    toolNames.forEach(t => {
        const btn = document.createElement('button');
        btn.textContent = t.label;
        btn.className = 'image-edit-tool';
        btn.style.width = '36px';
        btn.style.height = '36px';
        btn.style.borderRadius = '6px';
        btn.dataset.tool = t.id;
        btn.addEventListener('click', () => {
            if (imageEditor) imageEditor.setTool(t.id);
            Object.values(toolButtons).forEach(b => b.style.outline = 'none');
            btn.style.outline = '2px solid #00ffcc';
        });
        toolButtons[t.id] = btn;
        toolbar.appendChild(btn);
    });

    // Color picker and Alpha slider
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = '#ff0000';
    colorInput.title = 'Color';
    colorInput.style.width = '36px';
    colorInput.style.height = '36px';
    colorInput.style.borderRadius = '6px';
    colorInput.style.padding = '0';
    const alphaLabel = document.createElement('div');
    alphaLabel.textContent = 'Transparency';
    alphaLabel.style.fontSize = '11px';
    alphaLabel.style.color = '#aaa';
    const alphaInput = document.createElement('input');
    alphaInput.type = 'range';
    alphaInput.min = '0';
    alphaInput.max = '1';
    alphaInput.step = '0.01';
    alphaInput.value = '1';
    alphaInput.title = 'Alpha';
    alphaInput.style.width = '80px';
    const alphaNumber = document.createElement('input');
    alphaNumber.type = 'number';
    alphaNumber.min = '0';
    alphaNumber.max = '1';
    alphaNumber.step = '0.01';
    alphaNumber.value = '1';
    alphaNumber.style.width = '60px';
    colorInput.addEventListener('input', () => imageEditor && imageEditor.setColor(colorInput.value, parseFloat(alphaInput.value)));
    alphaInput.addEventListener('input', () => imageEditor && imageEditor.setColor(colorInput.value, parseFloat(alphaInput.value)));

    // Brush size
    const sizeLabel = document.createElement('div');
    sizeLabel.textContent = 'Size';
    sizeLabel.style.fontSize = '11px';
    sizeLabel.style.color = '#aaa';
    const sizeInput = document.createElement('input');
    sizeInput.type = 'range';
    sizeInput.min = '1';
    sizeInput.max = '100';
    sizeInput.value = '16';
    sizeInput.title = 'Brush Size';
    sizeInput.style.width = '120px';
    const sizeNumber = document.createElement('input');
    sizeNumber.type = 'number';
    sizeNumber.min = '1';
    sizeNumber.max = '100';
    sizeNumber.value = '16';
    sizeNumber.style.width = '60px';
    sizeInput.addEventListener('input', () => imageEditor && imageEditor.setBrushSize(parseInt(sizeInput.value)));

    // Fill toggle for shapes
    const fillLabel = document.createElement('label');
    fillLabel.style.display = 'flex';
    fillLabel.style.alignItems = 'center';
    fillLabel.style.gap = '4px';
    const fillCheckbox = document.createElement('input');
    fillCheckbox.type = 'checkbox';
    fillCheckbox.checked = true;
    const fillText = document.createElement('span');
    fillText.textContent = 'Fill';
    fillLabel.appendChild(fillCheckbox);
    fillLabel.appendChild(fillText);
    fillCheckbox.addEventListener('change', () => imageEditor && imageEditor.setFill(fillCheckbox.checked));

    // Undo / Redo
    const undoBtn = document.createElement('button');
    undoBtn.textContent = '↩';
    undoBtn.className = 'image-edit-tool';
    undoBtn.addEventListener('click', () => imageEditor && imageEditor.undo());
    const redoBtn = document.createElement('button');
    redoBtn.textContent = '↪';
    redoBtn.className = 'image-edit-tool';
    redoBtn.addEventListener('click', () => imageEditor && imageEditor.redo());

    // Clear
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '⎚';
    clearBtn.className = 'image-edit-tool';
    clearBtn.addEventListener('click', () => imageEditor && imageEditor.clear());

    // Wire numeric and range inputs
    colorInput.addEventListener('input', () => imageEditor && imageEditor.setColor(colorInput.value, parseFloat(alphaInput.value)));
    alphaInput.addEventListener('input', () => { alphaNumber.value = alphaInput.value; imageEditor && imageEditor.setColor(colorInput.value, parseFloat(alphaInput.value)); });
    alphaNumber.addEventListener('input', () => { alphaInput.value = alphaNumber.value; imageEditor && imageEditor.setColor(colorInput.value, parseFloat(alphaNumber.value)); });
    sizeInput.addEventListener('input', () => { sizeNumber.value = sizeInput.value; imageEditor && imageEditor.setBrushSize(parseInt(sizeInput.value)); });
    sizeNumber.addEventListener('input', () => { sizeInput.value = sizeNumber.value; imageEditor && imageEditor.setBrushSize(parseInt(sizeNumber.value)); });

    toolbar.appendChild(colorInput);
    const alphaGroup = document.createElement('div');
    alphaGroup.style.display = 'flex';
    alphaGroup.style.flexDirection = 'column';
    alphaGroup.style.gap = '2px';
    const alphaRow = document.createElement('div');
    alphaRow.style.display = 'flex'; alphaRow.style.gap = '6px'; alphaRow.style.alignItems = 'center';
    alphaRow.appendChild(alphaInput); alphaRow.appendChild(alphaNumber);
    alphaGroup.appendChild(alphaLabel); alphaGroup.appendChild(alphaRow);
    toolbar.appendChild(alphaGroup);

    const sizeGroup = document.createElement('div');
    sizeGroup.style.display = 'flex';
    sizeGroup.style.flexDirection = 'column';
    sizeGroup.style.gap = '2px';
    const sizeRow = document.createElement('div');
    sizeRow.style.display = 'flex'; sizeRow.style.gap = '6px'; sizeRow.style.alignItems = 'center';
    sizeRow.appendChild(sizeInput); sizeRow.appendChild(sizeNumber);
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
        overflow-y: auto;
        padding: 10px;
        display: flex;
        flex-direction: column;
    `;

    // Create thumbnails container
    const thumbnailsContainer = document.createElement('div');
    thumbnailsContainer.style.cssText = `
        flex: 1;
        overflow-y: auto;
    `;

    // Load and display images from ./images/0/
    loadImagesFromDirectory(thumbnailsContainer);

    // Add plus button at bottom
    const plusButton = document.createElement('button');
    plusButton.className = 'add-image-btn';
    plusButton.innerHTML = '+';
    plusButton.style.cssText = `
        width: 100%;
        height: 40px;
        background: #00ffcc;
        border: none;
        color: #1a1a1a;
        border-radius: 6px;
        cursor: pointer;
        font-size: 24px;
        font-weight: bold;
        margin-top: 10px;
        transition: background 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
    `;
    plusButton.title = 'Add new image';
    plusButton.addEventListener('mouseover', () => plusButton.style.background = '#00cccc');
    plusButton.addEventListener('mouseout', () => plusButton.style.background = '#00ffcc');
    plusButton.addEventListener('click', () => createNewImage());

    leftPanel.appendChild(thumbnailsContainer);
    leftPanel.appendChild(plusButton);

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
    zoomInBtn.textContent = '+';
    zoomInBtn.className = 'zoom-btn';
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
    zoomOutBtn.textContent = '−';
    zoomOutBtn.className = 'zoom-btn';
    zoomOutBtn.style.cssText = zoomInBtn.style.cssText;

    const zoomResetBtn = document.createElement('button');
    zoomResetBtn.textContent = '=';
    zoomResetBtn.className = 'zoom-btn';
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
}

// Load images from ./images/0/ directory
function loadImagesFromDirectory(container) {
    const images = getCurrentObjectImages();
    container.innerHTML = '';

    images.forEach(imgInfo => {
        if (!currentImageInfo) currentImageInfo = imgInfo; // track last referenced
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

    // Auto-select first image for the object if exists
    setTimeout(() => {
        if (images.length > 0) {
            const firstItem = container.children[0];
            if (firstItem) selectImage(images[0].src, firstItem);
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
    const busted = `${imagePath}${imagePath.includes('?') ? '&' : '?'}v=${imageRevision}`;
    selectedImage = busted;
    lastSelectedImage = imagePath;

    // Save to localStorage
    localStorage.setItem('lastSelectedImage', imagePath);

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
                img.style.width = '75px';
                img.style.height = '75px';
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
    const filename = `new_image_${timestamp}.png`;

    // Create a simple 256x256 transparent PNG
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    // Fill with transparent background (you could add a checkerboard pattern)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(0, 0, 256, 256);

    // Add a subtle grid pattern
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 256; i += 32) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, 256);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(256, i);
        ctx.stroke();
    }

    // In a real implementation, you would save this to the server
    // For now, we'll create a data URL and add it to our list
    const dataUrl = canvas.toDataURL('image/png');

    // Create a temporary image element to display the new image
    const img = new Image();
    img.onload = function() {
        // Add the new image to the images directory (simulated)
        // In a real app, this would be saved to the server
        console.log(`New image created: ${filename}`);

        // Add to current object's images and refresh
        const list = getCurrentObjectImages();
        list.unshift({ id: timestamp, name: filename, src: dataUrl });
        const thumbnailsContainer = document.querySelector('.images-left-panel > div');
        if (thumbnailsContainer) {
            loadImagesFromDirectory(thumbnailsContainer);
            setTimeout(() => {
                const firstItem = thumbnailsContainer.children[0];
                if (firstItem) selectImage(dataUrl, firstItem);
            }, 30);
        }
    };
    img.src = dataUrl;
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

    // Create icon element
    const icon = document.createElement("img"); // Use <img> instead of <image>
    // Check if media exists and has a valid path
    if (boxData.media && boxData.media.length > 0 && boxData.media[0].path) {
        icon.src = boxData.media[0].path; // Set src to the media path
        icon.alt = boxData.media[0].name; // Optional: set alt text
        icon.style.width = "75px"; // Optional: set a size for the icon
        icon.style.height = "75px";
        box.appendChild(icon);
    }

    const name = document.createElement("span");
    name.className = "object-name";
    name.textContent = boxData.name;
    box.appendChild(name);

    box.addEventListener("click", () => {
        document.querySelectorAll('.box').forEach(otherBox => {
            otherBox.classList.remove("selected");
        });
        box.classList.add("selected");
        selected_object = boxData.id;
        updateWorkspace();
        renderGameWindowSprite();
    });

    return box;
}

// Initialize grid
objects.forEach((boxData, index) => {
    const boxElement = createBox(boxData);
    grid.appendChild(boxElement);
    if (index === 0) {
        boxElement.classList.add("selected");
        selected_object = boxData.id;
    }
});

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

// Initialize tabs after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 DOM Content Loaded - Initializing app...');
    // Seed default blank images so every object starts with image-1
    initializeDefaultImages();
    initializeTabs();
    initializeEditMenu();
    setTimeout(() => refreshObjectGridIcons(), 50);
    console.log('✅ App initialization complete');
    // Add Play/Stop overlay button on game window
    try {
        const canvas = document.getElementById('game-window');
        const wrapper = canvas.parentElement || document.body;
        let playBtn = document.getElementById('__play_btn');
        if (!playBtn) {
            playBtn = document.createElement('button');
            playBtn.id = '__play_btn';
            playBtn.textContent = 'Play';
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
                    playBtn.textContent = 'Play';
                } else {
                    startPlay();
                    playBtn.textContent = 'Stop';
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
    }, 10); // Small delay to ensure DOM is fully ready
}

// Update canvas size on window resize
window.addEventListener("resize", () => {
    drawConnections();
});

// Render all objects' first sprites, centered by default
function renderGameWindowSprite() {
    const canvas = document.getElementById('game-window');
    const gctx = canvas.getContext('2d');
    // Fit the canvas to right pane size
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    // background
    gctx.clearRect(0, 0, canvas.width, canvas.height);
    gctx.fillStyle = '#777';
    gctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw each object's image. In play mode, use runtimePositions (0,0 at center); otherwise center preview.
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    // only draw objects that actually have a sprite
    const withSprites = objects
        .filter(o => o.media && o.media[0] && o.media[0].path)
        .map(o => ({ obj: o, path: o.media[0].path }));
    // order: selected first, then others
    const visibleObjects = withSprites.sort((a, b) => (a.obj.id == selected_object ? -1 : b.obj.id == selected_object ? 1 : 0));
    visibleObjects.forEach((entry, index) => {
        const mediaPath = entry.path; // already versioned by imageRevision if needed
        let img = imageCache[mediaPath];
        if (!img) {
            img = new Image();
            imageCache[mediaPath] = img;
            img.src = mediaPath;
        }

        const drawIfReady = () => {
            if (!img.complete) return;
            const scale = Math.min(canvas.width / img.width, canvas.height / img.height, 1);
            const dw = img.width * scale;
            const dh = img.height * scale;
            let drawX, drawY;
            if (isPlaying && runtimePositions[entry.obj.id]) {
                const p = worldToCanvas(runtimePositions[entry.obj.id].x, runtimePositions[entry.obj.id].y, canvas);
                drawX = Math.round(p.x - dw / 2);
                drawY = Math.round(p.y - dh / 2);
            } else {
                const angle = index === 0 ? 0 : (index / Math.max(1, visibleObjects.length)) * Math.PI * 2;
                const radius = index === 0 ? 0 : Math.min(canvas.width, canvas.height) * 0.04 * index;
                const offsetX = Math.cos(angle) * radius;
                const offsetY = Math.sin(angle) * radius;
                drawX = Math.round(centerX - dw / 2 + offsetX);
                drawY = Math.round(centerY - dh / 2 + offsetY);
            }
            gctx.drawImage(img, drawX, drawY, dw, dh);
        };

        if (img.complete) {
            drawIfReady();
        } else {
            img.onload = drawIfReady;
        }
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
                    img.style.width = '75px';
                    img.style.height = '75px';
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
    function setZoom(z) {
        state.zoom = Math.max(0.1, Math.min(8, z));
        canvas.style.transform = `scale(${state.zoom})`;
        const overlay = wrapper.querySelector('canvas.__overlay');
        if (overlay) overlay.style.transform = `translate(-50%, -50%) scale(${state.zoom})`;
    }

    async function saveToDisk(forceNewName) {
        try {
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
                const text = await res.text();
                throw new Error(`Unexpected response (status ${res.status}): ${text.slice(0,200)}`);
            }
            if (!res.ok || !json || !json.ok) {
                const message = (json && json.error) ? json.error : `HTTP ${res.status}`;
                throw new Error(message);
            }
            if (json && json.ok && json.path) {
                currentImageFilename = filename;
                // Update current image info and thumbnail src
                const list = getCurrentObjectImages();
                imageRevision += 1;
                const bust = `${json.path}?v=${imageRevision}`;
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
            }
        } catch (e) {
            console.warn('Failed to save image', e);
            // Optionally surface a small toast
            try {
                const old = document.getElementById('__img_save_err');
                if (old) old.remove();
                const toast = document.createElement('div');
                toast.id = '__img_save_err';
                toast.textContent = `Save failed: ${e && e.message ? e.message : e}`;
                toast.style.cssText = 'position:fixed;bottom:16px;left:16px;background:#b00020;color:#fff;padding:8px 12px;border-radius:6px;font-size:12px;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,0.3)';
                document.body.appendChild(toast);
                setTimeout(() => { if (toast && toast.parentNode) toast.parentNode.removeChild(toast); }, 3000);
            } catch {}
        }
    }

    function clear(silent) {
        pushUndo();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!silent) saveToDisk();
    }

    function loadImage(src) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            pushUndo();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
            const dw = Math.round(img.width * scale);
            const dh = Math.round(img.height * scale);
            const dx = Math.floor((canvas.width - dw) / 2);
            const dy = Math.floor((canvas.height - dh) / 2);
            ctx.drawImage(img, dx, dy, dw, dh);
            // Do not auto-save on image load to avoid save-load loops
        };
        img.src = src;
    }

    function applyBrushLine(x0, y0, x1, y1) {
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
            overlay.style.transform = `translate(-50%, -50%) scale(${state.zoom})`;
            overlay.style.transformOrigin = 'center';
            wrapper.appendChild(overlay);
        }
        return overlay;
    }

    function clearOverlay() {
        const overlay = wrapper.querySelector('canvas.__overlay');
        if (overlay) overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
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
            overlay.style.transform = `translate(-50%, -50%) scale(${state.zoom})`;
            overlay.style.transformOrigin = 'center';
            wrapper.appendChild(overlay);
        } else {
            overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
            overlay.style.transform = `translate(-50%, -50%) scale(${state.zoom})`;
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
        const overlay = wrapper.querySelector('canvas.__overlay');
        if (overlay) overlay.remove();
        saveToDisk();
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
            // create floating selection layer with the rect drawn on it
            const layer = document.createElement('canvas');
            layer.width = Math.max(1, rw); layer.height = Math.max(1, rh);
            const lctx = layer.getContext('2d');
            const isErase = state.color.a <= 0.01;
            lctx.save();
            lctx.globalCompositeOperation = isErase ? 'destination-out' : 'source-over';
            if (state.fill && !isErase) {
                lctx.fillStyle = rgbaString();
                lctx.fillRect(0, 0, rw, rh);
            } else {
                lctx.lineWidth = Math.max(1, state.brushSize);
                lctx.strokeStyle = isErase ? 'rgba(0,0,0,1)' : rgbaString();
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
            const layer = document.createElement('canvas');
            layer.width = Math.max(1, cw); layer.height = Math.max(1, ch);
            const lctx = layer.getContext('2d');
            const isErase = state.color.a <= 0.01;
            lctx.save();
            lctx.globalCompositeOperation = isErase ? 'destination-out' : 'source-over';
            lctx.beginPath();
            lctx.ellipse(cw/2, ch/2, Math.abs(cw/2), Math.abs(ch/2), 0, 0, Math.PI * 2);
            if (state.fill && !isErase) {
                lctx.fillStyle = rgbaString();
                lctx.fill();
            } else {
                lctx.lineWidth = Math.max(1, state.brushSize);
                lctx.strokeStyle = isErase ? 'rgba(0,0,0,1)' : rgbaString();
                lctx.stroke();
            }
            lctx.restore();
            state.selection = { x: cx0, y: cy0, w: cw, h: ch, layerCanvas: layer, dragging: false, offsetX: 0, offsetY: 0, resizing: null };
            drawSelectionOverlay();
            clearOverlay();
        } else if (state.tool === 'brush') {
            // Persist brush stroke when mouse is released
            saveToDisk();
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
    const api = { setTool, setColor, setBrushSize, setFill, setZoom, clear, loadImage, undo, redo };
    // Defaults
    setColor('#ff0000', 1);
    setBrushSize(16);
    setZoom(imageZoom);
    return api;
}