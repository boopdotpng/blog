/** @jsxImportSource preact */
import { useRef } from 'preact/hooks';
import { useFrameLoop } from './frame-loop';

/**
 * Animated Tenstorrent kernel dataflow pipeline.
 *
 * Tiles stream left→right through the five cores of one Tensix tile:
 *   DRAM → NCRISC (read) → CB0 → TRISC0/1/2 (unpack·math·pack) → CB16 → BRISC (write) → DRAM
 *
 * The motion comes from a tiny discrete-event simulation rather than a fixed
 * conveyor belt: each core works on one tile at a time, the circular buffers
 * are three-slot rings, and math is deliberately the slowest stage. So CB0
 * fills up and NCRISC stalls in cb_reserve_back (backpressure), while BRISC
 * idles in cb_wait_front on CB16. Durations are illustrative, not measured.
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
const SLOT_Y = BOX_TOP + BOX_H - 13;
const SLOT_H = 7;
// Tiles travel along the CB-slot line, below the labels, so they never cover them.
const LANE_Y = SLOT_Y + SLOT_H / 2;
const TOKEN = 9;
const NAME_Y = BOX_TOP + 14;
const SUB_Y = BOX_TOP + 25;

// ── simulation ─────────────────────────────────────────────────────────────

const SLOTS = 3; // pages per circular buffer
const TILES = 16; // tiles per loop
const MS = { read: 600, unpack: 350, math: 1100, pack: 350, write: 600 };
const MOVE_MS = 200; // hand-off between neighbouring TRISCs
const LOOP_PAUSE_MS = 900;

type Times = { readStart: number; readEnd: number; unpackStart: number; unpackEnd: number; mathStart: number;
  mathEnd: number; packStart: number; packEnd: number; writeStart: number; writeEnd: number };

/** Steps the pipeline in 5 ms increments and records when each tile enters and leaves each stage. */
function simulate(): Times[] {
  const t: Times[] = Array.from({ length: TILES }, () => ({} as Times));
  type Job = { k: number; end: number; done?: boolean };
  let read: Job | null = null, unpack: Job | null = null, math: Job | null = null;
  let pack: Job | null = null, write: Job | null = null;
  const cb0: number[] = []; // tiles pushed to CB0, waiting for unpack
  const cb16: number[] = []; // tiles pushed to CB16, waiting for brisc
  let next = 0;
  // Downstream stages go first so a slot freed this step is visible upstream.
  for (let now = 0; !(t[TILES - 1].writeEnd >= 0) && now < 600_000; now += 5) {
    if (write && now >= write.end) { t[write.k].writeEnd = now; write = null; }
    if (!write && cb16.length) { const k = cb16.shift()!; t[k].writeStart = now; write = { k, end: now + MS.write }; }

    if (pack && now >= pack.end) { t[pack.k].packEnd = now; cb16.push(pack.k); pack = null; }
    // cb_reserve_back(CB16): the tile being packed already owns its page.
    if (!pack && math?.done && cb16.length < SLOTS) { t[math.k].packStart = now; pack = { k: math.k, end: now + MS.pack }; math = null; }

    if (math && !math.done && now >= math.end) { t[math.k].mathEnd = now; math.done = true; }
    if (!math && unpack?.done) { t[unpack.k].mathStart = now; math = { k: unpack.k, end: now + MS.math }; unpack = null; }

    if (unpack && !unpack.done && now >= unpack.end) { t[unpack.k].unpackEnd = now; unpack.done = true; }
    if (!unpack && cb0.length) { const k = cb0.shift()!; t[k].unpackStart = now; unpack = { k, end: now + MS.unpack }; }

    if (read && now >= read.end) { t[read.k].readEnd = now; cb0.push(read.k); read = null; }
    // cb_reserve_back(CB0): only start a read if a page is free.
    if (!read && next < TILES && cb0.length < SLOTS) { t[next].readStart = now; read = { k: next, end: now + MS.read }; next++; }
  }
  return t;
}

const TIMES = simulate();
const LOOP_MS = TIMES[TILES - 1].writeEnd + LOOP_PAUSE_MS;

const cx = (s: { x: number; w: number }) => s.x + s.w / 2;
const slotW = (s: Stage) => (s.w - 16) / SLOTS - 3;
const slotX = (s: Stage, k: number) => s.x + 8 + (k % SLOTS) * ((s.w - 16) / SLOTS);
type Box = [x: number, y: number, w: number, h: number];
const at = (x: number, y = LANE_Y, size = TOKEN): Box => [x - size / 2, y - size / 2, size, size];
const inSlot = (s: Stage, k: number): Box => [slotX(s, k), SLOT_Y, slotW(s), SLOT_H];
const P = {
  dramIn: at(cx(STAGES[0])),
  ncrisc: at(cx(STAGES[1])),
  unpack: at(cx(COMPUTE[0])),
  math: at(cx(COMPUTE[1])),
  pack: at(cx(COMPUTE[2])),
  brisc: at(cx(STAGES[5])),
  dramOut: at(cx(STAGES[6])),
};

