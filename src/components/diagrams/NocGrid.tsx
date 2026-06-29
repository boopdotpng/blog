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

// ── Blackhole NoC topology (mirrors noc-visualization/topology.js, which in
// turn matches ttk/blackhole_coords.py). The physical NoC is a 17×12 torus.
//   - DRAM ports live on two vertical columns: x = 0 and x = 9.
//   - Tensix worker cores: rows y = 2..11, columns x = 1..7 and 10..16.
//   - Column x = 8 and rows y = 0..1 are non-Tensix tiles (PCIe / ARC / eth).
type Kind = 'dram' | 'tensix' | 'other';
const TENSIX_ROWS = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const TENSIX_COLS = new Set([1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 16]);

function cellKind(x: number, y: number): Kind {
  if (x === 0 || x === 9) return 'dram';
  if (y < 2) return 'other';
  if (x === 8) return 'other';
  if (TENSIX_COLS.has(x) && TENSIX_ROWS.has(y)) return 'tensix';
  return 'other';
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

  // multicast box corners (a = drag anchor, b = drag end)
  const defBox: [Coord, Coord] = boxProp ?? [[1, 2], [5, 5]];
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

  // tiles covered by the multicast box, tagged with flood distance from entry.
  // Only valid receivers (Tensix + DRAM) take part — the l2cpu / PCIe / ARC /
  // eth ("other") tiles inside the rectangle are skipped, even though the
  // packet still physically routes through their routers.
  const boxCells = useMemo(() => {
    if (mode !== 'multicast') return null;
    const m = new Map<string, number>();
    for (let y = box.y0; y <= box.y1; y++)
      for (let x = box.x0; x <= box.x1; x++) {
        if (cellKind(x, y) === 'other') continue;
        m.set(key(x, y), Math.abs(x - entry[0]) + Math.abs(y - entry[1]));
      }
    return m;
  }, [mode, box, entry]);

  // Faithful multicast tree (mirrors noc-visualization's mcastTree): the UNION
  // of every valid receiver's dimension-ordered path from the SOURCE. The trunk
  // is shared and the tree branches at routers, exactly how a hardware multicast
  // write fans out. "other" tiles (l2cpu / PCIe / ARC / eth) are skipped as
  // receivers — DRAM ports stay valid.
  const mcast = useMemo(() => {
    type MPath = { cells: Coord[]; pts: Coord[]; dist: number };
    type MLink = { a: Coord; b: Coord; wrap: boolean };
    if (mode !== 'multicast') return { paths: [] as MPath[], links: [] as MLink[], maxDist: 0 };
    const paths: MPath[] = [];
    const linkMap = new Map<string, MLink>();
    let maxDist = 0;
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        if (cellKind(x, y) === 'other') continue;
        if (x === src[0] && y === src[1]) continue;
        const cells = buildPath(src, [x, y], C, R, noc);
        const dist = cells.length - 1;
        maxDist = Math.max(maxDist, dist);
        paths.push({ cells, pts: cells.map(([cx, cy]) => center(cx, cy)), dist });
        for (let i = 0; i < cells.length - 1; i++) {
          const a = cells[i];
          const b = cells[i + 1];
          const lk = `${a[0]},${a[1]}->${b[0]},${b[1]}`;
          if (!linkMap.has(lk)) {
            const wrap = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) > 1;
            linkMap.set(lk, { a: center(a[0], a[1]), b: center(b[0], b[1]), wrap });
          }
        }
      }
    }
    return { paths, links: [...linkMap.values()], maxDist };
  }, [mode, box, src, C, R, noc]);

  const boxKey = `${box.x0},${box.y0},${box.x1},${box.y1}`;
  const hops = path.length - 1;
  const wraps = useMemo(() => countWraps(path), [path]);
  const boxW = box.x1 - box.x0 + 1;
  const boxH = box.y1 - box.y0 + 1;
  const boxTiles = boxCells ? boxCells.size : boxW * boxH;

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
  const mcastRef = useRef(mcast);
  mcastRef.current = mcast;

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;

    const set = (el: SVGCircleElement, x: number, y: number, op: number) => {
      el.setAttribute('cx', String(x));
      el.setAttribute('cy', String(y));
      el.setAttribute('opacity', String(op));
    };

    if (reduced) {
      if (mode === 'multicast') {
        marker.setAttribute('opacity', '0');
        mcastRef.current.paths.forEach((p, i) => {
          const el = fanRefs.current[i];
          if (el) set(el, p.pts[p.pts.length - 1][0], p.pts[p.pts.length - 1][1], 1);
        });
      } else {
        const end = pathRef.current[pathRef.current.length - 1];
        const [ex, ey] = center(end[0], end[1]);
        set(marker, ex, ey, 1);
      }
      return;
    }

    const dir = noc === 'noc1' ? -1 : 1;
    const off = (U + G) * 0.85;
    let raf = 0;
    let start = 0;

    const step = (t: number) => {
      // ── multicast: every receiver's packet rides the shared tree at once ──
      if (mode === 'multicast') {
        marker.setAttribute('opacity', '0');
        const m = mcastRef.current;
        const cycle = m.maxDist * HOP_MS + END_PAUSE_MS;
        if (!start) start = t;
        let e = t - start;
        if (e >= cycle) {
          start = t;
          e = 0;
        }
        const ph = e / HOP_MS;
        m.paths.forEach((p, idx) => {
          const el = fanRefs.current[idx];
          if (!el) return;
          const { pts, cells: pc, dist } = p;
          if (pts.length < 2) {
            set(el, pts[0][0], pts[0][1], 1);
            return;
          }
          const local = Math.min(dist, ph);
          const i = Math.min(pts.length - 2, Math.floor(local));
          const f = local - i;
          const a = pc[i];
          const b = pc[i + 1];
          // hide the dot while it's crossing a torus wrap (off the edge)
          if (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) > 1 && local < dist) {
            el.setAttribute('opacity', '0');
            return;
          }
          const [ax, ay] = pts[i];
          const [bx, by] = pts[i + 1];
          set(el, ax + (bx - ax) * f, ay + (by - ay) * f, 1);
        });
        raf = requestAnimationFrame(step);
        return;
      }

      const cells = pathRef.current;
      const nseg = cells.length - 1;
      const routeDur = nseg * HOP_MS;
      const cycle = routeDur + END_PAUSE_MS;
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

      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [src, target, noc, mode, reduced, boxKey]);

  // ── interaction ──────────────────────────────────────────────────────────
  // unicast: click → dst, shift-click → src
  // multicast: drag → box, shift-click → src
  const onDown = (x: number, y: number, e: MouseEvent) => {
    // src/dst (and the multicast box) only make sense on Tensix worker cores —
    // ignore DRAM ports and non-Tensix (PCIe/ARC/eth) tiles.
    if (cellKind(x, y) !== 'tensix') return;
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
    if (dragging && cellKind(x, y) === 'tensix') setBoxB([x, y]);
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
      let cls = `dgm-cell kind-${cellKind(x, y)}`;
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
        {/* multicast tree: the shared trunk + branches every receiver rides */}
        {mode === 'multicast' &&
          mcast.links.map((l, i) => (
            <line
              key={`ml${i}`}
              class={`dgm-mlink${l.wrap ? ' is-wrap' : ''}`}
              x1={l.a[0]}
              y1={l.a[1]}
              x2={l.b[0]}
              y2={l.b[1]}
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
        {mode === 'multicast' &&
          mcast.paths.map((_, i) => (
            <circle
              key={i}
              ref={(el: SVGCircleElement | null) => (fanRefs.current[i] = el)}
              class="dgm-fan"
              r={U * 0.18}
              cx={scx}
              cy={scy}
              opacity={0}
            />
          ))}
        <circle ref={markerRef} class="dgm-marker" r={U * 0.3} cx={scx} cy={scy} />
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
      <p class="dgm-hint">
        {mode === 'multicast' ? 'drag a box to set the multicast region' : 'click a tile to move the destination'}
        <span class="dgm-swatch" style="background:var(--cat-gpu)" /> · shift-click to move the
        source
        <span class="dgm-swatch" style="background:var(--accent)" />
      </p>
    </div>
  );
}
