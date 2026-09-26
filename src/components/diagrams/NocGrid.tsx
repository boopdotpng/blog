/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useFrameLoop } from './frame-loop';

/**
 * Interactive Tenstorrent NoC routing grid.
 *
 * Two unidirectional networks-on-chip over a torus of tiles:
 *   noc0 — origin top-left, steps right then down, wraps at edges
 *   noc1 — origin bottom-right, steps left then up, wraps at edges
 *
 * Unicast mode: click a tile to set the destination; shift-click to set the
 * source. Routing is dimension-ordered (X first, then Y) on a torus.
 *
 * Multicast mode: drag a rectangle to set the multicast box (the start/end
 * NoC coordinates you'd hand to configure_tlb). Every receiver's packet
 * follows its own dimension-ordered route from the source; the union of those
 * routes is the multicast tree, which shares a trunk and branches at routers.
 */

type Coord = [number, number];
type Noc = 'noc0' | 'noc1';
type Mode = 'unicast' | 'multicast';

interface Props {
  cols?: number;
  rows?: number;
  src?: Coord;
  dst?: Coord;
  box?: [Coord, Coord];
  noc?: Noc;
  mode?: Mode;
}

const U = 12; // cell edge, svg units
const G = 4; // gap between cells
const HOP_MS = 260;
const END_PAUSE_MS = 1100;
const RIPPLE_MS = 650;
const TRAIL = 6; // comet-tail dots behind the packet
const TRAIL_GAP = 0.2; // hops between tail dots
const GLOW_DECAY_MS = 380; // how fast a router's flash settles after the packet passes

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const key = (x: number, y: number) => `${x},${y}`;
const isWrap = (a: Coord, b: Coord) => Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) > 1;

// ── Blackhole NoC topology (mirrors noc-visualization/topology.js, which in
// turn matches ttk/blackhole_coords.py). The physical NoC is a 17×12 torus.
//   - DRAM ports live on two vertical columns: x = 0 and x = 9.
//   - Tensix worker cores: rows y = 2..11, columns x = 1..7 and 10..16.
//   - Column x = 8 and rows y = 0..1 are non-Tensix tiles (PCIe / ARC / eth).
type Kind = 'dram' | 'tensix' | 'other';

function cellKind(x: number, y: number): Kind {
  if (x === 0 || x === 9) return 'dram';
  if (y < 2 || y > 11 || x === 8 || x > 16) return 'other';
  return 'tensix';
}

function topLeft(x: number, y: number): Coord {
  return [G + x * (U + G), G + y * (U + G)];
}
function center(x: number, y: number): Coord {
  const [a, b] = topLeft(x, y);
  return [a + U / 2, b + U / 2];
}

/** Dimension-ordered torus route from src to dst. Returns the cells in order. */
function buildPath(src: Coord, dst: Coord, cols: number, rows: number, noc: Noc): Coord[] {
  const dir = noc === 'noc1' ? -1 : 1;
  let [x, y] = src;
  const cells: Coord[] = [[x, y]];
  const dxSteps = noc === 'noc1' ? (src[0] - dst[0] + cols) % cols : (dst[0] - src[0] + cols) % cols;
  for (let i = 0; i < dxSteps; i++) {
    x = (x + dir + cols) % cols;
    cells.push([x, y]);
  }
  const dySteps = noc === 'noc1' ? (src[1] - dst[1] + rows) % rows : (dst[1] - src[1] + rows) % rows;
  for (let i = 0; i < dySteps; i++) {
    y = (y + dir + rows) % rows;
    cells.push([x, y]);
  }
  return cells;
}

/**
 * Position of a packet `phase` hops along `cells`. A torus wrap exits one edge
 * and re-enters the opposite one, fading out and back in rather than
 * streaking across the whole grid.
 */
function positionAt(cells: Coord[], phase: number, dir: number): [x: number, y: number, opacity: number] {
  const nseg = cells.length - 1;
  if (nseg < 1 || phase <= 0) return [...center(...cells[0]), 1];
  if (phase >= nseg) return [...center(...cells[nseg]), 1];
  const i = Math.floor(phase);
  const f = phase - i;
  const from = cells[i];
  const to = cells[i + 1];
  const [fx, fy] = center(...from);
  const [tx, ty] = center(...to);
  if (!isWrap(from, to)) return [fx + (tx - fx) * f, fy + (ty - fy) * f, 1];
  const off = (U + G) * 0.85;
  const alongX = from[1] === to[1];
  if (f < 0.5) {
    const k = f * 2;
    return [alongX ? fx + dir * off * k : fx, alongX ? fy : fy + dir * off * k, 1 - k];
  }
  const k = (f - 0.5) * 2;
  return [alongX ? tx - dir * off * (1 - k) : tx, alongX ? ty : ty - dir * off * (1 - k), k];
}

