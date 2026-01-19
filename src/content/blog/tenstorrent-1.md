---
title: "tenstorrent blackhole update 1"
pubDate: "2026-01-09"
published: false 
description: "claude fill this in later"
cat: "hardware"
---

I bought a Tenstorrent p100a Blackhole. The idea of having a fully open source toolchain, from the kernel mode driver to the software stack that runs the models, is super exciting. Some parts of the card (like the firmware binaries) aren't open source because of 3rd party IP, but this is pretty much the gold standard (more about the firmware disassembly later).

**The most important repos**

1. **Firmware images / bring-up notes** — `tt-firmware`
2. **Hardware debug tooling (bring-up / deep debug)** — `tt-exalens`
3. **More hardware debug tooling** -- `luwen`
4. **Firmware flashing utility** — `tt-flash`
5. **Kernel-mode driver (Linux device access plumbing)** — `tt-kmd`
6. **User-mode driver (host API layer above KMD)** — `tt-umd`
7. **ISA documentation (low-level correctness reference)** — `tt-isa-documentation`
8. **Tensix SFPI toolchain bits (kernel toolchain ecosystem)** — `sfpi`
9. **Low-level kernels (LLK building blocks + dataflow)** — `tt-llk`
10. **Runtime + kernel authoring entrypoint (TT-Metalium + TTNN examples)** — `tt-metal`

## UT3G experience

I connected the card via a UT3G USB4 >-> PCIe4x4 adapter. It worked, and I was able to flash the latest firmware using tt-flash. tt-kmd, tt-smi, and tt-umd built and installed without a problem. tt-exalens also worked! 

One quirk about their build process: they hardcoded `clang-17` in their repos. It's very difficult to install a 2 year old compiler toolchain without building it from source. To get past this, you can set CMAKE_CXX_COMPILER or modify the `cmake` build script to point to the version of clang you have installed.

However, this is much more difficult to do for tt-metal. You have to find and replace `clang-17` with `clang-21` in at least 8 different places because of the way the CPM package management is done and how the `build_metal.sh` script is written. You're probably better off just asking Claude to do it. 

```bash
~/tenstorrent/tt-metal $ find . | rg CMakeLists.txt | wc -l
955
```

After it built, I ran the simplest possible test: 

```py 
import ttnn
dev = ttnn.open_device(device_id=0)

Traceback (most recent call last): File "<python-input-2>", line 1, in <module> device = ttnn.open_device(device_id=0) 
RuntimeError: TT_THROW @ /home/boop/tenstorrent/tt-metal/tt_metal/third_party/umd/device/pcie/pci_device.cpp:527: 
tt::exception info: Failed to pin pages for DMA buffer at virtual address 0x7fcc08000000 with size 0x40000000 and flags 0x2: Invalid argument
```

And in dmesg: 
```bash
tenstorrent: discontiguous mapping
# spammed over and over
```

Since I didn't know too much about how the card worked at this point, I went out and built the cheapest possible new PC so I could get the card working instead of troubleshooting weird UT3G-specific errors.  

I now know that it's actually possible to use the card over a UT3G adapter. 

## device firmware and startup

The firmware bundle (`latest.fwbundle`) is just an archive that contains firmware for all cards and variants. Every card has a `image.bin` (ascii text with very long lines) and `mask.json` that tells tt-flash what to preserve when writing the firmware. Firmware flashing is done over a low-level SPI interface (you can see some of this in `luwen`). `image.bin` contains the following components: 

**Binaries:**
- cmfw (ARC bootloader): exec=1, copied to 0x10000000. This is Zephyr + MCUBoot. 
- mainimg / safeimg: MCUBoot containers, ARC App images (payloads are for the Arc HS38 processor). Safeimg is a fallback image in case the mainimg fails to load. 
- maintail / safetail: Fixed `0x1000`-byte regions right after each MCUBoot image where the bootloader stores state about that image. Contains a magic marker, image_ok, and some other information. I don't know too much about this region. 
- bmfw / dmfwimg: MCUBoot-wrapped Cortex-M firmware (little-endian/thumb). `blupdate` is the Cortex-M updater. 
- ethfw, memfw: RISC-V (baby risc-v) tile firmware. 

