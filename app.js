// Game State Management
let gameState = 'NORMAL'; // Transitions: 'NORMAL' -> 'DOUBLE_1' -> 'DOUBLE_2' -> 'FINISHED'
let currentSlices = [];
let doubleVariantSelections = [];

const NO_VARIANT_NAME = 'No Variants (Rewards only)';
const DOUBLE_VARIANT_NAME = 'Double Variant';
const MIN_PROBABILITY = 0;
const MAX_PROBABILITY = 99;

const baseOptions = WHEEL_CONFIG.options.map(option => ({ ...option }));
const configState = {
    noVariantProbability: clamp(
        Number.isFinite(WHEEL_CONFIG.noVariantProbability) ? WHEEL_CONFIG.noVariantProbability : 50,
        MIN_PROBABILITY,
        MAX_PROBABILITY
    ),
    options: baseOptions.map(option => ({ ...option }))
};

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

// Generate synthesized mechanical peg clicks, loudness follows the real impact speed
function playClickSound(impactSpeed = 1) {
    if (!audioCtx) return;
    const strength = clamp(impactSpeed / 5, 0.12, 1);
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(420 + (strength * 420), audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(120, audioCtx.currentTime + 0.035);

    gain.gain.setValueAtTime(0.02 + (strength * 0.06), audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.035);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.035);
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

const configPanel = document.getElementById('config-panel');
const toggleConfigBtn = document.getElementById('toggle-config-btn');
const noVariantProbabilityInput = document.getElementById('no-variant-probability');
const configOptionsList = document.getElementById('config-options-list');
const applyConfigBtn = document.getElementById('apply-config-btn');
const resetConfigBtn = document.getElementById('reset-config-btn');

let canvasSize = 460;
let cx = canvasSize / 2;
let cy = canvasSize / 2;
let radius = 210;
let pixelsPerMetre = 1;

// Rigid-body simulation of the wheel and the flapper (see physics.js)
const sim = WheelPhysics.createWheelSimulation();

// Enough room above the rim for the peg ring and the flapper hinge
const CANVAS_FILL = 1 / ((sim.geometry.pivotDistance / sim.geometry.wheelRadius) + 0.06);

// Track scaling matches CSS media queries
function resizeCanvas() {
    const width = canvas.parentElement.clientWidth;
    canvas.width = width;
    canvas.height = width;
    canvasSize = width;
    cx = canvasSize / 2;
    cy = canvasSize / 2;
    radius = (canvasSize / 2) * CANVAS_FILL;
    pixelsPerMetre = radius / sim.geometry.wheelRadius;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

const MIN_SPIN_SPEED = 14;   // rad/s, a firm two-handed pull
const MAX_SPIN_SPEED = 20;
const MAX_CLICKS_PER_FRAME = 4;

let isSpinning = false;
let lastFrameTime = null;

function toScreenX(metres) {
    return cx + (metres * pixelsPerMetre);
}

function toScreenY(metres) {
    return cy + (metres * pixelsPerMetre);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizePositive(angle) {
    const twoPi = 2 * Math.PI;
    return ((angle % twoPi) + twoPi) % twoPi;
}

function getNoVariantOption() {
    return configState.options.find(option => option.name === NO_VARIANT_NAME);
}

function getOtherOptions() {
    return configState.options.filter(option => option.name !== NO_VARIANT_NAME);
}

function sanitizeOptionWeights() {
    getOtherOptions().forEach(option => {
        option.weight = Math.max(0, Math.round(option.weight || 0));
    });
}

function computeNoVariantWeight() {
    sanitizeOptionWeights();
    const othersWeightSum = getOtherOptions().reduce((sum, option) => sum + option.weight, 0);
    const probability = clamp(configState.noVariantProbability, MIN_PROBABILITY, MAX_PROBABILITY) / 100;

    if (othersWeightSum <= 0) return 1;
    if (probability <= 0) return 0;

    const ratio = probability / (1 - probability);
    return Math.max(1, Math.round(othersWeightSum * ratio));
}

function syncNoVariantWeight() {
    const noVariant = getNoVariantOption();
    if (!noVariant) return;
    noVariant.weight = computeNoVariantWeight();
}

// Interleaves segments cleanly so high-weight values are evenly spaced
function intersperseSlices(slices) {
    const groups = {};
    slices.forEach(slice => {
        if (!groups[slice.name]) groups[slice.name] = [];
        groups[slice.name].push(slice);
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
            index = (index + 2) % slices.length;
        });
    });

    return result;
}

// One peg per slice boundary, so the flapper always rests inside a slice
function syncPegCounter() {
    sim.setPegCount(currentSlices.length);
}

// Dynamically populates wheel state from custom configuration rules
function buildWheelPool(excludedNames = []) {
    syncNoVariantWeight();

    const rawPool = [];
    configState.options.forEach(option => {
        if (!excludedNames.includes(option.name) && option.weight > 0) {
            for (let i = 0; i < option.weight; i++) {
                rawPool.push({ name: option.name, color: option.color });
            }
        }
    });

    if (!rawPool.length) {
        const fallback = getNoVariantOption() || { name: NO_VARIANT_NAME, color: '#16162a', weight: 1 };
        rawPool.push({ name: fallback.name, color: fallback.color });
    }

    currentSlices = intersperseSlices(rawPool);
    updateUIOptionPool(excludedNames);
    syncPegCounter();
}

// Displays visible labels of variants in the pool indicator panel
function updateUIOptionPool(excludedNames) {
    poolList.innerHTML = '';
    const added = new Set();

    configState.options.forEach(option => {
        if (!excludedNames.includes(option.name) && !added.has(option.name) && option.weight > 0) {
            added.add(option.name);
            const badge = document.createElement('div');
            badge.className = 'pool-item';
            badge.style.borderLeft = `4px solid ${option.color}`;

            if (option.name === NO_VARIANT_NAME) {
                badge.textContent = `${option.name} (P:${configState.noVariantProbability}%, Auto W:${option.weight})`;
            } else {
                badge.textContent = `${option.name} (W:${option.weight})`;
            }

            poolList.appendChild(badge);
        }
    });
}

function renderConfigForm() {
    noVariantProbabilityInput.value = configState.noVariantProbability;
    configOptionsList.innerHTML = '';

    getOtherOptions().forEach(option => {
        const row = document.createElement('div');
        row.className = 'config-row';

        const label = document.createElement('label');
        label.textContent = option.name;

        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '1';
        input.value = option.weight;
        input.dataset.optionName = option.name;

        row.appendChild(label);
        row.appendChild(input);
        configOptionsList.appendChild(row);
    });
}

function getStateExclusions() {
    if (gameState === 'DOUBLE_1') {
        return [NO_VARIANT_NAME, DOUBLE_VARIANT_NAME];
    }
    if (gameState === 'DOUBLE_2') {
        return [NO_VARIANT_NAME, DOUBLE_VARIANT_NAME, doubleVariantSelections[0]];
    }
    return [];
}

function rebuildCurrentPoolForState() {
    buildWheelPool(getStateExclusions());
}

// Canvas render loop containing physics ticks & bulb blinking animations
function drawWheel() {
    ctx.clearRect(0, 0, canvasSize, canvasSize);

    const numSlices = currentSlices.length;
    if (!numSlices) return;

    const sliceAngle = (2 * Math.PI) / numSlices;
    const wheelAngle = sim.state.wheelAngle;

    // Draw slices
    for (let i = 0; i < numSlices; i++) {
        const startAngle = wheelAngle + i * sliceAngle;
        const endAngle = wheelAngle + (i + 1) * sliceAngle;

        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = currentSlices[i].color;
        ctx.fill();

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
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
        if (text.length > 20) text = `${text.substring(0, 18)}...`;

        ctx.fillText(text, radius - 15, 0);
        ctx.restore();
    }

    const gloss = ctx.createRadialGradient(cx - radius * 0.35, cy - radius * 0.45, radius * 0.2, cx, cy, radius);
    gloss.addColorStop(0, 'rgba(255,255,255,0.24)');
    gloss.addColorStop(0.6, 'rgba(255,255,255,0.02)');
    gloss.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
    ctx.fillStyle = gloss;
    ctx.fill();

    // Draw wheel rim for depth
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 1.5, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, radius - 9, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.lineWidth = 5;
    ctx.stroke();

    // Draw the pegs exactly where the simulation keeps them
    const pegPixelRadius = sim.geometry.pegRadius * pixelsPerMetre;
    for (let i = 0; i < numSlices; i++) {
        const peg = sim.getPegPosition(i);
        const px = toScreenX(peg.x);
        const py = toScreenY(peg.y);

        const pegGradient = ctx.createRadialGradient(
            px - (pegPixelRadius * 0.4), py - (pegPixelRadius * 0.4), pegPixelRadius * 0.2,
            px, py, pegPixelRadius
        );
        pegGradient.addColorStop(0, 'rgba(255,255,255,0.95)');
        pegGradient.addColorStop(0.55, 'rgba(220,220,230,0.95)');
        pegGradient.addColorStop(1, 'rgba(80,80,90,1)');

        ctx.beginPath();
        ctx.arc(px, py, pegPixelRadius, 0, 2 * Math.PI);
        ctx.fillStyle = pegGradient;
        ctx.fill();
    }

    // Draw central hub cap
    const hubGradient = ctx.createRadialGradient(cx - 8, cy - 10, 2, cx, cy, 32);
    hubGradient.addColorStop(0, '#ffffff');
    hubGradient.addColorStop(0.25, '#b4c1db');
    hubGradient.addColorStop(1, '#111526');

    ctx.beginPath();
    ctx.arc(cx, cy, 30, 0, 2 * Math.PI);
    ctx.fillStyle = hubGradient;
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 3;
    ctx.fill();
    ctx.stroke();

    // Alternate blinking light bulb borders (Wheel of Fortune style)
    const numBulbs = 24;
    const isLitState = Math.floor(Date.now() / 220) % 2 === 0;

    for (let i = 0; i < numBulbs; i++) {
        const bulbAngle = (i * 2 * Math.PI) / numBulbs;
        const bx = cx + (radius * 1.055) * Math.cos(bulbAngle);
        const by = cy + (radius * 1.055) * Math.sin(bulbAngle);

        ctx.beginPath();
        ctx.arc(bx, by, radius * 0.016, 0, 2 * Math.PI);
        if ((i % 2 === 0 && isLitState) || (i % 2 !== 0 && !isLitState)) {
            ctx.fillStyle = '#ffe600';
        } else {
            ctx.fillStyle = '#4b4b5e';
        }
        ctx.fill();
    }
}

// Draws the flapper (the arrow) as the rigid rod the simulation solves for
function drawFlapper() {
    const pivot = sim.geometry.pivot;
    const tip = sim.getFlapperTip();

    const pivotX = toScreenX(pivot.x);
    const pivotY = toScreenY(pivot.y);
    const tipX = toScreenX(tip.x);
    const tipY = toScreenY(tip.y);
    const thickness = sim.geometry.flapperHalfThickness * 2 * pixelsPerMetre;

    ctx.save();
    ctx.shadowColor = 'rgba(255, 0, 127, 0.85)';
    ctx.shadowBlur = Math.max(6, radius * 0.05);

    // Body of the flapper, drawn as the capsule the collision solver uses
    const bodyGradient = ctx.createLinearGradient(pivotX, pivotY, tipX, tipY);
    bodyGradient.addColorStop(0, '#fff6b5');
    bodyGradient.addColorStop(0.45, '#ff9f43');
    bodyGradient.addColorStop(1, '#ff007f');

    ctx.beginPath();
    ctx.moveTo(pivotX, pivotY);
    ctx.lineTo(tipX, tipY);
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(4, thickness * 2.6);
    ctx.strokeStyle = bodyGradient;
    ctx.stroke();

    ctx.shadowBlur = 0;

    // Hinge bracket
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, Math.max(4, radius * 0.028), 0, 2 * Math.PI);
    ctx.fillStyle = '#c9d3e8';
    ctx.strokeStyle = '#0b0d18';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();

    // Contact tip
    ctx.beginPath();
    ctx.arc(tipX, tipY, Math.max(2.5, thickness), 0, 2 * Math.PI);
    ctx.fillStyle = '#ffe6f4';
    ctx.fill();
    ctx.restore();
}

