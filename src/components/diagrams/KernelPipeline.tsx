/** @jsxImportSource preact */
import { useEffect, useRef } from 'preact/hooks';

/**
 * Animated Tenstorrent kernel dataflow pipeline.
 *
 * A tile streams left→right through the five cores of one Tensix tile:
 *   DRAM → NCRISC (read) → CB0 → TRISC0/1/2 (unpack·math·pack) → CB16 → BRISC (write) → DRAM
 *
 * Several tiles are in flight at once at staggered offsets — that overlap is
 * the whole reason the circular buffers exist: NCRISC can be reading tile N+2
 * from DRAM while the TRISC cores compute tile N+1 and BRISC writes tile N.
 */

interface Stage {
  x: number;
  w: number;
  title: string;
  sub?: string;
  c?: string; // accent css var
  mem?: boolean;
  ring?: boolean;
}

const STAGES: Stage[] = [
  { x: 6, w: 48, title: 'DRAM', mem: true },
  { x: 78, w: 66, title: 'ncrisc', sub: 'reader', c: '--cat-host' },
  { x: 160, w: 52, title: 'CB0', sub: 'in ring', c: '--cat-dispatch', ring: true },
  { x: 228, w: 156, title: '', c: '--cat-worker' }, // compute group (drawn specially)
  { x: 400, w: 52, title: 'CB16', sub: 'out ring', c: '--cat-dispatch', ring: true },
  { x: 468, w: 66, title: 'brisc', sub: 'writer', c: '--cat-green' },
  { x: 550, w: 48, title: 'DRAM', mem: true },
];

// three sub-cells of the compute group (TRISC0/1/2)
const COMPUTE = [
  { x: 228, w: 52, title: 'unpack', tag: 'trisc0' },
  { x: 280, w: 52, title: 'math', tag: 'trisc1' },
  { x: 332, w: 52, title: 'pack', tag: 'trisc2' },
];

// op labels sitting in the gaps between stages
const OPS = [
  { x: 66, t: 'read' },
  { x: 152, t: 'push' },
  { x: 220, t: 'wait' },
  { x: 392, t: 'push' },
  { x: 460, t: 'wait' },
  { x: 542, t: 'write' },
];

const VB_W = 604;
const VB_H = 112;
const BOX_TOP = 50;
const BOX_H = 42;
const TOKEN_Y = BOX_TOP + BOX_H / 2; // 71
const X0 = 30; // first DRAM center
const X1 = 574; // last DRAM center
const N_TOKENS = 5;
const CYCLE_MS = 5200;
const FADE = 0.05;

