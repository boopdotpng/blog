---
title: "tinygrad notes"
pubDate: "2025-08-15"
published: true
pinned: true
contents_table: true
description: "quick notes and links while exploring tinygrad internals."
cat: "programming"
---

# rough progression of a tinygrad tensor operation 

**1) Tensors are just Uop graphs**

- Tensor.py
- uop/ops.py

Tensors are just a thin wrapper over Uops. Every tensor operation is just a Uop (or set of Uops) that's injected into the current Uop graph.

**2) Schedule creation (kernel partitioning)**

- engine/schedule.py
- schedule/__init__.py
- rangeify.py

Each Uop graph turns into one or more kernel ASTs (rooted at Ops.SINK). Every kernel becomes an ExecItem with its own AST and buffers. 

**3) Kernel AST rewrite + optimization**

- codegen/init.py
- postrange.py
- opt/search.py (BEAM)

Kernel ASTs are re-written and optimized based on rewrite rules defined in `PatternMatchers`. These are scattered all around the codebase and re-write portions of the Uop graph: movement ops, range splitting, constant folding, etc. 

`apply_opts` applies optimizations to the AST. This path varies based on the BEAM environment variable. 

BEAM on: 
BEAM search happens. See the BEAM section below.

BEAM off: 
A bunch of hand-written optimizations are applied to each AST. See the pattern-matchers section below (todo). 

More rewrites happen after this: 
  - expander 
  - devectorizer 
  - gpudims
  - lower index dtype
  - decompositions 
  - final rewrite

These can be found in
  - codegen/late/expander.py
  - codegen/late/devectorizer.py
  - .../gpudims.py
  - codegen/simplify.py

At the end of the rewrite chain, the Uop graph is linearized into a list of Uops to be run in a straight line.

Linearization happens in
  - codegen/late/linearizer.py 
  - renderer/init.py

**4) Render to source**

- renderers, like renderer/ptx.py 
- renderer/init.py

The renderer (`tinygrad/renderer/*`) turns the linearized Uops into device source code (CUDA, HIP, etc). 

**5) Compile to binary**

- engine/realize.py
- runtime/ops_*.py

The device compiler compiles the source into a binary (ProgramSpec.lib). Done via CompiledRunner in `tinygrad/engine/realize.py`. 

**6) Runtime launch**

`ExecItem.run()` calls the device runtime with buffers, global_local sizes, and variable values. The kernel is run on the GPU/CPU here. 

**7) Caching/JIT**

- jit.py

`get_runner` memorizes compiled programs based on the AST + context (including BEAM, NOOPT, DEVECTORIZE). If TinyJit is used, it captures kernels and replays them without re-compiling. 

# BEAM search 

> https://github.com/tinygrad/tinygrad/pull/13836

Python 3.14 removed support for pickling Itertools objects, which broke BEAM in tinygad. BEAM pickles Scheduler objects and sends them to worker processes to be executed. The particular line that fails: 

```py
# tinygrad/codegen/opt/postrange.py:21
self.opt_range = itertools.count(start=max([x.arg[0] for x in self.rngs], default=0)+1)
```

This led into a long rabbit hole into what BEAM actually does. It's one of the main reasons tinygrad is so fast. 

It runs many variants of every AST in your graph to find the one that runs fastest on your hardware. 

The parameters adjusted are

| opt      | arguments                                  | description |
| -------- | ------------------------------------------ | ----------- |
| UNROLL   | axis, amt                                  | 
| UPCAST   | axis, amt                                  |
| LOCAL    | axis, amt                                  |
| GROUP    | axis, amt                                  |
| GROUPTOP | axis, amt                                  |
| THREAD   | axis, amt                                  |
| TC       | tc_select, tc_opt, use                     |
| SWAP     | axis0, axis1                               |
| PADTO    | axis, amt                                  |
| NOLOCALS | NOLOCALS=1 (optional environment variable) |

(from *actions* in `tinygrad/codegen/opt/search.py`)

Keep in mind that all of these optimizations are run at the AST stage, before the kernel is linearized and rendered into a program. For reference, here is a Uop graph for a 

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


## examples of kernels optimized with beam 


# pattern matchers + graph rewrites (the non beam optimization path)



# undocumented environment variables

There are a lot of random environment variables scattered around the tinygrad codebase, and most of these aren't documented at all. These are incredibly useful for debugging, profiling, and understanding what's going on. Here is a list of all the ones I've found so far. 


| variable          | range        | description                                                    |
| ----------------- | ------------ | -------------------------------------------------------------- |
| IGNORE_BEAM_CACHE | 0 or nonzero | always regenerate beam kernels                                 |
| CACHELEVEL        | 0 or nonzero | disable all cache                                              |
| TRACK_MATCH_STATS | 0-3          | 1: basic tracking, 2: detailed trace data, 3: per-match timing |
| CUDA_PTX          | 0 or nonzero | PTX codegen for Nvidia GPUs, use with NV=1                     |

You can set some of these using the `with helpers.Context(VAR=n):` pattern, which is useful for only enabling certain features for part of a program, but it's not guaranteed to work with all settings. Either set them using `os.environ["n"] = ""` at the start of the file or pass them when you run the program. 