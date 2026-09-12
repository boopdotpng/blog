/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import './elwmul.css';
import GapoolExecution from './GapoolExecution';

export interface FpuInstructionProps {
  operation?: 'ELWMUL' | 'GAPOOL';
  scale?: number;
  /** 1024 values in register order: four consecutive 16×16 faces. */
  srcA?: number[];
  /** Omit for x² (SrcB = SrcA). */
  srcB?: number[];
  initialDst?: number;
  dstTile?: number;
  dstFormat?: 'bf16' | 'fp32';
  stepMs?: number;
}
const SIZE = 128;
const sample = Array.from({ length: 1024 }, (_, i) => i % 4);
const fmt = (n: number) => Number.isInteger(n) ? String(n) : Number(n.toPrecision(6)).toString();

/** Equal-area allocation cells, each representing 8 rows × 16 columns. */
export function RegisterChunks({ name, chunks, columns, active, written, allocated, color }: {
  name: string; chunks: number; columns: number; active: number;
  written: (i: number) => boolean; allocated: (i: number) => boolean; color: string;
}) {
  return <svg viewBox={`0 0 ${columns * 14} ${Math.ceil(chunks / columns) * 14}`}
    role="img" aria-label={`${name}: ${chunks} blocks of 128 elements`} style={{ '--reg-color': color }}>
    {Array.from({ length: chunks }, (_, i) => <rect key={i}
      x={(i % columns) * 14 + 1} y={Math.floor(i / columns) * 14 + 1} width="11" height="11" rx="1"
      class={`elw-slot ${allocated(i) ? 'allocated' : ''} ${written(i) ? 'written' : ''} ${active === i ? 'active' : ''}`}>
      <title>{name} block {i}: rows {i * 8}–{i * 8 + 7}{written(i) ? ', accumulated' : allocated(i) ? ', allocated' : ', unused'}</title>
    </rect>)}
  </svg>;
}

function GapoolMatrix({ name, rows, values, color, active, scale }: {
  name: string; rows: number; values: number[]; color: string; active: boolean; scale?: number;
}) {
  return <div class={`gap-matrix ${active ? 'active' : ''}`} style={{ '--reg-color': color }}>
    <div class="elw-label"><b>{name}</b><span>{rows}×16</span></div>
    <svg viewBox={`0 0 512 ${rows * 20}`} role="img" aria-label={`${name}: ${rows} rows by 16 columns`}>
      {values.map((v, i) => {
        const x = (i % 16) * 32;
        const y = Math.floor(i / 16) * 20;
        const fraction = name === 'srcB' && i < 16 && scale === 1 / 1024;
        const label = fmt(v);
        return <g key={i}>
          <rect x={x + .5} y={y + .5} width="31" height="19" rx="1" fill="var(--reg-color)" opacity={v === 0 ? .07 : .22} />
          {fraction ? <>
            <text x={x + 16} y={y + 8} text-anchor="middle" font-size="8">1</text>
            <path d={`M${x + 5},${y + 10}h22`} stroke="currentColor" stroke-width=".5" />
            <text x={x + 16} y={y + 18} text-anchor="middle" font-size="8">1024</text>
          </> : <text x={x + 16} y={y + 13} text-anchor="middle" style={{ fontSize: `${Math.min(12, 46 / label.length)}px` }}>{label}</text>}
          <title>{name}[{Math.floor(i / 16)},{i % 16}] = {v}</title>
        </g>;
      })}
    </svg>
  </div>;
}

