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

// Generate synthesized mechanical peg clicks
function playClickSound() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(620, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(120, audioCtx.currentTime + 0.035);

    gain.gain.setValueAtTime(0.07, audioCtx.currentTime);
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
const pointerEl = document.querySelector('.pointer');

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
let flapperAngle = 0;
let flapperAngularVelocity = 0;
const wheelLinearDrag = 0.34;
const wheelConstantDrag = 0.17;
const flapperGravity = 26;
const flapperDamping = 4.6;
const flapperMaxDeflection = 0.82;
const contactStrength = 58;
const contactDamping = 6.8;
const wheelBackdrive = 0.18;
const settleWheelThreshold = 0.045;
const settleFlapperThreshold = 0.05;
const settleAngleThreshold = 0.035;
const settledFrameRequirement = 24;
let isSpinning = false;
let pointerKick = 0;
const pointerAngle = 1.5 * Math.PI;
let lastPegCross = 0;
let settledFrames = 0;
let lastFrameTime = null;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizePositive(angle) {
    const twoPi = 2 * Math.PI;
    return ((angle % twoPi) + twoPi) % twoPi;
}

function normalizeSigned(angle) {
    const wrapped = normalizePositive(angle);
    return wrapped > Math.PI ? wrapped - (2 * Math.PI) : wrapped;
}

function dampToZero(value, amount) {
    if (Math.abs(value) <= amount) return 0;
    return value - (Math.sign(value) * amount);
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

function syncPegCounter() {
    if (!currentSlices.length) {
        lastPegCross = 0;
        return;
    }
    const sliceAngle = (2 * Math.PI) / currentSlices.length;
    lastPegCross = Math.floor((currentAngle - pointerAngle) / sliceAngle);
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

    // Draw pegs around the circumference so pointer/peg interaction is visible
    for (let i = 0; i < numSlices; i++) {
        const pegAngle = currentAngle + i * sliceAngle;
        const px = cx + (radius + 4) * Math.cos(pegAngle);
        const py = cy + (radius + 4) * Math.sin(pegAngle);

        const pegGradient = ctx.createRadialGradient(px - 1.5, py - 1.5, 0.8, px, py, 4);
        pegGradient.addColorStop(0, 'rgba(255,255,255,0.95)');
        pegGradient.addColorStop(0.55, 'rgba(220,220,230,0.95)');
        pegGradient.addColorStop(1, 'rgba(80,80,90,1)');

        ctx.beginPath();
        ctx.arc(px, py, 3.6, 0, 2 * Math.PI);
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
        const bx = cx + (radius + 11) * Math.cos(bulbAngle);
        const by = cy + (radius + 11) * Math.sin(bulbAngle);

        ctx.beginPath();
        ctx.arc(bx, by, 3.3, 0, 2 * Math.PI);
        if ((i % 2 === 0 && isLitState) || (i % 2 !== 0 && !isLitState)) {
            ctx.fillStyle = '#ffe600';
        } else {
            ctx.fillStyle = '#4b4b5e';
        }
        ctx.fill();
    }
}

function applyPointerMotion() {
    pointerKick *= 0.8;
    const displayAngle = ((flapperAngle + pointerKick) * 180) / Math.PI;
    pointerEl.style.transform = `translateX(-50%) rotate(${displayAngle.toFixed(2)}deg)`;
}

function applyPegImpact(passes) {
    const direction = Math.sign(passes) || Math.sign(angularVelocity) || 1;
    const cappedPasses = Math.min(Math.max(1, Math.abs(passes)), 5);
    const impactStrength = Math.min(1.05, 0.16 + (Math.abs(angularVelocity) * 0.03));

    for (let i = 0; i < cappedPasses; i++) {
        playClickSound();
    }

    angularVelocity = dampToZero(angularVelocity, impactStrength * cappedPasses * 0.085);
    flapperAngularVelocity += direction * impactStrength * cappedPasses * 0.58;
    pointerKick = clamp(
        pointerKick + (direction * impactStrength * 0.16),
        -flapperMaxDeflection * 0.6,
        flapperMaxDeflection * 0.6
    );
}

function detectPegCrossings() {
    if (!currentSlices.length) return;

    const sliceAngle = (2 * Math.PI) / currentSlices.length;
    const pegCross = Math.floor((currentAngle - pointerAngle) / sliceAngle);
    const passed = pegCross - lastPegCross;

    if (passed !== 0) {
        applyPegImpact(passed);
    }

    lastPegCross = pegCross;
}

function getFlapperContactState() {
    if (!currentSlices.length) {
        return null;
    }

    const sliceAngle = (2 * Math.PI) / currentSlices.length;
    const nearestPeg = Math.round((pointerAngle - currentAngle) / sliceAngle);
    const pegOffset = normalizeSigned((currentAngle + (nearestPeg * sliceAngle)) - pointerAngle);
    const contactDelta = normalizeSigned(pegOffset - flapperAngle);
    const contactWindow = Math.min(flapperMaxDeflection, sliceAngle * 0.72);
    const inContact = Math.abs(pegOffset) < contactWindow && Math.abs(contactDelta) < contactWindow * 1.15;
    const strength = inContact
        ? Math.max(0, 1 - (Math.max(Math.abs(pegOffset), Math.abs(contactDelta) * 0.85) / contactWindow))
        : 0;

    return {
        contactDelta,
        inContact,
        pegOffset,
        strength
    };
}

function getWinningIndex() {
    if (!currentSlices.length) return 0;
    const sliceAngle = (2 * Math.PI) / currentSlices.length;
    const effectivePointerAngle = normalizePositive(pointerAngle + flapperAngle);
    const targetAngle = normalizePositive(effectivePointerAngle - currentAngle - 0.00001);
    return Math.floor(targetAngle / sliceAngle) % currentSlices.length;
}

function finishSpin() {
    angularVelocity = 0;
    flapperAngularVelocity = 0;
    isSpinning = false;
    settledFrames = 0;
    spinBtn.disabled = false;
    handleResult(getWinningIndex());
}

function applyWheelDrag(dt) {
    if (!angularVelocity) return;

    const drag = ((wheelLinearDrag * Math.abs(angularVelocity)) + wheelConstantDrag) * dt;
    angularVelocity = dampToZero(angularVelocity, drag);
}

function updateFlapperPhysics(dt, contactState) {
    let angularAcceleration = (-flapperGravity * Math.sin(flapperAngle)) - (flapperDamping * flapperAngularVelocity);

    if (contactState?.inContact) {
        const coupling = contactState.strength;
        const relativeVelocity = angularVelocity - flapperAngularVelocity;
        const contactAcceleration = ((contactState.contactDelta * contactStrength) + (relativeVelocity * contactDamping)) * coupling;

        angularAcceleration += contactAcceleration;
        angularVelocity -= contactAcceleration * wheelBackdrive * dt;
    }

    flapperAngularVelocity += angularAcceleration * dt;
    flapperAngle += flapperAngularVelocity * dt;

    if (Math.abs(flapperAngle) > flapperMaxDeflection) {
        flapperAngle = clamp(flapperAngle, -flapperMaxDeflection, flapperMaxDeflection);
        flapperAngularVelocity *= 0.42;
    }
}

function updateSettleState(contactState) {
    const restOffset = contactState?.inContact ? contactState.contactDelta : flapperAngle;
    const isNearRest = Math.abs(angularVelocity) < settleWheelThreshold
        && Math.abs(flapperAngularVelocity) < settleFlapperThreshold
        && Math.abs(restOffset) < settleAngleThreshold;

    settledFrames = isNearRest ? settledFrames + 1 : 0;

    if (settledFrames >= settledFrameRequirement) {
        finishSpin();
    }
}

function updateSpinningPhysics(dt) {
    currentAngle += angularVelocity * dt;
    detectPegCrossings();
    applyWheelDrag(dt);
    const contactState = getFlapperContactState();
    updateFlapperPhysics(dt, contactState);
    updateSettleState(contactState);
}

// Updates rotation values and peg interactions each frame
function updatePhysics(timestamp = 0) {
    const dt = lastFrameTime === null ? (1 / 60) : Math.min(0.05, (timestamp - lastFrameTime) / 1000);
    lastFrameTime = timestamp;

    if (isSpinning) {
        updateSpinningPhysics(dt);
    }

    applyPointerMotion();
    drawWheel();
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
    angularVelocity = 10.5 + (Math.random() * 4.5);
    flapperAngle = 0;
    flapperAngularVelocity = 0;
    pointerKick = 0;
    settledFrames = 0;
    syncPegCounter();
}

function resetGame() {
    gameState = 'NORMAL';
    doubleVariantSelections = [];
    angularVelocity = 0;
    flapperAngle = 0;
    flapperAngularVelocity = 0;
    pointerKick = 0;
    settledFrames = 0;
    isSpinning = false;
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
