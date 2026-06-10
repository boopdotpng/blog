/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

/**
 * Interactive Tenstorrent NoC routing grid.
 *
 * Two unidirectional networks-on-chip over a torus of tiles:
 *   noc0 — origin top-left, steps right then down, wraps at edges
 *   noc1 — origin bottom-right, steps left then up, wraps at edges
 *
 * Click a tile to set the destination; shift-click to set the source.
 * Routing is dimension-ordered (X first, then Y) on a torus, matching the
 * hardware's wraparound behaviour.
 */

type Coord = [number, number];
type Noc = 'noc0' | 'noc1';

interface Props {
  cols?: number;
  rows?: number;
  src?: Coord;
  dst?: Coord;
  noc?: Noc;
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

export default function NocGrid({
  cols = 14,
  rows = 12,
  src: srcProp = [11, 9],
  dst: dstProp = [2, 1],
  noc: nocProp = 'noc0',
}: Props) {
  const C = clamp(cols | 0, 2, 40);
  const R = clamp(rows | 0, 2, 40);
  const clampCoord = (c: Coord): Coord => [clamp(c[0] | 0, 0, C - 1), clamp(c[1] | 0, 0, R - 1)];

  const [src, setSrc] = useState<Coord>(clampCoord(srcProp));
  const [dst, setDst] = useState<Coord>(clampCoord(dstProp));
  const [noc, setNoc] = useState<Noc>(nocProp);
  const [hover, setHover] = useState<Coord | null>(null);

  const path = useMemo(() => buildPath(src, dst, C, R, noc), [src, dst, C, R, noc]);
  const pathSet = useMemo(() => new Set(path.map(([x, y]) => key(x, y))), [path]);
  const previewSet = useMemo(() => {
    if (!hover) return null;
    return new Set(buildPath(src, hover, C, R, noc).map(([x, y]) => key(x, y)));
  }, [hover, src, C, R, noc]);

  const hops = path.length - 1;
  const wraps = useMemo(() => countWraps(path), [path]);

  const W = G + C * (U + G);
  const H = G + R * (U + G);

  // ── marker animation ──────────────────────────────────────────────────
  const markerRef = useRef<SVGCircleElement | null>(null);
  const pathRef = useRef<Coord[]>(path);
  pathRef.current = path;

  const reduced = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;

    const place = (x: number, y: number, op: number) => {
      marker.setAttribute('cx', String(x));
      marker.setAttribute('cy', String(y));
      marker.setAttribute('opacity', String(op));
    };

    const dst0 = pathRef.current[pathRef.current.length - 1];
    if (reduced || pathRef.current.length < 2) {
      const [cx, cy] = center(dst0[0], dst0[1]);
      place(cx, cy, 1);
      return;
    }

    const dir = noc === 'noc1' ? -1 : 1;
    const off = (U + G) * 0.85;
    let raf = 0;
    let start = 0;

    const step = (t: number) => {
      const cells = pathRef.current;
      const nseg = cells.length - 1;
      if (!start) start = t;
      const total = nseg * HOP_MS;
      let elapsed = t - start;
      if (elapsed >= total + END_PAUSE_MS) {
        start = t;
        elapsed = 0;
      }
      const phase = Math.min(nseg, elapsed / HOP_MS);
      const i = Math.min(nseg - 1, Math.floor(phase));
      const f = phase - i;

      const from = cells[i];
      const to = cells[i + 1];
      const [fx, fy] = center(from[0], from[1]);
      const [tx, ty] = center(to[0], to[1]);
      const wrap = Math.abs(to[0] - from[0]) + Math.abs(to[1] - from[1]) > 1;

      if (phase >= nseg) {
        place(tx, ty, 1);
      } else if (!wrap) {
        place(fx + (tx - fx) * f, fy + (ty - fy) * f, 1);
      } else {
        const xAxis = from[1] === to[1];
        const ex = xAxis ? fx + dir * off : fx;
        const ey = xAxis ? fy : fy + dir * off;
        const sx = xAxis ? tx - dir * off : tx;
        const sy = xAxis ? ty : ty - dir * off;
        if (f < 0.5) {
          const k = f * 2;
          place(fx + (ex - fx) * k, fy + (ey - fy) * k, 1 - k);
        } else {
          const k = (f - 0.5) * 2;
          place(sx + (tx - sx) * k, sy + (ty - sy) * k, k);
        }
      }
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [src, dst, noc, reduced]);

  // ── interaction ───────────────────────────────────────────────────────
  const onCell = (x: number, y: number, e: MouseEvent) => {
    if (e.shiftKey) setSrc([x, y]);
    else setDst([x, y]);
  };

  const cells = [];
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < C; x++) {
      const [tx, ty] = topLeft(x, y);
      const k = key(x, y);
      const isSrc = src[0] === x && src[1] === y;
      const isDst = dst[0] === x && dst[1] === y;
      let cls = 'dgm-cell';
      if (previewSet?.has(k)) cls += ' is-preview';
      if (pathSet.has(k)) cls += ' is-path';
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
          onClick={(e: MouseEvent) => onCell(x, y, e)}
          onMouseEnter={() => setHover([x, y])}
        >
          <title>{`tile (${x}, ${y})`}</title>
        </rect>,
      );
    }
  }

  const [scx, scy] = center(src[0], src[1]);
  const [dcx, dcy] = center(dst[0], dst[1]);

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
        <div class="dgm-readout" aria-live="polite">
          <b>{noc}</b> · ({src[0]},{src[1]}) → ({dst[0]},{dst[1]}) · {hops} hops
          {wraps > 0 ? `, wraps ×${wraps}` : ''}
        </div>
      </div>

      <svg
        class="dgm-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`NoC ${noc} route from tile ${src[0]},${src[1]} to ${dst[0]},${dst[1]}`}
        onMouseLeave={() => setHover(null)}
      >
        {cells}
        <text class="dgm-endcap" x={scx} y={scy}>
          S
        </text>
        <text class="dgm-endcap" x={dcx} y={dcy}>
          D
        </text>
        <circle ref={markerRef} class="dgm-marker" r={U * 0.3} cx={scx} cy={scy} />
      </svg>

      <p class="dgm-caption">
        <b style="color:var(--cat-tenstorrent)">noc0</b> routes right → down from the top-left;{' '}
        <b style="color:var(--cat-ml)">noc1</b> routes left → up from the bottom-right. Both wrap
        around the edges — the grid is a torus.
      </p>
      <p class="dgm-hint">
        click a tile to move the destination
        <span class="dgm-swatch" style="background:var(--cat-gpu)" /> · shift-click to move the
        source
        <span class="dgm-swatch" style="background:var(--accent)" />
      </p>
    </div>
  );
}