// Impacts reported by the solver drive the mechanical clatter
function playImpactSounds(impacts) {
    if (!impacts.length) return;

    impacts
        .slice()
        .sort((a, b) => b.speed - a.speed)
        .slice(0, MAX_CLICKS_PER_FRAME)
        .forEach(impact => {
            if (impact.speed > 0.05) playClickSound(impact.speed);
        });
}

function getWinningIndex() {
    if (!currentSlices.length) return 0;
    return clamp(sim.getSelectedIndex(), 0, currentSlices.length - 1);
}

function finishSpin() {
    isSpinning = false;
    spinBtn.disabled = false;
    handleResult(getWinningIndex());
}

function updateSpinningPhysics(dt) {
    playImpactSounds(sim.step(dt));

    if (sim.isAtRest()) {
        finishSpin();
    }
}

// Advances the rigid-body simulation and redraws the machine each frame
function updatePhysics(timestamp = 0) {
    const dt = lastFrameTime === null ? (1 / 60) : Math.min(0.05, (timestamp - lastFrameTime) / 1000);
    lastFrameTime = timestamp;

    if (isSpinning) {
        updateSpinningPhysics(dt);
    } else if (!sim.isAtRest()) {
        // Keep the flapper alive (it can still swing) even when nothing spins
        sim.step(dt);
    }

    drawWheel();
    drawFlapper();
    requestAnimationFrame(updatePhysics);
}

