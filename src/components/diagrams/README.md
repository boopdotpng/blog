# Diagram components

## Matmul peak: device dataflow

```mdx
import MatmulPeak from '../../components/diagrams/MatmulPeak.tsx';

<MatmulPeak client:visible />
```

`MatmulPeak` is a fixed snapshot of the BF16 `plan_matmul(5000, 5000, 5000, P100_WORKER_CORES)` defaults in the adjacent `blackhole-py/examples` implementation: 10×11 cores, physical columns 1–7 and 10–13, rows 2–11, 27 K blocks of six tiles, and 504×464 per-core compute extents. It is not a topology detector or cycle simulator. Keep its constants in sync if changing the example described by the accompanying article.

Play/Back/Step/Reset traverse readiness, DRAM reads, A multicast, B multicast, math, and pack. The K-block selector jumps to a panel; Output shows the final writers. Intermediate packs distinguish first store from L1 accumulation; the final block shows partial reload and CB16 output. Playback stops at output. Reduced-motion disables packet travel. Active cores can be selected with a pointer or Enter/Space to inspect logical/physical coordinates, operand roles, output NoC, and logical C bounds.

The grid uses physical positions, but arrows represent dependencies, not physical packet routes. A/B phases are separated for teaching even though hardware overlaps them. Readiness and DRAM arrows show only the selected core/row/column; multicast and compute highlight the full grid. Input values, CB occupancy, packet counts, and hardware timing are not simulated. Small screens scroll the map horizontally while controls and descriptions wrap.
 ## SFPLOAD: one instruction

```mdx
import SfpuLoad from '../../components/diagrams/SfpuLoad.tsx';

<SfpuLoad client:visible />
```

Compact four-row Dst window with even/odd column selection and one 32-lane LReg[0], grouped visually into four sets of eight lanes. Values 0–63 identify source elements; this is a mapping diagram, not a timing or conversion simulation. For lane `i`, the source is `Dst[R + floor(i/8), 2*(i%8) + parity]`, with R aligned to four rows. Effective address bit 1 selects parity; bit 0 is unused. All lanes start enabled; click any of the 32 lane buttons to toggle its predicate, or use All/None. Disabled lanes display “old” for the value preserved from before this instruction, and their source cells are dimmed. This is a preview of one instruction, not a sequence of loads. No column-exchange overrides or destination-index capture. Standard SFPSTORE uses the inverse mapping; load/store conversions and special modes are not identical. Source: local `tt-isa-documentation/BlackholeA0/TensixTile/TensixCoprocessor/{SFPLOAD,SFPSTORE}.md`, cross-lane patterns and functional models.

## SFPU: reduce 32 accumulator lanes

```mdx
import SfpuReduction from '../../components/diagrams/SfpuReduction.tsx';

<SfpuReduction client:visible />
```

Opt-in animation of the reduction in `_rms_finalize_scale`, read from `tens:~/tenstorrent/blackhole-py/examples/llama3.py`. Starts with illustrative partial sums 1–32 already accumulated in L0, then shows every scratch copy, one-position right rotation, and addition for the 4/2/1 row reductions. Row sums are 36, 100, 164, 228. Copies to L1–L3 precede SFPTRANSP; colored rows move across registers, preserving each of the eight columns. Three lane-wise adds leave 528 in all 32 lanes of L0. Stops before mean/epsilon and reciprocal square root. SFPTRANSP also operates on L4–L7 in hardware; that unused register group is omitted.

Play/Pause, Back, Step, Reset/Replay, speed selection, and stage navigation are available. Each cell's hover text lists its original contributions. Register cells are not selectable; row colors identify the contributions through the animation. Reduced-motion preferences disable movement. Registers stack vertically with corresponding lanes aligned; L1 sits directly below the accumulator. L2 and L3 appear at the copy stage. The drawing scales to narrow screens. No autoplay, cycle timing, SFPNOP steps, predication, or FP32 rounding simulation. The model retains contribution identities to verify no input is lost or counted twice. References: `BlackholeA0/.../SFPSHFT2.md` (Mod1=3) and `WormholeB0/.../SFPTRANSP.md` in the local ISA repository (transpose behavior is shared with Blackhole).