const ease = (f: number) => (f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2);
const lerp = (a: Box, b: Box, f: number): Box => {
  const e = ease(Math.min(1, Math.max(0, f)));
  return a.map((v, i) => v + (b[i] - v) * e) as Box;
};
/** Travel through `stops` over the span [start, end]. */
const along = (stops: Box[], start: number, end: number, now: number): Box => {
  const f = Math.min(1, Math.max(0, (now - start) / (end - start))) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  return lerp(stops[i], stops[i + 1], f - i);
};

/** Where tile k is drawn at time `now`, and its opacity. */
function tokenAt(k: number, now: number): [Box, number] {
  const t = TIMES[k];
  const cb0 = inSlot(STAGES[2], k);
  const cb16 = inSlot(STAGES[4], k);
  if (now < t.readStart) return [P.dramIn, 0];
  if (now < t.readEnd) return [along([P.dramIn, P.ncrisc, cb0], t.readStart, t.readEnd, now), Math.min(1, (now - t.readStart) / 150)];
  if (now < t.unpackStart) return [cb0, 1];
  if (now < t.mathStart) return [lerp(cb0, P.unpack, (now - t.unpackStart) / MOVE_MS), 1];
  if (now < t.packStart) return [lerp(P.unpack, P.math, (now - t.mathStart) / MOVE_MS), 1];
  if (now < t.packEnd) return [along([P.math, P.pack, cb16], t.packStart, t.packEnd, now), 1];
  if (now < t.writeStart) return [cb16, 1];
  if (now < t.writeEnd) return [along([cb16, P.brisc, P.dramOut], t.writeStart, t.writeEnd, now), Math.min(1, (t.writeEnd - now) / 150)];
  return [P.dramOut, 0];
}

type Core = 'ncrisc' | 'unpack' | 'math' | 'pack' | 'brisc';
type State = 'busy' | 'blocked' | 'idle';

function coreStates(now: number): Record<Core, State> {
  const s: Record<Core, State> = { ncrisc: 'idle', unpack: 'idle', math: 'idle', pack: 'idle', brisc: 'idle' };
  let cb0 = 0;
  for (const t of TIMES) {
    if (now >= t.readStart && now < t.readEnd) s.ncrisc = 'busy';
    if (now >= t.readStart && now < t.unpackStart) cb0++;
    if (now >= t.unpackStart && now < t.unpackEnd) s.unpack = 'busy';
    else if (now >= t.unpackEnd && now < t.mathStart) s.unpack = 'blocked';
    if (now >= t.mathStart && now < t.mathEnd) s.math = 'busy';
    if (now >= t.packStart && now < t.packEnd) s.pack = 'busy';
    if (now >= t.writeStart && now < t.writeEnd) s.brisc = 'busy';
  }
  if (s.ncrisc === 'idle' && cb0 >= SLOTS) s.ncrisc = 'blocked';
  return s;
}

// What a core's sub-label says while it is stuck (blocked) or starved (idle).
const WAIT_LABEL: Partial<Record<Core, Partial<Record<State, string>>>> = {
  ncrisc: { blocked: 'cb0 full' },
  unpack: { blocked: 'math busy' },
  brisc: { idle: 'cb16 empty' },
};

