import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BubbleEffect, hueToRgb} from './bubbleEffect.js';
import {Physics} from './physics.js';

const FADE_DURATION = 20.0; // seconds
const BUBBLE_PADDING = 2;   // transparent logical pixels around each bubble
const EXPLOSION_DURATION = 1.0;
const EXPLOSION_WAVE_FRACTION = 0.05; // 5% of the bubbles per wave
const BLACK_FADE_OUT = 0.35;
const MAX_DROPLETS = 160;
// The exit cloud is drawn with Cairo (one St.DrawingArea per monitor), so the
// budget caps the number of droplets drawn at once rather than actors.
const DROPLET_BUDGET = 4000;
const DESTROY_PER_FRAME = 8;

const INPUT_EVENTS = [
    Clutter.EventType.MOTION,
    Clutter.EventType.BUTTON_PRESS,
    Clutter.EventType.KEY_PRESS,
    Clutter.EventType.TOUCH_BEGIN,
    Clutter.EventType.SCROLL,
    Clutter.EventType.PAD_BUTTON_PRESS,
];

function parseHexColor(value) {
    const match = /^#([0-9a-f]{6})$/i.exec(value ?? '');
    if (!match)
        return [0.52, 0.68, 0.92];

    const n = parseInt(match[1], 16);
    return [
        ((n >> 16) & 0xff) / 255,
        ((n >> 8) & 0xff) / 255,
        (n & 0xff) / 255,
    ];
}

