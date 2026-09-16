/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import './bf16-phases.css';

const value = 215 / 128;
const exact = value * value;
const highA = 26 / 16;
const highB = 107 / 64;
const bits = '11010111'; // Implied leading 1, followed by the seven stored fraction bits.
let total = 0;
export const phases = [
  { a: highA, b: highB, lowA: false, lowB: false },
  { a: value - highA, b: highB, lowA: true, lowB: false },
  { a: highA, b: value - highB, lowA: false, lowB: true },
  { a: value - highA, b: value - highB, lowA: true, lowB: true },
].map(phase => {
  const before = total;
  const product = phase.a * phase.b;
  total += product;
  return { ...phase, before, product, total, error: (exact - total) / exact * 100 };
});

function BitRow({ source, low, count, selected }: { source: string; low: boolean; count: number; selected: number }) {
  return <div class="bf-phase-source">
    <b>{source}</b>
    <div class="bf-phase-bits" aria-label={`${source}: ${low ? 'low' : 'high'} bits selected, value ${selected}`}>
      {Array.from(bits, (bit, index) => <span key={index}
        class={`${(low ? index >= count : index < count) ? 'selected' : ''} ${index === 0 ? 'implicit' : ''} ${index === count ? 'boundary' : ''}`}>
        {bit}{index === 0 && <i>.</i>}
      </span>)}
    </div>
    <span class="bf-phase-part">{low ? 'low' : 'high'}</span>
  </div>;
}

export default function Bf16Phases() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [changed, setChanged] = useState(false);
  const phase = phases[step];
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      setChanged(true);
      setStep(previous => Math.min(previous + 1, 3));
      if (step >= 2) setPlaying(false);
    }, 2400);
    return () => window.clearTimeout(timer);
  }, [playing, step]);
  const go = (next: number) => { setPlaying(false); setChanged(true); setStep(next); };
  return <figure class="dgm bf-phases" aria-label="Four BF16 fidelity phases: selected bits and accumulated product">
    <p class="bf-phase-example">a = b = <b>1.6796875</b> · exact a × b = <b>{exact}</b></p>
    <div class="bf-phase-controls">
      <button type="button" onClick={() => { if (step === 3) setStep(0); setChanged(true); setPlaying(!playing); }}>{playing ? 'Pause' : step === 3 ? 'Replay' : 'Play'}</button>
      <button type="button" disabled={step === 0} onClick={() => go(step - 1)}>Back</button>
      <button type="button" disabled={step === 3} onClick={() => go(step + 1)}>Step</button>
      <button type="button" onClick={() => go(0)}>Reset</button>
      <span>Phase {step} · {phase.lowA ? 'low' : 'high'} × {phase.lowB ? 'low' : 'high'}</span>
    </div>
    <div class="bf-phase-detail" aria-live={playing ? 'off' : 'polite'} aria-atomic="true">
      <BitRow source="srcA" low={phase.lowA} count={5} selected={phase.a} />
      <BitRow source="srcB" low={phase.lowB} count={7} selected={phase.b} />
      <p class="bf-phase-hint">Highlighted bits keep their place values. Dotted 1 = implicit leading bit.</p>
      <div class={`bf-phase-math ${changed ? 'changed' : ''}`} key={step}>
        <div>{phase.a} × {phase.b} = <strong>{phase.product}</strong></div>
        <div><span>dst</span> {phase.before} + <strong>{phase.product}</strong> = <b>{phase.total}</b></div>
      </div>
    </div>
    <table>
      <thead><tr><th>Phases used</th><th>Running result</th><th>Error</th></tr></thead>
      <tbody>{phases.map((row, i) => <tr key={i} class={i === step ? 'current' : ''} aria-current={i === step ? 'step' : undefined}>
        <td>{i + 1}{i === step && <span aria-hidden="true"> ←</span>}</td><td>{row.total.toFixed(6)}</td><td>{i === 3 ? '0' : row.error.toFixed(3)}%</td>
      </tr>)}</tbody>
    </table>
    <figcaption>Each row includes all phases so far, starting at phase 0. Table values are rounded; error is before output packing. Illustrates the arithmetic, not hardware timing.</figcaption>
  </figure>;
}
