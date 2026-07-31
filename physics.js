// physics.js
// Rigid-body simulation of a heavy carnival wheel and its flapper (the "arrow").
//
// Everything below is solved in SI units (metres, kilograms, seconds) using a
// screen-style coordinate frame whose origin is the wheel hub and whose Y axis
// points down, exactly like the canvas frame used for rendering.
//
// Two rotating bodies are simulated:
//   * the wheel, a disc that carries a ring of cylindrical pegs on its rim,
//   * the flapper, a rod hinged above the wheel that hangs down into the peg ring.
// The bodies only meet through real contacts: every peg is tested against the
// flapper segment and resolved with normal + friction impulses, so the flapper
// can never pass through a peg.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.WheelPhysics = api;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const GRAVITY = 9.81;

    const CONSTANTS = {
        // Wheel: 1.2 m across, 22 kg of plywood and paint.
        wheelRadius: 0.6,
        wheelMass: 22,
        // Bearing losses. The wheel is deliberately slippery on its own: most of
        // the energy is drained through the peg impacts, like the real machine.
        bearingViscous: 1.5,    // N*m per rad/s (air drag + axle churn)
        bearingCoulomb: 0.12,   // N*m dry friction, deliberately small enough that
                                // the flapper itself can still nudge the wheel

        // Pegs: 22 mm steel pins standing just outside the rim.
        pegRadius: 0.011,
        pegOrbitMargin: 0.012,

        // Flapper: leather/rubber tongue hinged above the wheel.
        flapperMass: 0.35,
        flapperLength: 0.112,
        flapperHalfThickness: 0.006,
        flapperPivotGap: 0.10,   // distance from peg orbit up to the hinge
        flapperPivotFriction: 0.006, // N*m per rad/s
        flapperSpring: 0.8,          // N*m per rad, the hinge's return spring
        flapperMaxDeflection: 1.4,   // hard stops of the hinge (rad)
        flapperStopRestitution: 0.15,

        // Contact material.
        restitution: 0.12,
        friction: 0.22,
        // Baumgarte style penetration recovery.
        penetrationSlop: 0.0004,
        penetrationCorrection: 0.35,

        // Integration.
        maxSubStep: 1 / 1500,
        maxSubSteps: 150,

        // Rest detection.
        restWheelSpeed: 0.035,
        restFlapperSpeed: 0.08,
        restDuration: 0.45
    };

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function normalizePositive(angle) {
        const twoPi = 2 * Math.PI;
        return ((angle % twoPi) + twoPi) % twoPi;
    }

    function createWheelSimulation(overrides) {
        const c = Object.assign({}, CONSTANTS, overrides || {});

        const pegOrbit = c.wheelRadius + c.pegOrbitMargin;
        const pivotDistance = pegOrbit + c.flapperPivotGap;
        // Hinge sits straight above the hub (canvas Y grows downwards).
        const pivot = { x: 0, y: -pivotDistance };

        const wheelInertia = 0.5 * c.wheelMass * c.wheelRadius * c.wheelRadius;
        const flapperInertia = (1 / 3) * c.flapperMass * c.flapperLength * c.flapperLength;
        const flapperGravityTorque = c.flapperMass * GRAVITY * (c.flapperLength / 2);
        const contactRadius = c.pegRadius + c.flapperHalfThickness;

        // Flapper world angle: PI/2 means "hanging straight down" towards the hub.
        const flapperRest = Math.PI / 2;

        const state = {
            wheelAngle: 0,
            wheelOmega: 0,
            flapperAngle: flapperRest,
            flapperOmega: 0,
            pegCount: 0,
            restTimer: 0
        };

        // Pegs that are currently touching the flapper, so a single strike only
        // reports one impact no matter how many sub-steps it spans.
        let touchingPegs = new Set();

        function setPegCount(count) {
            state.pegCount = Math.max(0, Math.floor(count));
            touchingPegs.clear();
        }

        function spin(omega) {
            state.wheelOmega = omega;
            state.restTimer = 0;
            touchingPegs.clear();
        }

        function reset() {
            state.wheelOmega = 0;
            state.flapperAngle = flapperRest;
            state.flapperOmega = 0;
            state.restTimer = 0;
            touchingPegs.clear();
        }

        function getFlapperTip() {
            return {
                x: pivot.x + (c.flapperLength * Math.cos(state.flapperAngle)),
                y: pivot.y + (c.flapperLength * Math.sin(state.flapperAngle))
            };
        }

        function getPegPosition(index) {
            const sliceAngle = (2 * Math.PI) / state.pegCount;
            const angle = state.wheelAngle + (index * sliceAngle);
            return {
                x: pegOrbit * Math.cos(angle),
                y: pegOrbit * Math.sin(angle)
            };
        }

        // Closest point of the flapper segment to an arbitrary point.
        function closestPointOnFlapper(px, py) {
            const dx = c.flapperLength * Math.cos(state.flapperAngle);
            const dy = c.flapperLength * Math.sin(state.flapperAngle);
            const lengthSq = (dx * dx) + (dy * dy);
            let t = 0;
            if (lengthSq > 0) {
                t = clamp((((px - pivot.x) * dx) + ((py - pivot.y) * dy)) / lengthSq, 0, 1);
            }
            return { x: pivot.x + (t * dx), y: pivot.y + (t * dy) };
        }

        function applyBearingFriction(h) {
            if (!state.wheelOmega) return;
            const sign = Math.sign(state.wheelOmega);
            const torque = -((c.bearingViscous * state.wheelOmega) + (c.bearingCoulomb * sign));
            const next = state.wheelOmega + ((torque / wheelInertia) * h);
            // Dry friction must never drive the wheel backwards.
            state.wheelOmega = Math.sign(next) === sign ? next : 0;
        }

        function applyFlapperForces(h) {
            const torque = (flapperGravityTorque * Math.cos(state.flapperAngle))
                - (c.flapperSpring * (state.flapperAngle - flapperRest))
                - (c.flapperPivotFriction * state.flapperOmega);
            state.flapperOmega += (torque / flapperInertia) * h;
        }

        function applyHingeStops() {
            const deflection = state.flapperAngle - flapperRest;
            if (Math.abs(deflection) <= c.flapperMaxDeflection) return;
            state.flapperAngle = flapperRest + clamp(deflection, -c.flapperMaxDeflection, c.flapperMaxDeflection);
            if (Math.sign(state.flapperOmega) === Math.sign(deflection)) {
                state.flapperOmega *= -c.flapperStopRestitution;
            }
        }

        // Impulse resolution for one peg/flapper contact.
        function resolveContact(peg) {
            const contact = closestPointOnFlapper(peg.x, peg.y);
            let nx = peg.x - contact.x;
            let ny = peg.y - contact.y;
            let distance = Math.hypot(nx, ny);

            if (distance >= contactRadius) return null;

            if (distance < 1e-9) {
                // Degenerate overlap: push the peg out along the flapper normal.
                nx = -Math.sin(state.flapperAngle);
                ny = Math.cos(state.flapperAngle);
                distance = 0;
            } else {
                nx /= distance;
                ny /= distance;
            }

            const penetration = contactRadius - distance;

            // Lever arms of the contact point on both bodies.
            const rwx = contact.x;
            const rwy = contact.y;
            const rfx = contact.x - pivot.x;
            const rfy = contact.y - pivot.y;

            // Velocities of the coincident material points (v = omega x r).
            const vwx = -state.wheelOmega * rwy;
            const vwy = state.wheelOmega * rwx;
            const vfx = -state.flapperOmega * rfy;
            const vfy = state.flapperOmega * rfx;

            const rvx = vwx - vfx;
            const rvy = vwy - vfy;
            const normalVelocity = (rvx * nx) + (rvy * ny);

            const crossWheel = (rwx * ny) - (rwy * nx);
            const crossFlapper = (rfx * ny) - (rfy * nx);
            const effectiveMass = ((crossWheel * crossWheel) / wheelInertia)
                + ((crossFlapper * crossFlapper) / flapperInertia);

            if (effectiveMass <= 0) return null;

            let impulse = 0;
            if (normalVelocity < 0) {
                // Restitution fades out for gentle touches so the flapper can rest
                // quietly against a peg instead of chattering forever.
                const restitution = normalVelocity < -0.35 ? c.restitution : 0;
                impulse = -(1 + restitution) * normalVelocity / effectiveMass;
                applyImpulse(impulse, nx, ny, crossWheel, crossFlapper);
                applyFriction(impulse, nx, ny, rwx, rwy, rfx, rfy);
            }

            // Positional correction: split between both bodies by inverse inertia
            // so the heavy wheel is barely nudged while the light flapper moves.
            if (penetration > c.penetrationSlop) {
                const correction = (penetration - c.penetrationSlop) * c.penetrationCorrection;
                const wheelShare = (crossWheel * crossWheel) / wheelInertia;
                const flapperShare = (crossFlapper * crossFlapper) / flapperInertia;
                const total = wheelShare + flapperShare;
                if (total > 0) {
                    const scalar = correction / total;
                    if (Math.abs(crossWheel) > 1e-9) {
                        state.wheelAngle += (crossWheel / wheelInertia) * scalar;
                    }
                    if (Math.abs(crossFlapper) > 1e-9) {
                        state.flapperAngle -= (crossFlapper / flapperInertia) * scalar;
                    }
                }
            }

            return { impulse, speed: Math.max(0, -normalVelocity) };
        }

        function applyImpulse(impulse, nx, ny, crossWheel, crossFlapper) {
            state.wheelOmega += (crossWheel * impulse) / wheelInertia;
            state.flapperOmega -= (crossFlapper * impulse) / flapperInertia;
        }

        function applyFriction(normalImpulse, nx, ny, rwx, rwy, rfx, rfy) {
            const tx = -ny;
            const ty = nx;

            const vwx = -state.wheelOmega * rwy;
            const vwy = state.wheelOmega * rwx;
            const vfx = -state.flapperOmega * rfy;
            const vfy = state.flapperOmega * rfx;

            const tangentVelocity = (((vwx - vfx) * tx) + ((vwy - vfy) * ty));
            const crossWheel = (rwx * ty) - (rwy * tx);
            const crossFlapper = (rfx * ty) - (rfy * tx);
            const effectiveMass = ((crossWheel * crossWheel) / wheelInertia)
                + ((crossFlapper * crossFlapper) / flapperInertia);

            if (effectiveMass <= 0) return;

            const maxFriction = c.friction * normalImpulse;
            const impulse = clamp(-tangentVelocity / effectiveMass, -maxFriction, maxFriction);

            state.wheelOmega += (crossWheel * impulse) / wheelInertia;
            state.flapperOmega -= (crossFlapper * impulse) / flapperInertia;
        }

        // Only the handful of pegs sweeping past the flapper can touch it.
        function resolveContacts(events) {
            if (!state.pegCount) return;

            const sliceAngle = (2 * Math.PI) / state.pegCount;
            const pivotAngle = Math.atan2(pivot.y, pivot.x);
            const nearest = Math.round((pivotAngle - state.wheelAngle) / sliceAngle);
            const span = Math.max(1, Math.ceil((c.flapperLength + contactRadius) / (pegOrbit * sliceAngle)) + 1);
            const stillTouching = new Set();

            for (let offset = -span; offset <= span; offset++) {
                const index = nearest + offset;
                const peg = getPegPosition(index);
                const hit = resolveContact(peg);
                if (!hit) continue;

                // Peg identity is stable across revolutions, so use the wrapped index.
                const id = ((index % state.pegCount) + state.pegCount) % state.pegCount;
                stillTouching.add(id);
                if (!touchingPegs.has(id) && hit.speed > 0) {
                    events.push({ peg: id, speed: hit.speed, impulse: hit.impulse });
                }
            }

            touchingPegs = stillTouching;
        }

        function integrate(h, events) {
            applyBearingFriction(h);
            applyFlapperForces(h);

            state.wheelAngle += state.wheelOmega * h;
            state.flapperAngle += state.flapperOmega * h;

            resolveContacts(events);
            applyHingeStops();
        }

        function updateRestTimer(dt) {
            const atRest = Math.abs(state.wheelOmega) < c.restWheelSpeed
                && Math.abs(state.flapperOmega) < c.restFlapperSpeed;
            state.restTimer = atRest ? state.restTimer + dt : 0;
        }

        function step(dt) {
            const events = [];
            if (dt <= 0) return events;

            const subSteps = Math.min(c.maxSubSteps, Math.max(1, Math.ceil(dt / c.maxSubStep)));
            const h = dt / subSteps;

            for (let i = 0; i < subSteps; i++) {
                integrate(h, events);
            }

            state.wheelAngle = normalizePositive(state.wheelAngle);
            updateRestTimer(dt);
            return events;
        }

        function isAtRest() {
            return state.restTimer >= c.restDuration;
        }

        // Index of the slice the flapper tip is currently sitting in.
        function getSelectedIndex() {
            if (!state.pegCount) return 0;
            const tip = getFlapperTip();
            const sliceAngle = (2 * Math.PI) / state.pegCount;
            const tipAngle = normalizePositive(Math.atan2(tip.y, tip.x) - state.wheelAngle);
            return Math.floor(tipAngle / sliceAngle) % state.pegCount;
        }

        return {
            constants: c,
            state,
            geometry: {
                wheelRadius: c.wheelRadius,
                pegOrbit,
                pegRadius: c.pegRadius,
                pivot,
                pivotDistance,
                flapperLength: c.flapperLength,
                flapperHalfThickness: c.flapperHalfThickness,
                flapperRest
            },
            setPegCount,
            spin,
            reset,
            step,
            isAtRest,
            getSelectedIndex,
            getFlapperTip,
            getPegPosition
        };
    }

    return { createWheelSimulation, CONSTANTS, GRAVITY };
}));