export default function KernelPipeline() {
  const tokenRefs = useRef<(SVGRectElement | null)[]>([]);

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const place = (el: SVGRectElement, x: number, op: number) => {
      el.setAttribute('x', String(x - 5));
      el.setAttribute('opacity', String(op));
    };

    // static fallback: spread tiles across the stages so overlap still reads
    if (reduced) {
      const spots = [X0, 111, 306, 426, 501];
      tokenRefs.current.forEach((el, i) => el && place(el, spots[i] ?? X0, 1));
      return;
    }

    let raf = 0;
    let start = 0;
    const step = (t: number) => {
      if (!start) start = t;
      const base = ((t - start) % CYCLE_MS) / CYCLE_MS;
      tokenRefs.current.forEach((el, i) => {
        if (!el) return;
        const g = (base + i / N_TOKENS) % 1;
        const x = X0 + g * (X1 - X0);
        const op = g < FADE ? g / FADE : g > 1 - FADE ? (1 - g) / FADE : 1;
        place(el, x, op);
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div class="dgm dgm-pipe">
      <svg
        class="dgm-svg"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label="Tenstorrent kernel dataflow: DRAM to NCRISC to CB0 to TRISC unpack-math-pack to CB16 to BRISC to DRAM, with tiles pipelined through the stages"
      >
        {/* connector rail */}
        <line class="dgm-pipe-rail" x1={X0} y1={TOKEN_Y} x2={X1} y2={TOKEN_Y} />

        {/* op labels + chevrons in the gaps */}
        {OPS.map((o) => (
          <>
            <text class="dgm-pipe-op" x={o.x} y={40}>
              {o.t}
            </text>
            <path
              class="dgm-pipe-chev"
              d={`M ${o.x - 3} ${TOKEN_Y - 4} L ${o.x + 3} ${TOKEN_Y} L ${o.x - 3} ${TOKEN_Y + 4}`}
            />
          </>
        ))}

        {/* stage boxes */}
        {STAGES.map((s, i) => {
          if (i === 3) return null; // compute group drawn below
          const cx = s.x + s.w / 2;
          return (
            <g style={s.c ? `--c:var(${s.c})` : undefined}>
              <rect
                class={`dgm-pipe-box${s.mem ? ' is-mem' : ''}`}
                x={s.x}
                y={BOX_TOP}
                width={s.w}
                height={BOX_H}
                rx={4}
              />
              {s.ring &&
                [0, 1, 2].map((k) => (
                  <rect
                    class="dgm-pipe-slot"
                    x={s.x + 8 + k * ((s.w - 16) / 3)}
                    y={BOX_TOP + BOX_H - 13}
                    width={(s.w - 16) / 3 - 3}
                    height={7}
                    rx={1.5}
                  />
                ))}
              <text class="dgm-pipe-name" x={cx} y={s.sub ? BOX_TOP + 16 : BOX_TOP + BOX_H / 2 + 3}>
                {s.title}
              </text>
              {s.sub && (
                <text class="dgm-pipe-sub" x={cx} y={BOX_TOP + 27}>
                  {s.sub}
                </text>
              )}
            </g>
          );
        })}

        {/* compute group: outer bracket + three TRISC sub-cells */}
        <g style="--c:var(--cat-worker)">
          <rect
            class="dgm-pipe-group"
            x={228}
            y={BOX_TOP}
            width={156}
            height={BOX_H}
            rx={4}
          />
          {COMPUTE.map((c, i) => {
            const cx = c.x + c.w / 2;
            return (
              <g style={i === 1 ? '--c:var(--cat-hardware)' : '--c:var(--cat-worker)'}>
                <rect
                  class={`dgm-pipe-cell${i === 1 ? ' is-hot' : ''}`}
                  x={c.x + 2}
                  y={BOX_TOP + 2}
                  width={c.w - 4}
                  height={BOX_H - 4}
                  rx={3}
                />
                <text class="dgm-pipe-name" x={cx} y={BOX_TOP + 16}>
                  {c.title}
                </text>
                <text class="dgm-pipe-sub" x={cx} y={BOX_TOP + 27}>
                  {c.tag}
                </text>
              </g>
            );
          })}
        </g>

        {/* in-flight tiles */}
        {Array.from({ length: N_TOKENS }, (_, i) => (
          <rect
            ref={(el: SVGRectElement | null) => (tokenRefs.current[i] = el)}
            class="dgm-pipe-token"
            x={X0 - 5}
            y={TOKEN_Y - 5}
            width={10}
            height={10}
            rx={2}
          />
        ))}
      </svg>

      <p class="dgm-caption">
        One tile streams through all five cores: <b style="color:var(--cat-host)">ncrisc</b> reads it
        from DRAM into <b style="color:var(--cat-dispatch)">CB0</b>, the three{' '}
        <b style="color:var(--cat-worker)">trisc</b> cores unpack → <b style="color:var(--cat-hardware)">compute</b> → pack into{' '}
        <b style="color:var(--cat-dispatch)">CB16</b>, and <b style="color:var(--cat-green)">brisc</b>{' '}
        writes it back. Tiles are staggered on purpose — while one is being written, the next is mid-compute
        and another is still being read. That overlap is exactly what the circular buffers buy you.
      </p>
    </div>
  );
}