function smoothstep(edge0, edge1, x) {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

export class BubblesOverlay {
    constructor({settings, look, burst, onDismiss, onError}) {
        this._settings = settings;
        this._look = look;
        this._burst = burst ?? {};
        this._onDismiss = onDismiss;
        this._onError = onError;
        this._destroyed = false;

        this._monitors = Main.layoutManager.monitors;
        if (this._monitors.length === 0)
            throw new Error('No monitor available');

        this._minX = Math.min(...this._monitors.map(m => m.x));
        this._minY = Math.min(...this._monitors.map(m => m.y));
        const maxX = Math.max(...this._monitors.map(m => m.x + m.width));
        const maxY = Math.max(...this._monitors.map(m => m.y + m.height));
        this._worldWidth = maxX - this._minX;
        this._worldHeight = maxY - this._minY;

        // Clutter uses y-down stage coordinates; the physics is y-up.
        const worldMonitors = this._monitors.map(m => ({
            x: m.x - this._minX,
            y: this._worldHeight - (m.y - this._minY) - m.height,
            width: m.width,
            height: m.height,
        }));
        // Same monitors in Clutter coordinates, used to place the drawing areas.
        this._monitorRects = this._monitors.map(m => ({
            x: m.x - this._minX,
            y: m.y - this._minY,
            width: m.width,
            height: m.height,
        }));

        this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._fadeDelay = settings.get_int('fade-delay');
        this._elapsed = 0;
        this._lastFrameTime = 0;

        this._physics = new Physics(this._worldWidth, this._worldHeight, worldMonitors, {
            count: settings.get_int('bubble-count'),
            size: settings.get_double('bubble-size') / 100.0,
            sizeVariation: settings.get_double('bubble-size-variation') / 100.0,
            speed: settings.get_double('bubble-speed') / 100.0,
            spawnInterval: settings.get_double('spawn-interval'),
        });

        this._root = new St.Widget({
            x: this._minX,
            y: this._minY,
            width: this._worldWidth,
            height: this._worldHeight,
            clip_to_allocation: true,
            reactive: false,
        });

        this._black = new St.Widget({
            style: 'background-color: black;',
            x: 0,
            y: 0,
            width: this._worldWidth,
            height: this._worldHeight,
            opacity: 0,
        });
        this._root.add_child(this._black);

        // Droplets are painted on their own layer so it can be raised above the
        // bubbles when they burst. One St.DrawingArea per monitor is created on
        // exit only: all droplets are then drawn with Cairo in a single pass.
        this._dropletLayer = new St.Widget({
            x: 0,
            y: 0,
            width: this._worldWidth,
            height: this._worldHeight,
            clip_to_allocation: true,
            reactive: false,
        });
        this._root.add_child(this._dropletLayer);
        this._dropletAreas = null;
        this._dropletFrameNow = 0;

        this._entries = new Map();   // bubble object -> entry
        this._ordered = [];          // entries sorted by descending radius
        this._stageEventId = 0;

        this._dismissing = false;
        this._dismissBatches = [];
        this._dismissBatchIndex = 0;
        this._dismissBatchDelay = 0.2;
        this._dismissStartedAt = 0;
        this._dismissCallback = null;
        this._bursts = [];
        this._blackOpacityStart = 0;
        this._motionGraceUntil = 0;
        this._destroyQueue = [];
        this._prevBurstCount = 0;

        this._timeline = new Clutter.Timeline({duration: 1000});
        this._timeline.set_repeat_count(-1);
        this._timeline.connect('new-frame', () => this._onFrame());
    }

    show() {
        if (this._destroyed)
            return;

        Main.layoutManager.uiGroup.add_child(this._root);
        // The timeline needs a frame clock; associate it with the actor only
        // once the actor is in the stage, then start it.
        this._timeline.set_actor(this._root);
        this._timeline.start();

        this._stageEventId = global.stage.connect('captured-event',
            (actor, event) => this._onCapturedEvent(event));
        this._motionGraceUntil = GLib.get_monotonic_time() + 1000 * 1000;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        if (this._stageEventId) {
            global.stage.disconnect(this._stageEventId);
            this._stageEventId = 0;
        }

        if (this._timeline) {
            this._timeline.stop();
            this._timeline = null;
        }

        this._entries.clear();
        this._ordered = [];
        this._dismissCallback = null;
        this._dismissing = false;
        this._bursts = [];
        this._destroyQueue = [];
        this._dropletAreas = null;

        if (this._root) {
            this._root.destroy();
            this._root = null;
            this._black = null;
            this._dropletLayer = null;
        }

        this._physics = null;
        this._settings = null;
        this._look = null;
    }

    _burstNumber(key, fallback) {
        const value = Number(this._burst[key]);
        return Number.isFinite(value) ? value : fallback;
    }

    setStyle(style, customColor) {
        if (this._destroyed)
            return;

        this._look.style = style;
        this._look.customColor = customColor;

        for (const [bubble, entry] of this._entries) {
            const {tint, iridescence, dropletTint} = this._styleParams(bubble);

            entry.effect.set_uniform_float('uTint', 3, tint);
            entry.effect.set_uniform_float('uIridescence', 1, [iridescence]);
            entry.effect.queue_repaint();

            for (const droplet of entry.droplets) {
                droplet.color = dropletTint.map(c =>
                    Math.min(1, c * droplet.brightness));
            }
        }
    }

    _styleParams(bubble) {
        switch (this._look.style) {
        case 'multicolor': {
            const tint = hueToRgb(bubble.hue, 0.85, 1.0);
            return {tint, iridescence: 0, dropletTint: tint};
        }
        case 'transparent': {
            const tint = [1.0, 1.0, 1.0];
            return {tint, iridescence: 0, dropletTint: tint};
        }
        case 'custom': {
            const tint = parseHexColor(this._look.customColor);
            return {tint, iridescence: 0, dropletTint: tint};
        }
        default: {
            const tint = hueToRgb(bubble.hue, 0.42, 1.0);
            return {
                tint,
                iridescence: this._look.iridescence,
                // Iridescent bubbles shift through many colors, so a single
                // tinted cloud would look wrong: use neutral white droplets.
                dropletTint: [1.0, 1.0, 1.0],
            };
        }
        }
    }

    _onFrame() {
        if (this._destroyed)
            return;

        try {
            const now = GLib.get_monotonic_time() / 1000000.0;

            if (this._dismissing) {
                this._processDestroyQueue();
                this._updateExit(now);
                return;
            }

            let dt = this._lastFrameTime ? now - this._lastFrameTime : 0;
            this._lastFrameTime = now;
            dt = Math.min(Math.max(dt, 0), 0.1);

            this._elapsed += dt;
            this._physics.update(dt);
            this._syncBubbles();
            this._updateFade();
            // Repaint the whole overlay so the previous positions of moving
            // bubbles never leave coloured edge trails behind.
            this._root.queue_redraw();
        } catch (e) {
            if (this._onError)
                this._onError(e);
        }
    }

    _syncBubbles() {
        const bubbles = this._physics.bubbles;

        for (const bubble of bubbles) {
            let entry = this._entries.get(bubble);
            if (!entry) {
                entry = this._createBubble(bubble);
                this._entries.set(bubble, entry);
                this._insertOrdered(entry);
            }

            const radius = bubble.radius;
            entry.actor.set_position(bubble.x - radius - BUBBLE_PADDING,
                this._worldHeight - bubble.y - radius - BUBBLE_PADDING);
        }
    }

    _makeEffect(bubble, tint, iridescence) {
        return new BubbleEffect({
            look: this._look,
            tint,
            iridescence,
            seed: bubble.seed,
            radius: bubble.radius,
            scale: this._scale,
            coordScale: (bubble.radius + BUBBLE_PADDING) / bubble.radius,
        });
    }

    _createBubble(bubble) {
        const radius = bubble.radius;
        const size = (radius + BUBBLE_PADDING) * 2;
        const actor = new St.Widget({
            x: 0,
            y: 0,
            width: size,
            height: size,
            clip_to_allocation: true,
        });

        const style = this._styleParams(bubble);
        const effect = this._makeEffect(bubble, style.tint, style.iridescence);

        actor.add_effect(effect);
        this._root.add_child(actor);

        // The droplet simulation data is built right away; nothing is painted
        // until the bubble bursts.
        return {
            actor,
            effect,
            radius,
            droplets: this._createDroplets(bubble, radius),
        };
    }

    _dropletCountPerBubble() {
        const requested = Math.max(1, Math.min(MAX_DROPLETS,
            Math.round(this._burstNumber('dropletCount', 80))));
        const bubbles = Math.max(1, this._physics.targetCount);
        const budgeted = Math.floor(DROPLET_BUDGET / bubbles);
        return Math.max(1, Math.min(requested, Math.max(8, budgeted)));
    }

    // One Cairo drawing area per monitor, created only when the exit starts.
    _ensureDropletAreas() {
        if (this._dropletAreas || this._destroyed || !this._dropletLayer)
            return;

        this._dropletAreas = this._monitorRects.map(rect => {
            const area = new St.DrawingArea({
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                reactive: false,
            });
            area.connect('repaint', () => this._paintDroplets(area, rect));
            this._dropletLayer.add_child(area);
            return area;
        });
    }

    // Draw every active droplet that intersects this monitor. St.DrawingArea
    // clears the surface and gives us a logical-pixel Cairo context.
    // Destroying a bubble also frees its shader framebuffer. Do it in small
    // batches so a whole wave does not free dozens of them in the same frame.
    _processDestroyQueue() {
        let budget = DESTROY_PER_FRAME;
        while (budget-- > 0 && this._destroyQueue.length > 0)
            this._destroyQueue.shift().destroy();
    }

    _paintDroplets(area, rect) {
        const cr = area.get_context();
        if (!cr)
            return;

        try {
            const now = this._dropletFrameNow;
            const right = rect.x + rect.width;
            const bottom = rect.y + rect.height;

            for (const burst of this._bursts) {
                const progress = Math.min(1,
                    (now - burst.startedAt) / burst.duration);
                if (!(progress > 0) || progress >= 1)
                    continue;

                const fadeStart = Math.min(burst.fadeStart, burst.fadeEnd - 0.001);
                const fadeEnd = Math.max(burst.fadeEnd, burst.fadeStart + 0.001);
                const fade = 1 - smoothstep(fadeStart, fadeEnd, progress);
                if (fade <= 0)
                    continue;

                for (const droplet of burst.droplets) {
                    const x = burst.cx + droplet.sx + droplet.vx * progress;
                    const y = burst.cy + droplet.sy + droplet.vy * progress +
                        0.5 * burst.gravityPx * progress * progress;
                    const radius = droplet.diameter / 2;

                    if (x + radius < rect.x || x - radius > right ||
                        y + radius < rect.y || y - radius > bottom)
                        continue;

                    const alpha = droplet.opacity * fade;
                    if (alpha <= 0)
                        continue;

                    cr.setSourceRGBA(droplet.color[0], droplet.color[1],
                        droplet.color[2], alpha);
                    cr.arc(x - rect.x, y - rect.y, radius, 0, Math.PI * 2);
                    cr.fill();
                }
            }
        } finally {
            cr.$dispose();
        }
    }

    _createDroplets(bubble, radius) {
        const count = this._dropletCountPerBubble();
        const baseSize = Math.max(0.0005,
            this._burstNumber('dropletSize', 0.012));
        const sizeVariation = Math.max(0,
            this._burstNumber('dropletSizeVariation', 0.010));
        const opacity = Math.max(0, Math.min(1,
            this._burstNumber('dropletOpacity', 0.90)));

        const startRadius = Math.max(0,
            this._burstNumber('startRadius', 0.36));
        const startVariation = Math.max(0,
            this._burstNumber('startRadiusVariation', 0.10));
        const direction = this._burstNumber('direction', 90);
        const spread = this._burstNumber('spread', 360);
        const speed = Math.max(0, this._burstNumber('speed', 0.45));
        const speedVariation = Math.max(0, Math.min(1,
            this._burstNumber('speedVariation', 0.60)));

        const pUnit = radius * 2;
        const tint = this._styleParams(bubble).dropletTint;
        const droplets = [];

        for (let i = 0; i < count; ++i) {
            const startAngle = Math.random() * Math.PI * 2;
            const startDistance = (startRadius + startVariation * Math.random()) * pUnit;
            const sx = Math.cos(startAngle) * startDistance;
            const sy = Math.sin(startAngle) * startDistance;

            const velocityAngle = direction * Math.PI / 180 +
                (Math.random() - 0.5) * spread * Math.PI / 180;
            const speedPx = speed *
                (1 - speedVariation + 2 * speedVariation * Math.random()) * pUnit;
            const vx = Math.cos(velocityAngle) * speedPx;
            const vy = Math.sin(velocityAngle) * speedPx;

            const sizeP = baseSize + sizeVariation * Math.random();
            const diameter = Math.max(2, sizeP * pUnit * 2);
            const brightness = 0.90 + Math.random() * 0.20;
            const color = tint.map(c => Math.min(1, c * brightness));

            droplets.push({
                diameter,
                sx,
                sy,
                vx,
                vy,
                opacity,
                brightness,
                color,
            });
        }

        return droplets;
    }

    _insertOrdered(entry) {
        let index = this._ordered.findIndex(other => other.radius < entry.radius);
        if (index < 0)
            index = this._ordered.length;
        this._ordered.splice(index, 0, entry);

        // Child 0 is the black background, child 1 is the droplet layer;
        // bubble actors start at index 2.
        this._root.set_child_at_index(entry.actor, index + 2);
    }

    _updateFade() {
        let alpha = 0;
        if (this._elapsed > this._fadeDelay) {
            const progress = Math.min(Math.max(
                (this._elapsed - this._fadeDelay) / FADE_DURATION, 0), 1);
            alpha = progress * progress * (3 - 2 * progress);
        }

        this._black.set_opacity(Math.round(alpha * 255));
    }

    /**
     * Pop every bubble in a random order, fade the black backdrop out, then
     * call `onFinished`. The caller destroys the overlay in that callback.
     */
    dismiss(onFinished) {
        if (this._destroyed || this._dismissing)
            return;

        this._dismissing = true;
        this._dismissCallback = onFinished;
        this._dismissStartedAt = GLib.get_monotonic_time() / 1000000.0;
        this._blackOpacityStart = this._black.opacity;

        const bubbles = Array.from(this._entries.keys());
        for (let i = bubbles.length - 1; i > 0; --i) {
            const j = Math.floor(Math.random() * (i + 1));
            [bubbles[i], bubbles[j]] = [bubbles[j], bubbles[i]];
        }

        // Waves of ~5% each; bubbles in a wave explode together.
        this._dismissBatches = [];
        const waveSize = Math.max(1,
            Math.ceil(bubbles.length * EXPLOSION_WAVE_FRACTION));
        for (let start = 0; start < bubbles.length; start += waveSize)
            this._dismissBatches.push(bubbles.slice(start, start + waveSize));

        this._dismissBatchIndex = 0;
        this._dismissBatchDelay = Math.max(0,
            this._burstNumber('batchDelay', 0.05));
        if (this._dismissBatches.length === 0) {
            this._finishDismiss();
            return;
        }

        this._dropletFrameNow = this._dismissStartedAt;
        this._ensureDropletAreas();
    }

    _updateExit(now) {
        const elapsed = now - this._dismissStartedAt;
        const fade = Math.min(1, elapsed / BLACK_FADE_OUT);
        this._black.set_opacity(Math.round(this._blackOpacityStart * (1 - fade)));

        while (this._dismissBatchIndex < this._dismissBatches.length &&
               elapsed >= this._dismissBatchIndex * this._dismissBatchDelay) {
            const batch = this._dismissBatches[this._dismissBatchIndex++];
            for (const bubble of batch)
                this._explodeBubble(bubble, now);
        }

        for (let i = this._bursts.length - 1; i >= 0; --i) {
            const burst = this._bursts[i];
            const progress = Math.min(1,
                (now - burst.startedAt) / burst.duration);
            if (progress >= 1)
                this._bursts.splice(i, 1);
        }

        // Redraw the whole cloud: droplets move, fade and die every frame. A
        // final repaint after the last burst clears the surface.
        this._dropletFrameNow = now;
        const hadDroplets = this._prevBurstCount > 0;
        this._prevBurstCount = this._bursts.length;
        if (this._dropletAreas &&
            (this._bursts.length > 0 || hadDroplets)) {
            for (const area of this._dropletAreas)
                area.queue_repaint();
        }

        if (this._dismissBatchIndex >= this._dismissBatches.length &&
            this._bursts.length === 0) {
            this._finishDismiss();
        }
    }

    _explodeBubble(bubble, now) {
        const entry = this._entries.get(bubble);
        if (!entry)
            return;

        this._entries.delete(bubble);
        const index = this._ordered.indexOf(entry);
        if (index >= 0)
            this._ordered.splice(index, 1);

        const cx = bubble.x;
        const cy = this._worldHeight - bubble.y;
        const duration = Math.max(0.05,
            this._burstNumber('duration', EXPLOSION_DURATION));
        const fadeStart = this._burstNumber('fadeStart', 0.15);
        const fadeEnd = this._burstNumber('fadeEnd', 1.0);
        const gravityPx = this._burstNumber('gravity', 0) * 2 * bubble.radius;

        entry.actor.hide();
        this._destroyQueue.push(entry.actor);

        // Keep the cloud above the remaining bubbles.
        this._root.set_child_above_sibling(this._dropletLayer, null);

        this._bursts.push({
            droplets: entry.droplets,
            cx,
            cy,
            gravityPx,
            duration,
            fadeStart,
            fadeEnd,
            startedAt: now,
        });
    }

    _finishDismiss() {
        if (!this._dismissing)
            return;

        this._dismissing = false;
        const callback = this._dismissCallback;
        this._dismissCallback = null;
        if (callback)
            callback();
    }

    _onCapturedEvent(event) {
        if (this._destroyed)
            return Clutter.EVENT_PROPAGATE;

        if (INPUT_EVENTS.includes(event.type())) {
            if (event.type() === Clutter.EventType.MOTION &&
                GLib.get_monotonic_time() < this._motionGraceUntil) {
                return Clutter.EVENT_PROPAGATE;
            }

            if (this._onDismiss)
                this._onDismiss();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }
}