/** SVG path for one link. A torus wrap is drawn as an exit stub and an entry stub at opposite edges. */
function linkPath(a: Coord, b: Coord, dir: number): string {
  const [ax, ay] = center(...a);
  const [bx, by] = center(...b);
  if (!isWrap(a, b)) return `M${ax},${ay}L${bx},${by}`;
  const off = (U + G) * 0.85;
  const [dx, dy] = a[1] === b[1] ? [dir * off, 0] : [0, dir * off];
  return `M${ax},${ay}l${dx},${dy}M${bx - dx},${by - dy}L${bx},${by}`;
}

/** Brightness of a router `since` ms after the packet reached it: a flash that settles to a steady glow. */
const glow = (since: number) => (since < 0 ? 0 : 0.28 + 0.6 * Math.exp(-since / GLOW_DECAY_MS));

/** Inclusive min/max corners of the rectangle spanned by two coords. */
function rect(a: Coord, b: Coord) {
  return {
    x0: Math.min(a[0], b[0]),
    y0: Math.min(a[1], b[1]),
    x1: Math.max(a[0], b[0]),
    y1: Math.max(a[1], b[1]),
  };
}

const setCircle = (el: SVGCircleElement | null, x: number, y: number, opacity: number, r?: number) => {
  if (!el) return;
  el.setAttribute('cx', String(x));
  el.setAttribute('cy', String(y));
  if (r !== undefined) el.setAttribute('r', String(r));
  el.style.opacity = String(opacity);
};

