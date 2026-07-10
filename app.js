// app.js

// Game State Management
let gameState = 'NORMAL'; // Transitions: 'NORMAL' -> 'DOUBLE_1' -> 'DOUBLE_2' -> 'FINISHED'
let currentSlices = [];
let doubleVariantSelections = [];

// Audio Context (Initialized securely on first user click)
let audioCtx = null;

function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

// Generate synthesized mechanical peg clicks
function playClickSound() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(550, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(80, audioCtx.currentTime + 0.03);
    
    gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.03);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 0.03);
}

// Synthesize custom victorious chimes
function playWinChime() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const playNote = (freq, start, duration) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.12, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
        osc.start(start);
        osc.stop(start + duration);
    };
    playNote(523.25, now, 0.15);       // C5
    playNote(659.25, now + 0.12, 0.15); // E5
    playNote(783.99, now + 0.24, 0.15); // G5
    playNote(1046.50, now + 0.36, 0.4); // C6
}

// Epic deep-space warp sound for Double Variant triggers
function playDoubleWarpSound() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.linearRampToValueAtTime(850, now + 0.85);
    
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.85);
    
    osc.start();
    osc.stop(now + 0.85);
}

// Canvas & Spin Setup
const canvas = document.getElementById('wheel-canvas');
const ctx = canvas.getContext('2d');
const spinBtn = document.getElementById('spin-btn');
const statusLabel = document.getElementById('status-label');
const resultDisplay = document.getElementById('result-display');
const poolList = document.getElementById('pool-list');

let canvasSize = 460;
let cx = canvasSize / 2;
let cy = canvasSize / 2;
let radius = 210;