export default function KernelPipeline() {
  const rootRef = useRef<HTMLDivElement>(null);
  const tokenRefs = useRef<(SVGRectElement | null)[]>([]);
  const coreRefs = useRef<Partial<Record<Core, SVGGElement | null>>>({});

  useFrameLoop(
    rootRef,
    (elapsed) => {
      const now = elapsed % LOOP_MS;
      tokenRefs.current.forEach((el, k) => {
        if (!el) return;
        const [[x, y, w, h], op] = tokenAt(k, now);
        el.setAttribute('x', String(x));
        el.setAttribute('y', String(y));
        el.setAttribute('width', String(w));
        el.setAttribute('height', String(h));
        el.style.opacity = String(op);
      });
      const states = coreStates(now);
      for (const [core, el] of Object.entries(coreRefs.current)) {
        el?.setAttribute('data-state', states[core as Core]);
      }
    },
    [],
    // Reduced motion: a steady-state frame with CB0 full and ncrisc stalled.
    TIMES[8].readStart - 50,
  );

  const coreRef = (core: Core) => (el: SVGGElement | null) => {
    coreRefs.current[core] = el;
  };

  const subLabels = (core: Core | undefined, x: number, sub: string) => (
    <>
      <text class="dgm-pipe-sub" x={x} y={SUB_Y}>
        {sub}
      </text>
      {core &&
        Object.entries(WAIT_LABEL[core] ?? {}).map(([state, label]) => (
          <text key={state} class={`dgm-pipe-sub dgm-pipe-wait is-${state}`} x={x} y={SUB_Y}>
            {label}
          </text>
        ))}
    </>
  );

  return (
    <div class="dgm dgm-pipe" data-zoomable ref={rootRef}>
      <svg
        class="dgm-svg"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label="Tenstorrent kernel dataflow: DRAM to NCRISC to CB0 to TRISC unpack-math-pack to CB16 to BRISC to DRAM, with tiles pipelined through the stages"
      >
        {/* connector rail */}
        <line class="dgm-pipe-rail" x1={cx(STAGES[0])} y1={LANE_Y} x2={cx(STAGES[6])} y2={LANE_Y} />

        {/* op labels + chevrons in the gaps */}
        {OPS.map((o) => (
          <g key={o.x}>
            <text class="dgm-pipe-op" x={o.x} y={40}>
              {o.t}
            </text>
            <path
              class="dgm-pipe-chev"
              d={`M ${o.x - 3} ${LANE_Y - 4} L ${o.x + 3} ${LANE_Y} L ${o.x - 3} ${LANE_Y + 4}`}
            />
          </g>
        ))}

        {/* stage boxes */}
        {STAGES.map((s, i) => {
          if (i === 3) return null; // compute group drawn below
          const core = i === 1 ? 'ncrisc' : i === 5 ? 'brisc' : undefined;
          return (
            <g key={i} style={s.c ? `--c:var(${s.c})` : undefined} ref={core ? coreRef(core) : undefined}>
              <rect
                class={`dgm-pipe-box${s.mem ? ' is-mem' : ''}`}
                x={s.x}
                y={BOX_TOP}
                width={s.w}
                height={BOX_H}
                rx={4}
              />
              {s.ring &&
                Array.from({ length: SLOTS }, (_, k) => (
                  <rect key={k} class="dgm-pipe-slot" x={slotX(s, k)} y={SLOT_Y} width={slotW(s)} height={SLOT_H} rx={1.5} />
                ))}
              <text class="dgm-pipe-name" x={cx(s)} y={s.sub ? NAME_Y : BOX_TOP + BOX_H / 2}>
                {s.title}
              </text>
              {s.sub && (s.ring ? (
                <text class="dgm-pipe-sub" x={cx(s)} y={SUB_Y}>
                  {s.sub}
                </text>
              ) : subLabels(core, cx(s), s.sub))}
            </g>
          );
        })}

        {/* compute group: outer bracket + three TRISC sub-cells */}
        <g style="--c:var(--cat-worker)">
          <rect class="dgm-pipe-group" x={228} y={BOX_TOP} width={156} height={BOX_H} rx={4} />
          {COMPUTE.map((c, i) => {
            const core = (['unpack', 'math', 'pack'] as const)[i];
            return (
              <g key={core} style={i === 1 ? '--c:var(--cat-hardware)' : '--c:var(--cat-worker)'} ref={coreRef(core)}>
                <rect
                  class={`dgm-pipe-cell${i === 1 ? ' is-hot' : ''}`}
                  x={c.x + 2}
                  y={BOX_TOP + 2}
                  width={c.w - 4}
                  height={BOX_H - 4}
                  rx={3}
                />
                <text class="dgm-pipe-name" x={cx(c)} y={NAME_Y}>
                  {c.title}
                </text>
                {subLabels(core, cx(c), c.tag)}
              </g>
            );
          })}
        </g>

        {/* in-flight tiles */}
        {Array.from({ length: TILES }, (_, k) => (
          <rect
            key={k}
            ref={(el: SVGRectElement | null) => {
              tokenRefs.current[k] = el;
            }}
            class="dgm-pipe-token"
            x={P.dramIn[0]}
            y={P.dramIn[1]}
            width={TOKEN}
            height={TOKEN}
            rx={2}
            style="opacity:0"
          />
        ))}
      </svg>

      <p class="dgm-caption">
        Tiles stream through all five cores: <b style="color:var(--cat-host)">ncrisc</b> reads each one
        from DRAM into a page of <b style="color:var(--cat-dispatch)">CB0</b>, the three{' '}
        <b style="color:var(--cat-worker)">trisc</b> cores unpack → <b style="color:var(--cat-hardware)">compute</b> → pack it into{' '}
        <b style="color:var(--cat-dispatch)">CB16</b>, and <b style="color:var(--cat-green)">brisc</b>{' '}
        writes it back. Every core works on a different tile at once; the circular buffers are what let
        them overlap. Here math is the slowest stage, so CB0 fills up and ncrisc stalls until a page frees
        up (backpressure), while brisc sits waiting on an empty CB16. Timings are illustrative.
      </p>
    </div>
  );
}
