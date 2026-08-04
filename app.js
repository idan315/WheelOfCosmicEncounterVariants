// Returns '#000000' for light backgrounds and '#ffffff' for dark ones
function getTextColorForBg(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // Perceived luminance (ITU-R BT.601)
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    return luminance > 160 ? '#000000' : '#ffffff';
}

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
let masterGain = null;
let noiseBuffer = null;
let spinNoise = null;

function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.9;
        masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

// One second of white noise, reused by every percussive/whoosh voice
function getNoiseBuffer() {
    if (!noiseBuffer) {
        const length = Math.floor(audioCtx.sampleRate);
        noiseBuffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < length; i++) {
            data[i] = (Math.random() * 2) - 1;
        }
    }
    return noiseBuffer;
}

// Generate synthesized mechanical peg clicks, loudness follows the real impact speed
function playClickSound(impactSpeed = 1) {
    if (!audioCtx) return;
    const strength = clamp(impactSpeed / 5, 0.12, 1);
    const now = audioCtx.currentTime;
    const variation = 0.92 + (Math.random() * 0.16);

    // Sharp noise transient: the plastic flapper slapping the metal peg
    const noise = audioCtx.createBufferSource();
    noise.buffer = getNoiseBuffer();
    noise.playbackRate.value = 0.8 + (strength * 0.6);

    const bandpass = audioCtx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.setValueAtTime((1500 + (strength * 2400)) * variation, now);
    bandpass.frequency.exponentialRampToValueAtTime(700, now + 0.05);
    bandpass.Q.value = 5;

    const noiseGain = audioCtx.createGain();
    noiseGain.gain.setValueAtTime(0.03 + (strength * 0.1), now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.05);

    noise.connect(bandpass);
    bandpass.connect(noiseGain);
    noiseGain.connect(masterGain);
    noise.start(now);
    noise.stop(now + 0.06);

    // Woody body resonance beneath the transient
    const osc = audioCtx.createOscillator();
    const oscGain = audioCtx.createGain();
    osc.connect(oscGain);
    oscGain.connect(masterGain);

    osc.type = 'triangle';
    osc.frequency.setValueAtTime((330 + (strength * 300)) * variation, now);
    osc.frequency.exponentialRampToValueAtTime(95, now + 0.07);

    oscGain.gain.setValueAtTime(0.018 + (strength * 0.045), now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.start(now);
    osc.stop(now + 0.09);
}

// Low rushing whoosh that lives for as long as the wheel is turning
function startSpinSound() {
    if (!audioCtx) return;
    stopSpinSound();

    const source = audioCtx.createBufferSource();
    source.buffer = getNoiseBuffer();
    source.loop = true;

    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(240, audioCtx.currentTime);
    filter.Q.value = 1.4;

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    source.start();

    spinNoise = { source, filter, gain };
}

// Whoosh brightness and loudness track the actual wheel speed
function updateSpinSound(wheelSpeed) {
    if (!audioCtx || !spinNoise) return;
    const now = audioCtx.currentTime;
    const intensity = clamp(Math.abs(wheelSpeed) / MAX_SPIN_SPEED, 0, 1);

    spinNoise.gain.gain.setTargetAtTime(0.006 + (intensity * 0.07), now, 0.08);
    spinNoise.filter.frequency.setTargetAtTime(200 + (intensity * 900), now, 0.08);
}

function stopSpinSound() {
    if (!audioCtx || !spinNoise) return;
    const { source, gain } = spinNoise;
    const now = audioCtx.currentTime;

    gain.gain.cancelScheduledValues(now);
    gain.gain.setTargetAtTime(0.0001, now, 0.05);
    try {
        source.stop(now + 0.35);
    } catch (error) {
        // Older browsers throw if the source already stopped
    }
    spinNoise = null;
}

// Heavy mechanical thunk played the moment the wheel settles on a slice
function playSettleSound() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;

    const osc = audioCtx.createOscillator();
    const oscGain = audioCtx.createGain();
    osc.connect(oscGain);
    oscGain.connect(masterGain);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(55, now + 0.22);

    oscGain.gain.setValueAtTime(0.16, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

    osc.start(now);
    osc.stop(now + 0.3);

    const noise = audioCtx.createBufferSource();
    noise.buffer = getNoiseBuffer();

    const lowpass = audioCtx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(900, now);
    lowpass.frequency.exponentialRampToValueAtTime(180, now + 0.16);

    const noiseGain = audioCtx.createGain();
    noiseGain.gain.setValueAtTime(0.07, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.18);

    noise.connect(lowpass);
    lowpass.connect(noiseGain);
    noiseGain.connect(masterGain);
    noise.start(now);
    noise.stop(now + 0.2);
}

// Synthesize custom victorious chimes
function playWinChime() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const playNote = (freq, start, duration) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(masterGain);
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
    gain.connect(masterGain);

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
const addConfigRowBtn = document.getElementById('add-config-row-btn');

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

// Colors handed out to freshly added rows
const NEW_OPTION_COLORS = [
    '#ff6b81', '#48dbfb', '#1dd1a1', '#feca57', '#c56cf0',
    '#ff9f43', '#00d2d3', '#5f27cd', '#ee5253', '#a4b0be'
];

function pickNewOptionColor() {
    const used = new Set(configState.options.map(option => option.color));
    const available = NEW_OPTION_COLORS.find(color => !used.has(color));
    return available || NEW_OPTION_COLORS[configState.options.length % NEW_OPTION_COLORS.length];
}

// Editable row: free-text name, weight, and a remove button
function createOptionRow(option) {
    const row = document.createElement('div');
    row.className = 'config-row config-option-row';
    row.dataset.color = option.color;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'config-name-input';
    nameInput.dataset.role = 'name';
    nameInput.placeholder = 'Variant name';
    nameInput.value = option.name;

    const weightInput = document.createElement('input');
    weightInput.type = 'number';
    weightInput.className = 'config-weight-input';
    weightInput.dataset.role = 'weight';
    weightInput.min = '0';
    weightInput.step = '1';
    weightInput.value = option.weight;
    weightInput.title = 'Weight';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-small btn-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = `Remove ${option.name || 'this row'}`;
    removeBtn.addEventListener('click', () => {
        if (isSpinning) return;
        row.remove();
        applyConfigFromForm();
    });

    row.appendChild(nameInput);
    row.appendChild(weightInput);
    row.appendChild(removeBtn);
    return row;
}

function renderConfigForm() {
    noVariantProbabilityInput.value = configState.noVariantProbability;
    configOptionsList.innerHTML = '';

    getOtherOptions().forEach(option => {
        configOptionsList.appendChild(createOptionRow(option));
    });
}

function addConfigRow() {
    const row = createOptionRow({ name: '', weight: 1, color: pickNewOptionColor() });
    configOptionsList.appendChild(row);
    row.scrollIntoView({ block: 'nearest' });
    row.querySelector('input[data-role="name"]').focus();
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

        ctx.fillStyle = getTextColorForBg(currentSlices[i].color);
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
    stopSpinSound();
    playSettleSound();
    handleResult(getWinningIndex());
}

function updateSpinningPhysics(dt) {
    playImpactSounds(sim.step(dt));
    updateSpinSound(sim.state.wheelOmega);

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
            spinBtn.textContent = 'SPIN AGAIN';
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
        spinBtn.textContent = 'SPIN AGAIN';
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
    statusLabel.textContent = 'Spinning...';
    resultDisplay.textContent = 'The wheel is turning!';
    startSpinSound();
    syncPegCounter();
    sim.spin(MIN_SPIN_SPEED + (Math.random() * (MAX_SPIN_SPEED - MIN_SPIN_SPEED)));
}

function resetGame() {
    gameState = 'NORMAL';
    doubleVariantSelections = [];
    isSpinning = false;
    stopSpinSound();
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

    const editedOptions = [];
    configOptionsList.querySelectorAll('.config-option-row').forEach(row => {
        const name = row.querySelector('input[data-role="name"]').value.trim();
        if (!name || name === NO_VARIANT_NAME) return;
        if (editedOptions.some(option => option.name === name)) return;

        const weightValue = parseInt(row.querySelector('input[data-role="weight"]').value, 10);
        editedOptions.push({
            name,
            weight: Number.isFinite(weightValue) ? Math.max(0, weightValue) : 1,
            color: row.dataset.color
        });
    });

    const noVariant = getNoVariantOption() || { name: NO_VARIANT_NAME, weight: 1, color: '#16162a' };
    configState.options = [noVariant, ...editedOptions];

    // A pool rebuilt mid-game must not reference variants that no longer exist
    doubleVariantSelections = doubleVariantSelections.filter(
        selection => configState.options.some(option => option.name === selection)
    );

    syncNoVariantWeight();
    renderConfigForm();
    rebuildCurrentPoolForState();

    if (gameState === 'FINISHED') {
        statusLabel.textContent = 'Configuration Updated';
        resultDisplay.textContent = 'Press SPIN AGAIN to spin with new settings';
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

// Drag-to-spin gesture on the wheel canvas
// Tracks the pointer/touch angle around the wheel centre and translates the
// resulting angular velocity into a sim.spin() call on release.
(function attachDragSpin() {
    const MIN_DRAG_SPEED = 1.5;   // rad/s — below this a tap is ignored
    const VELOCITY_WINDOW = 0.12; // seconds of history used to compute flick speed

    let dragging = false;
    let lastAngle = 0;
    let samples = [];             // { t, angle } circular buffer

    function getCanvasAngle(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = (clientX - rect.left) * scaleX - cx;
        const y = (clientY - rect.top) * scaleY - cy;
        return Math.atan2(y, x);
    }

    function onDragStart(clientX, clientY) {
        initAudio();
        dragging = true;
        lastAngle = getCanvasAngle(clientX, clientY);
        samples = [{ t: performance.now(), angle: lastAngle }];
    }

    function angleDelta(from, to) {
        // Shortest signed difference between two angles
        let d = to - from;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        return d;
    }

    function onDragMove(clientX, clientY) {
        if (!dragging) return;
        const now = performance.now();
        const angle = getCanvasAngle(clientX, clientY);
        const delta = angleDelta(lastAngle, angle);

        // Directly rotate the wheel while dragging (gives tactile feedback)
        sim.state.wheelAngle += delta;
        lastAngle = angle;

        samples.push({ t: now, angle });

        // Keep only samples within the velocity window
        const cutoff = now - VELOCITY_WINDOW * 1000;
        while (samples.length > 2 && samples[0].t < cutoff) {
            samples.shift();
        }
    }

    function onDragEnd() {
        if (!dragging) return;
        dragging = false;

        if (isSpinning || samples.length < 2) return;

        // Compute angular velocity over the recent sample window
        const first = samples[0];
        const last = samples[samples.length - 1];
        const dt = (last.t - first.t) / 1000;
        if (dt <= 0) return;

        let totalDelta = 0;
        for (let i = 1; i < samples.length; i++) {
            totalDelta += angleDelta(samples[i - 1].angle, samples[i].angle);
        }
        const omega = totalDelta / dt;  // rad/s

        if (Math.abs(omega) < MIN_DRAG_SPEED) return;

        // Clamp to the same speed range as the button spin
        const clampedOmega = clamp(Math.abs(omega), MIN_SPIN_SPEED, MAX_SPIN_SPEED) * Math.sign(omega);

        if (gameState === 'FINISHED') {
            resetGame();
        }

        isSpinning = true;
        spinBtn.disabled = true;
        statusLabel.textContent = 'Spinning...';
        resultDisplay.textContent = 'The wheel is turning!';
        startSpinSound();
        syncPegCounter();
        sim.spin(clampedOmega);
    }

    // Pointer events (desktop + touch via pointer API)
    canvas.addEventListener('pointerdown', e => {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        onDragStart(e.clientX, e.clientY);
    });

    canvas.addEventListener('pointermove', e => {
        if (!dragging) return;
        e.preventDefault();
        onDragMove(e.clientX, e.clientY);
    });

    canvas.addEventListener('pointerup', e => {
        e.preventDefault();
        onDragEnd();
    });

    canvas.addEventListener('pointercancel', () => {
        dragging = false;
    });
}());

// Trigger action bound to the primary CTA element
spinBtn.addEventListener('click', () => {
    initAudio();

    if (gameState === 'FINISHED') {
        resetGame();
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

addConfigRowBtn.addEventListener('click', () => {
    if (isSpinning) return;
    addConfigRow();
});

// Setup primary base configuration on script launch
syncNoVariantWeight();
renderConfigForm();
buildWheelPool([]);
updatePhysics();
