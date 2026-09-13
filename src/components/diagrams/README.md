# FPU instruction MDX diagrams

```mdx
import ElwMul from '../../components/diagrams/ElwMul.tsx';

<ElwMul client:visible />
```

The default loads the same arange(1024) % 4 values (repeating 0, 1, 2, 3) into both sources and accumulates x² into a zeroed BF16 destination tile. Playback is opt-in, stops after eight instructions, and can be paused or stepped. Accumulate again retains the destination; Reset restores `initialDst`. After completion, click any block to inspect its results.

Props: `srcA` and `srcB` (1024 finite numbers each; omit srcB to square srcA), `initialDst` (scalar, default 0), `dstFormat` (`bf16` or `fp32`), `dstTile` (0–15 for BF16, 0–7 for FP32), `stepMs` (default 1000, minimum 100). Values are in register order: four consecutive 16×16 faces, each visited as two 8×16 blocks. Remount the component when replacing its input dataset.

The diagram shows srcA above srcB on the left, each as eight labeled 8×16 blocks with endpoint values and miniature element grids. The destination allocation appears once, vertically on the right, spanning both sources, as eight accumulating blocks, each showing all 128 values in an 8×16 grid. Hover an element for its exact value and destination coordinates. Unused dst storage is omitted; its full row count remains in the label. The same arrangement is retained on narrow screens. Destination height is schematic, not a capacity scale. Click a destination block after completion to inspect its arithmetic. `RegisterChunks` remains exported for other diagrams.

This is a conceptual dataflow visualization, not a cycle/rounding/fidelity simulator. Default inputs yield repeating 0, 1, 4, 9 after the first pass, keeping individual cell values readable. General inputs use JavaScript arithmetic, not hardware rounding, saturation, or mantissa slicing. Broadcast and bank flips are omitted. Each instruction updates a distinct 8×16 destination region; there is no reduction across elements.

Reference: `tt-isa-documentation/WormholeB0/TensixTile/TensixCoprocessor/{ELWMUL,SrcASrcB,Dst}.md` in the adjacent Tenstorrent workspace (the functional model includes Blackhole behavior).


## GAPOOL: one execution

```mdx
import FpuInstruction from '../../components/diagrams/FpuInstruction.tsx';

<FpuInstruction client:visible operation="GAPOOL" scale={1 / 1024}
  dstFormat="fp32"
  srcA={Array.from({ length: 256 }, (_, i) => (i % 4) ** 2)} />
```

GAPOOL displays only the operands of one instruction: 16×16 srcA, 4×16 srcB, and 4×16 dst. `srcA` accepts 256 values, or an existing 1024-value tensor whose first 256 values are shown. srcB is prepared before playback: row 0 contains `scale` (default 1/1024) in all 16 columns; the other three rows are zero. Do not pass `srcB` in GAPOOL mode. There is no broadcast animation or implied GAPOOL broadcast flag.

Run animates the mathematical dot products of one conceptual single-fidelity instruction and stops. This is not hardware execution order or timing. Each column has 16 product steps, a sum step, and a dst accumulation step. GAPOOL defaults to 500 ms per product, with longer pauses around the sum/store; its `stepMs` prop sets the per-product delay. A prominent running sum at the bottom shows the previous sum plus the current product. Step advances one explanatory step; Next column finishes the current column. Accumulate again retains dst; Reset restores `initialDst`. Each output in row 0 receives `scale * sum(srcA[:, column])`; the other rows receive zero. SrcA is unchanged. For the squared repeating example the first-pass output repeats 0, 0.015625, 0.0625, 0.140625. With scale 1/1024, these are partial contributions toward the larger 1024-element mean, not the completed full-tensor reduction.

Reference: GAPOOL.md and MVMUL.md in the adjacent ISA documentation repository. Values use ideal arithmetic, omitting fidelity and hardware rounding. The ElwMul import remains compatible.

## Matmul peak: device dataflow

```mdx
import MatmulPeak from '../../components/diagrams/MatmulPeak.tsx';

<MatmulPeak client:visible />
```

`MatmulPeak` is a fixed snapshot of the BF16 `plan_matmul(5000, 5000, 5000, P100_WORKER_CORES)` defaults in the adjacent `blackhole-py/examples` implementation: 10×11 cores, physical columns 1–7 and 10–13, rows 2–11, 27 K blocks of six tiles, and 504×464 per-core compute extents. It is not a topology detector or cycle simulator. Keep its constants in sync if changing the example described by the accompanying article.

Play/Back/Step/Reset traverse readiness, DRAM reads, A multicast, B multicast, math, and pack. The K-block selector jumps to a panel; Output shows the final writers. Intermediate packs distinguish first store from L1 accumulation; the final block shows partial reload and CB16 output. Playback stops at output. Reduced-motion disables packet travel. Active cores can be selected with a pointer or Enter/Space to inspect logical/physical coordinates, operand roles, output NoC, and logical C bounds.

The grid uses physical positions, but arrows represent dependencies, not physical packet routes. A/B phases are separated for teaching even though hardware overlaps them. Readiness and DRAM arrows show only the selected core/row/column; multicast and compute highlight the full grid. Input values, CB occupancy, packet counts, and hardware timing are not simulated. Small screens scroll the map horizontally while controls and descriptions wrap.
