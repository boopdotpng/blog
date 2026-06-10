/** @jsxImportSource preact */

/**
 * Static block diagram of a single Tensix tile's internals.
 *
 * Pure layout — no hooks, no interactivity — so Astro renders it to plain HTML
 * at build time and ships zero client JS. It draws from the shared diagram
 * design tokens (see diagrams.css, `.dgm-tile`) so it themes natively in light
 * and dark without the invert() hack.
 *
 * Three stacked regions:
 *   L1 SRAM           — circular buffers + kernel/scratch/semaphore areas
 *   5 RISC-V cores    — ncrisc / trisc0-2 / brisc and their roles
 *   Tensix coprocessor — Dst register, the matrix engine (FPU) and the SFPU
 */

type C = string; // a --cat-* token name

const region = (x: number, y: number, w: number, h: number, c: C, label: string) => (
  <g style={`--c:var(${c})`}>
    <rect class="dgm-tile-region" x={x} y={y} width={w} height={h} rx={8} />
    <text class="dgm-tile-region-label" x={x + 11} y={y + 17}>
      {label}
    </text>
  </g>
);

const cell = (x: number, y: number, w: number, h: number, c: C, label: string, sub?: string) => (
  <g style={`--c:var(${c})`}>
    <rect class="dgm-tile-cell" x={x} y={y} width={w} height={h} rx={4} />
    <text class="dgm-tile-name" x={x + w / 2} y={sub ? y + h / 2 - 4 : y + h / 2}>
      {label}
    </text>
    {sub && (
      <text class="dgm-tile-sub" x={x + w / 2} y={y + h / 2 + 7}>
        {sub}
      </text>
    )}
  </g>
);

const pill = (x: number, y: number, w: number, h: number, c: C, label: string) => (
  <g style={`--c:var(${c})`}>
    <rect class="dgm-tile-pill" x={x} y={y} width={w} height={h} rx={6} />
    <text class="dgm-tile-op" x={x + w / 2} y={y + h / 2}>
      {label}
    </text>
  </g>
);

const sub = (x: number, y: number, label: string, left = false) => (
  <text class={`dgm-tile-sub${left ? ' is-left' : ''}`} x={x} y={y}>
    {label}
  </text>
);

const VB_W = 640;
const VB_H = 528;

