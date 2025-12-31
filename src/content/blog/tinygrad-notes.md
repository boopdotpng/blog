---
title: "tinygrad notes"
pubDate: "2025-12-26"
published: true
pinned: true
contents_table: true
description: "notes and links while exploring tinygrad."
cat: "code"
---

# rough progression of a tinygrad tensor operation 

**1) Tensors are just thin wrappers over UOps**

Files involved:
- `Tensor.py`
- `uop/ops.py`
- `uop/init.py`

Tensors are just a thin wrapper over UOps. Every tensor operation creates a UOp (or set of UOps) that gets injected into the current UOp graph.

For example: 
```py
Tensor.ones(3).uop

UOp(Ops.EXPAND, dtypes.float, arg=None, src=(
  UOp(Ops.RESHAPE, dtypes.float, arg=None, src=(
    UOp(Ops.CONST, dtypes.float, arg=1.0, src=(
      UOp(Ops.DEVICE, dtypes.void, arg='CPU', src=()),
      UOp(Ops.UNIQUE, dtypes.void, arg=0, src=()),)),
    UOp(Ops.CONST, dtypes.index, arg=1, src=()),)),
  UOp(Ops.CONST, dtypes.index, arg=3, src=()),))
```

## all the ops 

You can write an entire GPU kernel using just UOps, bypassing the tensor layer entirely.

### Ops that don't appear in compiled programs 

These are higher-level ops that get lowered or eliminated during compilation:

- `unique`, `device`, `kernel`, `assign`, `custom_kernel`, `lunique`
- `contiguous`, `contiguous_backward`, `detach`
- `bufferize`, `copy`, `buffer`, `buffer_view`, `mselect`, `mstack`, `encdec`
- `reshape`, `permute`, `expand`, `pad`, `shrink`, `flip`, `multi`
- `reduce_axis`, `reduce`, `allreduce`
- `unroll`, `contract`, `cat`, `ptrcat`

### everything else (ops that appear in compiled programs)

These are the low-level ops that actually make it into the final compiled kernel:

- `define_global`, `define_var`, `bind`, `special`, `define_local`, `define_reg`
- `noop`, `rewrite_error`, `program`, `linear`, `source`, `binary`, `sink`, `after`, `group`, `gep`, `vectorize`
- `index`, `load`, `store`
- `wmma`
- `cast`, `bitcast`, `exp2`, `log2`, `sin`, `sqrt`, `reciprocal`, `neg`, `trunc`
- `add`, `mul`, `shl`, `shr`, `idiv`, `max`, `mod`, `cmplt`, `cmpne`, `cmpeq`, `xor`, `or`, `and`, `threefry`, `sub`, `fdiv`, `pow`
- `where`, `mulacc`
- `barrier`, `range`, `if`, `end`, `endif`
- `vconst`, `const`
- `custom`, `customi`

**2) Schedule creation (kernel partitioning)**

Files involved:
- `engine/schedule.py`
- `schedule/__init__.py`
- `rangeify.py`

Each UOp graph gets turned into one or more kernel ASTs (each rooted at `Ops.SINK`). Every kernel becomes an `ExecItem` with its own AST and buffers. This is where tinygrad figures out how to partition your computation into separate GPU kernel launches.

**3) Kernel AST rewrite + optimization**

Files involved:
- `codegen/init.py`
- `postrange.py`
- `opt/search.py` (BEAM)

Kernel ASTs are rewritten and optimized based on rewrite rules defined in `PatternMatchers`. These are scattered all around the codebase and rewrite portions of the UOp graph: movement ops, range splitting, constant folding, etc. 

`apply_opts` applies optimizations to the AST. This path varies based on the `BEAM` environment variable. 

**BEAM on:** 
BEAM search happens. See the BEAM section below.

**BEAM off:** 
A bunch of hand-written optimizations are applied to each AST. See the pattern-matchers section below (todo). 

Calls `codegen/opt/heuristic.py` to apply hand-coded optimizations, assuming `NOOPT` is unset and the AST doesn't have optimizations already applied. 

More rewrites happen after this: 
- **expander** -- lowers ranges and reduces into loops
- **devectorizer** -- handles `UPCAST` ops
- **gpudims** -- GPU launch dimensions 
- **lower index dtype** -- converts symbolic dtypes into dtypes for the respective backend
- **decompositions** -- replaces unsupported ops with supported ops on the target renderer
- **final rewrite** -- one last cleanup pass

These can be found in:
- `codegen/late/expander.py`
- `codegen/late/devectorizer.py`
- `codegen/late/gpudims.py`
- `codegen/simplify.py`

At the end of the rewrite chain, the UOp graph is linearized into a list of UOps to be run in a straight line.

Linearization happens in:
- `codegen/late/linearizer.py` 
- `renderer/init.py`

**4) Render to source**

Files involved:
- renderers, like `renderer/ptx.py` 
- `renderer/init.py`

The renderer (`tinygrad/renderer/*`) turns the linearized UOps into device source code (CUDA, HIP, etc). A `ProgramSpec` object is created. 

**5) Compile to binary**

Files involved:
- `engine/realize.py`
- `runtime/ops_*.py`

The device compiler compiles the source into a binary (`ProgramSpec.lib`). This is done via `CompiledRunner` in `tinygrad/engine/realize.py`. 

**6) Runtime launch**

`ExecItem.run()` calls the device runtime with buffers, global/local sizes, and variable values. The kernel actually runs on the GPU/CPU here. 

**7) Caching/JIT**

Files involved:
- `jit.py`

