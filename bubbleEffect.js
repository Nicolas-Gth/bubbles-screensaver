import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

// Cogl fragment snippet. It replaces the fragment stage, so `cogl_color_out`
// and `cogl_tex_coord_in[0]` are provided by Cogl. The bubble is drawn in local
// coordinates: p = (-1..1), with y pointing up.
const DECLARATIONS = `
uniform float uRadius;
uniform float uCoordScale;
uniform vec3 uTint;
uniform float uSeed;
uniform float uPixelSize;
uniform float uIridescence;

uniform float uCrescentEnabled;
uniform float uOuter;
uniform float uPadding;
uniform float uOffset;
uniform float uAngle;
uniform float uCrescentOpacity;
uniform float uCrescentColor;
uniform float uCrescentSoft;
uniform float uCrescentGradient;

uniform float uSecondEnabled;
uniform float uSecondAngle;
uniform float uSecondOuter;
uniform float uSecondPadding;
uniform float uSecondOffset;
uniform float uSecondOpacity;
uniform float uSecondColor;
uniform float uSecondSoft;
uniform float uSecondGradient;

uniform float uBaseUL;
uniform float uBaseBR;
uniform float uBasePower;
uniform float uBaseOpacity;

uniform float uGlintSizeA;
uniform float uGlintSizeB;
uniform float uGlintOpacityA;
uniform float uGlintOpacityB;

vec3 spectral(float t) {
    vec3 x = fract(t + vec3(0.0, 0.33, 0.67));
    return clamp(abs(x * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

float areaLight(vec3 normal, vec3 direction, float power) {
    return pow(max(dot(normal, normalize(direction)), 0.0), power);
}

float crescentMask(vec2 p, float R, float angleDegrees, float padding, float offset, float soft, float gradient) {
    float angle = radians(angleDegrees);
    vec2 dir = vec2(cos(angle), sin(angle));
    vec2 cutoutCenter = -offset * dir;
    float cutoutRadius = max(R + offset - padding, 0.0);

    float dOuter = R - length(p);
    float dInner = length(p - cutoutCenter) - cutoutRadius;
    float m = min(dOuter, dInner);
    float s = max(soft, 0.0005);
    float mask = smoothstep(-s, s, m);

    if (abs(gradient) > 0.001) {
        float tInner = dOuter / max(dOuter + dInner, 0.00001);
        float factor = gradient >= 0.0
            ? mix(1.0, tInner, gradient)
            : mix(1.0, 1.0 - tInner, -gradient);
        mask *= clamp(factor, 0.0, 1.0);
    }

    return mask;
}
`;

const SOURCE = `
vec2 uv = cogl_tex_coord_in[0].xy;
vec2 p = vec2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0) * uCoordScale;
float r2 = dot(p, p);

if (r2 > 1.0) {
    cogl_color_out = vec4(0.0);
} else {
    float z = sqrt(max(1.0 - r2, 0.0));
    vec3 n = vec3(p, z);

    float t = 1.0 - z;
    float t2 = t * t;
    float edge = t2 * sqrt(sqrt(t));
    float rim = t2 * t2 * t2;

    float film = clamp(0.5 + 0.35 * p.x + 0.25 * p.y + 0.15 * uSeed, 0.0, 1.0);
    vec3 iridescence = spectral(film * (0.35 + 0.65 * z) * 3.0 + 0.15);
    vec3 shellColor = mix(uTint, iridescence, uIridescence);
    vec3 sheenColor = mix(uTint, mix(iridescence, iridescence.gbr, 0.45), uIridescence);

    vec3 color = shellColor * 0.06;
    color += shellColor * edge * 1.10;
    color += sheenColor * t2 * t2 * 0.25;
    color += vec3(1.0) * rim * 0.40;

    float alpha = 0.04 + edge * 0.75 + rim * 0.35;

    float glintA = 1.0 - smoothstep(0.15, 1.0,
        length((p - vec2(-0.42, 0.52)) / max(uGlintSizeA, 0.01)));
    float glintB = 1.0 - smoothstep(0.15, 1.0,
        length((p - vec2(0.38, -0.42)) / max(uGlintSizeB, 0.01)));
    color += vec3(1.0) * (glintA * 1.15 + glintB * 0.75);
    alpha += glintA * uGlintOpacityA + glintB * uGlintOpacityB;

    float base = areaLight(n, vec3(-0.55, 0.55, 0.62), uBasePower) * uBaseUL
               + areaLight(n, vec3(0.50, -0.50, 0.62), uBasePower) * uBaseBR;
    color += vec3(0.88, 0.94, 1.0) * base * 0.50;
    alpha += base * uBaseOpacity;

    float crescentA = 0.0;
    if (uCrescentEnabled > 0.5) {
        crescentA = crescentMask(p, uOuter, uAngle, uPadding, uOffset,
            uCrescentSoft, uCrescentGradient);
    }

    float crescentB = 0.0;
    if (uSecondEnabled > 0.5) {
        crescentB = crescentMask(p, uSecondOuter, uSecondAngle, uSecondPadding,
            uSecondOffset, uSecondSoft, uSecondGradient);
    }

    color += vec3(0.96, 0.98, 1.0) * (crescentA * uCrescentColor + crescentB * uSecondColor);
    alpha += crescentA * uCrescentOpacity + crescentB * uSecondOpacity;

    float edgeDistance = (1.0 - sqrt(r2)) * uRadius;
    alpha *= clamp(edgeDistance / (uPixelSize * 1.5), 0.0, 1.0);

    float finalAlpha = clamp(alpha, 0.0, 1.0);
    // Cogl's default blend is premultiplied alpha.
    cogl_color_out = vec4(color * finalAlpha, finalAlpha);
}
`;