function RegisterInstruction({ operation = 'ELWMUL', scale = 1 / 1024, srcA = sample, srcB, initialDst = 0, dstTile = 0, dstFormat = 'bf16', stepMs = 1000 }: FpuInstructionProps) {
  const pooling = operation === 'GAPOOL';
  const setup = 0;
  const instructions = pooling ? 1 : 8;
  const end = setup + instructions * 2;
  if (pooling && srcB) throw new Error('GAPOOL constructs srcB from scale; omit srcB.');
  const b = srcB ?? srcA;
  const tiles = dstFormat === 'bf16' ? 16 : 8;
  if (!(pooling ? [256, 1024].includes(srcA.length) : srcA.length === 1024) || b.length !== srcA.length || ![...srcA, ...b, initialDst].every(Number.isFinite)
      || !Number.isInteger(dstTile) || dstTile < 0 || dstTile >= tiles || !Number.isFinite(stepMs) || stepMs < 100 || !Number.isFinite(scale)) {
    throw new Error('FpuInstruction requires 1024 finite values per source (GAPOOL also accepts 256), a valid dstTile, finite initialDst, and stepMs >= 100.');
  }
  // Each instruction has a read phase, then a committed accumulate phase.
  const [tick, setTick] = useState(0);
  const [passes, setPasses] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    if (!playing || tick >= end) return;
    const timer = window.setTimeout(() => setTick(t => t + 1), stepMs / 2);
    return () => window.clearTimeout(timer);
  }, [playing, tick, stepMs, end]);
  useEffect(() => { if (tick === end) setPlaying(false); }, [tick, end]);
  const computeTick = Math.max(0, tick - setup);
  const chunk = tick === end && !pooling ? selected : Math.min(instructions - 1, Math.floor(Math.max(0, computeTick - 1) / 2));
  const completed = Math.floor(computeTick / 2);
  const sourceActive = (source: number, i: number) => pooling
    ? source ? i === 0 : tick >= setup && Math.floor(i / 2) === chunk
    : i === chunk;
  const destinationValue = (j: number) => {
    if (!pooling) return initialDst + srcA[j] * b[j] * accumulated(Math.floor(j / SIZE));
    if (j >= 16) return initialDst;
    let sum = initialDst;
    for (let block = 0; block < instructions; block++) {
      for (let k = 0; k < 16; k++) sum += srcA[(block * 16 + k) * 16 + j] * scale * accumulated(block);
    }
    return sum;
  };
  const accumulated = (i: number) => passes + (i < completed ? 1 : 0);
  const start = () => {
    if (tick === end) { setPasses(p => p + 1); setTick(0); }
    setPlaying(p => !p);
  };
  return <figure class="dgm elw" aria-label={`${operation} register animation`}>
    <header class="elw-heading"><strong>{operation}</strong><code>{pooling ? 'dst += srcB @ srcA' : 'dst += srcA × srcB'}</code></header>
    <div class="elw-controls">
      <button type="button" onClick={start}>{playing ? 'Pause' : tick === end ? 'Accumulate again' : 'Run'}</button>
      <button type="button" disabled={playing || tick === end} onClick={() => setTick(t => Math.min(end, (Math.floor(t / 2) + 1) * 2))}>Step</button>
      <button type="button" onClick={() => { setPlaying(false); setTick(0); setPasses(0); setSelected(0); }}>Reset</button>
      <span>{pooling && tick < setup ? 'Setup · broadcast srcB[0,0] across row 0' : `${completed}/${instructions} instructions · ${completed * (pooling ? 256 : 128)}/${pooling ? 256 : 1024} elements`}</span>
    </div>
    {pooling ? <div class="gap-single">
      <div class="gap-operands">
        <GapoolMatrix name="srcA" rows={16} values={srcA.slice(0, 256)} color="var(--cat-host)" active={tick === 1} />
        <GapoolMatrix name="srcB" rows={4} values={Array.from({ length: 64 }, (_, i) => i < 16 ? scale : 0)} color="var(--cat-worker)" active={tick === 1} scale={scale} />
      </div>
      <div class="elw-flow" aria-hidden="true">→</div>
      <div class="gap-result">
        <GapoolMatrix name="dst" rows={4} values={Array.from({ length: 64 }, (_, i) => destinationValue(i))} color="var(--cat-green)" active={completed === 1} />
        <small class="elw-note">{completed ? '16 scaled column sums in row 0' : 'Accumulates into row 0; srcB rows 1–3 are zero.'}</small>
      </div>
    </div> : <div class="elw-register-layout">
    <div class="elw-sources">
      {['srcA', 'srcB'].map((name, source) => <div key={name} style={{ '--reg-color': source ? 'var(--cat-worker)' : 'var(--cat-host)' }}>
        <div class="elw-label"><b>{name}</b><span>64 × 16 · {pooling && source ? tick === 0 ? 'scalar in [0,0]; rest zero' : 'row 0 = scale; other rows = 0' : srcA !== sample || srcB ? 'custom' : '0, 1, 2, 3 repeating'}</span></div>
        {pooling && source === 1 && <div class="elw-broadcast">
          <div class="elw-label"><b>{scale === 1 / 1024 ? '1/1024' : fmt(scale)} → row 0</b><span>setup before GAPOOL</span></div>
          <div class="elw-broadcast-row">{Array.from({ length: 16 }, (_, col) => <span key={col}
            class={col === 0 ? 'origin' : tick > 0 ? 'filled' : ''}
            title={`srcB[0,${col}] = ${col === 0 || tick > 0 ? scale : 0}`}>
            {col === 0 || tick > 0 ? (scale === 1 / 1024 ? <span class="elw-fraction"><span>1</span><span>1024</span></span> : fmt(scale)) : '0'}
          </span>)}</div>
        </div>}
        <div class="elw-source-blocks">
          {Array.from({ length: 8 }, (_, i) => {
            const values = source ? b : srcA;
            return <div key={i} class={`elw-block ${sourceActive(source, i) ? 'active' : ''} ${sourceActive(source, i) && tick % 2 ? 'computing' : ''}`}>
              <b>8×16</b><small>{pooling && source ? i === 0 ? 'scale in row 0' : '0' : `${fmt(values[i * SIZE])} … ${fmt(values[(i + 1) * SIZE - 1])}`}</small>
              <span class="elw-mini-grid" aria-hidden="true">{Array.from({ length: 128 }, (_, j) => <i key={j} style={pooling && source ? { opacity: i === 0 && (j === 0 || tick > 0 && j < 16) ? 1 : .08 } : undefined} />)}</span>
            </div>;
          })}
        </div>
      </div>)}
    </div>
    <div class="elw-flow" aria-hidden="true">→</div>
    <div class="elw-destination" style="--reg-color:var(--cat-green)">
      <div class="elw-label"><b>dst</b><span>rows {dstTile * 64}–{dstTile * 64 + 63} of {tiles * 64} · {dstFormat}</span></div>
      <div class="elw-destination-blocks">
        {Array.from({ length: 8 }, (_, i) => {
          const first = i * SIZE;
          const last = (i + 1) * SIZE - 1;
          const value = destinationValue;
          const active = pooling ? i === 0 : chunk === i;
          const written = pooling ? i === 0 && (completed > 0 || passes > 0) : accumulated(i) > 0;
          return <button key={i} type="button" disabled={tick !== end}
            class={`elw-block ${active ? 'active' : ''} ${written ? 'written' : ''}`}
            aria-label={`Destination block ${i}: 8 by 16, first value ${value(first)}, last value ${value(last)}`}
            aria-pressed={active} onClick={() => { if (!pooling) setSelected(i); }}>
            <b>8×16</b>
            <svg class="elw-dst-values" viewBox="0 0 512 144" role="img" aria-label={`128 destination values in block ${i}`}>
              {Array.from({ length: SIZE }, (_, offset) => {
                const v = value(first + offset);
                const label = fmt(v);
                const x = (offset % 16) * 32;
                const y = Math.floor(offset / 16) * 18;
                return <g key={offset}>
                  <rect x={x + .5} y={y + .5} width="31" height="17" rx="1" fill="var(--reg-color)" opacity={written && (!pooling || first + offset < 16) ? .2 : .07} />
                  <text x={x + 16} y={y + 12} text-anchor="middle" style={{ fontSize: `${Math.min(11, 46 / label.length)}px` }}>{label}</text>
                  <title>dst[{dstTile * 64 + i * 8 + Math.floor(offset / 16)}, {offset % 16}] = {v}</title>
                </g>;
              })}
            </svg>
          </button>;
        })}
      </div>
      {pooling && <small class="elw-note">{tick === end ? 'Done · 16 scaled column sums in dst row 0' : 'GAPOOL: 4×16 @ 16×16 → 4×16; row 0 accumulates the scaled column sums.'}</small>}
      <small class="elw-note">1,024 elements allocated. Remaining dst storage omitted; height is schematic.</small>
    </div>
    </div>}
  </figure>;
}

export default function FpuInstruction(props: FpuInstructionProps) {
  return props.operation === 'GAPOOL' ? <GapoolExecution {...props} /> : <RegisterInstruction {...props} />;
}
