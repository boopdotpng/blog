---
title: "rdna kernel breakdown"
pubDate: "2025-12-29"
published: true
pinned: false
description: "Breakdown of a very simple RDNA3.5 kernel, with visualizations"
cat: "programming"
---

Consider 
```asm
s_load_b64 s[2:3], s[0:1], 0x8
s_load_b64 s[0:1], s[0:1], 0x0
s_waitcnt lgkmcnt(0) 
s_mov_b32 exec_lo, 0xFFFF ; explicit
v_lshlrev_b32 v1, 2, v0 
global_load_b32 v4, v1, s[0:1]
s_waitcnt vmcnt(0)
v_add_f32 v4, 1.0, v4
global_store_b32 v1, v4, s[2:3]
s_waitcnt vmcnt(0)
s_endpgm
```
And the tinygrad code to run the program
```py
N = 16
a = Buffer(gpu, N, dtypes.float32).allocate()
out = Buffer(gpu, N, dtypes.float32).allocate()

a.copyin(memoryview(np.arange(N, dtype=np.float32)))

local = (N, 1, 1) 
global_ = (N, 1, 1) 

# launch kernel 
prg(a._buf, out._buf, global_size=global_, local_size=local, wait=True)
```

`tid` (0-31) is in v0, pointers to `a` and `a_out` (global memory addresses) in a `KernArg` struct at `s[0:1]`.

This kernel just does `Tensor.arange(16) + 1`.

## launching

The launch settings here specify a single work-group with 16 threads. 

Every wave runs a copy of this kernel, with a copy of the following state: 

| State   | Description                                                    | Width / Range |
| ------- | -------------------------------------------------------------- | ------------- |
| SGPRs   | scalar general purpose registers                               | s0–s105       |
| VGPRs   | vector general purpose registers                               | v0–v255       |
| LDS     | scratchpad memory shared with all threads in a compute unit    | 64kB          |
| EXEC    | top half not used in wave32                                    | 64-bit        |
| EXECZ   | exec is zero                                                   | 1-bit         |
| VCC     | vector condition code                                          | 64-bit        |
| VCCZ    | vcc is zero                                                    | 1-bit         |
| SCC     | scalar condition code                                          | 1-bit         |
| VMcnt   | vmem load and sample instructions issued but not yet completed | 6-bit         |
| VScnt   | issued, not completed vmem store instructions...                                     | 6-bit         |
| LGKMcnt | outstanding lds, gds, constant and message count                           | 6-bit         |

## line by line: 

```
s_load_b64 s[2:3], s[0:1], 0x8
s_load_b64 s[0:1], s[0:1], 0x0
```

Our kernel arguments are stored in the `kernarg_block`, and all we get is a 64-bit pointer to that in `s[0:1]`. 

KernArgs is essentially just a C-struct containing pointers to global memory. The address we get in `s[0:1]` is the base address of the struct. 
```c
struct KernArgs {
  float* a_ptr; // offset 0x0
  float* out_ptr; // offset 0x8 (pointers are 64-bit addresses)
}
```

Line 1 loads `out_ptr` (64-bit) into `s[2:3]` so that we can use it to do a global memory load later. 
Line 2 overwrites `s[0:1]`  with the contents of `a_ptr` (offset `0x0`). 

Remember SGPRs are 32-bit, so we need 2 SGPRs to store a 64-bit value. 

```asm
s_waitcnt lgkmcnt(0)
```

If you omit this line, you get complete garbage 
```bash
a:     [ 0.  1.  2.  3.  4.  5.  6.  7.  8.  9. 10. 11. 12. 13. 14. 15.]
a + 1: [-1.1589701e+11  1.0000000e+00 -1.1586345e+11  1.0000000e+00
  1.0000000e+00  1.0000000e+00  1.0000000e+00  1.0000000e+00
  1.0000000e+00  1.0000000e+00  1.0000000e+00  1.0000000e+00
  1.0000000e+00  1.0000000e+00  1.0000000e+00  1.0000000e+00]
```

because you didn't wait for the previous SMEM instructions to complete. 

On AMD GPUs, there are a few registers per wave that tell you how many memory operations are pending: 
- VMcnt: outstanding vmem/flat/global loads. ops that *return* data to VGPRs 
- VScnt: vector memory stores issued but not yet completed
- LGKMcnt: LGS, GDS, Constant and Message count. our `s_load*` instructions fall into this bucket 
- EXPcnt (in compute kernels this is almost never used, this is more for graphics/shaders)

LGS: Memory per CU (2 CUs per Work Group Processor) (64kB) 
GDS: Memory that can be used by all WGPs

The number you specify in `s_waitcnt` for each register type (you can combine them) is how many of those operations you're willing to leave in-flight before continuing on.  

