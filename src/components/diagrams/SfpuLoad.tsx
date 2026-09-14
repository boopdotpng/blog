/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import './elwmul.css';
import './sfpu-load.css';

const rowColors = ['var(--cat-host)', 'var(--cat-worker)', 'var(--cat-green)', 'var(--cat-ml)'];

/** Standard addressing, selectable lane predicate, no column exchange or index capture.
 * ISA: BlackholeA0/TensixTile/TensixCoprocessor/{SFPLOAD,SFPSTORE}.md.
 * Values label the 64 elements of a four-row Dst window, starting at aligned R.
 */
export default function SfpuLoad() {
  const [parity, setParity] = useState(0);
  const [active, setActive] = useState(() => Array<boolean>(32).fill(true));
  const count = active.filter(Boolean).length;
  return <figure class="dgm elw sfp-load" aria-label="One SFPLOAD: four destination rows into one SFPU register">
    <header class="elw-heading"><strong>SFPLOAD</strong><code>4 rows × 8 elements → 1 LReg</code></header>
    <div class="dgm-toolbar">
      <div class="dgm-seg" role="group" aria-label="Columns to load">
        {[0, 1].map(p => <button type="button" key={p} aria-pressed={parity === p} onClick={() => setParity(p)}>{p ? 'Odd columns' : 'Even columns'}</button>)}
      </div>
      <span class="dgm-readout">One instruction · {count}/32 lanes active</span>
    </div>
    <div class="sfp-layout">
      <div>
        <div class="elw-label"><b>dst · 4×16 window</b><span>values 0–63 for illustration</span></div>
        <svg viewBox="0 0 432 134" role="img" aria-label={`Dst rows R through R+3; ${parity ? 'odd' : 'even'} columns selected`}>
          {Array.from({ length: 16 }, (_, col) => <text key={col} class="sfp-axis" x={44 + col * 25} y={11} text-anchor="middle">{col}</text>)}
          {rowColors.map((color, row) => <g key={row}>
            <text class="sfp-axis" x={27} y={39 + row * 29} text-anchor="end">{row ? `R+${row}` : 'R'}</text>
            {Array.from({ length: 16 }, (_, col) => {
              const selected = col % 2 === parity && active[row * 8 + Math.floor(col / 2)];
              return <g key={col}>
                <rect x={32 + col * 25} y={21 + row * 29} width={23} height={26} rx={2} fill={selected ? color : 'var(--surface-soft)'} fill-opacity={selected ? .22 : 1} stroke={selected ? color : 'var(--border-muted)'} stroke-width={.7} />
                <text x={44 + col * 25} y={39 + row * 29} text-anchor="middle" opacity={selected ? 1 : .35}>{row * 16 + col}</text>
                <title>{`dst[R${row ? `+${row}` : ''},${col}] = ${row * 16 + col}${selected ? ` → LReg[0] lane ${row * 8 + Math.floor(col / 2)}` : ' · not loaded'}`}</title>
              </g>;
            })}
          </g>)}
        </svg>
      </div>
      <div class="sfp-arrows" aria-hidden="true">{rowColors.map(color => <span style={{ color }}>→</span>)}</div>
      <div>
        <div class="elw-label"><b>LReg[0]</b><span>one register · 32 lanes</span></div>
        <div class="sfp-lanes" role="group" aria-label="Active SFPU lanes; click to toggle">
          {active.map((enabled, lane) => {
            const row = Math.floor(lane / 8), col = 2 * (lane % 8) + parity;
            return <button type="button" key={lane} aria-pressed={enabled}
              aria-label={`Lane ${lane}: ${enabled ? `active, loads dst[R+${row},${col}]` : 'inactive, preserves old value'}`}
              style={{ '--lane-color': rowColors[row] }}
              onClick={() => setActive(mask => mask.map((value, i) => i === lane ? !value : value))}>
              <small>{lane}</small><b>{enabled ? row * 16 + col : 'old'}</b>
            </button>;
          })}
        </div>
      </div>
    </div>
    <div class="elw-controls sfp-mask-controls">
      <span>Click lanes to set their predicate · lane number above, loaded value below</span>
      <button type="button" onClick={() => setActive(Array<boolean>(32).fill(true))}>All</button>
      <button type="button" onClick={() => setActive(Array<boolean>(32).fill(false))}>None</button>
    </div>
  </figure>;
}
