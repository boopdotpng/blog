/** @jsxImportSource preact */
import { useEffect, useId, useState } from 'preact/hooks';
import './matmul-peak.css';

// Snapshot of plan_matmul(5000, 5000, 5000, P100_WORKER_CORES), BF16 defaults.
const COLS = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13];
const ROWS = Array.from({ length: 10 }, (_, i) => i + 2);
const BLOCKS = 27, PHASES = 6, END = BLOCKS * PHASES;
const names = ['Reserve + signal ready', 'Read panels from DRAM', 'Share A across rows', 'Share B down columns', 'Unpack + multiply', 'Pack partial sums'];
const xy = (x: number, y: number) => [38 + x * 37, 78 + y * 37];
const aColor = 'var(--cat-host)', bColor = 'var(--cat-worker)', cColor = 'var(--cat-gpu)';

export default function MatmulPeak() {
  const id = useId().replace(/:/g, '');
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<[number, number]>([4, 3]);
  const [ri, ci] = selected;
  const block = Math.min(BLOCKS - 1, Math.floor(tick / PHASES));
  const phase = tick === END ? 6 : tick % PHASES;
  const finalK = block === BLOCKS - 1;
  const phaseName = phase === 6 ? 'Write C to DRAM' : phase === 5 && finalK ? 'Pack final output' : names[phase];
  const outNoc = 1 - ci % 2;
  const [sx, sy] = xy(COLS[ci], ROWS[ri]);
  const [ax] = xy(COLS[0], ROWS[ri]);
  const [, by] = xy(COLS[ci], ROWS[0]);
  useEffect(() => {
    if (!playing) return;
    if (tick === END) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setTick(t => Math.min(END, t + 1)), 1100);
    return () => window.clearTimeout(timer);
  }, [tick, playing]);
  const move = (next: number) => { setPlaying(false); setTick(next); };
  const flows: { x1: number; y1: number; x2: number; y2: number; color: string; dashed?: boolean }[] = [];
  const add = (x1: number, y1: number, x2: number, y2: number, color: string, dashed = false) => flows.push({ x1, y1, x2, y2, color, dashed });
  if (phase === 0) {
    if (ci > 0) add(sx, sy - 7, ax + 15, sy - 7, aColor, true);
    if (ri > 0) add(sx + 7, sy, sx + 7, by + 15, bColor, true);
  } else if (phase === 1) {
    add(115, 32, ax, sy - 15, aColor);
    add(530, 32, sx, by - 15, bColor);
  } else if (phase === 2) {
    for (const y of ROWS) { const [x1, y1] = xy(COLS[0], y); const [x2] = xy(COLS.at(-1)!, y); add(x1 + 15, y1 + 10, x2, y1 + 10, aColor); }
  } else if (phase === 3) {
    for (const x of COLS) { const [x1, y1] = xy(x, ROWS[0]); const [, y2] = xy(x, ROWS.at(-1)!); add(x1 + 10, y1 + 15, x1 + 10, y2, bColor); }
  } else if (phase === 6) add(sx, sy - 15, 330, 32, cColor);
  const explanation = [
    'Each receiver reserves a free input slot, clears its ready flag, then increments its sender’s credit counter. Dashed arrows show the selected core’s credits.',
    'Every row leader reads its A panel on NoC 0; every column leader reads its B panel on NoC 1. Arrows show the selected row and column only.',
    'Each row leader multicasts its A panel to the other 10 cores in its row, using west and east rectangles on NoC 0, then signals data-ready. Receivers publish CB0; the leader keeps its local copy.',
    'Each column leader multicasts its B panel to the other 9 cores in its column on NoC 1. Data is followed by a ready signal; receivers publish their local CB pages.',
    finalK ? 'Each core reloads its accumulated CB24 subblock into dst, then adds the final K contribution. All 110 cores compute their own output blocks.' : 'All 110 cores unpack their local A and B panels and compute 2×4 output subblocks. No output values move between cores.',
    finalK ? 'TRISC2 packs final subblocks into CB16. CB16 and CB24 share the same L1 allocation; ownership changes as the final subblocks are produced.' : block === 0 ? 'TRISC2 stores the first K block’s partial sums in CB24. The next K block can reuse input slots after TRISC0 releases them.' : 'TRISC2 adds this K block’s contribution to the partials already in L1, using packer L1 accumulation. There is no partial-sum DRAM write.',
    'Every NCRISC writes its own C tiles to interleaved DRAM. Even logical columns use NoC 1; odd columns use NoC 0 after A_DONE. Only the selected core’s output arrow is drawn.',
  ][phase];
  return <figure class="dgm mp" aria-label="Matmul peak device dataflow">
    <header><strong>One matmul, 110 cores</strong><span>5000 × 5000 × 5000 · BF16</span></header>
    <div class="mp-controls">
      <button type="button" onClick={() => { if (tick === END) setTick(0); setPlaying(p => !p); }}>{playing ? 'Pause' : tick === END ? 'Replay' : 'Play'}</button>
      <button type="button" disabled={tick === 0} onClick={() => move(tick - 1)}>Back</button>
      <button type="button" disabled={tick === END} onClick={() => move(tick + 1)}>Step</button>
      <button type="button" onClick={() => move(0)}>Reset</button>
      <label>K block <select value={block} onChange={e => move(Number(e.currentTarget.value) * PHASES)}>{Array.from({ length: BLOCKS }, (_, k) => <option key={k} value={k}>{k + 1} / {BLOCKS}</option>)}</select></label>
      <button type="button" onClick={() => move(END)}>Output</button>
    </div>
    <div class="mp-phase" aria-live="polite">{phaseName} <span>· K = {block * 192}…{Math.min(5008, (block + 1) * 192) - 1}</span></div>
    <div class="mp-map-scroll">
      <svg viewBox="0 0 675 514" role="group" aria-label="Physical core grid. Select an active core to inspect its roles.">
        <defs><marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
        <text x="115" y="22" text-anchor="middle" class="mp-dram-label">A in DRAM</text>
        <text x="330" y="22" text-anchor="middle" class="mp-dram-label">C in DRAM</text>
        <text x="530" y="22" text-anchor="middle" class="mp-dram-label">B in DRAM</text>
        {Array.from({ length: 17 }, (_, x) => <text key={x} x={xy(x, 0)[0]} y="52" text-anchor="middle" class="mp-axis">{x}</text>)}
        {Array.from({ length: 12 }, (_, y) => <text key={y} x="10" y={xy(0, y)[1] + 4} class="mp-axis">{y}</text>)}
        {Array.from({ length: 204 }, (_, i) => {
          const x = i % 17, y = Math.floor(i / 17), r = ROWS.indexOf(y), c = COLS.indexOf(x);
          const active = r >= 0 && c >= 0, chosen = active && ri === r && ci === c;
          const dram = x === 0 || x === 9;
          const [cx, cy] = xy(x, y);
          let text = active ? c === 0 && r === 0 ? 'AB' : c === 0 ? 'A' : r === 0 ? 'B' : '·' : dram ? 'D' : '–';
          let color = 'var(--fg-faint)';
          if (active) {
            color = phase === 2 ? aColor : phase === 3 ? bColor : phase >= 4 ? cColor : 'var(--fg-muted)';
            if (phase >= 4) text = phase === 4 ? '×' : phase === 5 ? finalK ? 'C' : 'P' : `N${1 - c % 2}`;
            if (phase === 2) text = c === 0 ? 'A→' : 'A';
            if (phase === 3) text = r === 0 ? 'B↓' : 'B';
          }
          const label = `Physical (${x}, ${y}), logical (${r}, ${c}): A ${c === 0 ? 'sender' : 'receiver'}, B ${r === 0 ? 'sender' : 'receiver'}, output NoC ${1 - c % 2}`;
          return <g key={i} role={active ? 'button' : undefined} tabIndex={active ? 0 : undefined}
            aria-label={active ? label : undefined} aria-pressed={active ? chosen : undefined}
            class={active ? 'mp-core' : 'mp-inactive'} onClick={active ? () => setSelected([r, c]) : undefined}
            onKeyDown={active ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected([r, c]); } } : undefined}>
            <rect x={cx - 15} y={cy - 15} width="30" height="30" rx="3" fill={color} opacity={active ? .15 : .055} />
            <rect x={cx - 15} y={cy - 15} width="30" height="30" rx="3" class="mp-core-outline" fill="none" stroke={chosen ? 'var(--fg)' : 'transparent'} stroke-width="2" />
            <text x={cx} y={cy + 4} text-anchor="middle" class="mp-cell-text">{text}</text>
            <title>{active ? label : dram ? 'DRAM column (schematic ports)' : 'Not selected by this plan'}</title>
          </g>;
        })}
        <g key={tick} class="mp-flows" pointer-events="none">{flows.map((f, i) => <g key={i}>
          <line {...f} stroke={f.color} stroke-width="1.7" stroke-dasharray={f.dashed ? '4 4' : undefined} opacity=".65" marker-end={`url(#${id}-arrow)`} />
          <circle r="3" fill={f.color} class="mp-packet" style={{ '--x1': `${f.x1}px`, '--y1': `${f.y1}px`, '--x2': `${f.x2}px`, '--y2': `${f.y2}px` }} />
        </g>)}</g>
      </svg>
    </div>
    <div class="mp-legend"><span>A: row leader</span><span>B: column leader</span><span>P: L1 partial</span><span>D: DRAM</span><span>–: outside plan</span></div>
    <div class="mp-inspect">
      <strong>Core ({ri}, {ci})</strong> <span>physical ({COLS[ci]}, {ROWS[ri]})</span>
      <div>A {ci === 0 ? 'sender' : `receiver ← ( ${ri}, 0 )`} · B {ri === 0 ? 'sender' : `receiver ← ( 0, ${ci} )`} · output NoC {outNoc}</div>
      <div>C rows {ri * 504}…{Math.min(5000, (ri + 1) * 504) - 1}, columns {ci * 464}…{Math.min(5000, (ci + 1) * 464) - 1}</div>
    </div>
    <p class="mp-explanation">{explanation}</p>
    <figcaption>Physical positions; arrows show data dependencies, not router paths or measured timing. A and B transfers and compute overlap on hardware. Playback is opt-in and stops at output. Select a core to inspect its ownership.</figcaption>
  </figure>;
}