// Track scaling matches CSS media queries
function resizeCanvas() {
    const width = canvas.parentElement.clientWidth;
    canvas.width = width;
    canvas.height = width;
    canvasSize = width;
    cx = canvasSize / 2;
    cy = canvasSize / 2;
    radius = (canvasSize / 2) - 15;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

let currentAngle = 0;
let angularVelocity = 0;
const friction = 0.982; // Controls deceleration rate
let isSpinning = false;
let lastTickIndex = -1;

// Interleaves segments cleanly so high-weight values are evenly spaced
function intersperseSlices(slices) {
    const groups = {};
    slices.forEach(s => {
        if (!groups[s.name]) groups[s.name] = [];
        groups[s.name].push(s);
    });
    
    const sortedGroups = Object.values(groups).sort((a, b) => b.length - a.length);
    const result = new Array(slices.length);
    let index = 0;
    
    sortedGroups.forEach(group => {
        group.forEach(item => {
            while (result[index] !== undefined) {
                index = (index + 1) % slices.length;
            }
            result[index] = item;
            index = (index + 2) % slices.length; // Space placement intervals
        });
    });
    
    return result;
}

// Dynamically populates wheel state from custom configuration rules
function buildWheelPool(excludedNames = []) {
    let rawPool = [];
    WHEEL_CONFIG.options.forEach(opt => {
        if (!excludedNames.includes(opt.name)) {
            for (let i = 0; i < opt.weight; i++) {
                rawPool.push({ name: opt.name, color: opt.color });
            }
        }
    });

    currentSlices = intersperseSlices(rawPool);
    updateUIOptionPool(excludedNames);
}

// Displays visible labels of variants in the pool indicator panel
function updateUIOptionPool(excludedNames) {
    poolList.innerHTML = '';
    const added = new Set();
    WHEEL_CONFIG.options.forEach(opt => {
        if (!excludedNames.includes(opt.name) && !added.has(opt.name)) {
            added.add(opt.name);
            const badge = document.createElement('div');
            badge.className = 'pool-item';
            badge.style.borderLeft = `4px solid ${opt.color}`;
            badge.textContent = `${opt.name} (${opt.weight > 0 ? 'W:' + opt.weight : 'Excluded'})`;
            poolList.appendChild(badge);
        }
    });
}

// Canvas render loop containing physics ticks & bulb blinking animations
function drawWheel() {
    ctx.clearRect(0, 0, canvasSize, canvasSize);

    const numSlices = currentSlices.length;
    const sliceAngle = (2 * Math.PI) / numSlices;

    // Draw slices
    for (let i = 0; i < numSlices; i++) {
        const startAngle = currentAngle + i * sliceAngle;
        const endAngle = currentAngle + (i + 1) * sliceAngle;

        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = currentSlices[i].color;
        ctx.fill();

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Draw segment text
        ctx.save();
        ctx.translate(cx, cy);
        const midAngle = startAngle + sliceAngle / 2;
        ctx.rotate(midAngle);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px "Exo 2", sans-serif';
        if (canvasSize < 350) ctx.font = 'bold 9px "Exo 2", sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        
        let text = currentSlices[i].name;
        if (text.length > 20) text = text.substring(0, 18) + '...';

        ctx.fillText(text, radius - 15, 0);
        ctx.restore();
    }

    // Draw central hub cap
    ctx.beginPath();
    ctx.arc(cx, cy, 30, 0, 2 * Math.PI);
    ctx.fillStyle = '#151226';
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 3;
    ctx.fill();
    ctx.stroke();

    // Alternate blinking light bulb borders (Wheel of Fortune style)
    const numBulbs = 20;
    const isLitState = Math.floor(Date.now() / 250) % 2 === 0;

    for (let i = 0; i < numBulbs; i++) {
        const bulbAngle = (i * 2 * Math.PI) / numBulbs;
        const bx = cx + (radius + 6) * Math.cos(bulbAngle);
        const by = cy + (radius + 6) * Math.sin(bulbAngle);

        ctx.beginPath();
        ctx.arc(bx, by, 3.5, 0, 2 * Math.PI);
        if ((i % 2 === 0 && isLitState) || (i % 2 !== 0 && !isLitState)) {
            ctx.fillStyle = '#ffe600';
        } else {
            ctx.fillStyle = '#444455';
        }
        ctx.fill();
    }
}

// Updates rotation values and plays click sounds on slice margins
function updatePhysics() {
    if (isSpinning) {
        currentAngle += angularVelocity;
        angularVelocity *= friction;

        const numSlices = currentSlices.length;
        const sliceAngle = (2 * Math.PI) / numSlices;
        
        // Target index relative to the top physical pointer (3/2 PI)
        const pointerAngle = 1.5 * Math.PI;
        let targetAngle = (pointerAngle - currentAngle) % (2 * Math.PI);
        if (targetAngle < 0) targetAngle += 2 * Math.PI;

        const currentTickIndex = Math.floor(targetAngle / sliceAngle);

        if (currentTickIndex !== lastTickIndex) {
            playClickSound();
            lastTickIndex = currentTickIndex;
        }

        if (angularVelocity < 0.001) {
            angularVelocity = 0;
            isSpinning = false;
            spinBtn.disabled = false;
            handleResult(currentTickIndex);
        }
    }
    drawWheel();
    requestAnimationFrame(updatePhysics);
}

// Logic engine for standard spins and Double Variant branching choices
function handleResult(winningIndex) {
    const winner = currentSlices[winningIndex];
    
    if (gameState === 'NORMAL') {
        if (winner.name === 'Double Variant') {
            gameState = 'DOUBLE_1';
            playDoubleWarpSound();
            statusLabel.textContent = "CRITICAL EVENT DETECTED!";
            resultDisplay.textContent = "DOUBLE VARIANT! Transitioning...";
            
            triggerWarpTransition(() => {
                buildWheelPool(['No Variants (Rewards only)', 'Double Variant']);
                statusLabel.textContent = "Double Variant Selection (1/2)";
                resultDisplay.textContent = "Spin to select the First Variant!";
                spinBtn.textContent = "SPIN VARIANT 1";
            });
        } else {
            gameState = 'FINISHED';
            playWinChime();
            statusLabel.textContent = "Selected Variant";
            resultDisplay.textContent = winner.name;
            spinBtn.textContent = "RESET WHEEL";
        }
    } else if (gameState === 'DOUBLE_1') {
        doubleVariantSelections.push(winner.name);
        playWinChime();
        statusLabel.textContent = "First Variant Locked!";
        resultDisplay.textContent = `${winner.name}! Preparing phase 2...`;
        spinBtn.disabled = true;

        setTimeout(() => {
            triggerWarpTransition(() => {
                buildWheelPool(['No Variants (Rewards only)', 'Double Variant', doubleVariantSelections[0]]);
                gameState = 'DOUBLE_2';
                statusLabel.textContent = "Double Variant Selection (2/2)";
                resultDisplay.textContent = `Got [${doubleVariantSelections[0]}]. Spin for second option!`;
                spinBtn.textContent = "SPIN VARIANT 2";
                spinBtn.disabled = false;
            });
        }, 1800);
    } else if (gameState === 'DOUBLE_2') {
        doubleVariantSelections.push(winner.name);
        gameState = 'FINISHED';
        playWinChime();
        statusLabel.textContent = "Double Variant Selected!";
        resultDisplay.innerHTML = `<span style="font-size: 1.25rem; color:#ff9ff3;">${doubleVariantSelections[0]}</span><br>&<br><span style="font-size: 1.25rem; color:#ff9ff3;">${doubleVariantSelections[1]}</span>`;
        spinBtn.textContent = "RESET WHEEL";
    }
}

// Warps the visual rendering temporarily when swapping pools
function triggerWarpTransition(midpointCallback) {
    canvas.classList.add('transitioning');
    setTimeout(() => {
        midpointCallback();
        canvas.classList.remove('transitioning');
    }, 500);
}

// Trigger action bound to the primary CTA element
spinBtn.addEventListener('click', () => {
    initAudio();

    if (gameState === 'FINISHED') {
        // Reset full sequence back to primary state
        gameState = 'NORMAL';
        doubleVariantSelections = [];
        buildWheelPool([]);
        statusLabel.textContent = "Ready to Roll";
        resultDisplay.textContent = "Spin the wheel to begin!";
        spinBtn.textContent = "SPIN WHEEL";
        return;
    }

    if (!isSpinning) {
        isSpinning = true;
        spinBtn.disabled = true;
        // Generate high randomized force speed values
        angularVelocity = 0.35 + Math.random() * 0.25;
    }
});

// Setup primary base configuration on script launch
buildWheelPool([]);
updatePhysics();