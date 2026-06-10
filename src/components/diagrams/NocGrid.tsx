/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

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
 * NoC coordinates you'd hand to configure_tlb). The packet routes from the
 * source to the box's entry corner — top-left for noc0, bottom-right for
 * noc1 — then fans out across every tile in the box following the NoC
 * direction, which is how one write reaches many tiles at once.
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
const END_PAUSE_MS = 850;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const key = (x: number, y: number) => `${x},${y}`;

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

function countWraps(cells: Coord[]): number {
  let wraps = 0;
  for (let i = 0; i < cells.length - 1; i++) {
    const dx = Math.abs(cells[i + 1][0] - cells[i][0]);
    const dy = Math.abs(cells[i + 1][1] - cells[i][1]);
    if (dx + dy > 1) wraps++;
  }
  return wraps;
}

/** Inclusive min/max corners of the rectangle spanned by two coords. */
function rect(a: Coord, b: Coord) {
  return {
    x0: Math.min(a[0], b[0]),
    y0: Math.min(a[1], b[1]),
    x1: Math.max(a[0], b[0]),
    y1: Math.max(a[1], b[1]),
  };
}

/** The corner a packet enters the box from, given the NoC's travel direction. */
function entryCorner(noc: Noc, r: ReturnType<typeof rect>): Coord {
  return noc === 'noc1' ? [r.x1, r.y1] : [r.x0, r.y0];
}