`get_runner` memoizes compiled programs based on the AST + context (including `BEAM`, `NOOPT`, `DEVECTORIZE` settings). If `TinyJit` is used, it captures kernels and replays them without recompiling. 

# BEAM search 

> https://github.com/tinygrad/tinygrad/pull/13836

Python 3.14 removed support for pickling `itertools` objects, which broke BEAM in tinygrad. Currently, BEAM pickles `Scheduler` objects and sends them to worker processes to be executed. This is an issue because the `Scheduler` contains an `itertools.count` that cannot be serialized:

```py
# tinygrad/codegen/opt/postrange.py:21
self.opt_range = itertools.count(start=max([x.arg[0] for x in self.rngs], default=0)+1)
```

This led me down a long rabbit hole into what BEAM actually does. It's one of the main reasons tinygrad is so fast. 

## What BEAM does

It runs many variants of every AST in your graph to find the one that runs fastest on your hardware. Think of it as auto-tuning at the kernel optimization level.

The parameters BEAM adjusts are:

| opt      | arguments                      | description                                                                         |
| -------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| UNROLL   | axis, amt                      | loop unrolling, i.e. `#pragma unroll`                                               |
| UPCAST   | axis, amt                      | like `float4` loads, later touched by devectorize                                   |
| LOCAL    | axis, amt                      | split work between threads in a workgroup                                           |
| GROUP    | axis, amt                      | parallelize reduce operations, inner axis inside outer loop                         |
| GROUPTOP | axis, amt                      | same as above, inner axis is above outer loop                                       |
| THREAD   | axis, amt                      | which globalizable axis becomes the thread index? `local` is workgroup size (block) |
| TC       | axis, (tc_select, tc_opt, use) | tensor core/wmma ops when device supports                                           |
| SWAP     | axis0, axis1                   | two `RANGE` nodes exchange axis IDs, only on global axes                            |
| PADTO    | axis, amt                      | pads loop axes (for tile sizes that require dimensions to be multiples), adds guard |
| NOLOCALS | NOLOCALS=1 (optional env var)  | disables local/shared memory axes                                                   |

(from `actions` in `tinygrad/codegen/opt/search.py`)

Keep in mind that all of these optimizations are run at the AST stage, before the kernel is linearized and rendered into a program.

## Examples of each optimization

**Unroll**

**Upcast**

**Local**

**Group**

**Grouptop** 

**Thread**

**TC** 

**Swap**

**PadTo**

**Nolocals**

## Examples of kernels optimized with BEAM

# pattern matchers + graph rewrites (the non-BEAM optimization path)

# undocumented environment variables

There are a lot of random environment variables scattered around the tinygrad codebase, and most of these aren't documented at all. These are incredibly useful for debugging, profiling, and understanding what's going on. Here's a list of all the ones I've found so far:

| variable            | range        | description                                                        |
| ------------------- | ------------ | ------------------------------------------------------------------ |
| IGNORE_BEAM_CACHE   | 0 or nonzero | always regenerate BEAM kernels                                     |
| CACHELEVEL          | 0 or nonzero | 0 disables disk cache                                              |
| TRACK_MATCH_STATS   | 0-3          | 1: basic tracking, 2: detailed trace data, 3: per-match timing     |
| CUDA_PTX            | 0 or nonzero | PTX codegen for Nvidia GPUs, use with `NV=1`                       |
| NOOPT               | 0 or nonzero | disables optimizations on the AST                                  |
| DEVECTORIZE         | 0 or nonzero | controls whether devectorization happens                           |
| HCQ_VISIBLE_DEVICES | device #     | on amd, choose which device is used by tinygrad. just try each one |
| AMD_LLVM            | 0 or nonzero | on amd, use the LLVM-IR -> machine code path instead of comgr      |


You can set some of these using the `with helpers.Context(VAR=n):` pattern, which is useful for only enabling certain features for part of a program, but it's not guaranteed to work with all settings. Either set them using `os.environ["VAR"] = "value"` at the start of the file or pass them when you run the program:

```bash
BEAM=1 TRACK_MATCH_STATS=2 python your_script.py
```


# random tweaks and issues

## multilib handled poorly in c.py

Some Linux distros are multilib, meaning they download and store 32-bit libraries alongside 64-bit ones, for applications like Steam. Fedora is one of them. A lot of tinygrad (essentially all the code that runs your kernels on the GPU) relies on FFI (calling C functions from Python). These libraries are imported in `tinygrad/runtime/support/c.py:42` (findlib). 

The issue is that on Fedora, /lib contains 32-bit libraries: 

```bash
boop@framework:/lib$ file libLTO.so.21.1
libLTO.so.21.1: ELF 32-bit LSB shared object, Intel i386, version 1 (SYSV), dynamically linked, BuildID[sha1]=574d091ee52fa7856759bc49c393f2c2a4636ae4, stripped
```

The 64-bit libs are actually at `/lib64` or `/usr/lib64/`. You have to patch `c.py` to scan these first, and exclude all 32-bit ELFs by checking the magic numbers. If you installed Cuda, add its libs to scanlist as well. 

## wrong rocm path in amd_disassemble

If you have a non-standard ROCm installation (your ROCm isn't in `/opt/rocm`), you'll get a few errors while running `VIZ=1`, especially during disassembly. You might also encounter this if you run code with `DEBUG>5`.

Patch `compiler_amd.py` and edit `amdgpu_disassemble` to change the default location of `llvm-objdump`. This can point to your system llvm install or to your custom ROCm build of llvm. 

## tinygrad editable install not working with lsp? 

If you install tinygrad with `uv pip install -e .`, it won't generate types and completions for your LSP. 

Run this instead: `uv pip install -e . --config-settings editable_mode=strict`.
