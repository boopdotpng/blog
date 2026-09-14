/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { frames, valueOf } from './sfpu-reduction-model';
import './elwmul.css';
import './sfpu-reduction.css';

const colors = ['var(--cat-host)', 'var(--cat-worker)', 'var(--cat-green)', 'var(--cat-ml)'];
const phases = ['Reduce rows', 'Copy', 'Transpose', 'Add rows'];
const starts = phases.map((_, phase) => frames.findIndex(frame => frame.phase === phase));
const position = (register: number, row: number) => ({ x: 16, y: register * 156 + 36 + row * 26 });

export default function SfpuReduction() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1400);
  const [motion, setMotion] = useState(false);
  const frame = frames[step];
  const finished = step === frames.length - 1;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (step < frames.length - 1) { setMotion(true); setStep(step + 1); }
      if (step >= frames.length - 2) setPlaying(false);
    }, speed);
    return () => window.clearTimeout(timer);
  }, [playing, step, speed]);
  const go = (next: number, animate = false) => { setPlaying(false); setMotion(animate); setStep(next); };
  const previous = frames[Math.max(0, step - 1)];
  const rows = frame.registers.flatMap((register, reg) => (register ?? []).map((row, r) => ({ row, reg, r })));
  const count = frame.registers[0]![0].cells[0].terms.length;

  return <figure class={`dgm elw sfp-reduce ${motion ? 'sfp-reduce-motion' : ''}`} aria-label="Animated reduction of 32 SFPU accumulator lanes">
    <header class="elw-heading"><strong>Summing an LReg</strong><code>32 partial sums → broadcast s</code></header>
    <nav class="dgm-toolbar" aria-label="Reduction stages">
      <div class="dgm-seg">{phases.map((name, phase) => <button type="button" key={name} aria-pressed={frame.phase === phase} onClick={() => go(starts[phase])}>{name}</button>)}</div>
    </nav>
    <div class="sfp-reduce-status" aria-live={playing ? 'off' : 'polite'}>
      <strong>{frame.instruction}</strong><p>{frame.description}</p>
    </div>
    <div class="sfp-reduce-scroll">
      <svg viewBox={`0 0 480 ${frame.phase === 0 ? 312 : 624}`} role="img" aria-label={`${frame.instruction}. ${frame.description}`}>
        {(frame.phase === 0 ? [0, 1] : [0, 1, 2, 3]).map(reg => {
          const x = 0, y = reg * 156;
          return <g key={reg}>
            <rect class={`sfp-register ${frame.target === reg || frame.kind === 'transpose' ? 'active' : ''}`} x={x + 4} y={y + 4} width={468} height={144} rx={5} />
            <text class="sfp-reg-name" x={x + 16} y={y + 23}>{`LReg${reg}`}</text>
            <text class="sfp-reg-note" x={x + 452} y={y + 23} text-anchor="end">{reg === 0 ? (finished ? 's · all 32 lanes' : `${count} ${count === 1 ? 'input' : 'inputs'} / lane`) : reg === 1 && frame.phase === 0 ? 'scratch · rotated copy' : '4 rows × 8 lanes'}</text>
            {Array.from({ length: 32 }, (_, lane) => <rect key={lane} class="sfp-empty-cell" x={x + 16 + lane % 8 * 56} y={y + 36 + Math.floor(lane / 8) * 26} width={52} height={22} rx={2} />)}
            {!frame.registers[reg] && <text class="sfp-unused" x={x + 240} y={y + 93} text-anchor="middle">not used yet</text>}
          </g>;
        })}
        {rows.map(({ row, reg, r }) => {
          const pos = position(reg, r);
          return <g key={row.id} class="sfp-moving-row" style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}>
            {row.cells.map((cell, col) => {
              const originalRow = Math.floor(cell.terms[0] / 8);
              const mixed = cell.terms.some(term => Math.floor(term / 8) !== originalRow);
              const wrap = motion && frame.kind === 'rotate' && reg === 1 && col === 0;
              return <g key={cell.id} class={`sfp-moving-cell ${wrap ? 'sfp-wrap' : ''}`} style={{ transform: `translate(${col * 56}px, 0px)`, '--row-color': mixed ? 'var(--accent)' : colors[originalRow] }}>
                <rect class="sfp-value-cell" width={52} height={22} rx={2} />
                <text class="sfp-value" x={26} y={16}>{valueOf(cell)}</text>
                <title>{`LReg${reg}, lane ${r * 8 + col}: ${cell.terms.map(term => term + 1).join(' + ')} = ${valueOf(cell)}`}</title>
              </g>;
            })}
          </g>;
        })}
        {motion && frame.kind === 'add' && frame.source !== undefined &&
          <g key={`add-${step}`} class="sfp-add-flow" aria-hidden="true" style={{ '--sum-distance': `${-frame.source * 156}px` }}>
            {previous.registers[frame.source]!.flatMap((row, r) => row.cells.map((cell, col) => {
              const pos = position(frame.source!, r);
              return <g key={cell.id} transform={`translate(${pos.x + col * 56}, ${pos.y})`} style={{ '--row-color': colors[Math.floor(cell.terms[0] / 8)] }}>
                <rect class="sfp-value-cell" width={52} height={22} rx={2} />
                <text class="sfp-value" x={26} y={16}>+{valueOf(cell)}</text>
              </g>;
            }))}
          </g>}
      </svg>
    </div>
    <div class="elw-controls">
      <button type="button" onClick={() => { if (finished) { setMotion(false); setStep(0); } setPlaying(!playing); }}>{playing ? 'Pause' : finished ? 'Replay' : 'Play'}</button>
      <button type="button" disabled={step === 0} onClick={() => go(step - 1)}>Back</button>
      <button type="button" disabled={finished} onClick={() => go(step + 1, true)}>Step</button>
      <button type="button" onClick={() => go(0)}>Reset</button>
      <label class="sfp-speed">Speed <select value={speed} onChange={event => setSpeed(Number(event.currentTarget.value))}><option value={2200}>Slow</option><option value={1400}>Normal</option><option value={850}>Fast</option></select></label>
      <span>{step} / {frames.length - 1}</span>
    </div>
    <figcaption class="elw-note">Values 1–32 stand in for the accumulated sums in LReg0. All lanes are active. Hover a value to see its contributions. Movement is slowed down; SFPNOPs and hardware timing are omitted.</figcaption>
  </figure>;
}