**Config/metadata:**

- Boardcfg (protobuf): board and vendor info, other misc stuff
- cmfwcfg (protobuf): chip harvesting, chip limits, tdp limit, voltage, fan_table, ethernet disable mask, etc
- origcfg (protobuf): same fields as cmfwcfg 
- flshinfo (protobuf): currently empty 

Not protobuf: 
- pci0_property_table: bar sizes, mode, other PCIe info 
- ethfwcfg / memfwcfg: raw u32 little endian arrays 
- ethsdreg: register init script, (addr, val) u32 pairs 

The only firmware I've disassembled so far is dmfwimg:
- ARM Cortex-M/thumb little endian 
- Base address for payload: 0x08010000

There's a vector table at the start of the payload -- entry 0 (`0x20003710`) is the sp, and entry 1 (`0x08012E25`) is the reset pointer, where execution starts. 

I tried tracing the i2c calls to the MAX6639 PWM fan controller by looking at the [header file](https://docs.tenstorrent.com/tt-zephyr-platforms/doxygen/max6639_8h.html), which contains the i2c device address and the registers used to change temperature, set fan curve, etc. The registers that set the duty cycle (channel 1 and 2) are `0x26` and `0x27`, and the temperature is read from `0x06` and `0x07`. The tachometer is register `0x21`. Roughly: 

The init functions, which set config registers and initial state for the MAX6639,are `FUN_080147bc`, `FUN_08014a60`, and `FUN_0801494c` (this one is more of a gpio init). 

The temperature value and current PWM state are read in `FUN_0801c486`. This reads like a switch/case that chooses which register to read from; options include temperature, duty cycle CH1, duty cycle CH2, and the tach. 

The register reads happen in `FUN_0801c450`. 

The PWM duty cycle write is `FUN_0801b064`. 
```asm
   0801b064 7f b5      push    {r0,r1,r2,r3,r4,r5,r6,lr}
   0801b066 0c 00      movs    r4,r1
   0801b068 11 00      movs    r1,r2
   0801b06a 00 2c      cmp     r4,#0x0
   0801b06c 05 d0      beq     LAB_0801b07a
   0801b06e 27 22      movs    r2,#0x27 ; register for pwm channel 2
   0801b070 01 2c      cmp     r4,#0x1
   0801b072 03 d0      beq     LAB_0801b07c
   0801b074 16 20      movs    r0,#0x16
   0801b076 40 42      rsbs    r0,r0
   0801b078 19 e0      b       LAB_0801b0ae

  LAB_0801b07a                      XREF[1]: 0801b06c(j)  
   0801b07a 26 22      movs    r2,#0x26 ; register for pwm channel 1
```

With a little more diassembly work and a closer look, I think I can eventually figure this out. I'm not very good at reverse-engineering / Ghidra. 

I realized after doing all of this that there was a `fan_table` config in the firmware. You might have noticed it too! This looked like a 2-point linear fan curve to me, so I changed the values in the firmware bundle, and flashed the new image. Unfortunately, this broke my card. I had to re-flash with `tt-flash latest.fwbundle --force` to overwrite all fields and hard reset.

The firmware definitely writes a raw PWM value to the MAX6639, and the interface exists. There's no userspace way to control the fan speed. 

I'm determined to figure this out. My tenstorrent computer has been banished to the closet because it's so loud. Apparently Ghidra has an emulator, I'll give that a shot for part 2. 

**rough startup process**: 
1. BootROM reads BootFS table at SPI `0x0`, finds cmfw. 
2. BootROM copies cmfw to ARC tile sram at `0x1000_0000` and jumps. 
3. cmfw (mcuboot + zephyr) valides/chooses mainimg vs safeimg, copies the payload into ARC sram at `0x1001_0000`, then transfers control. 
4. ARC app (mainimg) brings up the chip using the protobuf configs (boardcfg, etc). 
5. Tile controllers are loaded with ethfw/memfw and SerDes data. 

## hardware: Everything is tile.

<img src="/images/blackhole-noc.png">

D tiles are dram, ARC is the ARC tile mentioned in the firmware, T tiles are Tensix tiles (these are responsible for the compute), and E tiles are ethernet tiles. 

All Tensors are represented as 32x32 tiles of elements. 

### arc tile (1) 

This tile reports fan speed and harvesting information. On p100a, a subset of the tiles are disabled. This is unique board, so we need to know which tiles are disabled in software. Not too sure what else happens here, it's not used too much. 

### dram tiles (21 on p100a, 24 on p150)

On p100a, the 28GB (one bank disabled) of GDDR6 is split up in banks, 4GB each. Every 4GB bank gets three dram tiles. I'm not sure why there are three dram tiles per bank, as usually you just choose one worker tile per bank and use that to issue DRAM writes and reads. `tt-metal` even does this. Using two dram tiles at once (on the same bank) isn't possible because those requests would ultimately hit the same GDDR6 controller. So in practice, you only end up using one tile per bank. 

### tensix tile (120 on p100a, 140 on p150)
This tile is responsible for *all* of the compute on the card. Inside each Tensix tile there are **5** baby RISC-V cores, a Tensix coprocessor, and 1.5KB of L1 memory. Unlike a L1 cache, this memory is stable -- you explicitly write to this memory, and it persists until you overwrite it. 

There are also 32 CBs (circular buffers) in each tile. Think of these like a fixed-size queue (you choose size in the kernel launch, but it has to fit in L1) that you can push tiles (32x32 elements) into. CBs 0-15 are used as input, the rest are output. 

Ncrisc: Reads from global memory, pushes a tile into the CB. 

trisc0: "Unpacks" tile and copies to the compute engine's register memory. 

trisc1: Sends ops to the compute engine (tensix coprocessor) to do the actual compute on the tile.

trisc2: "Packs" tile and copies from the compute engine's registers into the output CB. 

brisc: Pops tiles from output CB back to global memory. 

> Note: Ncrisc and brisc are commonly interchanged in tt-metal, but above is the most common convention.

```
Host memory -> global memory -> per-tile Circular Buffer (CB) in tile "L1" memory (1.5KB) -> baby risc-v registers -> L1 (CB) -> global memory
```

The `ncrisc` core copies memory from global memory into the CB in L1. Then, `trisc0` (unpack) copies from l1 into the compute engine. `trisc1` orchestrates the compute by sending ops to the Tensix coprocessor. `trisc2` (pack) copies the finished data back into L1. Finally, `brisc` copies data from L1 back to global memory. 

#### tensix coprocessor
This is a fully custom coprocessor built by Tenstorrent. It has its own instructions, op-set, and compiler. If you disassemble the TRISC2 ELF, you'll see instructions that start with `tt` that are sent to the coprocessor by the `trisc1` core. The instruction set and behavior is partially documented in `tt-isa-documentation`. Most of the throughput comes from here. 

The docs for Blackhole aren't updated, but it's safe to assume this hasn't changed too much since Wormhole. 

Inside: 
- A matrix engine (FPU) that consumes SrcA / SrcB and accumulates into Dst
- a SIMD vector engine (SFPU) that does 32-lane fp32/int32-ish operations, by streaming vectors through Lreg and writing Dst. 
- Unpack/pack engines that move tiles between l1 CBs and the coprocessor
- Hardware address counters (RWCs for math/SFPU, ADCs for pack/unpack) so instructions can "auto-walk" the correct rows.

**Register files**
SrcA and SrcB are like staging SRAMs for the matrix engine. The shape is 2 banks * 64 rows * 16 columns * 19-bit data. One bank can be filled by an unpacker, while the other is consumed by the matrix unit. A bank has an `AllowedClient` (unpackers vs matri unit); instructions will stall if the wrong unit tries to use it. 

The SIMD engine operates on `float LReg[17][32]`. 17 lanes, 32 32-bit values per lane. `SFPLOAD` loads values from Dst to `LReg`, and `SFPSTORE` stores values from `LReg` to Dst. For non-matrix ops, the input and output data are both stored in Dst. Triscs move tiles to and from Dst. It distinguishes from 16-bit vs 32-bit mode not by disabling the top half of each lane, but by how Dst is viewed when the kernel is setup.

Dst is `uint16_t DstBits[1024][16]` if viewed as `Dst16b` and `512x16` if viewed as `Dst32b`. All operations (matrix and simd) write into the dst register so that the last trisc core can copy that data back into L1. 

### l2cpu (16)
You can technically run linux on these cores! Not sure why these exist or what the purpose is, but they're effectively dead space to anyone doing ML on this card. They're probably very good RISC-V cores, but I see no purpose and no easy way to use them.

## NoC
This is a communication layer that connects every single Tensix tile. You can use this to write to tiles, read from tiles, and tiles can use this to communicate with other tiles. There are two NoCs, each running in the opposite direction: noc0 has origin at top left and can travel only down and right, noc1 has origin at the bottom right and can travel only up and left. All communication with the card happens through the NoC. You can use noc0 and noc1 at the same time (usually noc0 is used for inbound writes, and noc1 is used for outbound writes). 

Tiles can be accessed by their coordinate (x,y). On the p150b (the full card) there are 17 columns and 12 rows. 

The NoC has two modes, unicast and multicast. Multicast is useful when you have to issue the same writes to many tiles (when uploading firmware, for example). You specify a rect that you want to write to, and your writes are mirrored across all the tiles. For obvious reasons, you cannot multicast reads. Unicast just accesses one tile. 

### harvesting
p100a has 2 columns of Tensix tiles and 1 bank of dram tiles fused off, but the exact coordinates of the disabled tiles vary from board to board. For example, on my p100a: 

```bash
dev: harvesting(tensix=(6, 15), dram=3, eth=disabled)
```

Tensix tiles in columns 6 and 15 and the 3rd dram bank are fused off. p100a also does not have ethernet. 

Since writes and reads to invalid tiles is undefined behavior, your software has to be aware of the harvesting data on your card. On a p150b, your multicast rectangles (for writing to all Tensix tiles) will be `(1,2), (7,11)` and `(10,2), (16,11)`. However, if you try this on a p100a, your multicast will hit tiles in non-existent columns. The rect needs to be split up further. 

## the current software situation
```bash
~ $ du -sh tenstorrent/
32G     tenstorrent/
```

`tt-kmd`: lightweight kernel driver. It exposes some sensor telemetry (read-only, unfortunately) and some basic ioctls. This was super easy to read through and understand. 

`tt-umd`: mostly used by `tt-metal` as an abstraction for reading hardware registers and getting data on the device. For example, `tt-metal` uses `tt-umd` to get the harvesting data for the chip. tt-umd also has python bindings that are used by other repos.

`sfpi`: This is the custom op / instruction set used by the tensix coprocessor. It overloads traditional C++ math operations so that their compiler can lower nice-looking C++ vector / scalar math into SFPU ops. 

`tt-llk`: Low level kernels. Pre-built microkernels for ~70% of ops, written in SFPU or lowered to SFPU by the compiler. 

`tt-metal`: Launching kernels, command queue submission, sync, caching, device orchestration, etc. You can write kernels in C++ here. This is the codebase I've read the most.

`ttnn`: Python bindings over `tt-metal`. Sort of works, but it's very tedious to use. It's PyTorch interop (ish). You create tensors on torch, convert them to ttnn tensors, and then convert them back to torch. And it only supports bf16.

They don't have a compiler. There's essentially a fixed number of kernels that run on the device. There's a matmul kernel, a kernel to unary_add, a kernel to reduce, etc. Kernels in tt-metal are made up of these lower level ops. I don't believe in this strategy whatsoever. If a researcher wants to program a weird function, they only get what exists in the library already. If nothing exists, they are forced to drop down to writing raw SFPI. It's also not maintainable. There are over 100,000 lines of code in `tt-llk`. There are insanely specific kernels for different data types, formats, tile shapes, broadcast/reduce dims, etc. This is not sustainable long term. 

tt-metal is very hard to read. Codex often has to spend 10 minutes just reading files before it can figure out what a function or line of code is doing. I gave up reading this repository manually after the first day. 

In the pursuit of simplicity, I want to remove as many dependencies as possible when I write my python driver. 
- No tt-llk inside compute kernels
- Use only the kernel driver to program the device
- Use only the compiler and toolchain from tt-metal. I don't think I can replace this any time soon.
- Ideally no Python dependencies

### anatomy of a tenstorrent kernel

Every "op" is actually made up of 5 kernels (you only explicitly write 3). A dataflow kernel that copies memory from global memory to each core's L1, the 3 trisc compute kernels (you only write one), and another dataflow kernel that copies data from L1 to global memory. The convention in tt-metal is to use the ncrisc core for data in and brisc for data out. These use separate NoCs to increase bandwidth. 

With that said, here's the simplest possible 3-set of tt-metal kernels that adds 1 to an array of 65,536 `f16` values stored in dram. The long-term goal is to autogenerate these types of kernels based on a tinygrad's IR (a graph of Ops). There is a little extra complexity because you have to write three separate kernels for one operation, but the kernels themselves are short. Most of this code is boilerplate -- the actual compute part is only a few lines. 

This example kernel runs on *one* Tensix tile (core). That one core is responsible for processing all 64 input tiles. If you wanted to run this on 64 cores there would be no inner loop, because every core would process exactly one tile of the input. 

Dataflow in (global memory push to CB):
```cpp
#include <cstdint>

void kernel_main() {
  // global address to the dram buffer containing values
  uint32_t in0_addr = get_arg_val<uint32_t>(0);
  // number of tiles to process: 65536 / (32*32) tilesize = 64
  uint32_t n_tiles = get_arg_val<uint32_t>(1);

  // use Cb 0 for input (0-15)
  constexpr uint32_t cb_in0 = tt::CBIndex::c_0;
  // size of one tile in the CB, this can change with datatype
  const uint32_t tile_size_bytes = get_tile_size(cb_in0);

  // resolve dram address to noc read address 
  // tile has to read dram using the noc
  const InterleavedAddrGenFast<true> in0 = {
    .bank_base_address = in0_addr, // base addr
    .page_size = tile_size_bytes, // bytes per tile
    .data_format = DataFormat::Float16,
  };

  // one core has to iterate through all tiles
  for (uint32_t i = 0; i < n_tiles; ++i) {
    // reserve space for 1 tile in CB 
    cb_reserve_back(cb_in0, 1);
    // l1 write address for c0 
    uint32_t cb_in0_addr = get_write_ptr(cb_in0);

    // read tile from dram
    noc_async_read_tile(i, in0, cb_in0_addr);
    // wait until read is done
    noc_async_read_barrier();

    // push tile to CB
    cb_push_back(cb_in0, 1);
  }
}
```

Each trisc core (in charge of compute) runs a different kernel, but fortunately for you, you only have to write one! Instead, you have to guard the SFPI instructions (the coprocessor ops) behind `TRISC_MATH` so that the compiler only compiles that code for `trisc1`, which is responsible for dispatching MATH ops to the Tensix processor. Inside the `TRISC_MATH` section, you can see what SFPI (C++ interface for the SFPU) looks like.

tt-metal tries to hide which core runs what operations (except the compute) so you can write fairly sane looking functoins. They define macros called `PACK()`, `UNPACK()`, and `MATH()` that tell the compiler which functions should be compiled for which core. When tt-metal builds the "trisc" kernel, it's actually compiling your code three times. 

```cpp
#include <cstdint>

#include "compute_kernel_api/common.h"
#include "compute_kernel_api/tile_move_copy.h"

#ifdef TRISC_MATH
  #include "sfpi.h"
#endif

namespace NAMESPACE { // more quirky tt-metal stuff, injects a macro namespace

void MAIN { // compiler defines find-replace for real main 
  uint32_t n_tiles = get_arg_val<uint32_t>(0);

  // set which registers (srcA, srcB, Dst) are used and which CBs are used as inputs/outputs for the coprocessor
  // runs on all three cores
  init_sfpu(tt::CBIndex::c_0, tt::CBIndex::c_16);

  for (uint32_t i = 0; i < n_tiles; ++i) {
    // reserve coprocessor registers for use
    // MATH thread
    tile_regs_acquire();

    // unpack thread
    cb_wait_front(tt::CBIndex::c_0, 1);
    // copy tile into Dst for coprocessor 
    // unpack thread: unpack cb0 to srcA
    // copy ops go through srcA as an intermediate
    // math thread: src regs -> dst regs
    copy_tile(tt::CBIndex::c_0, /*cb_offset=*/0, /*reg_offset=*/0);

// the actual compute
#ifdef TRISC_MATH
    // 32-lane vector value
    // f32 or f16 based on data
    const sfpi::vFloat one = 1.0f;
    // Dst is 1024 by 1024, 32-bit.
    // (even though data is 16-bit, lane sizes don't change) 
    constexpr uint32_t vectors_per_tile = 32;

    // for all 32-bit vectors in the tile, 
    for (uint32_t v = 0; v < vectors_per_tile; ++v) {
      sfpi::dst_reg[v] = sfpi::dst_reg[v] + one;
    }
#endif

    // this is also TRISC_MATH, see below
    // compute done, notifies PACK core
    tile_regs_commit();

    // run on TRISC2 (pack core) 
    // set pack core up to receive above message
    tile_regs_wait();

    // reserve space on the output CB
    cb_reserve_back(tt::CBIndex::c_16, 1);

    // copy tile from Dst to L1 (CB) 
    // uses microcode in the packer (hardware) 
    // pack thread
    pack_tile(/*reg_offset=*/0, tt::CBIndex::c_16);

    // compute on this tile done, pop 
    // unpack thread
    cb_pop_front(tt::CBIndex::c_0, 1);

    // un-reserve registers (undo call from above) 
    // pack thread: mark DST section consumed
    tile_regs_release();

    // register newly written tile to the CB
    // pack thread
    cb_push_back(tt::CBIndex::c_16, 1);
  }
}

}  // namespace NAMESPACE
```

Dataflow out: 
```cpp
#include <cstdint>

void kernel_main() {
  // where to write output buffer in dram
  uint32_t out_addr = get_arg_val<uint32_t>(0);
  uint32_t n_tiles = get_arg_val<uint32_t>(1);

  // 16-31 for output CBs
  constexpr uint32_t cb_out0 = tt::CBIndex::c_16;
  const uint32_t tile_size_bytes = get_tile_size(cb_out0);

  const InterleavedAddrGenFast<true> out0 = {
    .bank_base_address = out_addr,
    .page_size = tile_size_bytes,
    .data_format = DataFormat::Float16,
  };

  for (uint32_t i = 0; i < n_tiles; ++i) {
    // wait until compute has produced at least one tile
    cb_wait_front(cb_out0, 1);
    // l1 read address 
    uint32_t cb_out0_addr = get_read_ptr(cb_out0);

    // write that tile to dram output buffer
    noc_async_write_tile(i, out0, cb_out0_addr);
    // wait until write is done
    noc_async_write_barrier();

    // pop tile from queue
    cb_pop_front(cb_out0, 1);
  }
}
```

## tensix coprocessor 

## tt-metal: slow vs fast dispatch