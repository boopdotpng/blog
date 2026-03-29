---
title: the tenstorrent plan
pubDate: "2026-03-28"
published: false
description: "a vision"
cat: hardware
---

Since the last post, [blackhole-py](https://github.com/boopdotpng/blackhole-py) has grown a lot. It's now a complete replacement for tt-metal, minus multi-card and support beyond blackhole p100a and p150. There are a few edges--notably, I haven't figured out the best way to get tensors to and from the device. Currently we launch `dram_drain` and `dram_fill` kernels to copy data from the 1G sysmem buffer (iommu mapped) to the device's DRAM, but this means you have to launch a kernel for each Tensor you want to read/write, which is probably not scalable long term? There are alternatives, like using the CQ sysmem to copy tensors over (the firmware already has this wired up) but getting performance this way is difficult because Python mmaps are notoriously slow. I might end up going back to the `dram_fill` approach. 

It also has decent profiling through two independent systems, which you can look at by passing `PROFILE=1`: 

- Hardware profile counters that show FPU/SFPU/MATH/UNPACK/PACK utilization, along with lots of misc statistics 
- Cycle counts of instructions with `DeviceZoneScopedN("DRAM_READ_IN1")`. This just copies start/end cycle pairs to L1, which are then read back to host after the kernel ends. There's enough space for ~120 pairs in L1, but this can be increased if your CBs don't occupy the entire L1. 

Together, you can get a pretty good idea of why your kernel is slow, but I don't think this is necessary, for the following reason: there's only one way to write a given operation. There's almost no knobs to optimize or tweak. Consider a matmul+add kernel. You have to run a `MVMUL` instruction, then `SFPADD`. No other combinations. The only thing we have control over is how many kernels we can fuse together. From that standpoint, profiling is not necessary at all, because how are you going to write the kernel differently? 

Reader dataflow kernels can be hardcoded based on the number and datatypes of input+output tensors. Because of the limited L1 space, you're limited to 3-4 tensors per kernel (CBs).

Writer dataflow is even simpler, since most kernels have only one output tensor. It would just write the output CB into dram. 

It gets a little more interesting when you look at compute kernels. This can be written using the list of linearized ops that tinygrad generates for every kernel. There are some outstanding questions regarding indexing, padding, etc, but for the most part this should boil down to a list of `match/case` statements. 

We could write the kernels as C++ strings, like the other backends in tinygrad, but I think this is still too high up the abstraction tree. 

Unlike RDNA/CDNA, which have thousands of instructions, the decision space for tenstorrent is 