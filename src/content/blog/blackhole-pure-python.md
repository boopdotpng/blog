---
title: blackhole in pure python
pubDate: "2026-05-01"
published: true
description: "emitting tenstorrent kernels without their compiler"
cat: hardware
---

Since my [last post](https://anuraagw.me/blog/blackhole-architecture), I have realized that my vision and plan for tenstorrent hardware was completely wrong. I've thought about it a while, and below is the fastest, most fun approach. 

--- 
Originally the plan was to build on top of tt-metal. All [blackhole-py](https://github.com/boopdotpng/blackhole-py) would do is write C++ kernel strings, compile them using the tenstorrent's compiler, and then run them on the device. This worked for a while—I had a `tt-metal-deps` as a downloadable bundle inside blackhole-py that contained the compiler, debugging tools, and all the c++ source and header files required to write kernels. 

This fell apart about a month or two into blackhole-py; I tried to update the version of tt-metal I used to build `tt-metal-deps` and encountered a lot of issues, API changes, and breaking changes that would take too much effort to fix. I also had to backport profiling from future versions of tt-metal into our `tt-metal-deps` folder, making it a weird hodge-podge of January's tt-metal combined with some updates from March's tt-metal. One specific breaking change is the memory map (`dev_mem_map.h`) that defines where firmware, kernels, mailboxes, etc are uploaded—when these change, it requires a re-write of blackhole-py modules to support the new firmware sizes and mailbox locations. Long term, it would be a tedious effort to keep `tt-metal-deps` updated with the latest `tt-metal`, not to mention you now require your users to download a 90MB artifact just to run kernels on their device. 

It's also not the correct abstraction layer to stop at. tt-metal functions and APIs are heavily dependent on many other projects under it (tt-umd, sfpi, tt-llk, etc), and understanding how tt-metal or ttnn operations get lowered into kernels is a massive undertaking. Reasoning about these is nearly impossible. "How does this card work" only became clear to me once I started reading the disassembly output for tt-metal kernels and writing an emulator (which I believe is strongly necessary). The assembly, even for the fastest possible matmul kernel, is only approximately ~1000 risc-v instructions, most of which are just initialization and setup—building NoC packets, configuring tensix coprocessor registers, etc. I really doubt tenstorrent needed to build an entire fork of GCC just to have their most complicated kernel only be ~1000 risc-v instructions. 

So I'm removing the compiler, `tt-kmd`, and `tt-metal-deps`. My goal now is to generate risc-v directly from Python, and have some kind of DSL (like tt-lang) that lowers to rv32i instructions runnable on each core. `tt-lang` itself lowers python DSL to MLIR to C++ kernel strings, which are then compiled using their regular compiler toolchain and ran on the device using tt-metal. You can hook into this and have tt-lang print out the c++ source kernels before they run on the device, effectively giving you a map of operation -> assembly for almost every workload. 

The added benefit of this approach is that it's easier to run on macOS, as you don't need to build their compiler toolchain for macOS (this might not even be fully functional). The result: 99% python. 

## removing tt-kmd (opus wrote 80% of this, i'm lazy)

tt-kmd is the linux kernel module that gives userspace a `/dev/tenstorrent/N` char device per card.
ioctls on that fd are how tt-umd (and through it, tt-metal) talks to the chip: TLB allocation, DMA
pinning, ARC messaging, resets, interrupts, hugepage mappings for sysmem. It's a few thousand lines of
C to support what's basically a thin shim over PCIe config space, BAR mmaps, and the IOMMU. None of
it needs kernel privileges that VFIO doesn't already give you.

[pcie.py](https://github.com/boopdotpng/blackhole-py/blob/master/pcie.py) walks
`/sys/bus/pci/devices/*` looking for vendor `1e52` + device `b140` (Blackhole), pokes the PCI command
register through `/sys/.../config` to enable memory space + bus mastering, and `mmap`s `resource0`,
`resource0_wc`, `resource2`, `resource4`, and `resource4_wc` directly. Same view of the chip
`tenstorrent.ko` would hand back behind an ioctl, one fewer layer in the way.

Three things tt-kmd does for you that you have to do yourself once it's gone:

1. **TLB allocation.** Blackhole has 202 2MB TLBs and 8 4GB TLBs sitting in BAR0/BAR4. tt-kmd hands
these out per-fd; in Python it's a pair of bool arrays and a free-list. The TLB config register is a
96-bit value written as three u32s (local offset, mcast bounds, NoC selection, ordering, etc.) —
`configure_tlb()` just packs that struct.

2. **DMA pinning.** This is what VFIO is for. Once the device is bound to `vfio-pci`, you open
`/dev/vfio/vfio` + `/dev/vfio/<group>`, set the IOMMU to `VFIO_TYPE1v2_IOMMU`, and `VFIO_IOMMU_MAP_DMA`
  your buffer into a contiguous IOVA range. Then you program the iATU in BAR2 to translate a chunk of
NoC PCIe space to that IOVA. tt-kmd does the same thing internally but hides it behind a "pin pages"
ioctl; in Python it's maybe 30 lines.

3. **Reset.** This one took the longest. `tt-smi -r` is the user-facing version, but underneath
it does a PCIe secondary bus reset on the upstream bridge, restores endpoint PCI config,
fires the BH "interface timer" through extended config space (offsets `0x930`/`0x934`) for the in-place
  ASIC reset, polls the parity bit until it clears, restores MPS/MRRS via a DBI write over the NoC, and
then sends the ARC A0 go-busy message + watchdog timeout. All of it lives in `PCIDevice.reset_bdf()`
now, with a fallback to plain PCIe FLR via `/sys/.../reset` if extended config space isn't reachable.

ARC messaging follows the same pattern: read `SCRATCH_RAM_2` to check boot status, walk the message
queue control block out of `SCRATCH_RAM_11`, write the message + args into the next request slot, bump
the wptr, trigger IRQ0 by setting bit 16 of `ARC_MISC_CNTL`, and poll the response wptr. No kernel
module needed — it's just a NoC mailbox.

You just need to load VFIO and grant Python the caps it needs to mlock + bind to vfio-pci:

sudo modprobe vfio-pci
./setup_python_cap.sh

(tinygrad does something very similar to support the Python amdgpu driver.)

## the emulator 
I've spent a lot of time writing a partially cycle-accurate emulator for blackhole because it's impossible to debug the device. If you write a kernel and it hangs somewhere, it's really difficult for me (or an LLM) to figure out why it hung and what exactly went wrong. You do get a rough PC for each core after the crash/hang, but each hang takes ~10 seconds, and iteration is expensive. You also don't know which core hung and at what point. You can sort of estimate this from the PC stored on the debug bus after the crash, but this is unreliable and time-consuming, since you need to have a disassembly of all kernels and a mapping from source to disassembly. 

The emulator also defines the functionality of the device in code, which is way more reliable than reading tt-metal, tt-isa-documentation, or [my docs](https://github.com/boopdotpng/tenstorrent-docs) to learn the semantics of the card. Any LLM can read the emulator code and understand how the device functions and how to write kernels for it. Additionally, this makes debugging very simple. 

Currently the emulator can run a full matmul_peak kernel, so the following work: 
- noc transactions and multicasts 
- firmware upload and jumping to kernels 
- unpacker, packer 
- FPU matmul emulation / MVMUL instruction
- dram access through dram tiles on noc 

and more. The remaining gaps will be ironed out when I collect kernels from tt-lang (since it just lowers to C++ kernel strings) and run them through the emulator. I think I'm missing emulation for some SFPU instructions and NoC atomics. 

Once the emulator is finished, I can concretely map out all the assembly / mmio writes in a tenstorrent kernel (to configure the tensix coprocessor or build NoC command packets) and then build a small IR on top of the raw instruction words. That's where the codegen comes in. 

## removing the compiler 

[dsl.py](https://github.com/boopdotpng/blackhole-py/blob/master/dsl.py), which should really be renamed `rv.py`, contains all the risc-v and `tt*` instructions that are supported on tenstorrent blackhole. Some of the `zaamo` atomics may not be used, but I haven't tried enough kernels to be sure, so I'm leaving them in. There are also some `tt*` instructions in there that I've never seen used before and may be rare/deprecated, but I'll trim it the further along I get. This instruction layer plus some predefined setup/init functions should in theory assemble to the same functional output as the `sfpi` compiler. A big chunk of every kernel (referring to the set of 5 cores here) can be hardcoded. 

### types of kernels 
All dataflow kernels can essentially be hardcoded, since they fall into a few categories: 
- matmul_peak style dataflow arrangement where one core multicasts tensors from dram to the rest of the cores, instead of every core reading duplicate data from dram. This may also apply to other kernels that feature heavy reuse. 
- all other kernels, assuming each core reads its own slice of data from dram. 

For case 1, I have a [matmul_planner](https://github.com/boopdotpng/blackhole-py/blob/master/examples/matmul_peak.py) that creates the optimal matmul plan for every matrix size. Since smaller matrices don't have enough data to saturate all the cores, we need to reshape the kernels and grid layout for every matrix size. 

| Size | Executed shape | Best matmul time | Requested TFLOP/s | Executed TFLOP/s |
|---|---:|---:|---:|---:|
| 256^3 | 256x256x448 | 32.8 us | 1.02 | 1.79 |
| 512^3 | 640x512x640 | 42.0 us | 6.39 | 9.99 |
| 1024^3 | 1280x1024x1280 | 63.1 us | 34.03 | 53.18 |
| 2048^3 | 2240x2048x2112 | 151.7 us | 113.25 | 127.74 |
| 4096^3 | 4160x4096x4224 | 654.9 us | 209.86 | 219.80 |
| 5120x4096x5632 (default) | 5120x4096x5632 | 1069.8 us | 220.81 | 220.81 |

There is a distinction between requested TFLOP/s and executed TFLOP/s because all tensors must be padded to the minimum tile size (32x32=1024 elements). So the actual compute run is higher, even though the extra padding is just zeros. 

This template will stay the same no matter what matmul is done, regardless of datatype or F32 acc. 

There are only a few other dataflow templates required, since all kernels have one output tensor (CB). Once you write a unary, binary, and n-ary dataflow kernel, you've covered 99% of kernels. The compute kernel will be generated using tinygrad Uops. The scope here is super small; there are well defined tt instructions for each operation, and there's effectively one fast implementation per kernel because of how constrained the hardware is (this is fantastic compared to the amount of effort that goes into optimizing kernels for Nvidia and AMD gpus). Then, finally, the tinygrad backend will be ready to write. 