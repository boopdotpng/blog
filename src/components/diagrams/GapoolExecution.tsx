/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import type { FpuInstructionProps } from './FpuInstruction';

const COLUMNS = 16;
const FRAMES_PER_COLUMN = 18; // 16 products, sum, then dst accumulation.
const END = COLUMNS * FRAMES_PER_COLUMN;
const sample = Array.from({ length: 256 }, (_, i) => i % 4);
const format = (n: number) => String(Number(n.toPrecision(6)));

/** A teaching timeline, not a model of FPU execution order or timing. */
export function gapoolFrame(tick: number, source: number[], scale: number, initialDst: number, passes: number) {
  const column = Math.min(15, Math.floor(Math.max(0, tick - 1) / FRAMES_PER_COLUMN));
  const phase = tick === 0 ? 0 : (tick - 1) % FRAMES_PER_COLUMN + 1;
  const terms = Math.min(16, phase);
  const completed = Math.floor(tick / FRAMES_PER_COLUMN);
  const products = Array.from({ length: 16 }, (_, k) => source[k * 16 + column] * scale);
  const sums = Array.from({ length: 16 }, (_, j) => Array.from({ length: 16 }, (_, k) => source[k * 16 + j] * scale).reduce((a, b) => a + b, 0));
  const dst = Array.from({ length: 64 }, (_, i) => i < 16 ? initialDst + sums[i] * (passes + Number(i < completed)) : initialDst);
  return { column, phase, terms, completed, products, sums, dst, partial: products.slice(0, terms).reduce((a, b) => a + b, 0) };
}

function Matrix({ name, rows, values, color, column, term, written, scale }: {
  name: 'srcA' | 'srcB' | 'dst'; rows: number; values: number[]; color: string;
  column: number; term: number; written?: number; scale?: number;
}) {
  return <div class="gap-matrix" style={{ '--reg-color': color }}>
    <div class="elw-label"><b>{name}</b><span>{rows}×16</span></div>
    <svg viewBox={`0 0 512 ${rows * 20}`} role="img" aria-label={`${name}: ${rows} rows by 16 columns`}>
      {values.map((value, i) => {
        const row = Math.floor(i / 16), col = i % 16;
        const highlighted = name === 'srcA' ? col === column : name === 'srcB' ? row === 0 : row === 0 && col === column;
        const paired = name === 'srcA' ? col === column && row === term : name === 'srcB' ? row === 0 && col === term : false;
        const x = col * 32, y = row * 20;
        return <g key={i} data-value={value}>
          <rect x={x + .5} y={y + .5} width="31" height="19" rx="1" fill="var(--reg-color)"
            opacity={highlighted || (name === 'dst' && row === 0 && col < (written ?? 0)) ? .4 : .08} />
          {(highlighted || paired) && <rect x={x + 1} y={y + 1} width="30" height="18" rx="1" fill="none"
            stroke={paired ? 'var(--fg)' : 'var(--reg-color)'} stroke-width={paired ? 2 : .8} />}
          {name === 'srcB' && row === 0 && scale === 1 / 1024 ? <>
            <text x={x + 16} y={y + 8} text-anchor="middle" font-size="8">1</text>
            <path d={`M${x + 5},${y + 10}h22`} stroke="currentColor" stroke-width=".5" />
            <text x={x + 16} y={y + 18} text-anchor="middle" font-size="8">1024</text>
          </> : <text x={x + 16} y={y + 13} text-anchor="middle" style={{ fontSize: `${Math.min(12, 46 / format(value).length)}px` }}>{format(value)}</text>}
          <title>{name}[{row},{col}] = {value}</title>
        </g>;
      })}
    </svg>
  </div>;
}