export default function TensixTile() {
  // five core columns: x, label, role, colour
  const cores: [number, string, string, C][] = [
    [24, 'NCRISC', 'data in', '--cat-ml'],
    [144, 'TRISC0', 'unpack', '--cat-tenstorrent'],
    [264, 'TRISC1', 'math', '--cat-hardware'],
    [384, 'TRISC2', 'pack', '--cat-bio'],
    [504, 'BRISC', 'data out', '--cat-gpu'],
  ];

  // SFPU pill columns
  const lrX = [334, 405, 476, 547];
  const lrW = 61;
  const lanes = ['LR0', 'LR1', '⋯', 'LR7'];
  const consts = ['LR8: 0.84', 'LR9: 0', 'LR10: 1', 'LR15: IDs'];

  return (
    <div class="dgm dgm-tile" data-zoomable>
      <svg
        class="dgm-svg"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label="Tensix tile internals: 1.5 MB L1 SRAM with input and output circular buffers, five RISC-V cores (ncrisc, trisc0-2, brisc), and the Tensix coprocessor containing the Dst register, matrix engine (FPU), and SFPU"
      >
        {/* outer container */}
        <rect class="dgm-tile-outer" x={8} y={8} width={624} height={512} rx={10} />
        <text class="dgm-tile-title" x={320} y={29}>
          Tensix Tile
        </text>

        {/* ── L1 SRAM ─────────────────────────────────────────────────────── */}
        {region(16, 42, 608, 130, '--cat-tenstorrent', 'L1 SRAM · 1.5 MB')}
        {cell(24, 70, 290, 30, '--cat-tenstorrent', 'Input CBs (0–15)')}
        {cell(326, 70, 290, 30, '--cat-gpu', 'Output CBs (16–31)')}
        {sub(28, 113, 'ring queues of 32×32 tiles · four 16×16 faces', true)}
        {cell(24, 120, 189, 30, '--cat-bio', 'Kernel Binaries')}
        {cell(225, 120, 189, 30, '--cat-bio', 'Scratchpad / Stack')}
        {cell(426, 120, 189, 30, '--cat-bio', 'Semaphores')}
        {sub(28, 164, '~1.3 MB usable after overhead', true)}

        {/* ── 5 RISC-V cores ──────────────────────────────────────────────── */}
        <g style="--c:var(--cat-misc)">
          <text class="dgm-tile-region-label" x={16} y={193}>
            5 RISC-V cores
          </text>
        </g>
        {cores.map(([x, name, role, c]) => cell(x, 200, 110, 40, c, name, role))}

        {/* ── Tensix coprocessor ──────────────────────────────────────────── */}
        {region(16, 254, 608, 260, '--cat-misc', 'Tensix coprocessor')}
        {pill(24, 280, 592, 26, '--cat-hardware', 'Dst · 1024×16 (16b) / 512×16 (32b)')}

        {/* matrix engine (FPU) */}
        {region(24, 314, 290, 192, '--cat-gpu', 'Matrix Engine (FPU)')}
        {cell(32, 338, 130, 26, '--cat-ml', 'srcA bank 0')}
        {cell(176, 338, 130, 26, '--cat-ml', 'srcB bank 0')}
        {sub(169, 374, 'unpacker fills')}
        {cell(32, 384, 130, 26, '--cat-tenstorrent', 'srcA bank 1')}
        {cell(176, 384, 130, 26, '--cat-tenstorrent', 'srcB bank 1')}
        {sub(169, 420, 'FPU reads')}
        {sub(169, 434, '64×16, 19-bit · SETDVALID swaps')}
        {pill(32, 442, 274, 24, '--cat-gpu', 'MVMUL · ELWADD · ELWMUL · GMPOOL')}
        {sub(169, 480, 'LoFi / HiFi2 / HiFi4 · up to 32,639 MOP @ 1/cyc')}

        {/* SFPU */}
        {region(326, 314, 290, 192, '--cat-bio', 'SFPU')}
        {lanes.map((l, i) => pill(lrX[i], 338, lrW, 26, '--cat-hardware', l))}
        {sub(471, 376, '32 lanes × 32-bit each')}
        {consts.map((l, i) => pill(lrX[i], 386, lrW, 26, '--cat-ml', l))}
        {sub(471, 424, 'LR8–15: constants · 11–14 configurable')}
        {pill(334, 432, 274, 24, '--cat-hardware', 'exp · sin · gelu · sqrt · recip …')}
        {sub(471, 470, '~64× slower than FPU')}
      </svg>

      <p class="dgm-caption">
        Each <b style="color:var(--cat-tenstorrent)">Tensix tile</b> packs 1.5&nbsp;MB of{' '}
        <b style="color:var(--cat-tenstorrent)">L1 SRAM</b> (input/output circular buffers plus
        kernel, scratch and semaphore space), <b>five RISC-V cores</b> —{' '}
        <b style="color:var(--cat-ml)">ncrisc</b> reads, the three{' '}
        <b style="color:var(--cat-tenstorrent)">trisc</b> cores unpack →{' '}
        <b style="color:var(--cat-hardware)">math</b> → pack, and{' '}
        <b style="color:var(--cat-gpu)">brisc</b> writes — and the Tensix coprocessor: a{' '}
        <b style="color:var(--cat-gpu)">matrix engine</b> fed by double-buffered srcA/srcB banks and
        an <b style="color:var(--cat-bio)">SFPU</b> for transcendentals, both writing into the shared{' '}
        <b style="color:var(--cat-hardware)">Dst</b> register.
      </p>
    </div>
  );
}
