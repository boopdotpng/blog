/* ------------------------------------------------------------------ *
 *  The homepage painting: forested hills over a hazy bay, a castle
 *  town on the far shore, a meadow of blue flowers in front. At night
 *  the sky fills with stars and a meteor shower.
 *
 *  The whole picture is a function of place and time. `render()` lays
 *  it down once in full (that is what scripts/painting/render.sh bakes
 *  into day.webp / night.webp). On the page those images are the
 *  underpainting, and every frame a few hundred fresh crayon strokes
 *  are sampled from the scene as it is *now* (clouds further along,
 *  a gust crossing the meadow, a cloud shadow sliding over the hills)
 *  and laid on top, so the picture keeps moving without ever being
 *  redrawn. Petals and falling meteors live on a second canvas.
 *
 *  Everything is laid out in a fixed 2560x1600 space and fitted to the
 *  viewport like `background-size: cover`, so strokes land exactly on
 *  the image underneath.
 * ------------------------------------------------------------------ */
(() => {
  'use strict';

  const VW = 2560;
  const VH = 1600;
  const HOR = VH * 0.415; // horizon
  const FOCUS_X = 0.64; // must match background-position on .painting
  const TAU = Math.PI * 2;

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => {
    x = clamp((x - a) / (b - a));
    return x * x * (3 - 2 * x);
  };
  const hsl = (c, a = 1) => `hsla(${c[0]},${clamp(c[1], 0, 100)}%,${clamp(c[2], 0, 100)}%,${a})`;
  const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 2D value noise, for the fields that travel: gusts and cloud shadows
  const hash2 = (x, y) => {
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  function vnoise(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    return lerp(lerp(hash2(ix, iy), hash2(ix + 1, iy), u), lerp(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), u), v);
  }
  const fbm2 = (x, y) => vnoise(x, y) * 0.57 + vnoise(x * 2.03, y * 2.03) * 0.29 + vnoise(x * 4.1, y * 4.1) * 0.14;

  const SCENES = ['morning', 'day', 'sunset', 'night'];
  // Hues may run past 360 so that a ramp can pass from pink through red to orange without going the long way round.
  const DAYLIGHT = {
    lamps: 0,
    flag: [355, 62, 52],
    townTree: [165, 28, 42],
    boat: [[40, 60, 96], [20, 30, 34]],
    bloom: { tip: [220, 78, 52], mid: [210, 84, 66], core: [198, 90, 90], vein: [200, 90, 92], stem: [122, 40, 24], leaf: [115, 42, 29], eye: [48, 95, 78] },
  };
  const PALETTES = {
    // low sun in a lavender haze
    morning: {
      ...DAYLIGHT,
      sky: [[0, [221, 66, 43]], [0.35, [224, 64, 57]], [0.7, [233, 58, 71]], [0.9, [256, 50, 80]], [1, [282, 42, 85]]],
      sun: { x: 0.835, y: 0.105, r: 40, disc: [45, 90, 92, 98], glow: [18, 40, 72, 87], reach: 0.42, power: 0.8 },
      glitter: [30, 44, 85, 93],
      // plenty of it about first thing
      clouds: [[0.7, 0.16, 640, 120, 1], [0.93, 0.25, 420, 78, 1], [0.46, 0.25, 360, 66, 0.95], [0.2, 0.12, 480, 92, 0.95], [0.04, 0.28, 300, 54, 0.9], [0.33, 0.33, 240, 30, 0.7], [0.6, 0.345, 280, 28, 0.65], [0.84, 0.36, 220, 24, 0.6]],
      cloud: [[42, 70, 96], [252, 30, 78]],
      ranges: [[244, 30, 73], [236, 32, 62], [228, 33, 51]],
      snow: [[35, 60, 95], [245, 40, 86]],
      haze: [262, 48, 83],
      water: [[240, 48, 82], [226, 46, 69]],
      land: [205, 22, 58],
      wall: [34, 38, 86], wallShade: [250, 22, 72], roofs: [[14, 52, 60], [222, 26, 52], [24, 46, 66]],
      hills: [[188, 26, 41], [152, 46, 20], [148, 44, 22]],
      meadow: [112, 40, 33],
      grass: [[105, 42, 30], [92, 48, 42], [130, 38, 26], [78, 50, 48]],
      petal: [[214, 78, 60], [206, 82, 72], [222, 72, 52]],
      heart: [48, 80, 92],
      path: [36, 34, 64],
      shade: 9,
    },
    // high sun out of frame: clear blue, hard light, not a cloud in it
    day: {
      ...DAYLIGHT,
      sky: [[0, [216, 80, 40]], [0.4, [213, 78, 52]], [0.75, [208, 74, 66]], [1, [200, 62, 82]]],
      sun: null,
      glitter: null,
      clouds: [],
      cloud: [[205, 30, 98], [216, 28, 83]],
      ranges: [[217, 28, 74], [215, 30, 61], [211, 32, 49]],
      snow: [[205, 40, 98], [220, 38, 84]],
      haze: [204, 52, 84],
      water: [[203, 58, 74], [213, 62, 50]],
      land: [150, 22, 52],
      wall: [42, 36, 92], wallShade: [225, 22, 74], roofs: [[12, 58, 58], [220, 30, 50], [22, 52, 64]],
      hills: [[168, 30, 38], [142, 48, 23], [134, 48, 26]],
      meadow: [105, 48, 36],
      grass: [[100, 48, 33], [88, 55, 45], [125, 42, 28], [72, 58, 50]],
      petal: [[214, 80, 60], [206, 84, 72], [222, 74, 52]],
      heart: [48, 85, 92],
      path: [38, 38, 68],
      shade: 0, // no clouds, no cloud shadows
    },
    // the sun going down behind the ranges
    sunset: {
      ...DAYLIGHT,
      lamps: 0.4,
      flag: [350, 55, 40],
      townTree: [200, 26, 22],
      boat: [[25, 80, 80], [280, 25, 20]],
      sky: [[0, [246, 46, 30]], [0.3, [268, 44, 42]], [0.55, [312, 46, 56]], [0.75, [352, 68, 64]], [0.9, [384, 86, 64]], [1, [402, 92, 70]]],
      sun: { x: 0.8, y: 0.062, r: 66, disc: [44, 100, 78, 90], glow: [376, 402, 95, 66], reach: 0.6, power: 0.95 },
      glitter: [384, 404, 95, 72],
      clouds: [],
      cloud: [[376, 92, 76], [292, 30, 46]],
      ranges: [[292, 26, 56], [284, 28, 43], [272, 30, 32]],
      snow: [[384, 85, 80], [296, 28, 62]],
      haze: [372, 70, 66],
      water: [[382, 72, 70], [296, 34, 44]],
      land: [280, 22, 30],
      wall: [386, 62, 74], wallShade: [282, 26, 40], roofs: [[366, 46, 38], [258, 22, 30], [376, 44, 44]],
      hills: [[258, 22, 30], [178, 36, 14], [166, 34, 15]],
      meadow: [125, 30, 20],
      grass: [[115, 34, 18], [86, 42, 27], [140, 30, 15], [48, 52, 36]],
      petal: [[224, 70, 58], [214, 76, 70], [236, 62, 52]],
      heart: [42, 90, 86],
      path: [384, 38, 46],
      shade: 0,
      bloom: { tip: [228, 70, 48], mid: [216, 78, 62], core: [200, 85, 86], vein: [200, 85, 90], stem: [130, 34, 14], leaf: [125, 36, 18], eye: [44, 95, 74] },
    },
    night: {
      lamps: 0.75,
      flag: [350, 40, 22],
      townTree: [200, 30, 10],
      boat: [[225, 25, 30], [225, 30, 9]],
      sky: [[0, [234, 58, 6]], [0.4, [231, 55, 11]], [0.75, [226, 50, 17]], [1, [214, 46, 27]]],
      sun: null,
      glitter: null,
      // they come back after dark, drifting in front of the stars
      clouds: [[0.16, 0.29, 520, 84, 0.9], [0.6, 0.17, 400, 70, 0.85], [0.9, 0.32, 460, 74, 0.9], [0.4, 0.36, 260, 26, 0.6]],
      cloud: [[224, 30, 31], [230, 36, 15]],
      ranges: [[230, 34, 21], [229, 38, 16], [227, 42, 12]],
      snow: [[225, 30, 40], [230, 30, 30]],
      haze: [220, 45, 30],
      water: [[224, 46, 25], [226, 48, 15]],
      land: [215, 30, 15],
      wall: [228, 26, 20], wallShade: [230, 30, 14], roofs: [[232, 30, 12], [225, 28, 16]],
      hills: [[205, 34, 11], [190, 36, 8], [185, 34, 7.5]],
      meadow: [170, 32, 10],
      grass: [[160, 30, 9], [175, 35, 13], [150, 28, 12]],
      petal: [[205, 95, 70], [195, 100, 80], [215, 90, 62]],
      heart: [190, 100, 93],
      path: [218, 20, 21],
      shade: 0,
      bloom: { tip: [212, 95, 60], mid: [200, 100, 72], core: [186, 100, 93], vein: [190, 100, 92], stem: [168, 34, 15], leaf: [165, 36, 18], eye: [55, 100, 88] },
    },
  };
  const GLOW = 'hsla(198, 100%, 70%, 0.9)';
  // Canvas shadows are blurred afresh for every shape, every frame: far too dear for a few hundred
  // glowing things. On the page the glow is one soft disc, drawn once and stamped under whatever shines.
  let glowCv = null;
  function glowAt(c, x, y, r, a) {
    if (!glowCv) {
      glowCv = document.createElement('canvas');
      glowCv.width = glowCv.height = 64;
      const gc = glowCv.getContext('2d');
      const gr = gc.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'hsla(198, 100%, 70%, 0.9)');
      gr.addColorStop(0.35, 'hsla(198, 100%, 70%, 0.5)');
      gr.addColorStop(0.65, 'hsla(198, 100%, 70%, 0.15)');
      gr.addColorStop(1, 'hsla(198, 100%, 70%, 0)');
      gc.fillStyle = gr;
      gc.fillRect(0, 0, 64, 64);
    }
    c.globalAlpha = a;
    c.drawImage(glowCv, x - r, y - r, r * 2, r * 2);
    c.globalAlpha = 1;
  }

  const r3 = (q) => q[2] - q[1]; // how far a puff reaches above the cloud base

  function createPainting(scene, seed = 11) {
    const P = PALETTES[scene] || PALETTES.morning;
    const NIGHT = P === PALETTES.night;
    const G = rng(seed); // geometry: identical on every run, so live strokes line up with the baked image
    let R = rng(seed * 7919 + 1); // the brush hand
    const rr = (a, b) => a + (b - a) * R();
    const g = () => R() + R() + R() + R() - 2; // ~gaussian, sd ≈ 0.58
    const gG = () => G() + G() + G() + G() - 2;
    const jit = (c, h = 0, s = 0, l = 0) => [c[0] + g() * h, c[1] + g() * s, c[2] + g() * l];
    // far-apart hues are never lerped (blue to orange passes through green): one or the other is chosen
    const pick = (a, b, t) => (R() < t ? b : a);
    const any = (list) => list[(R() * list.length) | 0];
    const ramp = (stops, t) => {
      for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i][0]) return mix(stops[i - 1][1], stops[i][1], (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
      }
      return stops[stops.length - 1][1];
    };

    const makeNoise = () => {
      const t = Array.from({ length: 512 }, () => G());
      return (x) => {
        const i = Math.floor(x);
        const f = x - i;
        const u = f * f * (3 - 2 * f);
        return t[i & 511] * (1 - u) + t[(i + 1) & 511] * u;
      };
    };
    const fbm = (n, x, oct = 4) => {
      let a = 0;
      let amp = 0.5;
      let fr = 1;
      for (let o = 0; o < oct; o++) {
        a += amp * n(x * fr);
        amp *= 0.5;
        fr *= 2.07;
      }
      return a / 0.94;
    };
    const nA = makeNoise();
    const nB = makeNoise();
    // fixed patchiness: where the woods are lighter, where the flowers gather
    const patch = (x, y) => fbm(nA, x * 0.003 + y * 0.0017) * 0.6 + fbm(nB, y * 0.006 - x * 0.0012) * 0.4;

    let ctx = null;
    let time = 0;

    // ── things that travel on the wind (it blows right to left) ──
    const gust = (x, y) => smooth(0.38, 0.78, fbm2((x + time * 150) * 0.0021, y * 0.0055 + 9 + time * 0.06));
    const shadow = (x, y) => (!P.shade ? 0 : smooth(0.5, 0.72, fbm2((x + time * 26) * 0.0015, y * 0.004 + 40)));

    // ── brushes ──────────────────────────────────────────────
    function line(x0, y0, x1, y1, w, style) {
      ctx.strokeStyle = style;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    // a crayon stroke: a bundle of thin, slightly ragged parallel lines
    function crayon(x, y, ang, len, w, c, alpha) {
      const n = Math.max(2, Math.round(w / 2.4));
      const cx = Math.cos(ang);
      const sy = Math.sin(ang);
      for (let i = 0; i < n; i++) {
        const off = (i / (n - 1) - 0.5) * w + g() * 0.8;
        const l = len * rr(0.7, 1.05);
        const sh = g() * len * 0.08;
        const px = x - sy * off + cx * sh;
        const py = y + cx * off + sy * sh;
        line(px - (cx * l) / 2, py - (sy * l) / 2, px + (cx * l) / 2, py + (sy * l) / 2, rr(1.4, 2.8), hsl(jit(c, 0, 0, 2.5), alpha * rr(0.55, 1)));
      }
    }
    function blob(x, y, rx, ry, rot, style) {
      ctx.fillStyle = style;
      ctx.beginPath();
      ctx.ellipse(x, y, Math.max(0.3, rx), Math.max(0.3, ry), rot, 0, TAU);
      ctx.fill();
    }
    function fillBelow(top, style, bottom = VH) {
      ctx.fillStyle = style;
      ctx.beginPath();
      ctx.moveTo(-10, bottom + 10);
      for (let x = -10; x <= VW + 10; x += 6) ctx.lineTo(x, top(x));
      ctx.lineTo(VW + 10, bottom + 10);
      ctx.closePath();
      ctx.fill();
    }

    // ── geometry ─────────────────────────────────────────────
    const SUN = P.sun && { x: VW * P.sun.x, y: HOR - VH * P.sun.y, r: P.sun.r };

    const RANGES = [
      { base: HOR, amp: VH * 0.27, freq: 1 / 560, snow: true },
      { base: HOR + VH * 0.005, amp: VH * 0.15, freq: 1 / 400 },
      { base: HOR + VH * 0.014, amp: VH * 0.075, freq: 1 / 300 },
    ].map((d, i) => {
      const n = makeNoise();
      // ridged noise gives creased, alpine peaks instead of soft lumps
      d.top = (x) => {
        const u = x * d.freq + i * 9;
        const ridged = 1 - Math.abs(2 * fbm(n, u, 5) - 1);
        return d.base - d.amp * Math.max(0, ridged * 0.75 + fbm(n, u * 0.37 + 40, 2) * 0.55 - 0.62);
      };
      return d;
    });
    const ridge = (x) => Math.min(RANGES[0].top(x), RANGES[1].top(x), RANGES[2].top(x));

    const nH = [makeNoise(), makeNoise(), makeNoise(), makeNoise()];
    const X = (x) => clamp(x / VW);
    const HILLS = [
      {
        top: (x) => VH * 0.5 + (fbm(nH[0], x / 420) - 0.5) * VH * 0.06 + X(x) * VH * 0.012,
        n: 15000, size: [2.2, 4.6], yMax: VH * 0.72, light: NIGHT ? 4 : 14, rim: NIGHT ? 3 : 9, fall: 2, shift: 0,
      },
      {
        top: (x) => VH * (0.468 + 0.31 * X(x) ** 0.85) + (fbm(nH[1], x / 300) - 0.5) * VH * 0.06,
        n: 30000, size: [3.5, 7.5], yMax: VH, light: NIGHT ? 5 : 22, rim: NIGHT ? 2 : 7, fall: NIGHT ? 2 : 6, shift: 700,
      },
      {
        top: (x) => VH * (0.815 - 0.25 * X(x) ** 1.6) + (fbm(nH[2], x / 280) - 0.5) * VH * 0.055,
        n: 28000, size: [4, 8.5], yMax: VH, light: NIGHT ? 5 : 24, rim: NIGHT ? 2 : 8, fall: NIGHT ? 2 : 5, shift: 1900,
      },
    ];
    HILLS.forEach((h, i) => (h.col = P.hills[i]));
    const meadowTop = (x) => VH * (0.845 - 0.075 * Math.cos((x / VW - 0.66) * 2.3)) + (fbm(nH[3], x / 500) - 0.5) * VH * 0.02;
    const hillsTop = (x) => Math.min(HILLS[0].top(x), HILLS[1].top(x), HILLS[2].top(x));
    const WATER_TOP = HOR + VH * 0.012;

    // A dirt track: up out of the meadow, through the notch where the near hills meet,
    // and over the far ridge toward the lake. Right of centre, thin, and pale.
    const PATH = (() => {
      const k = [[0.775, 1.03, 34], [0.715, 0.955, 26], [0.742, 0.895, 19], [0.695, 0.84, 13], [0.674, 0.8, 10], [0.664, 0.772, 8.5], [0.67, 0.745, 7.5],
        [0.654, 0.72, 6.5], [0.664, 0.69, 5.5], [0.675, 0.655, 4.6], [0.653, 0.615, 3.8], [0.676, 0.575, 3.1], [0.666, 0.54, 2.6], [0.674, 0.5, 2.2], [0.67, 0.47, 2]];
      const at = (i) => k[clamp(i, 0, k.length - 1)];
      const out = [];
      for (let i = 0; i < k.length - 1; i++) {
        for (let n = 0; n < 18; n++) {
          const t = n / 18;
          // Catmull-Rom through the knots
          const cr = (j) => 0.5 * (2 * at(i)[j] + (at(i + 1)[j] - at(i - 1)[j]) * t + (2 * at(i - 1)[j] - 5 * at(i)[j] + 4 * at(i + 1)[j] - at(i + 2)[j]) * t * t + (3 * at(i)[j] - at(i - 1)[j] - 3 * at(i + 1)[j] + at(i + 2)[j]) * t * t * t);
          const pt = { x: cr(0) * VW, y: cr(1) * VH, w: cr(2) * 0.7 };
          if (pt.y > HILLS[0].top(pt.x) + 4) out.push(pt); // it drops out of sight over the far ridge
        }
      }
      return out;
    })();
    const pathNear = (x, y, pad) => {
      if (x < VW * 0.62 || x > VW * 0.8) return false;
      for (const p of PATH) if ((x - p.x) ** 2 + (y - p.y) ** 2 < (p.w / 2 + pad) ** 2) return true;
      return false;
    };
    function drawPath(where) {
      for (let i = 0; i < PATH.length - 1; i++) {
        const a = PATH[i];
        const b = PATH[i + 1];
        if (!where(a)) continue;
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        line(a.x, a.y, b.x, b.y, a.w, hsl(P.path, 0.34));
        // worn unevenly: ragged dabs of lighter and darker earth along the way
        crayon(a.x + g() * a.w * 0.25, a.y, ang + g() * 0.2, a.w * rr(1, 2) + 5, a.w * 0.9, jit(P.path, 3, 4, 6), rr(0.18, 0.42));
      }
    }

    const TOWN = { cx: VW * 0.655, base: HOR + VH * 0.047, half: VW * 0.125 };
    TOWN.hill = (x) => TOWN.base - VH * 0.05 * Math.exp(-(((x - TOWN.cx) / (TOWN.half * 0.5)) ** 2)) - VH * 0.006;
    const BOATS = [
      [TOWN.cx - TOWN.half * 1.5, TOWN.base + 30, 1],
      [TOWN.cx + TOWN.half * 1.35, TOWN.base + 46, 1.3],
      [TOWN.cx - TOWN.half * 0.2, TOWN.base + 62, 1.6],
      [VW * 0.4, TOWN.base + 22, 0.8],
    ];

    // Cumulus: a flat base, a row of billows along it and a few taller towers heaped on top.
    // Their own generator, so every scene shares the same meadow whatever its weather.
    const GC = rng(seed + 101);
    const CLOUDS = P.clouds.map(([fx, fy, w, h, alpha]) => {
      const puffs = [];
      const row = Math.max(3, Math.round(w / (h * 0.8)));
      for (let i = 0; i < row; i++) {
        const u = i / (row - 1) - 0.5;
        const r = h * (0.3 + GC() * 0.2) * (0.45 + 0.75 * Math.sqrt(1 - (2 * u) ** 2));
        puffs.push([u * w * 0.9 + (GC() - 0.5) * h * 0.3, -r * 0.55, r]);
      }
      for (let i = 0, n = 2 + Math.round(w / 260); i < n; i++) {
        const u = (GC() + GC() + GC()) / 3 - 0.5; // towers gather toward the middle
        const r = h * (0.3 + GC() * 0.22) * (1 - Math.abs(u) * 0.8);
        puffs.push([u * w * 0.75, -h * (0.4 + GC() * 0.32) * (1 - Math.abs(u)), r]);
      }
      const top = Math.max(...puffs.map((q) => r3(q)));
      const weight = puffs.reduce((a, q) => a + q[2] * q[2], 0);
      // higher clouds are nearer and cross the sky faster
      return { x: fx * VW, y: fy * VH, w, h, alpha, puffs, top, weight, speed: lerp(9, 3, clamp(fy / 0.35)) * (NIGHT ? 0.5 : 1) };
    });
    const inCloud = (x, y, pad) => {
      for (const c of CLOUDS) if (Math.abs(x - c.x) < c.w * 0.5 + c.h * 0.4 + pad && y > c.y - c.top - pad && y < c.y + pad) return true;
      return false;
    };

    const STARS = [];
    if (NIGHT) {
      for (let i = 0; i < 5200; i++) { // a faint band of dust across the sky
        const u = -0.1 + G() * 1.2;
        const s = { x: u * VW + gG() * 60, y: lerp(VH * 0.34, -VH * 0.04, u) + gG() * VH * 0.085, r: 0.4 + G() * 0.7, dust: true, hue: 215 + G() * 50, l: 62 + G() * 26, a: 0.08 + G() * 0.37 };
        if (s.y < ridge(s.x) - 8) STARS.push(s);
      }
      for (let i = 0; i < 1700; i++) {
        const big = G() < 0.045;
        const s = { x: G() * VW, y: G() * (HOR - 20), big, r: big ? 1.7 + G() : 0.5 + G() * 0.9, hue: G() < 0.2 ? 25 + G() * 25 : 200 + G() * 35, l: 84 + G() * 13, a: 0.35 + G() * 0.65, k: 0.6 + G() * 2.4, ph: G() * TAU };
        s.a *= clamp((HOR - s.y) / (VH * 0.1), 0.25, 1);
        if (s.y < ridge(s.x) - 8) STARS.push(s);
      }
    }

    const FLOWERS = [];
    for (let i = 0; i < 9000; i++) {
      const x = -20 + G() * (VW + 40);
      const y0 = meadowTop(x);
      const y = y0 - 4 + G() ** 1.15 * (VH + 20 - y0);
      // they gather in drifts rather than an even carpet
      if (patch(x * 1.7 + 900, y * 3.2) < 0.36 + G() * 0.2 || pathNear(x, y, 7)) continue;
      const d = clamp((y - y0) / (VH - y0));
      FLOWERS.push({ x, y, s: lerp(0.3, 1.75, d ** 0.9) * (0.75 + G() * 0.45), c: (G() * 3) | 0, rot: G() * Math.PI, squash: 0.55 + G() * 0.3 });
    }
    FLOWERS.sort((a, b) => a.y - b.y);

    const PETALS = Array.from({ length: 54 }, () => ({
      ph: G(), period: 11 + G() * 14, x0: VW * (0.5 + G() * 0.62), run: VW * (0.35 + G() * 0.55),
      y0: VH * (0.8 + G() * 0.16), rise: VH * (0.12 + G() ** 1.6 * 0.62), amp: 14 + G() * 30, s: 0.7 + G() * 0.8, c: (G() * 3) | 0, spin: 1.2 + G() * 2.6,
    }));

    // the blooms nearest the viewer: tall, five-petalled, close enough to count
    const BLOOMS = [];
    for (let i = 0; i < 46; i++) {
      // crowding the corners, thinning out toward the middle so the meadow shows through
      const side = G() < 0.5 ? G() ** 1.7 * 0.5 : 1 - G() ** 1.7 * 0.5;
      const z = G();
      BLOOMS.push({
        x: side * VW + gG() * 30, z, s: lerp(0.55, 1.3, z), h: lerp(70, 330, G() ** 1.3) * lerp(0.7, 1.1, z),
        lean: gG() * 60, rot: G() * TAU, squash: 0.62 + G() * 0.3, ph: G() * TAU, bud: G() < 0.16, leaf: 0.25 + G() * 0.2,
      });
    }
    BLOOMS.sort((a, b) => a.z - b.z);

    // ── sky ──────────────────────────────────────────────────
    function skyCol(x, y) {
      let c = jit(ramp(P.sky, clamp(y / HOR + g() * 0.07)), 4, 3, NIGHT ? 2 : 4.5);
      if (SUN) {
        // warm the sky around the low sun
        const d = Math.hypot(x - SUN.x, (y - SUN.y) * 1.6) / (VW * P.sun.reach);
        const w = P.sun.glow;
        if (d < 1) c = pick(c, jit([rr(w[0], w[1]), w[2], w[3]], 0, 4, 3), (1 - d) ** 1.8 * P.sun.power);
      }
      return c;
    }
    const townSkyline = (x) => (Math.abs(x - TOWN.cx) > TOWN.half ? VH : TOWN.hill(x) - (Math.abs(x - TOWN.cx) < 90 ? 155 : 85));
    // live strokes may not run over anything painted in front of the sky
    function skyBlocked(x, y) {
      if (y > ridge(x) - 6 || y > townSkyline(x)) return true;
      if (SUN && Math.hypot(x - SUN.x, y - SUN.y) < SUN.r + 14) return true;
      return inCloud(x, y, 10);
    }
    function skyStroke(x, y, live) {
      const ang = -0.4 + g() * 0.09;
      let len = rr(70, 250);
      if (live) {
        const dx = Math.cos(ang) / 2;
        const dy = Math.sin(ang) / 2;
        // shorten until the stroke fits between the clouds and the ridge
        for (; len > 20; len *= 0.5) {
          let hit = false;
          for (let k = -1; k <= 1 && !hit; k += 0.5) hit = skyBlocked(x + dx * len * k, y + dy * len * k);
          if (!hit) break;
        }
        if (len <= 20) return;
      }
      crayon(x, y, ang, len, rr(4, 12), skyCol(x, y), rr(0.22, 0.6));
    }

    function cloudDots(c, n) {
      const [body, shade] = P.cloud;
      for (let i = 0; i < n; i++) {
        let at = R() * c.weight;
        let q = c.puffs[0];
        for (const puff of c.puffs) {
          q = puff;
          if ((at -= puff[2] * puff[2]) <= 0) break;
        }
        const stray = R() < 0.14; // a fringe of loose flecks keeps the edge soft
        const a = R() * TAU;
        const d = stray ? q[2] * rr(0.95, 1.3) : q[2] * Math.sqrt(R());
        const x = c.x + q[0] + Math.cos(a) * d;
        let y = c.y + q[1] + Math.sin(a) * d * 0.9;
        if (y > c.y) y = c.y - R() * c.h * 0.07; // the flat base
        if (y > ridge(x) - 6) continue;
        // shaded underneath and on the side away from the sun, bright where the billows catch it
        const height = clamp((c.y - y) / c.top);
        const turned = clamp(0.5 + ((y - c.y - q[1]) * 0.6 - (x - c.x - q[0]) * 0.35) / q[2]);
        const dim = clamp((1 - height) ** 1.6 * 0.75 + turned * 0.3 - 0.12);
        const r = stray ? rr(0.8, 2.2) : rr(1.6, 5);
        blob(x, y, r, r * rr(0.7, 1), 0, hsl(jit(pick(body, shade, dim), 0, 0, 2), c.alpha * (stray ? rr(0.3, 0.7) : rr(0.4, 0.85))));
      }
    }

    function star(s, live) {
      if (s.dust) {
        blob(s.x, s.y, s.r, s.r, 0, hsl([s.hue, 60, s.l], s.a));
        return;
      }
      // twinkling means dimming too: put a little night back first
      if (live) blob(s.x, s.y, s.r * (s.big ? 4.2 : 2.6), s.r * (s.big ? 4.2 : 2.6), 0, hsl(ramp(P.sky, clamp(s.y / HOR)), 0.85));
      const a = s.a * (live ? 0.5 + 0.5 * Math.sin(time * s.k + s.ph) ** 2 : 1);
      const c = [s.hue, 65, s.l];
      blob(s.x, s.y, s.r, s.r, 0, hsl(c, a));
      if (s.big) {
        line(s.x - s.r * 3.6, s.y, s.x + s.r * 3.6, s.y, 0.8, hsl(c, a * 0.5));
        line(s.x, s.y - s.r * 3.6, s.x, s.y + s.r * 3.6, 0.8, hsl(c, a * 0.5));
      }
    }

    // ── meteors: one radiant off the top right, every trail runs down and to the left ──
    const METEOR_ANG = Math.PI * 0.69;
    function meteorTrail(c, hx, hy, len, w, bright, ang) {
      const tx = hx - Math.cos(ang) * len;
      const ty = hy - Math.sin(ang) * len;
      const grad = c.createLinearGradient(tx, ty, hx, hy);
      grad.addColorStop(0, hsl([205, 90, 80], 0));
      grad.addColorStop(0.6, hsl([200, 90, 80], 0.3 * bright));
      grad.addColorStop(1, hsl([190, 95, 95], bright));
      c.strokeStyle = grad;
      c.lineWidth = w;
      c.beginPath();
      c.moveTo(tx, ty);
      c.lineTo(hx, hy);
      c.stroke();
      const glow = c.createRadialGradient(hx, hy, 0, hx, hy, w * 7);
      glow.addColorStop(0, hsl([190, 100, 96], 0.85 * bright));
      glow.addColorStop(0.25, hsl([195, 100, 82], 0.3 * bright));
      glow.addColorStop(1, hsl([200, 100, 75], 0));
      c.fillStyle = glow;
      c.beginPath();
      c.arc(hx, hy, w * 7, 0, TAU);
      c.fill();
    }
    function bakedMeteors() {
      for (let i = 0; i < 15; i++) {
        const big = i < 4;
        const hx = big ? rr(VW * 0.4, VW * 0.93) : rr(VW * 0.06, VW);
        const hy = Math.min(big ? rr(VH * 0.09, VH * 0.24) : rr(VH * 0.03, HOR - VH * 0.1), ridge(hx) - 50);
        meteorTrail(ctx, hx, hy, big ? rr(430, 720) : rr(110, 330), big ? rr(3.2, 4.6) : rr(1.3, 2.6), big ? 1 : rr(0.45, 0.9), METEOR_ANG + g() * 0.035);
      }
    }

    const meteors = [];
    let meteorWait = NIGHT ? 0.4 : 2.5;
    function spawnMeteor(view) {
      const big = R() < 0.22;
      const ex = rr(view.x0 - 60, view.x1 + 260);
      const ey = rr(VH * 0.07, Math.max(VH * 0.1, ridge(clamp(ex, 0, VW)) - 60));
      const dist = big ? rr(620, 1050) : rr(300, 640);
      const ang = METEOR_ANG + g() * 0.03;
      meteors.push({ ex, ey, ang, dist, len: big ? rr(380, 640) : rr(130, 300), w: big ? rr(3, 4.4) : rr(1.4, 2.6), bright: (big ? 1 : rr(0.5, 0.9)) * (NIGHT ? 1 : 0.6), dur: dist / rr(950, 1300), t: 0, big });
    }
    function meteorAt(m) {
      const u = clamp(m.t / m.dur);
      const gone = m.dist * (1 - (1 - u) ** 1.6); // fast out of the radiant, slowing as it burns up
      const back = m.dist - gone;
      return { x: m.ex - Math.cos(m.ang) * back, y: m.ey - Math.sin(m.ang) * back, len: Math.min(m.len, gone), a: smooth(0, 0.12, u) * (1 - smooth(0.62, 1, u)) };
    }

    // ── distance ─────────────────────────────────────────────
    function ranges() {
      RANGES.forEach((d, i) => {
        const c = P.ranges[i];
        const foot = HOR + VH * 0.03;
        fillBelow(d.top, hsl(c), foot);
        for (let k = 0; k < 4200; k++) {
          const x = rr(0, VW);
          const y0 = d.top(x);
          const y = y0 + R() ** 1.4 * (foot - y0);
          const facing = clamp((d.top(x + 8) - d.top(x - 8)) / 9, -1, 1); // > 0 faces the sun
          const height = (d.base - y) / d.amp;
          let col = jit([c[0], c[1], c[2] + facing * (NIGHT ? 2.5 : 6)], 3, 2, 2);
          if (d.snow && height > rr(0.3, 0.5)) col = P.snow[facing > 0 ? 0 : 1];
          else col = mix(col, P.haze, clamp(1 - height * 2.2) * 0.7);
          crayon(x, y, facing > 0 ? rr(0.7, 1.15) : rr(1.9, 2.4), rr(14, 46), rr(3, 7), col, rr(0.3, 0.6));
        }
      });
    }

    const WATER_BOTTOM = VH * 0.56;
    function waterBlocked(x, y) {
      if (y > hillsTop(x) - 5) return true;
      if (y < TOWN.base + 12 && x > TOWN.cx - TOWN.half * 1.78 && x < TOWN.cx + TOWN.half * 1.98) return true;
      for (const [bx, by, s] of BOATS) if (Math.abs(x - bx - s) < 14 * s && y > by - 20 * s && y < by + 6 * s) return true;
      return false;
    }
    function waterStroke(x, y, live) {
      const len = live ? rr(24, 90) : rr(30, 150);
      if (live && (waterBlocked(x - len / 2, y) || waterBlocked(x + len / 2, y) || waterBlocked(x, y))) return;
      let c = jit(mix(P.water[0], P.water[1], (y - WATER_TOP) / (WATER_BOTTOM - WATER_TOP)), 4, 4, 4);
      // the town, mirrored: lamplight at night, walls and roofs by day
      const inRefl = Math.abs(x - TOWN.cx) < TOWN.half * 0.9 && y > TOWN.base && y < TOWN.base + VH * 0.055;
      if (inRefl && R() < (1 - (y - TOWN.base) / (VH * 0.055)) * (1 - Math.abs(x - TOWN.cx) / (TOWN.half * 0.9)) * 1.3) {
        const rc = NIGHT ? [rr(32, 46), 90, 64] : R() < 0.3 ? P.roofs[0] : P.wall;
        crayon(x, y, g() * 0.03, rr(8, 26), 2.5, rc, NIGHT ? rr(0.25, 0.65) : rr(0.2, 0.45));
        return;
      }
      if (SUN && P.glitter) {
        // sun glitter, coming and going
        const d = Math.abs(x - SUN.x) / (VW * 0.16);
        const w = P.glitter;
        if (d < 1) c = pick(c, [rr(w[0], w[1]), w[2], w[3]], (1 - d) * (0.3 + 0.4 * vnoise(x * 0.02 + time * 0.7, y * 0.05)));
      }
      crayon(x, y, g() * 0.02, len, rr(2, 5), c, rr(0.25, 0.6));
    }
    function water() {
      const grad = ctx.createLinearGradient(0, WATER_TOP, 0, WATER_BOTTOM);
      grad.addColorStop(0, hsl(P.water[0]));
      grad.addColorStop(1, hsl(P.water[1]));
      ctx.fillStyle = grad;
      ctx.fillRect(0, WATER_TOP, VW, WATER_BOTTOM - WATER_TOP);
      for (let i = 0; i < 4200; i++) waterStroke(rr(0, VW), rr(WATER_TOP, WATER_BOTTOM), false);
    }

    function town() {
      const { cx, base, half, hill } = TOWN;
      // the promontory it sits on
      ctx.fillStyle = hsl(P.land);
      ctx.beginPath();
      ctx.moveTo(cx - half * 1.7, base + 5);
      for (let x = cx - half * 1.7; x <= cx + half * 1.9; x += 8) {
        const edge = clamp((x - (cx - half * 1.7)) / 90) * clamp((cx + half * 1.9 - x) / 140);
        ctx.lineTo(x, lerp(base + 5, hill(x), edge));
      }
      ctx.lineTo(cx + half * 1.9, base + 5);
      ctx.fill();

      const { wall, wallShade, roofs } = P;
      const dark = [wallShade[0], wallShade[1], wallShade[2] * 0.5];
      const lamp = () => hsl([rr(32, 46), 95, rr(62, 76)], rr(0.7, 1));
      const lit = () => R() < P.lamps;
      const tri = (x, y, hw, h, c) => {
        ctx.fillStyle = hsl(c);
        ctx.beginPath();
        ctx.moveTo(x - hw, y);
        ctx.lineTo(x, y - h);
        ctx.lineTo(x + hw, y);
        ctx.fill();
      };
      const walls = (x, y, w, h, j) => {
        ctx.fillStyle = hsl(jit(wall, j, j, j + 1));
        ctx.fillRect(x - w / 2, y - h, w, h);
        ctx.fillStyle = hsl(wallShade, 0.62); // the side away from the sun
        ctx.fillRect(x - w / 2, y - h, w * 0.39, h);
      };
      const crenels = (x0, x1, y) => {
        ctx.fillStyle = hsl(wall);
        for (let x = x0; x < x1 - 3; x += 6) ctx.fillRect(x, y - 4, 3.4, 4.5);
      };
      // an arrow slit by day, a lit window once the lamps come on
      const slit = (x, y, h = 5) => {
        ctx.fillStyle = lit() ? lamp() : hsl(dark, 0.85);
        ctx.fillRect(x - 0.9, y, 1.8, h);
      };
      const flag = (x, y, dir) => {
        line(x, y, x, y - 12, 1, hsl(dark));
        ctx.fillStyle = hsl(P.flag);
        ctx.beginPath();
        ctx.moveTo(x, y - 12);
        ctx.lineTo(x + dir * 10, y - 9.5);
        ctx.lineTo(x, y - 7);
        ctx.fill();
      };
      const tower = (x, y, w, h, cone, o = {}) => {
        walls(x, y, w, h, 2);
        ctx.fillStyle = hsl(wall); // the parapet, a little proud of the shaft
        ctx.fillRect(x - w / 2 - 1.5, y - h - 1, w + 3, 3.5);
        tri(x, y - h - 1, w / 2 + 3, cone, o.roof || roofs[1]);
        for (let wy = y - h + 9; wy < y - 12 && !o.plain; wy += 17) slit(x + 0.5, wy);
        if (o.flag) flag(x, y - h - 1 - cone, o.flag);
      };
      const house = (x, y, w, h) => {
        walls(x, y, w, h, 3);
        tri(x, y - h, w / 2 + 1.5, w * rr(0.45, 0.8), jit(any(roofs), 4, 4, 4));
        if (lit()) blob(x + rr(-w / 4, w / 4), y - h * rr(0.3, 0.7), 1.3, 1.5, 0, lamp());
      };

      // ── the castle crowning the hill ──
      const ty = hill(cx) + 6;
      // the tall towers at the back
      tower(cx - 49, ty - 8, 13, 68, 24, { flag: -1 });
      tower(cx + 48, ty - 8, 12, 60, 22);
      tower(cx - 23, ty - 10, 10, 88, 22);
      tower(cx + 25, ty - 10, 10, 79, 20, { flag: 1 });
      // the keep, in two tiers under a steep roof
      walls(cx + 1, ty - 10, 34, 64, 0);
      crenels(cx - 16, cx + 19, ty - 74);
      for (const dx of [-8, 1.5, 11]) for (const dy of [58, 40]) slit(cx + dx, ty - dy, 6);
      walls(cx + 1, ty - 74, 20, 23, 0);
      slit(cx + 1.5, ty - 90, 6);
      tri(cx + 1, ty - 97, 13.5, 32, roofs[1]);
      flag(cx + 1, ty - 129, 1);
      // the inner ward: a hall with a row of tall windows
      walls(cx, ty - 2, 98, 31, 0);
      crenels(cx - 49, cx + 50, ty - 33);
      for (let dx = -40; dx <= 40; dx += 10) slit(cx + dx, ty - 22, 7);
      tri(cx - 30, ty - 33, 12, 13, roofs[0]); // the chapel gable
      blob(cx - 30, ty - 37, 2.2, 2.2, 0, lit() ? lamp() : hsl(dark, 0.8));
      // the curtain wall with its turrets, and the gatehouse
      walls(cx, ty + 13, 152, 24, 0);
      crenels(cx - 76, cx + 77, ty - 11);
      for (const dx of [-76, -42, 42, 76]) tower(cx + dx, ty + 13, 10, 33, 11, { roof: roofs[0], plain: true });
      walls(cx, ty + 13, 22, 33, 0);
      crenels(cx - 11, cx + 12, ty - 20);
      ctx.fillStyle = hsl(dark);
      ctx.beginPath();
      ctx.moveTo(cx - 4, ty + 13);
      ctx.lineTo(cx - 4, ty + 2);
      ctx.arc(cx, ty + 2, 4, Math.PI, 0);
      ctx.lineTo(cx + 4, ty + 13);
      ctx.fill();

      // spires lower down in the town, and a lighthouse out on the point
      tower(cx + half * 0.47, hill(cx + half * 0.47) + 4, 9, 40, 34, { plain: true });
      tower(cx - half * 0.55, hill(cx - half * 0.55) + 4, 8, 26, 20, { plain: true });
      tower(cx + half * 1.5, base + 3, 6, 26, 7, { roof: roofs[0], plain: true });
      if (P.lamps) blob(cx + half * 1.5, base - 20, 2, 2, 0, lamp());

      const houses = [];
      for (let i = 0; i < 330; i++) {
        const x = cx + g() * half * 0.72;
        const y = lerp(hill(x) + 5, base + 3, R() ** 0.75);
        // keep the gate and the foot of the wall clear
        if (Math.abs(x - cx) < 84 && y < ty + 22) continue;
        houses.push([x, y]);
      }
      houses.sort((a, b) => a[1] - b[1]);
      for (const [x, y] of houses) house(x, y, rr(7, 15), rr(6, 14));

      // a few trees tucked between the houses
      for (let i = 0; i < 120; i++) {
        const x = cx + g() * half * 0.95;
        blob(x, lerp(hill(x) + 6, base + 4, R()) - 3, rr(3, 6), rr(3, 6), 0, hsl(jit(P.townTree, 6, 4, 4), 0.9));
      }

      for (const [bx, by, s] of BOATS) {
        ctx.fillStyle = hsl(P.boat[0]);
        ctx.beginPath();
        ctx.moveTo(bx, by - 15 * s);
        ctx.lineTo(bx + 8 * s, by - 2 * s);
        ctx.lineTo(bx - 1 * s, by - 2 * s);
        ctx.fill();
        line(bx - 6 * s, by, bx + 9 * s, by, 2.2 * s, hsl(P.boat[1]));
        if (P.lamps) blob(bx + 2 * s, by - 4 * s, 1.5, 1.5, 0, lamp());
      }
    }

    // ── forested hills ───────────────────────────────────────
    const hillAt = (x, y) => (y >= HILLS[2].top(x) ? 2 : y >= HILLS[1].top(x) ? 1 : y >= HILLS[0].top(x) ? 0 : -1);
    function canopy(x, y, o, live) {
      const d = y - o.top(x);
      const r = rr(o.size[0], o.size[1]) * (1 + d / (VH * 0.6));
      // live dabs leave the silhouettes alone: the ridge line above, the grass fringe below
      if (live && (d < r * 1.3 || y + r + 30 > meadowTop(x) || pathNear(x, y, r + 1))) return;
      const pa = patch(x + o.shift, y) - 0.5;
      const gu = gust(x, y);
      // lighter near the ridge where the haze sits, deeper further down;
      // a gust turns the leaves pale side up, a cloud overhead dulls them
      const l = o.col[2] + pa * o.light + clamp(1 - d / (VH * 0.09)) * o.rim - clamp(d / (VH * 0.5)) * o.fall + gu * (NIGHT ? 1.6 : 4) - shadow(x, y) * P.shade;
      const hue = o.col[0] + pa * 30;
      const tone = g() * (NIGHT ? 1.5 : 4);
      blob(x, y, r * rr(0.9, 1.4), r * rr(0.6, 1), g() * 0.5, hsl([hue + g() * 6, o.col[1], l - 2.5 + tone], 0.9));
      if (R() < 0.7) crayon(x + r * 0.2 - gu * r * 0.5, y - r * 0.35, -0.5 - gu * 0.5 + g() * 0.5, r * rr(0.8, 1.5), r * 0.6, [hue - 12 + g() * 8, o.col[1] + 6, l + tone + (NIGHT ? 2 : 4.5) + rr(0, NIGHT ? 1.5 : 4)], rr(0.4, 0.8));
    }
    function hills() {
      for (const o of HILLS) {
        fillBelow(o.top, hsl(o.col));
        const pts = [];
        for (let i = 0; i < o.n; i++) {
          const x = rr(-20, VW + 20);
          const y0 = o.top(x);
          const y = y0 + R() ** 1.25 * (o.yMax - y0);
          if (y >= y0 - 2 && y < VH + 20) pts.push([x, y]);
        }
        pts.sort((a, b) => a[1] - b[1]);
        for (const [x, y] of pts) canopy(x, y, o, false);
      }
      drawPath((p) => p.y < meadowTop(p.x));
    }

    // ── the meadow ───────────────────────────────────────────
    function grass(x, y, scale = 1, offPath = false) {
      if (offPath && pathNear(x, y, 4)) return;
      const y0 = meadowTop(x);
      const d = clamp((y - y0) / (VH - y0));
      const gu = gust(x, y);
      const c = jit(any(P.grass), 6, 4, 4);
      c[2] += (patch(x + 300, y * 2) - 0.5) * (NIGHT ? 4 : 16) - d * (NIGHT ? 1 : 5) + gu * (NIGHT ? 2.5 : 8) - shadow(x, y) * P.shade;
      // the blades lean with the wind, further in a gust
      crayon(x, y, -Math.PI / 2 - 0.1 - gu * 0.55 + g() * 0.3, lerp(9, 44, d) * rr(0.6, 1.3) * scale, lerp(2.5, 6, d), c, rr(0.45, 0.85));
    }
    function flower(f, live) {
      const gu = gust(f.x, f.y);
      const s = f.s;
      const x = f.x - gu * 9 * s;
      const y = f.y + gu * 2 * s;
      // its last position is still on the canvas: brush some grass back over it first
      if (live) for (let i = 0; i < 3; i++) grass(f.x + g() * 12 * s, f.y + 5 * s + g() * 6 * s, 0.7, true);
      const c = P.petal[f.c];
      if (NIGHT) {
        // the baked picture gets true shadows; live repaints get the stamped glow
        if (live) glowAt(ctx, x, y, (s < 0.55 ? 3 : 6.7) * s + 5 + s * 9, 0.9);
        else {
          ctx.shadowColor = GLOW;
          ctx.shadowBlur = 5 + s * 9;
        }
      } else if (s > 0.8) line(x, y, f.x - 2 * s, f.y + 13 * s, 1.5 * s, hsl([118, 36, 24], 0.8));
      if (s < 0.55) blob(x, y, 2.4 * s + 0.6, 2 * s + 0.6, 0, hsl(jit(c, 5, 4, 7), rr(0.75, 1)));
      else {
        for (let k = 0; k < 5; k++) {
          const a = f.rot + (k / 5) * TAU;
          blob(x + Math.cos(a) * 3.4 * s, y + Math.sin(a) * 3.4 * s * f.squash, 3.3 * s, 2 * s, a, hsl(jit(c, 5, 4, 7), 0.95));
        }
        blob(x, y, 1.5 * s, 1.5 * s * f.squash, 0, hsl(P.heart));
      }
      ctx.shadowBlur = 0;
    }
    const meadowPoint = (view) => {
      const x = rr(view.x0 - 20, view.x1 + 20);
      const y0 = meadowTop(x);
      return [x, y0 + R() ** 1.1 * (VH + 30 - y0)];
    };
    function meadow() {
      fillBelow(meadowTop, hsl(P.meadow));
      const all = { x0: 0, x1: VW };
      for (let i = 0; i < 26000; i++) grass(...meadowPoint(all));
      drawPath((p) => p.y >= meadowTop(p.x) - 8);
      for (const f of FLOWERS) flower(f, false);
      // a last scatter of grass tips over the nearest blooms
      for (let i = 0; i < 1500; i++) grass(rr(0, VW), rr(VH * 0.94, VH + 20), 1.4, true);
    }

    function grain() {
      const img = ctx.getImageData(0, 0, VW, VH);
      const d = img.data;
      let s = 0x9e3779b9;
      const amount = NIGHT ? 8 : 11;
      for (let i = 0; i < d.length; i += 4) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        const r = (s >>> 0) / 4294967296;
        // fine noise, plus the odd pale fleck where the crayon skipped
        const n = (r - 0.5) * amount + (r > 0.99 ? (NIGHT ? 8 : 14) : 0);
        d[i] += n;
        d[i + 1] += n;
        d[i + 2] += n;
      }
      ctx.putImageData(img, 0, 0);
    }

    // ── the whole picture, once ──────────────────────────────
    function render(c) {
      ctx = c;
      ctx.lineCap = ctx.lineJoin = 'round';
      time = 0;
      const grad = ctx.createLinearGradient(0, 0, 0, HOR);
      for (const [t, col] of P.sky) grad.addColorStop(t, hsl(col));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, VW, VH);
      for (let i = 0; i < 12000; i++) skyStroke(rr(-120, VW + 120), rr(-60, HOR + 40), false);
      for (const s of STARS) star(s, false);
      for (const cl of CLOUDS) cloudDots(cl, Math.round((cl.w * cl.h) / 6));
      if (NIGHT) bakedMeteors();
      if (SUN) {
        const [h, sat, l0, l1] = P.sun.disc;
        for (let i = 0; i < SUN.r * SUN.r * 1.7; i++) { // a stippled disc; the ranges are painted over its lower edge
          const a = R() * TAU;
          const d = Math.sqrt(R()) * SUN.r;
          blob(SUN.x + Math.cos(a) * d, SUN.y + Math.sin(a) * d, rr(0.8, 2.2), rr(0.8, 2.2), 0, hsl([h, sat, rr(l0, l1)], rr(0.4, 0.9)));
        }
      }
      ranges();
      water();
      town();
      hills();
      meadow();
      grain();
    }

    // ── one frame's worth of fresh strokes ───────────────────
    // strokes per second when the whole picture is in view
    const RATE = { sky: NIGHT ? 300 : 900, star: 520, cloud: 2600, water: 320, canopy: 2600, grass: 2400, flower: 1500 };
    const budget = {};
    function spend(key, amount, fn) {
      budget[key] = Math.min(400, (budget[key] || 0) + amount);
      while (budget[key] >= 1) {
        budget[key]--;
        fn();
      }
    }
    const cloudArea = CLOUDS.reduce((a, c) => a + c.w * c.h, 0);

    function paint(c, dt, view, quality) {
      ctx = c;
      time += dt;
      for (const cl of CLOUDS) {
        cl.x -= cl.speed * dt;
        if (cl.x < -cl.w) cl.x = VW + cl.w;
      }
      const inView = (x) => x > view.x0 - 30 && x < view.x1 + 30;
      const pace = dt * quality * clamp((view.x1 - view.x0) / VW);

      spend('sky', RATE.sky * pace, () => skyStroke(rr(view.x0 - 60, view.x1 + 60), rr(-40, HOR + 30), true));
      spend('star', RATE.star * pace * (STARS.length ? 1 : 0), () => {
        const s = any(STARS);
        if (inView(s.x) && !inCloud(s.x, s.y, 6)) star(s, true); // not through a cloud
      });
      // cloud dabs are not scaled by the view: a cloud keeps its shape even when most of the sky is cropped
      spend('cloud', CLOUDS.length ? RATE.cloud * dt * quality * (NIGHT ? 0.5 : 1) : 0, () => {
        let pickAt = R() * cloudArea;
        for (const cl of CLOUDS) {
          if ((pickAt -= cl.w * cl.h) > 0) continue;
          if (inView(cl.x - cl.w * 0.5) || inView(cl.x + cl.w * 0.5)) cloudDots(cl, 1);
          break;
        }
      });
      spend('water', RATE.water * pace, () => waterStroke(rr(view.x0, view.x1), rr(WATER_TOP + 4, WATER_BOTTOM), true));
      spend('canopy', RATE.canopy * pace, () => {
        const x = rr(view.x0 - 10, view.x1 + 10);
        const y = rr(HILLS[0].top(x), meadowTop(x));
        const i = hillAt(x, y);
        if (i >= 0) canopy(x, y, HILLS[i], true);
      });
      spend('grass', RATE.grass * pace, () => {
        const [x, y] = meadowPoint(view);
        // go easy where the flowers are thick
        if (patch(x * 1.7 + 900, y * 3.2) < 0.4 || R() < 0.3) grass(x, y, 1, true);
      });
      spend('flower', RATE.flower * pace, () => {
        const f = any(FLOWERS);
        if (inView(f.x)) flower(f, true);
      });

      {
        meteorWait -= dt;
        if (meteorWait <= 0) {
          spawnMeteor(view);
          // mostly a steady fall, now and then a flurry
          // by day only the odd pale one crosses the blue
          meteorWait = !NIGHT ? rr(5, 13) : R() < 0.25 ? rr(0.08, 0.3) : rr(0.5, 2.2);
        }
        for (let i = meteors.length - 1; i >= 0; i--) {
          const m = meteors[i];
          m.t += dt;
          if (m.t < m.dur) continue;
          // a bright one leaves its streak on the painting for the sky to slowly take back
          if (m.big && NIGHT) crayon(m.ex - Math.cos(m.ang) * m.len * 0.5, m.ey - Math.sin(m.ang) * m.len * 0.5, m.ang, m.len * 0.9, 3, [200, 80, 78], 0.16);
          meteors.splice(i, 1);
        }
      }
    }

    // ── what floats over the picture, redrawn every frame ────
    function sprites(c) {
      c.lineCap = 'round';
      const k = c.getTransform().a; // device pixels per scene unit
      // petals lifted off the meadow, carried up and away to the left
      for (const p of PETALS) {
        const u = (time / p.period + p.ph) % 1;
        const a = smooth(0, 0.08, u) * (1 - smooth(0.8, 1, u));
        if (a <= 0.01) continue;
        const x = p.x0 - u * p.run + Math.sin(time * 0.9 + p.ph * 40) * p.amp * 0.6;
        const y = p.y0 - u ** 0.8 * p.rise + Math.sin(time * 1.4 + p.ph * 70) * p.amp * (0.3 + u);
        const s = p.s * lerp(1.25, 0.6, u);
        const turn = time * p.spin + p.ph * 20;
        if (NIGHT) glowAt(c, x, y, 5.5 * s + 10 / k, a * 0.6);
        c.fillStyle = hsl(P.petal[p.c], a * (NIGHT ? 1 : 0.92));
        c.beginPath();
        // tumbling: the petal narrows as it turns edge-on
        c.ellipse(x, y, 5.5 * s, Math.max(0.6, 2.8 * s * Math.abs(Math.cos(turn))), turn * 0.6, 0, TAU);
        c.fill();
      }
      for (const m of meteors) {
        const at = meteorAt(m);
        if (at.a > 0.01 && at.len > 2) meteorTrail(c, at.x, at.y, at.len, m.w, m.bright * at.a, m.ang);
      }
      for (const b of BLOOMS) bloom(c, b, k);
    }

    const BLOOM = P.bloom;
    function bloom(c, b, k) {
      const s = b.s;
      const gu = gust(b.x, VH * 0.95);
      // the whole stem bends with the gust, and never quite stops nodding
      const sway = -gu * 34 * s * (b.h / 200) + Math.sin(time * 1.5 + b.ph) * 5 * s;
      const hx = b.x + b.lean + sway;
      const hy = VH - b.h + gu * 6 + Math.abs(sway) * 0.12;
      const kx = b.x + b.lean * 0.2 + sway * 0.35;
      const ky = VH - b.h * 0.45;
      c.strokeStyle = hsl(BLOOM.stem);
      c.lineWidth = 3.6 * s;
      c.beginPath();
      c.moveTo(b.x, VH + 20);
      c.quadraticCurveTo(kx, ky, hx, hy);
      c.stroke();
      // one leaf, partway up
      const t = b.leaf;
      const lx = (1 - t) ** 2 * b.x + 2 * t * (1 - t) * kx + t * t * hx;
      const ly = (1 - t) ** 2 * (VH + 20) + 2 * t * (1 - t) * ky + t * t * hy;
      const dir = b.lean > 0 ? -1 : 1;
      c.fillStyle = hsl(BLOOM.leaf);
      c.beginPath();
      c.ellipse(lx + dir * 17 * s, ly - 9 * s, 21 * s, 5.5 * s, dir * (-0.5 - gu * 0.25), 0, TAU);
      c.fill();

      // the head only ever moves and turns, so it is drawn once (glow and all) and stamped from then on
      if (!b.head || b.head.k !== k) {
        const r = 31 * s + (NIGHT ? (34 * s) / k : 2);
        const cv = document.createElement('canvas');
        cv.width = cv.height = Math.ceil(r * 2 * k);
        const hc = cv.getContext('2d');
        hc.setTransform(k, 0, 0, k, r * k, r * k);
        hc.lineCap = 'round';
        bloomHead(hc, b);
        b.head = { cv, r, k };
      }
      c.save();
      c.translate(hx, hy);
      c.rotate(b.rot * 0.2 + sway * 0.006);
      c.drawImage(b.head.cv, -b.head.r, -b.head.r, b.head.r * 2, b.head.r * 2);
      c.restore();
    }

    function bloomHead(c, b) {
      const s = b.s;
      if (NIGHT) {
        c.shadowColor = GLOW;
        c.shadowBlur = 16 * s;
      }
      const L = 30 * s;
      const Wd = 12.5 * s;
      if (b.bud) {
        // not open yet: a closed teardrop on its stem
        c.fillStyle = hsl(BLOOM.mid);
        c.beginPath();
        c.moveTo(0, 4 * s);
        c.bezierCurveTo(-Wd * 0.8, -L * 0.2, -Wd * 0.4, -L * 0.7, 0, -L * 0.85);
        c.bezierCurveTo(Wd * 0.4, -L * 0.7, Wd * 0.8, -L * 0.2, 0, 4 * s);
        c.fill();
        return;
      }
      c.scale(1, b.squash);
      const grad = c.createLinearGradient(0, 0, L, 0);
      grad.addColorStop(0, hsl(BLOOM.core));
      grad.addColorStop(0.45, hsl(BLOOM.mid));
      grad.addColorStop(1, hsl(BLOOM.tip));
      for (let i = 0; i < 5; i++) {
        c.save();
        c.rotate(b.rot + (i / 5) * TAU);
        c.fillStyle = grad;
        c.beginPath();
        c.moveTo(1.5 * s, 0);
        c.bezierCurveTo(L * 0.3, -Wd * 1.15, L * 0.82, -Wd * 0.85, L, 0);
        c.bezierCurveTo(L * 0.82, Wd * 0.85, L * 0.3, Wd * 1.15, 1.5 * s, 0);
        c.fill();
        c.shadowBlur = 0;
        c.strokeStyle = hsl(BLOOM.vein, 0.45);
        c.lineWidth = 1.1 * s;
        c.beginPath();
        c.moveTo(L * 0.18, 0);
        c.lineTo(L * 0.78, 0);
        c.stroke();
        c.restore();
      }
      c.shadowBlur = 0;
      c.fillStyle = hsl(BLOOM.eye);
      c.beginPath();
      c.arc(0, 0, 3.6 * s, 0, TAU);
      c.fill();
    }

    return { render, paint, sprites };
  }

  // ── on the page ────────────────────────────────────────────
  function mount(host) {
    const root = document.documentElement;
    const qs = new URLSearchParams(location.search);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const still = reduced.matches && !qs.has('motion'); // no loop: the baked image, plus one frame of what stands in front

    const paintCv = document.createElement('canvas');
    const spriteCv = document.createElement('canvas');
    host.append(paintCv, spriteCv);
    const pctx = paintCv.getContext('2d');
    const sctx = spriteCv.getContext('2d');
    if (!pctx || !sctx) return;

    // the scene is chosen in the page head (the last pick, else sunset, or ?scene=) before anything is drawn
    const scene = () => (SCENES.includes(root.dataset.scene) ? root.dataset.scene : 'sunset');
    const picks = [...document.querySelectorAll('[data-scene-pick]')];

    let painting = null;
    let view = null;
    let transform = null;

    function resize() {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      // device pixels, within reason: about 3.4 megapixels at most
      const px = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(3.4e6 / (w * h)));
      const pw = Math.round(w * px);
      const ph = Math.round(h * px);
      if (paintCv.width === pw && paintCv.height === ph) return;
      // resizing clears the canvases; the image underneath is still there and fresh strokes soon cover it
      paintCv.width = spriteCv.width = pw;
      paintCv.height = spriteCv.height = ph;
      const s = Math.max(w / VW, h / VH); // background-size: cover
      const ox = (w - VW * s) * FOCUS_X;
      const oy = (h - VH * s) * 0.5;
      transform = [px * s, 0, 0, px * s, px * ox, px * oy];
      view = { x0: -ox / s, x1: (w - ox) / s };
      pctx.setTransform(...transform);
      pctx.lineCap = pctx.lineJoin = 'round';
      // a resize wipes a half-finished scene change: settle it rather than leave the old picture showing through
      if (coat) {
        commit(coat.name);
        coat = null;
      }
      if (still && painting) drawSprites();
    }

    const mark = (name) => picks.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scenePick === name)));
    let settleTimer = 0;
    const commit = (name) => {
      root.dataset.scene = name;
      root.dataset.theme = name === 'night' ? 'dark' : 'light'; // only the homepage: posts follow the browser
      try { localStorage.setItem('scene', name); } catch (e) { /* private mode */ }
      // the slips were turned over one by one as the brush passed; the page as a whole now agrees with them
      for (const el of document.querySelectorAll('[data-paper]')) el.removeAttribute('data-paper');
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => root.removeAttribute('data-repainting'), 900);
    };

    function restart() {
      painting = createPainting(scene());
      mark(scene());
      pctx.save();
      pctx.setTransform(1, 0, 0, 1, 0, 0);
      pctx.clearRect(0, 0, paintCv.width, paintCv.height);
      pctx.restore();
      if (view) drawSprites();
    }

    function drawSprites() {
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, spriteCv.width, spriteCv.height);
      sctx.setTransform(...transform);
      painting.sprites(sctx);
    }

    let last = performance.now();
    let cost = 6;
    let quality = 1;
    function step(dt) {
      if (coat) runCoat(dt);
      else painting.paint(pctx, dt, view, quality);
      drawSprites();
    }

    // Changing scene: the new picture is brushed over the old one in broad dry-brush strokes,
    // sweeping the way the pick moved along the picker: morning to day runs left to right, day to morning right to left. Each frame's strokes are drawn plain onto a scratch canvas,
    // the new painting is poured into just those strokes (source-in), and the result is laid on the
    // picture: so what the brush puts down is already the right picture, for the price of two blits.
    // (Stroking with the painting as a pattern looks the same and rasterises many times slower.)
    const brushCv = document.createElement('canvas');
    const bctx = brushCv.getContext('2d');
    let coat = null;
    const cr = rng((Date.now() & 0xffff) + 3);
    function startCoat(name, img) {
      // the paper slips change with the picture only when night falls or lifts;
      // each one turns as the brush front crosses it, so they are measured up front
      let slips = [];
      if ((name === 'night') !== (scene() === 'night')) {
        const paper = name === 'night' ? 'night' : 'day';
        slips = [...document.querySelectorAll('.home-shell .slip')].map((el) => {
          const r = el.getBoundingClientRect();
          return { el, x: r.left + r.width / 2, paper };
        });
        clearTimeout(settleTimer);
        root.dataset.repainting = '';
      }
      painting = createPainting(name); // petals, blooms and meteors change over at once
      mark(name);
      coat = { name, img, slips, dir: SCENES.indexOf(name) > SCENES.indexOf(scene()) ? 1 : -1, t: 0, dur: 1.9, settle: 0 };
    }
    function runCoat(dt) {
      if (coat.t >= coat.dur) {
        // the brush is done: whatever slivers it missed are glazed in over a few frames, not stamped
        coat.settle += dt;
        const done = coat.settle >= 0.4;
        pctx.globalAlpha = done ? 1 : 0.3;
        pctx.drawImage(coat.img, 0, 0, VW, VH);
        pctx.globalAlpha = 1;
        if (!done) return;
        // only now does the image underneath catch up with the canvas
        commit(coat.name);
        coat = null;
        return;
      }
      const u0 = coat.t / coat.dur;
      coat.t += dt;
      const u1 = Math.min(1, coat.t / coat.dur);
      const span = view.x1 - view.x0 + 1000;
      // how far across the front has come, in scene units from the edge it set out from
      const reach = (u) => u * u * (3 - 2 * u) * span - 500;
      const ltr = coat.dir > 0;
      const across = (d) => (ltr ? view.x0 + d : view.x1 - d);
      // where the front is on screen (css px), a little behind its leading edge so the paint lands first
      const front = ((across(reach(u1) - 120) - view.x0) / (view.x1 - view.x0)) * host.clientWidth;
      for (const sl of coat.slips) {
        if (sl.el && (ltr ? sl.x < front : sl.x > front)) {
          sl.el.dataset.paper = sl.paper;
          sl.el = null;
        }
      }
      if (brushCv.width !== paintCv.width || brushCv.height !== paintCv.height) {
        brushCv.width = paintCv.width;
        brushCv.height = paintCv.height;
      }
      bctx.globalCompositeOperation = 'source-over';
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.clearRect(0, 0, brushCv.width, brushCv.height);
      bctx.setTransform(...transform);
      bctx.lineCap = 'round';
      for (let i = 0, n = Math.ceil((u1 - u0) * 520); i < n; i++) {
        const u = lerp(u0, u1, cr());
        // stragglers ahead of the front and touch-ups behind
        const x = across(reach(u)) + (cr() - 0.5) * 520;
        const y = cr() * VH;
        const ang = -0.4 * -coat.dir + (cr() - 0.5) * 0.5;
        const len = 320 + cr() * 520;
        const width = 50 + cr() * 110;
        const cx = Math.cos(ang);
        const sy = Math.sin(ang);
        for (let k = 0; k < 6; k++) { // six bristle clumps, ragged at both ends
          const off = (k / 5 - 0.5) * width;
          const l = len * (0.6 + cr() * 0.45);
          const sh = (cr() - 0.5) * len * 0.2;
          const px = x - sy * off + cx * sh;
          const py = y + cx * off + sy * sh;
          bctx.globalAlpha = 0.75 + cr() * 0.25;
          bctx.lineWidth = (width / 5) * (0.55 + cr() * 0.75);
          bctx.beginPath();
          bctx.moveTo(px - (cx * l) / 2, py - (sy * l) / 2);
          bctx.lineTo(px + (cx * l) / 2, py + (sy * l) / 2);
          bctx.stroke();
        }
      }
      bctx.globalAlpha = 1;
      bctx.globalCompositeOperation = 'source-in';
      bctx.drawImage(coat.img, 0, 0, VW, VH);
      pctx.save();
      pctx.setTransform(1, 0, 0, 1, 0, 0);
      pctx.drawImage(brushCv, 0, 0);
      pctx.restore();
    }
    let loading = false;
    function change(name) {
      if (coat || loading || name === scene()) return;
      loading = true;
      // fetch the new painting first: it is both the paint on the brush and the next underpainting
      const img = new Image();
      let pending = true;
      const go = (ok) => {
        if (!pending) return;
        pending = false;
        loading = false;
        if (!ok || still || !view) {
          commit(name);
          restart();
        } else startCoat(name, img);
      };
      img.onerror = () => go(false);
      img.src = `/painting/${name}.webp`;
      // decoded before the first stroke, so the brush never stalls on it
      img.decode().then(() => go(true), () => go(false));
    }
    function frame(now) {
      requestAnimationFrame(frame);
      if (now - last < 31 || !view) return; // ~30fps is plenty for wind
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t0 = performance.now();
      step(dt);
      // slow machines get fewer fresh strokes rather than a slower wind
      cost += (performance.now() - t0 - cost) * 0.05;
      if (cost > 14) quality = Math.max(0.25, quality * 0.97);
      else if (cost < 8) quality = Math.min(1, quality * 1.01);
    }

    for (const b of picks) b.addEventListener('click', () => change(b.dataset.scenePick));

    restart();
    resize();
    if (view) drawSprites();
    window.addEventListener('resize', resize);
    // ?t=20 fast-forwards, for looking at a later moment in a screenshot
    if (view && !still && qs.get('t')) for (let i = 0, n = parseFloat(qs.get('t')) * 30; i < n; i++) step(1 / 30);
    if (!still) requestAnimationFrame(frame);
  }

  window.Painting = {
    scenes: SCENES,
    /** Paint the full picture for one scene onto a 2560x1600 canvas. */
    render(canvas, scene, seed) {
      canvas.width = VW;
      canvas.height = VH;
      createPainting(scene, seed).render(canvas.getContext('2d'));
    },
  };

  const host = document.querySelector('.painting');
  if (host) mount(host);
})();
