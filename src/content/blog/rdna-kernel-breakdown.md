---
title: "rdna kernel breakdown"
pubDate: "2025-12-29"
published: true
pinned: false
description: "breakdown of a very simple rdna3.5 kernel, with visualizations"
cat: "code"
---

## our kernel 

Consider 
```asm
s_clause 0x1
s_load_b64 s[2:3], s[0:1], 0x8
s_load_b64 s[0:1], s[0:1], 0x0
s_waitcnt lgkmcnt(0) 
s_mov_b32 exec_lo, 0xFFFF ; explicit
v_lshlrev_b32 v1, 2, v0 
global_load_b32 v4, v1, s[0:1]
s_waitcnt vmcnt(0)
v_add_f32 v4, 1.0, v4
global_store_b32 v1, v4, s[2:3]
s_sendmsg sendmsg(MSG_DEALLOC_VGPRS)
s_endpgm
```
And the tinygrad code to run the program
```py
a = Buffer(gpu, 16, dtypes.float32).allocate()
out = Buffer(gpu, 16, dtypes.float32).allocate()

a.copyin(memoryview(np.arange(16, dtype=np.float32)))

local = (16, 1, 1) 
global_ = (16, 1, 1) 
```

# launch kernel 

```py
prg(a._buf, out._buf, global_size=global_, local_size=local, wait=True)
```

`tid` (0-31) is in v0, pointers to `a` and `a_out` (global memory addresses) in a `KernArg` struct at `s[0:1]`.

This kernel just does `Tensor.arange(16, dtype=dtypes.float32) + 1.0`.

## launching

The launch settings here specify a single work-group with 16 threads. 

Every wave runs a copy of this kernel, with a copy of the following state: 

| State   | Description                                                    | Width / Range |
| ------- | -------------------------------------------------------------- | ------------- |
| SGPRs   | scalar general purpose registers                               | s0–s105       |
| VGPRs   | vector general purpose registers                               | v0–v255       |
| LDS     | on-chip workgroup-shared mem; "local" memory                   | 64kB          |
| EXEC    | top half not used in wave32                                    | 64-bit        |
| EXECZ   | exec is zero                                                   | 1-bit         |
| VCC     | vector condition code                                          | 64-bit        |
| VCCZ    | vcc is zero                                                    | 1-bit         |
| SCC     | scalar condition code                                          | 1-bit         |
| VMcnt   | vmem load and sample instructions issued but not yet completed | 6-bit         |
| VScnt   | issued, not completed vmem store instructions                  | 6-bit         |
| LGKMcnt | outstanding lds, gds, constant and message count               | 6-bit         |

## architecture fundamentals

In RDNA, instructions can be vector (`v_*`) or scalar (`s_*`), and they deal with two different kinds of registers. 

**SGPRs**

SGPRs are per-wave (shared by all lanes). On gfx10+ the ISA names 106 scalar registers as `s0..s105`. Separate from those, the ISA also exposes special named registers like `exec` (the lane mask), `vcc` (condition code), and `ttmp0..ttmp15` (trap temporaries). So you’ll usually see kernel arguments kept in SGPRs, while exec/vcc live in their own named registers.

**VGPRs**

VGPRs are unique per thread. In `wave32`, every thread in the wave (32 threads) gets its own 32-bit register. When you access `v0`, you're accessing one 32-bit value for every thread in that wave, which is how you end up with 32 32-bit values that can be fed into one of the simd32s in the CU. 

VGPRs are allocated in blocks of 16 in `wave32` and 8 in `wave64`. When you write the `hsaco` code object contaning the kernel, you have to specify how many VGPRs your kernel requires per wave (this will be rounded up based on the wave size). 

`v0` in this example contains the AMD equivalent of `threadIdx`, "what thread am I in this wave"? It looks like this: 
```
v0              : 0 1 2 3 4 5 6 7 .. 31

thread # in wave: 0 1 2 3 4 5 6 7 .. 31 
```

As a data structure: `v0 = vec![u32; num of threads per wave]`.

**exec_lo and exec_hi**

All vector instructions (loads, computes, and stores) hit this register. `exec` is a 64-bit register (split into two halves) allocated per wave that controls which threads vector instructions act on. In `wave32`, there are only 32 threads, so only `exec_lo` is used. You don't need to manually copy into this register; in this kernel, it's determined by the `local` and `global_` launch sizes we set earlier. 

In this example, we launched 1 work-group containing 16 threads. In `wave32`, this means that the top half of threads have no data and can be ignored. 

So we can write `s_mov_b32 exec_lo, 0xFFFF` (debugging confirms that this is the actual value). Now all of our vector instructions (including global memory loads) only execute on the bottom 16 threads. If you set this value incorrectly, your GPU will crash. In this case, the offset calculations and global memory read instructions would run beyond the bottom 16 threads; thread 17 (1-indexed, literally the 17th thread) would read `a[16]` from global memory, which isn't allocated. Again, normally the hardware/runtime sets this, it's only set explicitly for educational purposes. 

If you write `0b1` to `exec_lo`, only the first thread will be active for the duration of the kernel. Notice that `exec` affects writes from vector memory as well, not just compute instructions.


```
a:     [ 0.  1.  2.  3.  4.  5.  6.  7.  8.  9. 10. 11. 12. 13. 14. 15.]
a + 1: [1. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0. 0.]
```

If you ever manually write to `exec_lo`, save its value to an SGPR so you can restore its value.