export default function NocGrid({
  cols = 17,
  rows = 12,
  src: srcProp = [16, 11],
  dst: dstProp = [1, 2],
  box: boxProp,
  noc: nocProp = 'noc0',
  mode: modeProp = 'unicast',
}: Props) {
  const C = clamp(cols | 0, 2, 40);
  const R = clamp(rows | 0, 2, 40);
  const clampCoord = (c: Coord): Coord => [clamp(c[0] | 0, 0, C - 1), clamp(c[1] | 0, 0, R - 1)];

  const [src, setSrc] = useState<Coord>(clampCoord(srcProp));
  const [dst, setDst] = useState<Coord>(clampCoord(dstProp));
  const [mode, setMode] = useState<Mode>(modeProp);
  const [noc, setNoc] = useState<Noc>(nocProp);
  const [hover, setHover] = useState<Coord | null>(null);
  // Touch screens have no shift key, so they get an explicit toggle instead.
  const [tapMovesSrc, setTapMovesSrc] = useState(false);

  // multicast box corners (a = drag anchor, b = drag end)
  const defBox: [Coord, Coord] = boxProp ?? [[1, 2], [5, 5]];
  const [boxA, setBoxA] = useState<Coord>(clampCoord(defBox[0]));
  const [boxB, setBoxB] = useState<Coord>(clampCoord(defBox[1]));
  const [dragging, setDragging] = useState(false);

  const box = useMemo(() => rect(boxA, boxB), [boxA, boxB]);
  const dir = noc === 'noc1' ? -1 : 1;
  const boxKey = `${box.x0},${box.y0},${box.x1},${box.y1}`;

  const path = useMemo(() => buildPath(src, dst, C, R, noc), [src, dst, C, R, noc]);
  const pathSet = useMemo(() => new Set(path.map(([x, y]) => key(x, y))), [path]);

  const previewSet = useMemo(() => {
    if (mode !== 'unicast' || !hover) return null;
    return new Set(buildPath(src, hover, C, R, noc).map(([x, y]) => key(x, y)));
  }, [mode, hover, src, C, R, noc]);

  // Faithful multicast tree (mirrors noc-visualization's mcastTree): the UNION
  // of every valid receiver's dimension-ordered path from the source. "other"
  // tiles (l2cpu / PCIe / ARC / eth) inside the box are skipped as receivers,
  // even though packets still route through their routers; DRAM ports stay valid.
  const mcast = useMemo(() => {
    type Receiver = { cells: Coord[]; dist: number };
    type Link = { d: string; depth: number; wrap: boolean };
    const receivers: Receiver[] = [];
    const links = new Map<string, Link>();
    let maxDist = 0;
    if (mode !== 'multicast') return { receivers, links: [] as Link[], maxDist };
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        if (cellKind(x, y) === 'other' || (x === src[0] && y === src[1])) continue;
        const cells = buildPath(src, [x, y], C, R, noc);
        maxDist = Math.max(maxDist, cells.length - 1);
        receivers.push({ cells, dist: cells.length - 1 });
        // Routes are dimension-ordered from one source, so a shared link is
        // always the same number of hops from the source on every route.
        cells.slice(1).forEach((b, i) => {
          const a = cells[i];
          const k = `${key(...a)}>${key(...b)}`;
          if (!links.has(k)) links.set(k, { d: linkPath(a, b, dir), depth: i, wrap: isWrap(a, b) });
        });
      }
    }
    return { receivers, links: [...links.values()], maxDist };
  }, [mode, box, src, C, R, noc, dir]);

  const hops = path.length - 1;
  const wraps = path.slice(1).filter((c, i) => isWrap(path[i], c)).length;
  const boxW = box.x1 - box.x0 + 1;
  const boxH = box.y1 - box.y0 + 1;

  const W = G + C * (U + G);
  const H = G + R * (U + G);

  // ── animation ────────────────────────────────────────────────────────────
  // Everything that moves is written straight to the DOM through refs (via
  // `style.opacity` / cx / cy, which Preact never touches), so re-renders from
  // hovering can't interrupt it.
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<SVGCircleElement>(null);
  const haloRef = useRef<SVGCircleElement>(null);
  const rippleRef = useRef<SVGCircleElement>(null);
  const trailRefs = useRef<(SVGCircleElement | null)[]>([]);
  const glowRefs = useRef<(SVGRectElement | null)[]>([]);
  const linkRefs = useRef<(SVGPathElement | null)[]>([]);
  const fanRefs = useRef<(SVGCircleElement | null)[]>([]);

  const drawUnicast = (t: number) => {
    const nseg = path.length - 1;
    const e = t % (nseg * HOP_MS + END_PAUSE_MS);
    const raw = e / HOP_MS; // keeps growing through the end pause, so the tail catches up
    const phase = Math.min(nseg, raw);

    const [hx, hy, hop] = positionAt(path, phase, dir);
    setCircle(headRef.current, hx, hy, hop);
    setCircle(haloRef.current, hx, hy, hop * 0.35, U * (0.55 + 0.08 * Math.sin(t / 90)));
    trailRefs.current.forEach((el, k) => {
      const p = Math.min(phase, raw - (k + 1) * TRAIL_GAP);
      const [x, y, op] = positionAt(path, p, dir);
      setCircle(el, x, y, p <= 0 ? 0 : op * (1 - (k + 1) / (TRAIL + 1)) * 0.8);
    });
    glowRefs.current.forEach((el, i) => {
      if (el) el.style.opacity = String(glow(e - i * HOP_MS));
    });

    const arrived = (e - nseg * HOP_MS) / RIPPLE_MS;
    const [dx, dy] = center(...path[nseg]);
    setCircle(rippleRef.current, dx, dy, arrived >= 0 && arrived < 1 ? (1 - arrived) * 0.9 : 0, U * (0.5 + Math.max(0, arrived) * 1.3));
  };

  const drawMulticast = (t: number) => {
    const e = t % (mcast.maxDist * HOP_MS + END_PAUSE_MS);
    const ph = e / HOP_MS;
    mcast.links.forEach((l, i) => {
      const el = linkRefs.current[i];
      if (el) el.style.opacity = String(ph > l.depth ? (l.wrap ? 0.3 : 0.25 + 0.5 * Math.exp(-(ph - l.depth) * 1.5)) : 0.08);
    });
    mcast.receivers.forEach((r, i) => {
      const [x, y, op] = positionAt(r.cells, Math.min(r.dist, ph), dir);
      // Parked dots retire once their tile has lit up; the glow carries the story from there.
      setCircle(fanRefs.current[i], x, y, ph >= r.dist ? Math.max(0, 1 - (ph - r.dist) * 2) : op);
      const el = glowRefs.current[i];
      if (el) el.style.opacity = String(glow(e - r.dist * HOP_MS));
    });
  };

  const routeMs = mode === 'multicast' ? mcast.maxDist * HOP_MS : hops * HOP_MS;
  useFrameLoop(rootRef, mode === 'multicast' ? drawMulticast : drawUnicast, [src, dst, noc, mode, boxKey], routeMs + RIPPLE_MS);

  // ── interaction ──────────────────────────────────────────────────────────
  // unicast: click → dst, shift-click → src
  // multicast: drag → box, shift-click → src
  // Pointer events + elementFromPoint keep dragging working for touch too.
  const cellAt = (e: PointerEvent): Coord | null => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-cell]');
    const [x, y] = el?.getAttribute('data-cell')?.split(',').map(Number) ?? [];
    return el ? [x, y] : null;
  };

  const onDown = (x: number, y: number, e: PointerEvent) => {
    // src/dst (and the multicast box) only make sense on Tensix worker cores.
    if (cellKind(x, y) !== 'tensix') return;
    if (e.shiftKey || (tapMovesSrc && e.pointerType !== 'mouse')) {
      setSrc([x, y]);
      return;
    }
    if (mode === 'multicast') {
      e.preventDefault();
      setBoxA([x, y]);
      setBoxB([x, y]);
      setDragging(true);
    } else {
      setDst([x, y]);
    }
  };

  const onMove = (e: PointerEvent) => {
    const c = cellAt(e);
    if (e.pointerType === 'mouse' && (c?.[0] !== hover?.[0] || c?.[1] !== hover?.[1])) setHover(c);
    if (dragging && c && cellKind(...c) === 'tensix' && (c[0] !== boxB[0] || c[1] !== boxB[1])) setBoxB(c);
  };

  useEffect(() => {
    if (!dragging) return;
    const up = () => setDragging(false);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging]);

  const receiverSet = useMemo(
    () => new Set(mcast.receivers.map((r) => key(...r.cells[r.cells.length - 1]))),
    [mcast],
  );

  const cells = [];
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < C; x++) {
      const [tx, ty] = topLeft(x, y);
      const k = key(x, y);
      let cls = `dgm-cell kind-${cellKind(x, y)}`;
      if (previewSet?.has(k)) cls += ' is-preview';
      if (mode === 'unicast' && pathSet.has(k)) cls += ' is-path';
      if (receiverSet.has(k)) cls += ' is-mcast';
      if (src[0] === x && src[1] === y) cls += ' is-src';
      if (mode === 'unicast' && dst[0] === x && dst[1] === y) cls += ' is-dst';
      cells.push(
        <rect
          key={k}
          data-cell={k}
          class={cls}
          x={tx}
          y={ty}
          width={U}
          height={U}
          rx={2}
          onPointerDown={(e: PointerEvent) => onDown(x, y, e)}
        >
          <title>{`tile (${x}, ${y})`}</title>
        </rect>,
      );
    }
  }

  // Glow overlays: one per router on the unicast route, or one per multicast receiver.
  const glowCells = mode === 'multicast' ? mcast.receivers.map((r) => r.cells[r.cells.length - 1]) : path;

  const [scx, scy] = center(...src);
  const [dcx, dcy] = center(...dst);

  return (
    <div class="dgm dgm-noc" data-active={noc} data-mode={mode} ref={rootRef}>
      <div class="dgm-toolbar">
        <div class="dgm-seg" role="group" aria-label="Select network">
          <button type="button" aria-pressed={noc === 'noc0'} onClick={() => setNoc('noc0')}>
            noc0
          </button>
          <button type="button" aria-pressed={noc === 'noc1'} onClick={() => setNoc('noc1')}>
            noc1
          </button>
        </div>
        <div class="dgm-seg" role="group" aria-label="Select write mode">
          <button type="button" aria-pressed={mode === 'unicast'} onClick={() => setMode('unicast')}>
            unicast
          </button>
          <button type="button" aria-pressed={mode === 'multicast'} onClick={() => setMode('multicast')}>
            multicast
          </button>
        </div>
        <div class="dgm-seg dgm-touch-only" role="group" aria-label="What a tap moves">
          <button type="button" aria-pressed={!tapMovesSrc} onClick={() => setTapMovesSrc(false)}>
            tap: {mode === 'multicast' ? 'box' : 'dst'}
          </button>
          <button type="button" aria-pressed={tapMovesSrc} onClick={() => setTapMovesSrc(true)}>
            src
          </button>
        </div>
        <div class="dgm-readout" aria-live="polite">
          <b>{noc}</b> ·{' '}
          {mode === 'multicast' ? (
            <>
              ({src[0]},{src[1]}) → box ({box.x0},{box.y0})–({box.x1},{box.y1}) · {boxW}×{boxH} ·{' '}
              {mcast.receivers.length} receivers · farthest {mcast.maxDist} hops
            </>
          ) : (
            <>
              ({src[0]},{src[1]}) → ({dst[0]},{dst[1]}) · {hops} hops
              {wraps > 0 ? `, wraps ×${wraps}` : ''}
            </>
          )}
        </div>
      </div>

      <svg
        class="dgm-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={
          mode === 'multicast'
            ? `NoC ${noc} multicast from tile ${src[0]},${src[1]} to box ${box.x0},${box.y0} through ${box.x1},${box.y1}`
            : `NoC ${noc} route from tile ${src[0]},${src[1]} to ${dst[0]},${dst[1]}`
        }
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {cells}
        <g class="dgm-glows" key={`${mode}|${noc}|${key(...src)}|${key(...dst)}|${boxKey}`}>
          {glowCells.map(([x, y], i) => {
            const [gx, gy] = topLeft(x, y);
            return (
              <rect
                key={i}
                ref={(el: SVGRectElement | null) => { glowRefs.current[i] = el; }}
                class="dgm-glow"
                x={gx}
                y={gy}
                width={U}
                height={U}
                rx={2}
                style="opacity:0"
              />
            );
          })}
        </g>
        {mode === 'multicast' &&
          mcast.links.map((l, i) => (
            <path
              key={i}
              ref={(el: SVGPathElement | null) => { linkRefs.current[i] = el; }}
              class={`dgm-mlink${l.wrap ? ' is-wrap' : ''}`}
              d={l.d}
              style="opacity:0"
            />
          ))}
        <text class="dgm-endcap" x={scx} y={scy}>
          S
        </text>
        {mode === 'unicast' && (
          <text class="dgm-endcap" x={dcx} y={dcy}>
            D
          </text>
        )}
        {mode === 'multicast' ? (
          mcast.receivers.map((_, i) => (
            <circle
              key={i}
              ref={(el: SVGCircleElement | null) => { fanRefs.current[i] = el; }}
              class="dgm-fan"
              r={U * 0.18}
              cx={scx}
              cy={scy}
              style="opacity:0"
            />
          ))
        ) : (
          <>
            <circle ref={rippleRef} class="dgm-ripple" r={U / 2} cx={dcx} cy={dcy} style="opacity:0" />
            <circle ref={haloRef} class="dgm-halo" r={U * 0.55} cx={scx} cy={scy} style="opacity:0" />
            {Array.from({ length: TRAIL }, (_, k) => (
              <circle
                key={k}
                ref={(el: SVGCircleElement | null) => { trailRefs.current[k] = el; }}
                class="dgm-trail"
                r={U * 0.26 * (1 - (k + 1) / (TRAIL + 2))}
                cx={scx}
                cy={scy}
                style="opacity:0"
              />
            ))}
            <circle ref={headRef} class="dgm-marker" r={U * 0.3} cx={scx} cy={scy} />
          </>
        )}
      </svg>

      <div class="dgm-caption">
        <p>
          <b style="color:var(--cat-tenstorrent)">noc0</b> routes right → down from the top-left;{' '}
          <b style="color:var(--cat-ml)">noc1</b> routes left → up from the bottom-right.
        </p>
        {mode === 'multicast' && (
          <p>
            A multicast write fans out as a tree: one packet rides the shared trunk, then branches at
            each router to reach every tile in the box.
          </p>
        )}
        <p class="dgm-legend">
          <span class="dgm-swatch" style="background:var(--dgm-dram)" /> DRAM ports (columns 0 &amp; 9)
          <span class="dgm-swatch" style="background:var(--dgm-ignore)" /> l2cpu / PCIe / ARC / eth —
          ignored by multicast
        </p>
      </div>
      <p class="dgm-hint dgm-pointer-only">
        {mode === 'multicast' ? 'drag a box to set the multicast region' : 'click a tile to move the destination'}
        <span class="dgm-swatch" style="background:var(--cat-gpu)" /> · shift-click to move the
        source
        <span class="dgm-swatch" style="background:var(--accent)" />
      </p>
      <p class="dgm-hint dgm-touch-only">
        {tapMovesSrc
          ? 'tap a tile to move the source'
          : mode === 'multicast'
            ? 'drag a box to set the multicast region'
            : 'tap a tile to move the destination'}
      </p>
    </div>
  );
}