```asm
v_lshlrev_b32 v1, 2, v0
```

In RDNA, instructions can be vector (`v_*`) or scalar (`s_*`), and they deal with two different kinds of registers. 

**SGPRs**

SGPRs are quite straightforward. In RDNA3.5, every wave is allocated 128 SGPRs (32-bit registers) that are shared between every thread in the wave. The kernel can access 106 of these registers; `s106` and `s107` are `vcc_hi` and `vcc_lo`, and everything beyond 107 is part of the trap handler. Don't worry about those yet. The main takeaway is that these are shared between every thread in the wave. That's why we use it to store kernel arguments. 

**VGPRs**

VGPRs are unique per thread. In `wave32`, every thread in the wave (32 threads) gets its own `b32`. When you access `v0`, you're accessing one value for every thread in that wave, which is how you end up with a 32-bit value that can be fed into one of the simd32s in the CU. 

VGPRs are allocated in blocks of 16 in `wave32` and 8 in `wave64`. When you write the `hsaco` code object contaning the kernel, you have to specify how many VGPRs your kernel requires per wave (this will be rounded up based on the wave size). 

`v0` in this example contains the AMD equivalent of `threadIdx`, "what thread am I in this wave"? It looks like this: 
```
v0              : 0 1 2 3 4 5 6 7 .. 31

thread # in wave: 0 1 2 3 4 5 6 7 .. 31 
```

As a data structure: `v0 = vec![u32; num of threads per wave]`.

To actually do anything with `a`, we need to copy it into a VGPR. The model is typically 
- host writes data to gpu global memory
- gpu copies data from global memory to vector registers 
- computation happens  
- gpu copies from registers back to global memory so the host can read back the value

We want each thread to load one float32 value from global memory. We have the base address of `a` in `s[0:1]`, and since every `f32` is 4 bytes long, each thread needs to read the `f32` value 4 bytes (32 bits) after the previous thread. 

`v_lshlrev_b32 v1, 2, v0` = `v4 = v0 << 2`. 

If the base address `s[0:1]` is `0x0`, v4 now looks like: 
```
v0              : 0 1 2 03 04 05 .. 16 ..000000 ; our original threadIdx 
v4              : 0 4 8 12 16 20 .. 64 ..000000 ; offset (in bytes) from addr of a in glbl memory

thread # in wave: 0 1 2 03 04 05 .. 31 
```

Thread 0 loads the first float (0), thread 1 loads the second float (1), etc. 

We can now use these offsets to perform the load from global memory into a VGPR. 

`global_load_b32 v4 (dest), v1 (vector address offset), s[0:1] (global memory address)`

**exec_lo and exec_hi**
All vector instructions (loads, computes, and stores) hit this register. `exec` is a 64-bit register (split into two halves) allocated per wave that controls which threads corresponding vector instructions act on. In `wave32`, there are only 32 threads, so only `exec_lo` is used. You don't need to manually copy into this register; it's determined by the `local` and `global_` launch sizes we set earlier. 

In this example, we launched 1 work-group containing 16 threads. In `wave32`, this means that the top half of threads can be ignored. 

So we can write `s_mov_b32 exec_lo, 0xFFFF` (debugging confirms that this is the actual value). Now all of our vector instructions (including global memory loads) only execute on the bottom 16 threads. If you don't set this value correctly, your GPU will crash. The offset calculations and global memory read instructions would run beyond the bottom 16 threads; thread 17 (1-indexed, literally the 17th thread) would read `a[16]` from global memory, which isn't allocated. 

In most cases, `exec_lo=0xFFFFFFFF`, since every wave will have 32 active items to compute. But in cases where the amount of items computed is not divisible by 32, you may have a smaller wave that only executes, say, 5 spillover items. 

If you write `0b1` to `exec_lo`, only the first thread will be computed. Notice that `exec` affects writes from vector memory as well, not just compute instructions.

```
a:     [ 0.  1.  2.  3.  4.  5.  6.  7.  8.  9. 10. 11. 12. 13. 14. 15.]
a + 1: [1. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0.]
```

If you manually write to `exec_lo`, save it to an SGPR so you can restore its value.

Now v4 contains `[0,1,2,3,4..15, 0....]`. 

`v_add_f32 v4 (dst), 1.0 (immediate), v4 (src)`

This one does the addition.  

`global_store_b32 v1 (vector address offset), v4 (src data), s[2:3] (global mem address)`

Remember that `s[2:3]` is the address of `a_out` in our `KernArg` struct. The store works the same way as the float load that we wrote earlier. We use the same offsets (`v1`) to write each float 4 bytes after the previous one. 

And the last `s_waitcnt vmcnt(0)` to wait for the global memory store to finish before ending the program. 