// Logic engine for standard spins and Double Variant branching choices
function handleResult(winningIndex) {
    const winner = currentSlices[winningIndex];

    if (gameState === 'NORMAL') {
        if (winner.name === DOUBLE_VARIANT_NAME) {
            gameState = 'DOUBLE_1';
            playDoubleWarpSound();
            statusLabel.textContent = 'CRITICAL EVENT DETECTED!';
            resultDisplay.textContent = 'DOUBLE VARIANT! Transitioning...';

            triggerWarpTransition(() => {
                buildWheelPool([NO_VARIANT_NAME, DOUBLE_VARIANT_NAME]);
                statusLabel.textContent = 'Double Variant Selection (1/2)';
                resultDisplay.textContent = 'Spin to select the First Variant!';
                spinBtn.textContent = 'SPIN VARIANT 1';
            });
        } else {
            gameState = 'FINISHED';
            playWinChime();
            statusLabel.textContent = 'Selected Variant';
            resultDisplay.textContent = winner.name;
            spinBtn.textContent = 'RESET WHEEL';
        }
    } else if (gameState === 'DOUBLE_1') {
        doubleVariantSelections.push(winner.name);
        playWinChime();
        statusLabel.textContent = 'First Variant Locked!';
        resultDisplay.textContent = `${winner.name}! Preparing phase 2...`;
        spinBtn.disabled = true;

        setTimeout(() => {
            triggerWarpTransition(() => {
                buildWheelPool([NO_VARIANT_NAME, DOUBLE_VARIANT_NAME, doubleVariantSelections[0]]);
                gameState = 'DOUBLE_2';
                statusLabel.textContent = 'Double Variant Selection (2/2)';
                resultDisplay.textContent = `Got [${doubleVariantSelections[0]}]. Spin for second option!`;
                spinBtn.textContent = 'SPIN VARIANT 2';
                spinBtn.disabled = false;
            });
        }, 1800);
    } else if (gameState === 'DOUBLE_2') {
        doubleVariantSelections.push(winner.name);
        gameState = 'FINISHED';
        playWinChime();
        statusLabel.textContent = 'Double Variant Selected!';
        resultDisplay.innerHTML = `<span style="font-size: 1.25rem; color:#ff9ff3;">${doubleVariantSelections[0]}</span><br>&<br><span style="font-size: 1.25rem; color:#ff9ff3;">${doubleVariantSelections[1]}</span>`;
        spinBtn.textContent = 'RESET WHEEL';
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

function startSpin() {
    if (!currentSlices.length) return;
    isSpinning = true;
    spinBtn.disabled = true;
    syncPegCounter();
    sim.spin(MIN_SPIN_SPEED + (Math.random() * (MAX_SPIN_SPEED - MIN_SPIN_SPEED)));
}

function resetGame() {
    gameState = 'NORMAL';
    doubleVariantSelections = [];
    isSpinning = false;
    sim.reset();
    rebuildCurrentPoolForState();
    statusLabel.textContent = 'Ready to Roll';
    resultDisplay.textContent = 'Spin the wheel to begin!';
    spinBtn.textContent = 'SPIN WHEEL';
}

function applyConfigFromForm() {
    const probabilityValue = parseInt(noVariantProbabilityInput.value, 10);
    configState.noVariantProbability = Number.isFinite(probabilityValue)
        ? clamp(probabilityValue, MIN_PROBABILITY, MAX_PROBABILITY)
        : 50;

    configOptionsList.querySelectorAll('input[data-option-name]').forEach(input => {
        const option = configState.options.find(item => item.name === input.dataset.optionName);
        if (!option) return;

        const weightValue = parseInt(input.value, 10);
        option.weight = Number.isFinite(weightValue) ? Math.max(0, weightValue) : option.weight;
    });

    syncNoVariantWeight();
    renderConfigForm();
    rebuildCurrentPoolForState();

    if (gameState === 'FINISHED') {
        statusLabel.textContent = 'Configuration Updated';
        resultDisplay.textContent = 'Press RESET WHEEL to spin with new settings';
    }
}

function resetConfig() {
    configState.options = baseOptions.map(option => ({ ...option }));
    configState.noVariantProbability = clamp(
        Number.isFinite(WHEEL_CONFIG.noVariantProbability) ? WHEEL_CONFIG.noVariantProbability : 50,
        MIN_PROBABILITY,
        MAX_PROBABILITY
    );

    syncNoVariantWeight();
    renderConfigForm();
    rebuildCurrentPoolForState();

    statusLabel.textContent = 'Configuration Reset';
    resultDisplay.textContent = 'Wheel settings restored to defaults';
}

// Trigger action bound to the primary CTA element
spinBtn.addEventListener('click', () => {
    initAudio();

    if (gameState === 'FINISHED') {
        resetGame();
        return;
    }

    if (!isSpinning) {
        startSpin();
    }
});

toggleConfigBtn.addEventListener('click', () => {
    const nowHidden = !configPanel.hasAttribute('hidden');
    if (nowHidden) {
        configPanel.setAttribute('hidden', 'hidden');
        toggleConfigBtn.textContent = 'Configure Wheel';
    } else {
        configPanel.removeAttribute('hidden');
        toggleConfigBtn.textContent = 'Hide Configuration';
    }
});

applyConfigBtn.addEventListener('click', () => {
    if (isSpinning) return;
    applyConfigFromForm();
});

resetConfigBtn.addEventListener('click', () => {
    if (isSpinning) return;
    resetConfig();
});

// Setup primary base configuration on script launch
syncNoVariantWeight();
renderConfigForm();
buildWheelPool([]);
updatePhysics();