**s_clause**

A marker that tells the GPU that the next memory ops belong together. On pre-gfx10 hardware, the GPU would implicitly detect soft clauses (runs of adjacent memory instructions of the same general kind). Starting with gfx10, this detection was removed and `s_clause` was introduced so that compilers could explicitly mark a hard clause. 

In practice, it tells the memory pipeline to treat the next N eligible memory instructions as one clause. Clausing load instructions can give cache coherency benefits, and the scheduler is expected to line up similar memory instructions. 

`clause_len = (imm & 63) + 1`, so we write `s_clause N-1` to clause the next N instructions.

There are a lot of restrictions on the types of instructions you can clause: 
- VMEM loads 
- VMEM stores 
- atomics 
- FLAT loads/stores/atomics

Branches, messages, `s_waitcnt` are also illegal inside clauses. 

It doesn't really matter in this kernel because the only place we can *maybe* put an `s_clause` is at the very start, since the first two instructions (`s_load*`) are fairly similar. In future, we'll benchmark kernels with and without this instruction and see if it makes a difference. 

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

because you didn't wait for the previous SMEM loads to complete.

On AMD GPUs, there are a few registers per wave that tell you how many memory operations are pending. Loads and stores are tracked independently. 
- VMcnt: outstanding vmem/flat/global loads. ops that *return* data to VGPRs 
- VScnt: vector memory stores issued but not yet completed
- LGKMcnt: LDS, GDS, Constant and Message count. `s_load*` instructions fall into this bucket 
- EXPcnt (in compute kernels this is almost never used, this is more for graphics/shaders)

LDS: Memory per CU (2 CUs per Work Group Processor) (64kB) 
GDS: Memory that can be used by all WGPs

The number you specify in `s_waitcnt` for each register type (you can combine them) is how many of those operations you're willing to leave in-flight before continuing on.  

```asm
v_lshlrev_b32 v1, 2, v0
```

To actually do something with `a`, we need to copy it into a VGPR. The model is typically 
- host writes data to gpu global memory
- gpu copies data from global memory to vector registers 
- computation happens  
- gpu copies from registers back to global memory so the host can read back the value

We want each thread to load one float32 value from global memory. We have the base address of `a` in `s[0:1]`, and since every `f32` is 4 bytes long, each thread needs to read the `f32` value 4 bytes (32 bits) after the previous thread. 

`v_lshlrev_b32 v1, 2, v0` = `v1 = v0 << 2`. 

If the base address `s[0:1]` is `0x0`, v1 now looks like: 
```
v0  : 0 1 2 03 04 05 .. 15 ; our original threadIdx 
v1  : 0 4 8 12 16 20 .. 60 ; offset (in bytes) from addr of a in glbl memory

thread # in wave: 0 1 2 03 04 05 .. 15
```

Thread 0 loads the first float (0), thread 1 loads the second float (1), etc. 

We can now use these offsets to perform the load from global memory into a VGPR. 

`global_load_b32 v4 (dest), v1 (vector address offset), s[0:1] (global memory address)`

Now v4 contains `[0,1,2,3,4..15]`. 

`v_add_f32 v4 (dst), 1.0 (immediate), v4 (src)`

This one does the addition.  

`global_store_b32 v1 (vector address offset), v4 (src data), s[2:3] (global mem address)`

Remember that `s[2:3]` is the address of `a_out` in our `KernArg` struct. The store works the same way as the float load that we wrote earlier. We use the same offsets (`v1`) to write each float 4 bytes after the previous one. 

`s_sendmsg sendmsg(MSG_DEALLOC_VGPRS)` is part of a family of instructions that send a small message to the GPU control logic so some *side effect* happens. This frees up all per-wave allocated resources, and the only thing you can do after this is end the program. Be careful though, if you deallocate vectors directly after 


We don't need a final "wait-for-memory" instruction after our global store; in modern RDNA, `s_endpgm` will automatically wait for all non-atomic stores to complete before exiting the kernel.

## tinygrad's kernel (LLVM-generated)

```py
# DEBUG=7, AMD_LLVM=1
from tinygrad import Tensor, dtypes
a = Tensor.arange(15, dtype=dtypes.float32).realize()
print((a+1.0).realize().numpy()) # we're disassembling this kernel
```

```asm
s_load_b128 s[4:7], s[0:1], null
v_mad_u64_u32 v[0:1], null, s2, 3, v[0:1]
s_delay_alu instid0(VALU_DEP_1) | instskip(NEXT) | instid1(VALU_DEP_1)
v_ashrrev_i32_e32 v1, 31, v0
v_lshlrev_b64 v[0:1], 2, v[0:1]
s_waitcnt lgkmcnt(0)
s_delay_alu instid0(VALU_DEP_1) | instskip(NEXT) | instid1(VALU_DEP_2)
v_add_co_u32 v2, vcc_lo, s6, v0
v_add_co_ci_u32_e32 v3, vcc_lo, s7, v1, vcc_lo
v_add_co_u32 v0, vcc_lo, s4, v0
v_add_co_ci_u32_e32 v1, vcc_lo, s5, v1, vcc_lo
global_load_b32 v2, v[2:3], off
s_waitcnt vmcnt(0)
v_add_f32_e32 v2, 1.0, v2
global_store_b32 v[0:1], v2, off
s_nop 0
s_sendmsg sendmsg(MSG_DEALLOC_VGPRS)
s_endpgm
```