export default function NocGrid({
  cols = 14,
  rows = 12,
  src: srcProp = [11, 9],
  dst: dstProp = [2, 1],
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

  // multicast box corners (a = drag anchor, b = drag end)
  const defBox: [Coord, Coord] = boxProp ?? [[1, 1], [5, 4]];
  const [boxA, setBoxA] = useState<Coord>(clampCoord(defBox[0]));
  const [boxB, setBoxB] = useState<Coord>(clampCoord(defBox[1]));
  const [dragging, setDragging] = useState(false);

  const box = useMemo(() => rect(boxA, boxB), [boxA, boxB]);
  const entry = useMemo(() => entryCorner(noc, box), [noc, box]);

  // The animated route: src → dst (unicast) or src → box entry corner (multicast)
  const target = mode === 'multicast' ? entry : dst;
  const path = useMemo(() => buildPath(src, target, C, R, noc), [src, target, C, R, noc]);
  const pathSet = useMemo(() => new Set(path.map(([x, y]) => key(x, y))), [path]);

  const previewSet = useMemo(() => {
    if (mode !== 'unicast' || !hover) return null;
    return new Set(buildPath(src, hover, C, R, noc).map(([x, y]) => key(x, y)));
  }, [mode, hover, src, C, R, noc]);

  // tiles covered by the multicast box, tagged with flood distance from entry
  const boxCells = useMemo(() => {
    if (mode !== 'multicast') return null;
    const m = new Map<string, number>();
    for (let y = box.y0; y <= box.y1; y++)
      for (let x = box.x0; x <= box.x1; x++)
        m.set(key(x, y), Math.abs(x - entry[0]) + Math.abs(y - entry[1]));
    return m;
  }, [mode, box, entry]);

  // one fan-out route per box tile (except the entry), each a non-wrapping
  // dimension-ordered path from the entry corner. A dot rides each one.
  const fanout = useMemo(() => {
    if (mode !== 'multicast') return [] as { pts: Coord[]; dist: number }[];
    const list: { pts: Coord[]; dist: number }[] = [];
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        if (x === entry[0] && y === entry[1]) continue;
        const cells = buildPath(entry, [x, y], C, R, noc);
        list.push({ pts: cells.map(([cx, cy]) => center(cx, cy)), dist: cells.length - 1 });
      }
    }
    return list;
  }, [mode, box, entry, C, R, noc]);

  const boxKey = `${box.x0},${box.y0},${box.x1},${box.y1}`;
  const hops = path.length - 1;
  const wraps = useMemo(() => countWraps(path), [path]);
  const boxW = box.x1 - box.x0 + 1;
  const boxH = box.y1 - box.y0 + 1;
  const boxTiles = boxW * boxH;

  const W = G + C * (U + G);
  const H = G + R * (U + G);

  const reduced = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  // ── marker animation ─────────────────────────────────────────────────────
  // The lead marker travels src → target (the box entry corner in multicast).
  // Once it arrives, a swarm of dots emanates from the entry to every box tile,
  // each riding its own non-wrapping route, so the multicast visibly fans out.
  const markerRef = useRef<SVGCircleElement | null>(null);
  const fanRefs = useRef<(SVGCircleElement | null)[]>([]);
  const pathRef = useRef<Coord[]>(path);
  pathRef.current = path;
  const fanoutRef = useRef(fanout);
  fanoutRef.current = fanout;

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;

    const set = (el: SVGCircleElement, x: number, y: number, op: number) => {
      el.setAttribute('cx', String(x));
      el.setAttribute('cy', String(y));
      el.setAttribute('opacity', String(op));
    };
    // position along a list of adjacent (non-wrapping) centers
    const along = (pts: Coord[], ph: number): Coord => {
      if (pts.length < 2) return pts[0];
      const i = Math.min(pts.length - 2, Math.floor(ph));
      const f = ph - i;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
    };

    if (reduced) {
      const end = pathRef.current[pathRef.current.length - 1];
      const [ex, ey] = center(end[0], end[1]);
      set(marker, ex, ey, 1);
      fanoutRef.current.forEach((f, i) => {
        const el = fanRefs.current[i];
        if (el) set(el, f.pts[f.pts.length - 1][0], f.pts[f.pts.length - 1][1], 1);
      });
      return;
    }

    const dir = noc === 'noc1' ? -1 : 1;
    const off = (U + G) * 0.85;
    let raf = 0;
    let start = 0;

    const step = (t: number) => {
      const cells = pathRef.current;
      const fan = fanoutRef.current;
      const nseg = cells.length - 1;
      const routeDur = nseg * HOP_MS;
      const maxFan = fan.reduce((m, f) => Math.max(m, f.dist), 0);
      const fanDur = mode === 'multicast' ? maxFan * HOP_MS : 0;
      const cycle = routeDur + fanDur + END_PAUSE_MS;
      if (!start) start = t;
      let e = t - start;
      if (e >= cycle) {
        start = t;
        e = 0;
      }

      // ── lead marker: travels the route, then parks at the entry ──
      const phase = Math.min(nseg, Math.min(e, routeDur) / HOP_MS);
      if (nseg < 1) {
        const [cx, cy] = center(cells[0][0], cells[0][1]);
        set(marker, cx, cy, 1);
      } else {
        const i = Math.min(nseg - 1, Math.floor(phase));
        const f = phase - i;
        const from = cells[i];
        const to = cells[i + 1];
        const [fx, fy] = center(from[0], from[1]);
        const [tx, ty] = center(to[0], to[1]);
        const wrap = Math.abs(to[0] - from[0]) + Math.abs(to[1] - from[1]) > 1;
        if (phase >= nseg) {
          set(marker, tx, ty, 1);
        } else if (!wrap) {
          set(marker, fx + (tx - fx) * f, fy + (ty - fy) * f, 1);
        } else {
          const xAxis = from[1] === to[1];
          const ex = xAxis ? fx + dir * off : fx;
          const ey = xAxis ? fy : fy + dir * off;
          const sx = xAxis ? tx - dir * off : tx;
          const sy = xAxis ? ty : ty - dir * off;
          if (f < 0.5) {
            const k = f * 2;
            set(marker, fx + (ex - fx) * k, fy + (ey - fy) * k, 1 - k);
          } else {
            const k = (f - 0.5) * 2;
            set(marker, sx + (tx - sx) * k, sy + (ty - sy) * k, k);
          }
        }
      }

      // ── fan-out dots: emanate from the entry once the route completes ──
      if (mode === 'multicast') {
        const tFan = e - routeDur;
        fan.forEach((fobj, idx) => {
          const el = fanRefs.current[idx];
          if (!el) return;
          if (tFan <= 0) {
            el.setAttribute('opacity', '0');
            return;
          }
          const ph = Math.min(fobj.dist, tFan / HOP_MS);
          const [px, py] = along(fobj.pts, ph);
          set(el, px, py, 1);
        });
      }

      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [src, target, noc, mode, reduced, boxKey]);

  // ── interaction ──────────────────────────────────────────────────────────
  // unicast: click → dst, shift-click → src
  // multicast: drag → box, shift-click → src
  const onDown = (x: number, y: number, e: MouseEvent) => {
    if (e.shiftKey) {
      setSrc([x, y]);
      return;
    }
    if (mode === 'multicast') {
      setBoxA([x, y]);
      setBoxB([x, y]);
      setDragging(true);
    } else {
      setDst([x, y]);
    }
  };

  const onEnter = (x: number, y: number) => {
    setHover([x, y]);
    if (dragging) setBoxB([x, y]);
  };

  useEffect(() => {
    if (!dragging) return;
    const up = () => setDragging(false);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [dragging]);

  const cells = [];
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < C; x++) {
      const [tx, ty] = topLeft(x, y);
      const k = key(x, y);
      const isSrc = src[0] === x && src[1] === y;
      const isDst = mode === 'unicast' && dst[0] === x && dst[1] === y;
      const dist = boxCells?.get(k);
      let cls = 'dgm-cell';
      if (previewSet?.has(k)) cls += ' is-preview';
      if (pathSet.has(k)) cls += ' is-path';
      if (dist !== undefined) cls += ' is-mcast';
      if (isSrc) cls += ' is-src';
      if (isDst) cls += ' is-dst';
      cells.push(
        <rect
          key={k}
          class={cls}
          x={tx}
          y={ty}
          width={U}
          height={U}
          rx={2}
          style={dist !== undefined ? `--d:${dist}` : undefined}
          onMouseDown={(e: MouseEvent) => onDown(x, y, e)}
          onMouseEnter={() => onEnter(x, y)}
        >
          <title>{`tile (${x}, ${y})`}</title>
        </rect>,
      );
    }
  }

  const [scx, scy] = center(src[0], src[1]);
  const [dcx, dcy] = center(target[0], target[1]);

  return (
    <div class="dgm dgm-noc" data-active={noc}>
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
          <button
            type="button"
            aria-pressed={mode === 'unicast'}
            onClick={() => setMode('unicast')}
          >
            unicast
          </button>
          <button
            type="button"
            aria-pressed={mode === 'multicast'}
            onClick={() => setMode('multicast')}
          >
            multicast
          </button>
        </div>
        <div class="dgm-readout" aria-live="polite">
          <b>{noc}</b> ·{' '}
          {mode === 'multicast' ? (
            <>
              ({src[0]},{src[1]}) → box ({box.x0},{box.y0})–({box.x1},{box.y1}) · {boxW}×{boxH} ={' '}
              {boxTiles} tiles · {hops} hops to entry
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
        onMouseLeave={() => setHover(null)}
      >
        {cells}
        <text class="dgm-endcap" x={scx} y={scy}>
          S
        </text>
        {mode === 'unicast' && (
          <text class="dgm-endcap" x={dcx} y={dcy}>
            D
          </text>
        )}
        {mode === 'multicast' &&
          fanout.map((_, i) => (
            <circle
              key={i}
              ref={(el: SVGCircleElement | null) => (fanRefs.current[i] = el)}
              class="dgm-fan"
              r={U * 0.2}
              cx={scx}
              cy={scy}
              opacity={0}
            />
          ))}
        <circle ref={markerRef} class="dgm-marker" r={U * 0.3} cx={scx} cy={scy} />
      </svg>

      <p class="dgm-caption">
        <b style="color:var(--cat-tenstorrent)">noc0</b> routes right → down from the top-left;{' '}
        <b style="color:var(--cat-ml)">noc1</b> routes left → up from the bottom-right. Both wrap
        around the edges — the grid is a torus.{' '}
        {mode === 'multicast'
          ? 'A multicast write travels to the box’s entry corner, then fans out to every tile inside it.'
          : ''}
      </p>
      <p class="dgm-hint">
        {mode === 'multicast' ? 'drag a box to set the multicast region' : 'click a tile to move the destination'}
        <span class="dgm-swatch" style="background:var(--cat-gpu)" /> · shift-click to move the
        source
        <span class="dgm-swatch" style="background:var(--accent)" />
      </p>
    </div>
  );
}