export default function GapoolExecution({ srcA = sample, srcB, scale = 1 / 1024, initialDst = 0, stepMs = 500 }: FpuInstructionProps) {
  if (srcB || ![256, 1024].includes(srcA.length) || !srcA.every(Number.isFinite) || !Number.isFinite(scale) || !Number.isFinite(initialDst) || !Number.isFinite(stepMs) || stepMs < 100) {
    throw new Error('GAPOOL requires 256 or 1024 finite srcA values, finite scale/initialDst, stepMs >= 100, and no srcB override.');
  }
  const [tick, setTick] = useState(0);
  const [passes, setPasses] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frame = gapoolFrame(tick, srcA, scale, initialDst, passes);
  const { column, phase, terms, completed, products, sums, dst, partial } = frame;
  useEffect(() => {
    if (!playing || tick === END) return;
    const timer = window.setTimeout(() => setTick(t => t + 1), phase >= 16 ? stepMs * 2 : stepMs);
    return () => window.clearTimeout(timer);
  }, [playing, tick, stepMs, phase]);
  useEffect(() => { if (tick === END) setPlaying(false); }, [tick]);
  const run = () => {
    if (tick === END) { setPasses(p => p + 1); setTick(0); }
    setPlaying(p => !p);
  };
  const weight = scale === 1 / 1024 ? '1/1024' : format(scale);
  return <figure class="dgm elw" aria-label="GAPOOL register animation">
    <header class="elw-heading"><strong>GAPOOL</strong><code>dst += srcB @ srcA</code></header>
    <div class="elw-controls">
      <button type="button" onClick={run}>{playing ? 'Pause' : tick === END ? 'Accumulate again' : 'Run'}</button>
      <button type="button" disabled={playing || tick === END} onClick={() => setTick(t => t + 1)}>Step</button>
      <button type="button" disabled={playing || tick === END} onClick={() => setTick(t => Math.min(END, (Math.floor(t / 18) + 1) * 18))}>Next column</button>
      <button type="button" onClick={() => { setTick(0); setPasses(0); setPlaying(false); }}>Reset</button>
      <span>One instruction · {completed}/16 column sums</span>
    </div>
    <p class="elw-note gap-timing">Dot products shown sequentially to explain the math—not hardware cycles or separate instructions.</p>
    <div class="gap-single">
      <div class="gap-operands">
        <Matrix name="srcA" rows={16} values={srcA.slice(0, 256)} color="var(--cat-host)" column={column} term={phase > 0 && phase <= 16 ? terms - 1 : -1} />
        <Matrix name="srcB" rows={4} values={Array.from({ length: 64 }, (_, i) => i < 16 ? scale : 0)} color="var(--cat-worker)" column={column} term={phase > 0 && phase <= 16 ? terms - 1 : -1} scale={scale} />
      </div>
      <div class="elw-flow" aria-hidden="true">→</div>
      <div class="gap-result">
        <Matrix name="dst" rows={4} values={dst} color="var(--cat-green)" column={column} term={-1} written={completed} />
        <small class="elw-note">srcB row 0 · srcA column {column} → dst[0,{column}]</small>
      </div>
    </div>
    <div class="gap-dot-product">
      <div class="elw-label"><b>Row × column</b><span>{terms}/16 products</span></div>
      <div class="gap-products">{products.map((product, k) => <div key={k} class={`${k < terms ? 'included' : ''} ${phase <= 16 && k === terms - 1 ? 'current' : ''}`}>
        <span>{weight} × {format(srcA[k * 16 + column])}</span><b>{k < terms ? format(product) : '·'}</b>
      </div>)}</div>
      <small class="elw-note">The other three srcB rows are zero, so they add zero to dst rows 1–3.</small>
      <div class="gap-sum">
        <div class="gap-sum-label">Running sum · column {column} · {terms}/16 products</div>
        <div class="gap-sum-total">{Number(partial.toPrecision(12))}</div>
        <div class="gap-sum-addition">{phase === 0 ? 'Starts at 0 for each column.' : phase <= 16
          ? `${Number(products.slice(0, terms - 1).reduce((a, b) => a + b, 0).toPrecision(12))} + ${Number(products[terms - 1].toPrecision(12))} = ${Number(partial.toPrecision(12))}`
          : `dst[0,${column}] = ${format(initialDst + passes * sums[column])} + ${format(sums[column])} = ${format(initialDst + (passes + 1) * sums[column])}${phase === 18 ? ' · stored' : ' · accumulate'}`}</div>
      </div>
    </div>
  </figure>;
}
