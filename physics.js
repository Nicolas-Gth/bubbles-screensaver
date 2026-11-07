// Bubble simulation.
//
// The simulation uses a y-up world coordinate system. The overlay converts to
// Clutter's y-down stage coordinates when it positions the bubble actors.

const TWO_PI = Math.PI * 2;

function rand(min, max) {
    return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export class Physics {
    constructor(width, height, monitors, config) {
        this.width = width;
        this.height = height;
        this.minDimension = Math.min(width, height);
        this.monitors = monitors;
        this.config = config;

        this.targetCount = config.count > 0
            ? clamp(Math.round(config.count), 1, 500)
            : clamp(Math.round(Math.sqrt(width * height) / 70), 10, 18);

        this.bubbles = [];
        this.spawnEdges = [];
        this.time = 0;
        this.spawnTimer = 0.2;

        this._buildSpawnEdges();
    }

    _buildSpawnEdges() {
        this.spawnEdges = [];

        if (this.monitors.length === 0) {
            this.spawnEdges.push({
                vertical: false,
                fixed: 0,
                from: 0,
                to: this.width,
                nx: 0,
                ny: 1,
            });
            return;
        }

        // Bubbles enter from the bottom edge of the lowest monitor(s).
        let lowest = this.monitors[0].y;
        for (const monitor of this.monitors)
            lowest = Math.min(lowest, monitor.y);

        for (const monitor of this.monitors) {
            if (monitor.y <= lowest + 0.5) {
                this.spawnEdges.push({
                    vertical: false,
                    fixed: monitor.y,
                    from: monitor.x,
                    to: monitor.x + monitor.width,
                    nx: 0,
                    ny: 1,
                });
            }
        }
    }

    _isClearOfMonitors(x, y, radius) {
        for (const monitor of this.monitors) {
            const closestX = clamp(x, monitor.x, monitor.x + monitor.width);
            const closestY = clamp(y, monitor.y, monitor.y + monitor.height);
            const dx = x - closestX;
            const dy = y - closestY;

            if (dx * dx + dy * dy < radius * radius)
                return false;
        }
        return true;
    }

    _isClearOfBubbles(x, y, radius) {
        for (const other of this.bubbles) {
            const minDistance = radius + other.radius;
            const dx = x - other.x;
            const dy = y - other.y;

            if (dx * dx + dy * dy < minDistance * minDistance)
                return false;
        }
        return true;
    }

    _spawnEnteringBubble() {
        const config = this.config;
        const base = config.size * this.minDimension;
        const radius = Math.max(18, base * (1 + config.sizeVariation * rand(-1, 1)));
        const speed = config.speed * this.minDimension * rand(0.80, 1.40);
        const entrySpeed = Math.max(speed * 1.25, radius * 0.35);
        const angle = rand(-0.35, 0.35);
        const cosAngle = Math.cos(angle);
        const sinAngle = Math.sin(angle);

        for (let attempt = 0; attempt < 80; ++attempt) {
            if (this.spawnEdges.length === 0)
                break;

            const edge = this.spawnEdges[Math.floor(Math.random() * this.spawnEdges.length)];
            const along = rand(edge.from, edge.to);
            const offset = radius * rand(1.40, 3.50);

            const bubble = {
                x: 0,
                y: 0,
                vx: 0,
                vy: 0,
                radius,
                hue: Math.random(),
                phase: rand(0, TWO_PI),
                seed: Math.random(),
                entering: true,
            };

            if (edge.vertical) {
                bubble.x = edge.fixed - edge.nx * offset;
                bubble.y = along;
            } else {
                bubble.x = along;
                bubble.y = edge.fixed - edge.ny * offset;
            }

            if (!this._isClearOfMonitors(bubble.x, bubble.y, bubble.radius))
                continue;

            // Keep a small gap so the newcomer does not immediately collide.
            if (!this._isClearOfBubbles(bubble.x, bubble.y, bubble.radius * 1.25))
                continue;

            bubble.vx = (edge.nx * cosAngle - edge.ny * sinAngle) * entrySpeed;
            bubble.vy = (edge.nx * sinAngle + edge.ny * cosAngle) * entrySpeed;
            this.bubbles.push(bubble);
            return true;
        }

        return false;
    }

    _targetSpeed(bubble) {
        return this.config.speed * this.minDimension * (0.80 + 0.40 * bubble.seed);
    }

    update(dt) {
        if (!(dt > 0))
            return;

        this.time += dt;

        if (this.bubbles.length < this.targetCount) {
            this.spawnTimer -= dt;
            if (this.spawnTimer <= 0) {
                if (this._spawnEnteringBubble())
                    this.spawnTimer = this.config.spawnInterval * rand(0.80, 1.20);
                else
                    this.spawnTimer = 0.25;
            }
        }

        const w = this.width;
        const h = this.height;
        const wobble = 0.009 * this.minDimension;

        for (const bubble of this.bubbles) {
            bubble.vx += Math.cos(this.time * 0.55 + bubble.phase) * wobble * dt;
            bubble.vy += Math.sin(this.time * 0.42 + bubble.phase * 1.7) * wobble * dt;

            // Freeze the inward entry speed until the bubble is fully on screen.
            if (!bubble.entering) {
                const speed = Math.hypot(bubble.vx, bubble.vy);
                if (speed > 0.0001) {
                    const target = this._targetSpeed(bubble);
                    const scale = 1 + (target - speed) * dt * 0.6 / speed;
                    bubble.vx *= scale;
                    bubble.vy *= scale;
                }
            }

            bubble.x += bubble.vx * dt;
            bubble.y += bubble.vy * dt;
        }

        // Bounce off the world edges. A bubble still outside and moving inwards
        // is left alone so it can finish entering the screen.
        for (const bubble of this.bubbles) {
            if (!bubble.entering) {
                if (bubble.x - bubble.radius < 0 && bubble.vx < 0) {
                    bubble.x = bubble.radius;
                    bubble.vx = -bubble.vx;
                } else if (bubble.x + bubble.radius > w && bubble.vx > 0) {
                    bubble.x = w - bubble.radius;
                    bubble.vx = -bubble.vx;
                }

                if (bubble.y - bubble.radius < 0 && bubble.vy < 0) {
                    bubble.y = bubble.radius;
                    bubble.vy = -bubble.vy;
                } else if (bubble.y + bubble.radius > h && bubble.vy > 0) {
                    bubble.y = h - bubble.radius;
                    bubble.vy = -bubble.vy;
                }
            } else {
                // Never snap the position, only steer the velocity: this is
                // what prevents visible popping when a bubble enters.
                if (bubble.x < -bubble.radius && bubble.vx < 0)
                    bubble.vx = -bubble.vx;
                else if (bubble.x > w + bubble.radius && bubble.vx > 0)
                    bubble.vx = -bubble.vx;

                if (bubble.y + bubble.radius <= 0)
                    bubble.vy = Math.max(bubble.vy, bubble.radius * 0.12);
            }

            if (bubble.entering &&
                bubble.x - bubble.radius > 0 && bubble.x + bubble.radius < w &&
                bubble.y - bubble.radius > 0 && bubble.y + bubble.radius < h) {
                bubble.entering = false;
            }
        }

        // Collisions. Bubbles waiting below the screen push each other apart
        // out of sight, so they enter already spaced out.
        for (let i = 0; i < this.bubbles.length; ++i) {
            for (let j = i + 1; j < this.bubbles.length; ++j) {
                const a = this.bubbles[i];
                const b = this.bubbles[j];

                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const minDistance = a.radius + b.radius;
                const distance = Math.hypot(dx, dy);

                if (distance >= minDistance || distance <= 0.0001)
                    continue;

                const nx = dx / distance;
                const ny = dy / distance;
                const overlap = minDistance - distance;
                const massA = a.radius * a.radius;
                const massB = b.radius * b.radius;
                const totalMass = massA + massB;

                const aVisible = a.y + a.radius > 0;
                const bVisible = b.y + b.radius > 0;

                if (!aVisible && !bVisible) {
                    // Both off-screen: separate them with a capped step so
                    // nothing can be flung into the viewport in one tick.
                    const factor = 0.50;
                    const maxStep = 2.0;
                    const pushA = Math.min(overlap * (massB / totalMass) * factor, maxStep);
                    const pushB = Math.min(overlap * (massA / totalMass) * factor, maxStep);
                    a.x -= nx * pushA;
                    a.y -= ny * pushA;
                    b.x += nx * pushB;
                    b.y += ny * pushB;

                    const relative = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
                    if (relative < 0) {
                        const restitution = 0.45;
                        const impulse = -(1 + restitution) * relative / (1 / massA + 1 / massB);
                        a.vx -= impulse * nx / massA;
                        a.vy -= impulse * ny / massA;
                        b.vx += impulse * nx / massB;
                        b.vy += impulse * ny / massB;
                    }
                } else if (!aVisible || !bVisible) {
                    // Only the off-screen bubble moves.
                    const maxStep = 2.0;
                    const push = Math.min(overlap * 0.6, maxStep);
                    if (!aVisible) {
                        a.x -= nx * push;
                        a.y -= ny * push;
                    } else {
                        b.x += nx * push;
                        b.y += ny * push;
                    }
                } else {
                    // Both visible: smooth separation, low restitution.
                    const factor = 0.30;
                    const maxStep = 1.5;
                    const pushA = Math.min(overlap * (massB / totalMass) * factor, maxStep);
                    const pushB = Math.min(overlap * (massA / totalMass) * factor, maxStep);
                    a.x -= nx * pushA;
                    a.y -= ny * pushA;
                    b.x += nx * pushB;
                    b.y += ny * pushB;

                    const relative = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
                    if (relative < 0) {
                        const restitution = 0.15;
                        const impulse = -(1 + restitution) * relative / (1 / massA + 1 / massB);
                        a.vx -= impulse * nx / massA;
                        a.vy -= impulse * ny / massA;
                        b.vx += impulse * nx / massB;
                        b.vy += impulse * ny / massB;
                    }
                }
            }
        }
    }
}
