const workspace = document.getElementById('node-window');
const stage = document.getElementById('game-window');
const ctx = stage.getContext('2d');
const grid = document.getElementById('grid');

const objects = [
  {
    id: 0,
    name: "AppController",
    type: "controller",
    media: [
      { id: 1, name: "blue circle", type: "image", path: "/media/blue_circle.png" }
    ],
    code: [
      { id: 0, type: "start", location: {x: 0, y: 0}, content: "start", val_a: null, val_b: null, next_block: 1, position: {x: 20, y: 20} },
      { id: 1, type: "action", location: {x: 0, y: 0}, content: "move_xy", val_a: 5, val_b: 5, next_block: null, position: {x: 20, y: 100} }
    ]
  },
  {
    id: 1,
    name: "Object1",
    type: "object",
    media: [],
    code: [
        { id: 0, type: "start", location: {x: 0, y: 0}, content: "When Created", val_a: null, val_b: null, next_block: 1, position: {x: 20, y: 20} },

    ]
  },
  {
    id: 2,
    name: "Object2",
    type: "object",
    media: [],
    code: []
  },
  {
    id: 3,
    name: "Object3",
    type: "object",
    media: [],
    code: []
  },
  {
    id: 4,
    name: "Object4",
    type: "object",
    media: [],
    code: []
  },
  {
    id: 5,
    name: "Object5",
    type: "object",
    media: [],
    code: []
  },
  {
    id: 6,
    name: "Object6",
    type: "object",
    media: [],
    code: []
  },
  {
    id: 7,
    name: "Object7",
    type: "object",
    media: [],
    code: []
  },
  {
    id: 8,
    name: "Object8",
    type: "object",
    media: [],
    code: []
  },
  {
    id: 9,
    name: "Object9",
    type: "object",
    media: [],
    code: []
  },
  {
    id: 10,
    name: "Object10",
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

// Create a node block
function createNodeBlock(codeData, x, y) {
    const block = document.createElement("div");
    block.className = "node-block";
    block.dataset.codeId = codeData.id;
    block.style.left = `${x}px`;
    block.style.top = `${y}px`;
    block.style.transition = 'transform 0.1s ease-out';
    block.draggable = true;

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

    // Desktop drag events
    block.addEventListener("dragstart", (e) => {
        draggedBlock = block;
        block.classList.add("dragging");
        e.dataTransfer.setData("text/plain", "");
        block.style.transition = 'none';
    });

    block.addEventListener("dragend", () => {
        block.classList.remove("dragging");
        draggedBlock = null;
        block.style.transition = 'transform 0.1s ease-out';
        codeData.position = {
            x: parseFloat(block.style.left),
            y: parseFloat(block.style.top)
        };
        drawConnections();
    });

    // Mobile touch events
    block.addEventListener("touchstart", (e) => {
        e.preventDefault();
        draggedBlock = block;
        block.classList.add("dragging");
        block.style.transition = 'none';
        const touch = e.touches[0];
        touchOffsetX = touch.clientX - block.offsetLeft;
        touchOffsetY = touch.clientY - block.offsetTop;
    });

    block.addEventListener("touchmove", (e) => {
        if (draggedBlock) {
            e.preventDefault();
            const touch = e.touches[0];
            const x = touch.clientX - touchOffsetX;
            const y = touch.clientY - touchOffsetY;
            block.style.left = `${x}px`;
            block.style.top = `${y}px`;
            drawConnections();
        }
    });

    block.addEventListener("touchend", () => {
        if (draggedBlock) {
            block.classList.remove("dragging");
            block.style.transition = 'transform 0.1s ease-out';
            draggedBlock = null;
            codeData.position = {
                x: parseFloat(block.style.left),
                y: parseFloat(block.style.top)
            };
            drawConnections();
        }
    });

    return block;
}

// Canvas for drawing connections
const connectionCanvas = document.createElement("canvas");
connectionCanvas.style.position = "absolute";
connectionCanvas.style.top = "0";
connectionCanvas.style.left = "0";
connectionCanvas.style.pointerEvents = "none";
workspace.appendChild(connectionCanvas);
const connectionCtx = connectionCanvas.getContext("2d");

// Resize canvas to match workspace
function resizeConnectionCanvas() {
    connectionCanvas.width = workspace.offsetWidth;
    connectionCanvas.height = workspace.offsetHeight;
}

// Draw connections between blocks
function drawConnections() {
    resizeConnectionCanvas();
    connectionCtx.clearRect(0, 0, connectionCanvas.width, connectionCanvas.height);
    
    const selectedObj = objects.find(obj => obj.id == selected_object);
    if (!selectedObj) return;

    selectedObj.code.forEach(code => {
        if (code.next_block !== null) {
            const startBlock = workspace.querySelector(`.node-block[data-code-id="${code.id}"]`);
            const endBlock = workspace.querySelector(`.node-block[data-code-id="${code.next_block}"]`);
            
            if (startBlock && endBlock) {
                const startRect = startBlock.getBoundingClientRect();
                const endRect = endBlock.getBoundingClientRect();
                const workspaceRect = workspace.getBoundingClientRect();

                const startX = startRect.left - workspaceRect.left + startRect.width / 2;
                const startY = startRect.bottom - workspaceRect.top;
                const endX = endRect.left - workspaceRect.left + endRect.width / 2;
                const endY = endRect.top - workspaceRect.top;

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

// Update workspace with node blocks
function updateWorkspace() {
    workspace.innerHTML = '';
    workspace.appendChild(connectionCanvas);
    const selectedObj = objects.find(obj => obj.id == selected_object);
    if (!selectedObj) return;

    selectedObj.code.forEach(codeData => {
        const block = createNodeBlock(
            codeData,
            codeData.position.x,
            codeData.position.y
        );
        workspace.appendChild(block);
    });
    
    drawConnections();
}

// Handle workspace drag for desktop
workspace.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (draggedBlock) {
        const rect = workspace.getBoundingClientRect();
        const x = e.clientX - rect.left - (draggedBlock.offsetWidth / 2);
        const y = e.clientY - rect.top - (draggedBlock.offsetHeight / 2);
        draggedBlock.style.left = `${x}px`;
        draggedBlock.style.top = `${y}px`;
        drawConnections();
    }
});

workspace.addEventListener("drop", (e) => {
    e.preventDefault();
    if (draggedBlock) {
        const rect = workspace.getBoundingClientRect();
        const x = e.clientX - rect.left - (draggedBlock.offsetWidth / 2);
        const y = e.clientY - rect.top - (draggedBlock.offsetHeight / 2);
        draggedBlock.style.left = `${x}px`;
        draggedBlock.style.top = `${y}px`;
        const codeId = draggedBlock.dataset.codeId;
        const selectedObj = objects.find(obj => obj.id == selected_object);
        const codeData = selectedObj.code.find(code => code.id == codeId);
        codeData.position = { x, y };
        drawConnections();
    }
});

// Create a box in the grid
function createBox(boxData) {
    const box = document.createElement("div");
    box.className = "box";
    box.dataset.id = boxData.id;

    const name = document.createElement("span");
    name.className = "object-name";
    name.textContent = boxData.name;
    box.appendChild(name);

    box.addEventListener("click", () => {
        document.querySelectorAll('.box').forEach(otherBox => {
            otherBox.classList.remove("selected");
        });
        box.classList.add("selected");
        selected_object = box.dataset.id;
        updateWorkspace();
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

// Initialize workspace
updateWorkspace();


// Update canvas size on window resize
window.addEventListener("resize", () => {
    drawConnections();
});