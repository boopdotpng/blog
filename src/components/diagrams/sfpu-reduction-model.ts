/** Blackhole SFPSHFT2 Mod1=3 and SFPTRANSP, all lanes enabled.
 * Mirrors _rms_finalize_scale in tens:~/tenstorrent/blackhole-py/examples/llama3.py.
 * Provenance is kept with each value so movement and disjoint additions are visible.
 */
export type Cell = { id: number; terms: number[] };
export type Row = { id: number; cells: Cell[] };
export type Frame = {
  registers: (Row[] | null)[];
  phase: number;
  instruction: string;
  description: string;
  target: number;
  kind: 'start' | 'copy' | 'rotate' | 'add' | 'transpose';
  equation?: string;
  source?: number;
};
export const valueOf = (cell: Cell) => cell.terms.reduce((sum, term) => sum + term + 1, 0);

export function reductionFrames(): Frame[] {
  let identity = 0;
  const initial = Array.from({ length: 4 }, (_, row) => ({ id: identity++, cells:
    Array.from({ length: 8 }, (_, col) => ({ id: identity++, terms: [row * 8 + col] })) }));
  let registers: (Row[] | null)[] = [initial, null, null, null];
  const frames: Frame[] = [];
  const emit = (frame: Omit<Frame, 'registers'>) => frames.push({ ...frame, registers: structuredClone(registers) });
  const copy = (source: Row[]) => source.map(row => ({ id: identity++, cells: row.cells.map(cell => ({ id: identity++, terms: [...cell.terms] })) }));
  const add = (other: number, phase: number, description: string) => {
    const left = valueOf(registers[0]![0].cells[0]);
    const right = valueOf(registers[other]![0].cells[0]);
    registers[0] = registers[0]!.map((row, r) => ({ ...row, cells: row.cells.map((cell, c) => ({ ...cell, terms: [...cell.terms, ...registers[other]![r].cells[c].terms].sort((a, b) => a - b) })) }));
    emit({ phase, kind: 'add', target: 0, source: other, instruction: `SFPADD: LReg0 ← LReg0 + LReg${other}`, description, equation: `Lane 0: ${left} + ${right} = ${left + right}` });
  };
  emit({ phase: 0, kind: 'start', target: 0, instruction: 'LReg0: 32 partial sums', description: 'Use 1–32 as example partial sums. Each colored row contains eight lanes of one register.' });
  for (const distance of [4, 2, 1]) {
    registers[1] = copy(registers[0]!);
    emit({ phase: 0, kind: 'copy', target: 1, instruction: 'SFPMOV: LReg1 ← LReg0', description: `Save a scratch copy to rotate right by ${distance}. LReg0 stays in place until the add.` });
    for (let shift = 1; shift <= distance; shift++) {
      registers[1] = registers[1]!.map(row => ({ ...row, cells: [row.cells[7], ...row.cells.slice(0, 7)] }));
      emit({ phase: 0, kind: 'rotate', target: 1, instruction: `SFPSHFT2: rotate LReg1 right by 1 · ${shift}/${distance}`, description: `Rotate within each eight-lane row; the last lane wraps to the first. ${distance > 1 ? `A rotate by ${distance} takes ${distance} one-position instructions.` : 'No values cross between rows.'}` });
    }
    add(1, 0, `Add the rotated copy to LReg0.${distance === 1 ? ' Every lane in a row holds the same row sum.' : ''}`);
  }
  for (const target of [1, 2, 3]) {
    registers[target] = copy(registers[0]!);
    emit({ phase: 1, kind: 'copy', target, instruction: `SFPMOV: LReg${target} ← LReg0`, description: `Copy the four row sums into LReg${target}.${target === 3 ? ' LReg0, LReg1, LReg2, and LReg3 now contain identical copies.' : ' Each row sum is already repeated eight times.'}` });
  }
  const before = registers;
  registers = Array.from({ length: 4 }, (_, register) => Array.from({ length: 4 }, (_, row) => before[row]![register]));
  emit({ phase: 2, kind: 'transpose', target: -1, instruction: 'SFPTRANSP: transpose rows across LReg0–LReg3', description: 'Follow the colors: row j of each source register moves to LRegj. Each register now holds one row sum in all 32 lanes.' });
  for (const other of [1, 2, 3]) add(other, 3, other === 3
    ? 'Done: s = 36 + 100 + 164 + 228 = 528 in every lane of LReg0. The sum is ready for lane-wise arithmetic.'
    : `Add LReg${other} to LReg0 lane by lane. Every lane in LReg0 now includes ${8 * (other + 1)} original partial sums.`);
  return frames;
}
export const frames = reductionFrames();