export function hueToRgb(hue, saturation, value) {
    const h = (hue - Math.floor(hue)) * 6;
    const c = value * saturation;
    const x = c * (1 - Math.abs((h % 2) - 1));
    const m = value - c;

    let rgb;
    switch (Math.floor(h)) {
    case 0: rgb = [c, x, 0]; break;
    case 1: rgb = [x, c, 0]; break;
    case 2: rgb = [0, c, x]; break;
    case 3: rgb = [0, x, c]; break;
    case 4: rgb = [x, 0, c]; break;
    default: rgb = [c, 0, x]; break;
    }

    return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

export const BubbleEffect = GObject.registerClass(
class BubbleEffect extends Clutter.ShaderEffect {
    _init(params = {}) {
        super._init({});

        this._look = params.look;
        this._setFloat('uIridescence', params.iridescence);
        this._setFloat('uCrescentEnabled', this._look.crescentEnabled ? 1 : 0);
        this._setFloat('uOuter', this._look.outer);
        this._setFloat('uPadding', this._look.padding);
        this._setFloat('uOffset', this._look.offset);
        this._setFloat('uAngle', this._look.angle);
        this._setFloat('uCrescentOpacity', this._look.crescentOpacity);
        this._setFloat('uCrescentColor', this._look.crescentColor);
        this._setFloat('uCrescentSoft', this._look.crescentSoft);
        this._setFloat('uCrescentGradient', this._look.crescentGradient);

        this._setFloat('uSecondEnabled', this._look.secondEnabled ? 1 : 0);
        this._setFloat('uSecondAngle', this._look.secondAngle);
        this._setFloat('uSecondOuter', this._look.secondOuter);
        this._setFloat('uSecondPadding', this._look.secondPadding);
        this._setFloat('uSecondOffset', this._look.secondOffset);
        this._setFloat('uSecondOpacity', this._look.secondOpacity);
        this._setFloat('uSecondColor', this._look.secondColor);
        this._setFloat('uSecondSoft', this._look.secondSoft);
        this._setFloat('uSecondGradient', this._look.secondGradient);

        this._setFloat('uBaseUL', this._look.baseUL);
        this._setFloat('uBaseBR', this._look.baseBR);
        this._setFloat('uBasePower', this._look.basePower);
        this._setFloat('uBaseOpacity', this._look.baseOpacity);

        this._setFloat('uGlintSizeA', this._look.glintSizeA);
        this._setFloat('uGlintSizeB', this._look.glintSizeB);
        this._setFloat('uGlintOpacityA', this._look.glintOpacityA);
        this._setFloat('uGlintOpacityB', this._look.glintOpacityB);

        this.set_uniform_float('uTint', 3, params.tint);
        this._setFloat('uSeed', params.seed);
        this._setFloat('uRadius', params.radius * params.scale);
        this._setFloat('uPixelSize', 1.0);
        this._setFloat('uCoordScale', params.coordScale ?? 1.0);
    }

    _setFloat(name, value) {
        this.set_uniform_float(name, 1, [value]);
    }

    vfunc_get_static_snippet() {
        const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, null);
        snippet.set_replace(SOURCE);
        return snippet;
    }
});
