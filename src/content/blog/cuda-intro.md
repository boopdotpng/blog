---
title: "Intro to GPU programming: part 1"
pubDate: "2025-05-10"
published: true
contents_table: true
pinned: false
description: "A practical intro to GPU architecture and performance, building toward an efficient SGEMM kernel."
cat: "machine learning"
---

This post is an in depth overview on GPU architecture and how to write performant GPU code. It covers execution hierarchy, memory layout, scheduling, memory access patterns, and basic profiling. The goal is to build enough knowledge to write a SGEMM (single precision general matrix multiply) kernel that achieves 50% of theoretical GPU FLOPS. 

The specifics in this guide, including naming and the specific capabilities of each SM are tailored to Nvidia's Blackwell (GB203) generation of cards (specifically the 5070 Ti). 
## GPU Architecture Overview
This is a high level chart that shows the hierarchy of components in an Nvidia GPU. At the top is a GPC. The 5070 Ti includes 6 GPCs and 35 TPCs, which averages to about 6 TPCs per GPC. The distribution is intentionally uneven to accommodate performance tuning and chip layout constraints.

<svg viewBox="0 0 700 580" xmlns="http://www.w3.org/2000/svg" style="font-family: monospace; font-size: 14px; width: 100%">
  <!-- GPU Box -->
  <rect x="20" y="20" width="660" height="540" fill="#121212" stroke="#aaa" stroke-width="1.5"/>
  <text x="30" y="40" fill="#fff">GPU</text>

  <!-- GPC Box -->
  <rect x="40" y="60" width="620" height="320" fill="#2d2d4d" stroke="#aaa"/>
  <text x="50" y="80" fill="#fff">GPC (Graphics Processing Cluster)</text>

  <!-- TPC 1 -->
  <rect x="60" y="100" width="580" height="120" fill="#2d4d2d" stroke="#aaa"/>
  <text x="70" y="120" fill="#fff">TPC (Texture Processing Cluster)</text>
  <!-- SM Boxes in TPC 1 -->
  <rect x="80" y="130" width="260" height="80" fill="#4d2d2d" stroke="#aaa"/>
  <text x="90" y="150" fill="#fff">SM (Streaming Multiprocessor)</text>
  <rect x="360" y="130" width="260" height="80" fill="#4d2d2d" stroke="#aaa"/>
  <text x="370" y="150" fill="#fff">SM (Streaming Multiprocessor)</text>

  <!-- TPC 2 -->
  <rect x="60" y="240" width="580" height="120" fill="#2d4d2d" stroke="#aaa"/>
  <text x="70" y="260" fill="#fff">TPC (Texture Processing Cluster)</text>
  <!-- SM Boxes in TPC 2 -->
  <rect x="80" y="270" width="260" height="80" fill="#4d2d2d" stroke="#aaa"/>
  <text x="90" y="290" fill="#fff">SM (Streaming Multiprocessor)</text>
  <rect x="360" y="270" width="260" height="80" fill="#4d2d2d" stroke="#aaa"/>
  <text x="370" y="290" fill="#fff">SM (Streaming Multiprocessor)</text>

  <!-- L2 Cache Box -->
  <rect x="40" y="400" width="620" height="40" fill="#4d4d2d" stroke="#aaa"/>
  <text x="50" y="425" fill="#fff">L2 Cache — 48 MB, shared across all SMs</text>

  <!-- Global Memory Box -->
  <rect x="40" y="450" width="620" height="60" fill="#2d4d4d" stroke="#aaa"/>
  <text x="50" y="480" fill="#fff">Global Memory — 16GB GDDR7, off-chip DRAM</text>
</svg>

If you want to see a more comprehensive review of GPU architecture check out [High Yield's](https://www.youtube.com/@HighYield) videos on YouTube. He does a great job of showing where each element is on the physical GPU die. 

The purpose of the GPCs and TPCs is to organize SMs (the main compute of the GPU) into modular blocks that have their own memory, cache, instruction dispatch, and texture units. Without this abstraction, there would be excessive contention for global resources and scaling the chip across product tiers would be much more difficult. 

GPCs in traditional consumer GPUs also handle rasterization and graphics functions. In compute-only GPUs like the Nvidia H100, they may be optimized for throughput. For machine learning oriented workloads, this almost never comes into the picture. We're focused entirely on the SMs.
### Streaming Multiprocessors 
There are a lot of individual components that make up an SM: 

| Element                | Notes                                                                                                          | Count / Size Per SM |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------- |
| CUDA cores             | Scalar ALUs that can execute one FP32 or INT32 instruction per clock cycle, per core.                          | 128                 |
| Tensor cores           | Accelerates small matrix multiply-accumulate ops using mixed precision (FP16, BF16, TF32).                     | 4                   |
| Special Function Units | Handles transcendental and high-latency functions: sin, cos, exp, sqrt, etc.                                   | 4                   |
| Warp schedulers        | Manages instruction dispatch for one warp (32 threads) per cycle, directing execution to available CUDA cores. | 4                   |
| Load/Store units       | Interface for memory ops (load, store). Routes data to/from memory hierarchy.                                  | 8                   |
| Register file          | Fast, per-thread memory used for all intermediate values. Like CPU registers, but all 32-bit.                  | 256 KB              |
| Shared memory/L1 cache | Low-latency, per-SM memory. Shared memory is stored in L1 cache and is managed by the programmer.              | 128 KB              |

Most if not all of the compute on a GPU is done by CUDA cores. Some mixed precision datatypes (fp16, bf16, tf32, etc) are offloaded to other units within the SM (tensor cores for example), along with all exp, sin, cos-adjacent computations (on SFUs). 
### Execution model 
The GPU execution model follows a hierarchy; from bottom to top: 

A **thread** is the smallest unit of execution on the GPU. Every thread runs its own instance of the kernel function, with its operations independently scheduled on CUDA cores.

A **warp** is a fixed group of 32 threads (all from the same block) that are executed in lockstep under the SIMT (single instruction multiple thread) model. Each SM has 4 warp schedulers, each capable of issuing one instruction per cycle to a warp. In practice, the SM can track and switch between dozens of warps (active or stalled), depending on occupancy.

This is crucial for mitigating memory latency. If memory access is slow for one warp, it can be put aside and executed later once the data is ready. Context switching like this is extremely cheap on a GPU. It's also important to note that memory access requests are done per warp level, not per thread.

A **block** is a group of threads (up to 1024) that execute together and share memory. Blocks are assigned to individual SMs, and multiple blocks can be scheduled on the same SM if there are enough available resources (dependent on register and shared memory usage). The number of active threads and blocks per SM is known as occupancy. 

A **grid** is a collection of blocks that covers all blocks and threads launched by the kernel and spans the entire GPU. Blocks within a grid cannot communicate or share memory with each other. 

**Occupancy:**
Occupancy refers to how many warps can be actively scheduled on an SM at a time. It depends on resource usage per block: registers, shared memory, and thread count. Higher occupancy can help hide memory latency, but it’s not always correlated with performance.

This is how each part of the execution model maps to CUDA terms. Each parameter in the table is of type `dims3(x,y,z)`. 

| Parameter | Notes                               |
| --------- | ----------------------------------- |
| blockIdx  | Which block is this thread in?      |
| blockDim  | How many threads are in each block? |
| threadIdx | Where in the block is this thread?  |
| gridDim   | How many total blocks are there?    |
<svg viewBox="0 0 700 520" xmlns="http://www.w3.org/2000/svg" style="font-family: monospace; font-size: 14px; width: 100%">
  <!-- Outer Grid Box -->
  <rect x="20" y="20" width="660" height="470" fill="#121212" stroke="#aaa" stroke-width="1.5"/>
  <text x="30" y="40" fill="#fff">grid (1d) gridDim = 3</text>
  
  <!-- Block 0 -->
  <rect x="60" y="60" width="600" height="120" fill="#2d2d4d" stroke="#aaa"/>
  <text x="70" y="80" fill="#fff">Block 0 (x=0) blockDim = 3</text>
  <!-- Threads in Block 0 -->
  <rect x="100" y="100" width="160" height="60" fill="#2d4d2d" stroke="#aaa"/>
  <text x="110" y="130" fill="#fff">T0</text>
  <rect x="280" y="100" width="160" height="60" fill="#2d4d2d" stroke="#aaa"/>
  <text x="290" y="130" fill="#fff">T1</text>
  <rect x="460" y="100" width="160" height="60" fill="#2d4d2d" stroke="#aaa"/>
  <text x="470" y="130" fill="#fff">T2(threadIdx = 2)</text>

  <!-- Block 1 -->
  <rect x="60" y="200" width="600" height="120" fill="#2d2d4d" stroke="#aaa"/>
  <text x="70" y="220" fill="#fff">Block 1 (x=1) blockIdx = 1 for all threads</text>
  <!-- Threads in Block 1 -->
  <rect x="100" y="240" width="160" height="60" fill="#2d4d2d" stroke="#aaa"/>
  <text x="110" y="270" fill="#fff">T0 (gid = 3)</text>
  <rect x="280" y="240" width="160" height="60" fill="#2d4d2d" stroke="#aaa"/>
  <text x="290" y="270" fill="#fff">T1(threadIdx = 1)</text>
  <rect x="460" y="240" width="160" height="60" fill="#2d4d2d" stroke="#aaa"/>
  <text x="470" y="270" fill="#fff">T2</text>

  <!-- Block 2 -->
  <rect x="60" y="340" width="600" height="120" fill="#2d2d4d" stroke="#aaa"/>
  <text x="70" y="360" fill="#fff">Block 2</text>
  <!-- Threads in Block 2 -->
  <rect x="100" y="380" width="160" height="60" fill="#2d4d2d" stroke="#aaa"/>
  <text x="110" y="410" fill="#fff">T0 (gid = 6)</text>
  <rect x="280" y="380" width="160" height="60" fill="#2d4d2d" stroke="#aaa"/>
  <text x="290" y="410" fill="#fff">T1</text>
  <rect x="460" y="380" width="160" height="60" fill="#2d4d2d" stroke="#aaa"/>
  <text x="470" y="410" fill="#fff">T2</text>
</svg>

### Memory hierarchy

| Memory type          | Latency (cycles) | Bandwidth  |
| -------------------- | ---------------- | ---------- |
| Global (GDDR or HBM) | 400-800          | 0.8-1 TB/s |
| L2 cache             | 100-200          | 1-2 TB/s   |
| L1 cache/shared      | 20-40            | 1-2 TB/s   |
| Register file        | 1-4              | >10 TB/s   |

Accessing memory, especially global memory, is often orders of magnitude more expensive than compute. It's often the major bottleneck for performance. In the matrix multiplication examples later, you'll see that the actual compute doesn't change at all. We only make the memory access faster each kernel.  
#### Global memory 
Global memory is accessible to all SMs and represents the largest but slowest memory region on the GPU, typically implemented as off-chip GDDR6 or GDDR7 DRAM. It serves as the main interface between CPU and GPU, storing model weights, input datasets, and output buffers.

When you call `cudaMalloc`, the pointer returned points to a region in this memory.
#### L2 cache
L2 cache is a unified, on chip cache shared by all SMs. It sits between global memory and the SMs, buffering data to reduce access latency and minimize redundant memory traffic. 
#### L1 cache / shared memory 
L1 cache is a fast, low-latency memory local to each Streaming Multiprocessor (SM). On most NVIDIA GPUs, it shares physical space with shared memory, and the partition between the two can sometimes be configured (e.g., 48 KB shared / 16 KB L1, or 32 KB / 32 KB).

Shared memory is a software-managed memory space that lives on-chip. It can be explicitly allocated in a kernel using the `__shared__` keyword and is visible to all threads within the same block. It has significantly lower latency and higher bandwidth than global memory, making it ideal for data reuse within blocks.

**Shared memory bank conflicts:**
Shared memory is divided into 32 banks, each capable of servicing 4 bytes (a float) per clock cycle. You can think of these banks as lanes that operate in parallel. When all 32 threads in a warp access different banks in a given cycle, all memory requests are serviced in parallel -- this is the optimal, conflict free case. 

Each shared memory address (in bytes) maps to a bank using the formula: 
```cpp
bank = (address_in_bytes / 4) % 32
// or, for an array of floats: 
bank = float_index % 32
```

However, if multiple threads accesses different address that map to the same bank, a bank conflict occurs. These accesses are serialized, and each thread must wait its turn to access shared memory. For example, if all 32 threads access different rows of the same column in a row-major 2D array (which often maps to the same bank), the memory accesses will be serialized, significantly reducing performance. 

In most kernels, this isn't a massive bottleneck. Since shared memory is low latency (~40 cycles), the extra time added by conflicts is often negligible compared to compute or global memory access.

**Note:**
If multiple threads access the same address in the same bank, there is no conflict. The hardware can broadcast the result to all of the threads.

See the end of the post for a Nvidia video with more details.
#### Register file
Each SM has a large bank of 32-bit registers (around 128 KB) divided among its active threads. Registers are the fastest form of memory and are private to each thread.

The number of registers used per thread directly constrains occupancy: more registers per thread mean fewer threads per SM. At the low level (PTX or SASS), registers fall into categories (general-purpose, predicate, special), but these details are rarely relevant outside hand-tuned kernel work.
#### Memory coalescing 
Memory access on GPUs occurs at the warp level—each warp of 32 threads issues memory requests together. When threads access global memory, the hardware attempts to combine their individual requests into as few large transactions as possible, typically aligned 128-byte.

Coalescing is most efficient when threads access consecutive and properly aligned addresses (a float array accessed linearly). In such cases, the entire warp can be served with a single 128-byte transaction. When access patterns are irregular, misaligned, or sparse, the warp may generate multiple transactions, each with higher latency and lower throughput.

Efficient memory coalescing is key to reducing bandwidth waste and hiding global memory latency. We’ll revisit this in detail during the matrix multiplication section.
## Basic kernel example
A kernel launch consists of the following: 
1. A GPU kernel function
2. Number of blocks 
3. Number of threads per block
4. The data you want to write 
### 1D Dispatch 
 Consider the following kernel that adds two arrays `A+B` and stores the output in another array `C`. We'll assume that `len(a) = len(b) = len(c) = 1000`.
```cpp
__global__ void add(const float *a, const float *b, float *c) {
	int gid = blockIdx.x * blockDim.x + threadIdx.x;
	if (gid >= 1000) return;
	c[gid] = a[gid] + b[gid];
}
```

In this kernel, the first thread calculates `c[0] = a[0] + b[0]`, the second `c[1] = a[1] + b[1]`, and so on. This requires us to launch 1000 threads. 

To launch this kernel, we need to determine the launch configuration -- specifically the number of blocks and threads per block. 

The typical approach is to choose the number of threads per block, and then compute how many blocks are needed to cover the entire kernel. In this example, we'll choose 128 threads per block, which means we'll need 8 blocks to cover all 1000 threads (128 * 8 = 1024).  

So, for this launch: 
- gridDim = (8, 1, 1) (8 total blocks)
- blockDim = (128, 1, 1) (128 threads per block) 
- threadIdx = (0..127, 1, 1)
- blockIdx = (0..7, 1, 1)

The extra `1` dimensions are added by default if you don't specify them. Remember that these values are 3d (x, y, z). Going forward, if the dimension doesn't exist, I won't mention it. 

Looking at the `gid` calculation:
```cpp
int gid = blockIdx.x * blockDim.x + threadIdx.x;
```

We get the global id by multiplying which block the thread is in by how many total blocks there are, and then adding the position of the current thread in the block. This gives us the global position of the thread, relative to every other thread in the dispatch. Refer back to [[#Execution model]] for a visual.

All the parameters listed here are actually three dimensional, but since our data in this kernel is 1d, we only use one dimension. 2d and 3d dispatches are just abstractions over a 1d dispatch, and mostly exist to make indexing more convenient when you're operating on matrices. 

#### Over-launching and powers of 2
Due to the way GPU hardware is designed, you should use a power-of-two number for threads per block. This avoids having a partially unfilled warp, which hurts throughput. Even though this isn't strictly necessary, powers of two have several other advantages: 
- Promotes coalesced memory accesses, since addresses are more likely to be aligned and regularly spaced
- Enables faster index math, as bit shifting is cheaper than division or modulo
- Simplifies tiling (especially for a tiled matrix multiplication, which we will see later)

To prevent these extra threads from accessing out-of-bounds memory, we add a guard that exits the kernel if the thread number is more than 999.
```cpp
if (gid >= 1000) return;
```
#### Why 1d dispatch breaks down for 2d data
This style of indexing works very well when your data is 1 dimensional, but falls apart fast when you're working with 2d structures like matrices or images. Consider a `32x32` matrix stored in row-major order. We calculate the `gid` value the same way as last time, but now, since our data is 2d, we have to manually unflatten the index into a (row, col) pair. 
```cpp
int gid = blockIdx.x * blockDim.x + threadIdx.x;
int row = gid / width;
int col = gid % width;
```
This calculation wastes cycles on the GPU and introduces extra complexity to every kernel. It also makes the structure of the data hard to reason about. 2d dispatching aims to make this much simpler.
### Visualizing a 2d dispatch
To visualize 2d thread dispatch, we will write a kernel that records each thread's global (x,y) coordinate into a 2d matrix.
```cpp
__global__ void record_thread_coords(int* coords, int width) {
  int col = blockIdx.x * blockDim.x + threadIdx.x; 
  int row = blockIdx.y * blockDim.y + threadIdx.y;
  
  int idx = row * width + col; // flattened row-major index
  
  coords[2 * idx + 0] = col; 
  coords[2 * idx + 1] = row; 
}
```

The shape of `coords` is `(2,6,4)` represented as a flat `int[48]`: two values per cell `(row,col)` across a `6x4` thread grid. We need to launch 24 threads to cover the entire grid. Consider the following arrangement, where `blockDim = (2,2)`, `gridDim = (2,3)`, and `total_threads = 2*2*2*3 = 24`:  

<svg viewBox="0 0 560 580" xmlns="http://www.w3.org/2000/svg" style="font-family: monospace; font-size: 14px; width: 100%">
  <!-- Outer Grid Box -->
  <rect x="20" y="20" width="520" height="540" fill="#121212" stroke="#aaa" stroke-width="1.5"/>
  <text x="30" y="40" fill="#fff">grid (2d) gridDim = (2,3)</text>

  <!-- Block (0,0) -->
  <rect x="40" y="60" width="180" height="120" fill="#2d2d4d" stroke="#aaa"/>
  <text x="50" y="80" fill="#fff">Block (0,0)</text>
  <rect x="55" y="95" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="60" y="115" fill="#fff">(0,0)</text>
  <rect x="135" y="95" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="140" y="115" fill="#fff">(0,1)</text>
  <rect x="55" y="135" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="60" y="155" fill="#fff">(1,0)</text>
  <rect x="135" y="135" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="140" y="155" fill="#fff">(1,1)</text>

  <!-- Block (1,0) -->
  <rect x="240" y="60" width="180" height="120" fill="#2d2d4d" stroke="#aaa"/>
  <text x="250" y="80" fill="#fff">Block (1,0)</text>
  <rect x="255" y="95" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="260" y="115" fill="#fff">(0,2)</text>
  <rect x="335" y="95" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="340" y="115" fill="#fff">(0,3)</text>
  <rect x="255" y="135" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="260" y="155" fill="#fff">(1,2)</text>
  <rect x="335" y="135" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="340" y="155" fill="#fff">(1,3)</text>

  <!-- Block (0,1) -->
  <rect x="40" y="200" width="180" height="120" fill="#2d2d4d" stroke="#aaa"/>
  <text x="50" y="220" fill="#fff">Block (0,1)</text>
  <rect x="55" y="235" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="60" y="255" fill="#fff">(2,0)</text>
  <rect x="135" y="235" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="140" y="255" fill="#fff">(2,1)</text>
  <rect x="55" y="275" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="60" y="295" fill="#fff">(3,0)</text>
  <rect x="135" y="275" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="140" y="295" fill="#fff">(3,1)</text>

  <!-- Block (1,1) -->
  <rect x="240" y="200" width="180" height="120" fill="#2d2d4d" stroke="#aaa"/>
  <text x="250" y="220" fill="#fff">Block (1,1)</text>
  <rect x="255" y="235" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="260" y="255" fill="#fff">(2,2)</text>
  <rect x="335" y="235" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="340" y="255" fill="#fff">(2,3)</text>
  <rect x="255" y="275" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="260" y="295" fill="#fff">(3,2)</text>
  <rect x="335" y="275" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="340" y="295" fill="#fff">(3,3)</text>

  <!-- Block (0,2) -->
  <rect x="40" y="340" width="180" height="120" fill="#2d2d4d" stroke="#aaa"/>
  <text x="50" y="360" fill="#fff">Block (0,2)</text>
  <rect x="55" y="375" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="60" y="395" fill="#fff">(4,0)</text>
  <rect x="135" y="375" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="140" y="395" fill="#fff">(4,1)</text>
  <rect x="55" y="415" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="60" y="435" fill="#fff">(5,0)</text>
  <rect x="135" y="415" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="140" y="435" fill="#fff">(5,1)</text>

  <!-- Block (1,2) -->
  <rect x="240" y="340" width="180" height="120" fill="#2d2d4d" stroke="#aaa"/>
  <text x="250" y="360" fill="#fff">Block (1,2)</text>
  <rect x="255" y="375" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="260" y="395" fill="#fff">(4,2)</text>
  <rect x="335" y="375" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="340" y="395" fill="#fff">(4,3)</text>
  <rect x="255" y="415" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="260" y="435" fill="#fff">(5,2)</text>
  <rect x="335" y="415" width="70" height="35" fill="#2d4d2d" stroke="#aaa"/>
  <text x="340" y="435" fill="#fff">(5,3)</text>
</svg>

To illustrate the `col` and `row` calculations, let's go through the kernel for thread `2,3`.
`blockIdx = (1,1)` `blockDim = (2,2)` `threadIdx = (0,1)`. 
```cpp
int col = blockIdx.x * blockDim.x + threadIdx.x; 
int row = blockIdx.y * blockDim.y + threadIdx.y;
```

This gives a global thread position of `(row, col) = (3, 2)` computed as:
- `row = 1 * 2 + 1 = 3`.
- `col = 1 * 2 + 0 = 2`.
 
 ```
Output (coords array): 
(0,0) (0,1) (0,2) (0,3)
(1,0) (1,1) (1,2) (1,3)
(2,0) (2,1) (2,2) (2,3)
(3,0) (3,1) (3,2) (3,3)
(4,0) (4,1) (4,2) (4,3)
(5,0) (5,1) (5,2) (5,3)
```

You can see this example at [cuda-matmuls/misc/2d_dispatch_viz.cu](https://github.com/boopdotpng/cuda-matmuls/blob/master/misc/2d_dispatch_viz.cu).
## Matrix multiplication

### Theoretical matrix multiplication performance
Matrix multiplication is one of the most common dense compute kernels in machine learning. This section covers a series of increasingly optimized matrix multiplication kernels. [This](http://matrixmultiplication.xyz/) is the best way to visualize it. 

To find out how fast a matrix multiplication kernel can be on your GPU, you can use the `cuBLAS` library, which contains highly optimized kernels written by Nvidia. These kernels are fine tuned to extract the maximum performance from the hardware; it's extremely difficult to outperform a `cuBLAS` kernel.

All of the examples going forward will be multiplying two 4096x4096 matrices in single precision (SGEMM). 

Performance is measured in TFLOPS (trillion floating point operations per second). In order to calculate the theoretical maximum FP32 performance for my GPU (a 5070 Ti): 
- 70 SMs * 128 Cores per SM = 8960 Cuda Cores
- Each Cuda core performs 2 operations per clock cycle (FMA = fused multiply-add) 
- Boost clock: 2.45 GHz  = 2.45 * 10^9 cycles per second
- Equals approximately 44 TFLOPS. 

Now, let's estimate the number of operations required to multiply two square matrices of size 4096. Each of the `N^2` cells in matrix C requires a dot product between a row of A and a column of B, consisting of `N` multiplications and `N` additions. That’s `2N` floating point operations per entry, yielding a total of `2*N^3` FLOPs.

So the total number of operations is `2*4096^3 = 137,438,953,472`. 

TFLOPS = `(2*4096^3) / (execution time in seconds × 10^12)`

The `cuBLAS` kernel hovers around 34 TFLOPS on my GPU (77% of theoretical). You'll never get the advertised theoretical performance due to warp scheduling, memory access patterns, and many other factors. We'll compare all future kernels to the 34 TFLOPS max instead of the theoretical 44 TFLOPS because it's a much more realistic estimate of how fast our kernel could be.
### Matrix multiplication on CPU
The most straightforward `N*N` square matrix multiplication goes like this: 
```cpp
float A[N][N], B[N][N], C[N][N];
for (int i = 0; i < N; i++)
  for (int j = 0; j < N; j++) {
    float acc = 0.0;
    for (int k = 0; k < N; k++)
	  acc += A[i][k] * B[k][j];
    C[i][j] = acc;
}
```

For each output cell in C, we calculate the [dot product](https://en.wikipedia.org/wiki/Dot_product) of row `i` from matrix A and column `j` from matrix B. This is an incredibly slow way to multiply matrices: the time complexity is `O(n^3)` and it only achieves around 0.019 TFLOPS for a 1024x1024 matrix. This example is missing SIMD instructions, use of multiple cores, cache-friendly access for B (memory access not coalesced), to name a few. 

Numpy delegates matrix multiplication to high performance BLAS libraries, which use multithreading and SIMD. They're extremely optimized, and a good way to figure out how far you are from the theoretical performance of your CPU. 
```bash
OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 OMP_NUM_THREADS=1 python -c "import numpy as np, time; N=4096; A=np.random.rand(N,N).astype(np.float32); B=np.random.rand(N,N).astype(np.float32); t0=time.time(); C=A@B; t1=time.time(); flops=2*N**3; dt=t1-t0; print(f'Time: {dt:.4f} s, GFLOPS: {flops/dt/1e9:.2f}')"
```
This gets around 0.3 TFLOPS on my Ryzen 7 9700x (one core). For multi-threaded performance, just remove the environment variables (1.4 TFLOPS).
### The simplest GPU matrix multiplication 
This code is a copy of the CPU matrix multiplication code, with the outer loops replaced by thread indexing. Each thread computes a single element in the output matrix `C`. 

Since the matrix is 4096×4096, we launch 16,777,216 threads total. Using 256 threads per block (`blockDim = (16, 16)`), we require 65,536 blocks (`gridDim = (256, 256)`).

The launch configuration is two dimensional: 
`blockDim = (16,16)`  -> 256 threads per block,
`gridDim = (256,256)`  -> 65,536 total blocks.
```cpp
__global__ void matmul(const float *a, const float *b, float *c) {
    uint row = blockIdx.y * blockDim.y + threadIdx.y;
    uint col = blockIdx.x * blockDim.x + threadIdx.x;
    float sum = 0.0f;
    for (uint i = 0; i < N; ++i)
        sum += a[row * N + i] * b[i * N + col];
    c[row * N + col] = sum;
}
```

This hovers around 2.7 TFLOPS (7.9% of theoretical).
#### Uncoalesced memory access
To highlight the performance impact of global memory access patterns, here’s a version of the matmul kernel where `b` is accessed differently. To preserve correctness, `b` must be transposed so that each of its columns becomes a row in memory. This allows column access via row-major indexing:
```cpp
__global__ void matmul_uncoalesced(const float *a, const float *bt, float *c) {
    uint row = blockIdx.y * blockDim.y + threadIdx.y;
    uint col = blockIdx.x * blockDim.x + threadIdx.x;
    float sum = 0.0f;
    for (uint i = 0; i < N; ++i) {
		sum += a[row * N + i] * bt[col * N + i];
		//                      this changed
    }
    c[row * N + col] = sum;
}
```

This kernel hovers around ~0.6 TFLOPS (1.7% of theoretical). 

`ncu` is the one of the best ways to understand what the bottleneck is for a particular kernel. You can see SM throughput, number of cycles, DRAM bandwidth, and a lot of other important statistics. To verify that this kernel is memory bottlenecked, we can read the `ncu` report: 

| Metric                     | Value       | Unit   |
| -------------------------- | ----------- | ------ |
| Compute (SM) Throughput    | 21.79       | %      |
| Memory Throughput          | 98.06       | %      |
| DRAM Throughput            | 7.52        | %      |
| Elapsed Cycles             | 5.63281e+08 | cycles |
| Average SM Active Cycles   | 5.62532e+08 | cycles |
| Average L1 Active Cycles   | 5.62532e+08 | cycles |
| Average L2 Active Cycles   | 5.04343e+08 | cycles |
| Average DRAM Active Cycles | 2.54577e+08 | cycles |

The key takeaways here are: 
- Compute throughput is only 22%, meaning nearly 80% of cycles are spent not executing useful instructions 
- DRAM throughput is only 7.52%. Even though the kernel is spending significant time waiting on memory, actual data throughput is low dude to inefficient memory access patterns. The memory requests are scattered.
- L2 sees significantly fewer cycles than L1. Since L2 sits between global memory and the SMs, this means that the global memory accesses are not being cached. 
- DRAM was active for ~45% of the kernel duration, meaning nearly **half** the time is spent waiting on global memory. 

The root cause of the memory issues is this line: 
```cpp
sum += a[row * N + i] * bt[col * N + i];
```
The most important question to ask when thinking about memory coalescing is "Are threads in a warp accessing adjacent memory?". In this case, `col` changes by 1 for every thread in a warp, which makes the index of `bt` jump by `N` every thread. Every thread in the warp is accessing a memory location `N` floats away from the previous one. 

In the original kernel, we had: 
```cpp
sum += a[row * N + i] * b[i * N + col];
```

Here, the key difference is the index of `b` only increases by 1 each warp, which means that adjacent threads in a warp access adjacent memory. This is why the original kernel is faster. 

The reason `B` is the performance bottleneck instead of A is that threads are assigned to warps in row-major order, meaning that 32 values of `threadIdx.x` increase before incrementing `threadIdx.y`. So, `col` changes per thread in each warp, but `row` varies much less.  With our current `16x16` block size: 

| Warp | ThreadIdx.y | ThreadIdx.x Range |
| ---- | ----------- | ----------------- |
| 0    | 0           | 0–15              |
|      | 1           | 0–15              |
| 1    | 2           | 0–15              |
|      | 3           | 0–15              |
| 2    | 4           | 0–15              |
|      | 5           | 0–15              |
| 3    | 6           | 0–15              |
|      | 7           | 0–15              |

All threads in a warp access the same or adjacent `row` values. Looping over `i` accesses contiguous memory, and there stride is 1 across threads. `col`(dependent on `threadIdx.x`) is different for every thread in the warp.
#### NCU comparison table
Here is a table comparing profiling results from the two kernels. 

| Metric              | matmul  | matmul_uncoalesced | Unit  |
| ------------------- | -------- | ------------------ | ----- |
| SM Throughput       | 92.33    | 21.79              | %     |
| DRAM Throughput     | 33.58    | 7.52               | %     |
| L2 Cache Throughput | 28.38    | 9.01               | %     |
| Duration            | 57.95    | 245.92             | ms    |
| Total DRAM Cycles   | 6.39e+09 | 2.71e+10           | cycle |
| Total L2 Cycles     | 2.86e+09 | 1.21e+10           | cycle |

The key differences to note: 
- SM throughput increased to 92% (~4.2x higher), indicating that the GPU is now spending most of its time performing computations rather than stalling on memory accesses.
- Memory system cycles have gone down almost 5x.
- L2 cache throughput has gone up. Since we made our memory access more linear and predictable, more of our global reads can be cached and reused.
- DRAM throughput is up ~4.5x. By transposing matrix B, we enabled coalesced memory access, allowing adjacent threads to read adjacent memory locations.
### Tiled matmul 
In the previous kernel, every thread computed one element from the output matrix by loading: 
- A full row of `A` from global memory
- A full column of `B` from global memory
```cpp
for (uint i = 0; i < N; ++i)
	sum += a[row * N + i] * b[i * N + col];
```

Since many threads access overlapping rows and columns, the same values are repeatedly fetched from global memory thousands of times. This is extremely wasteful, because values fetched here are not reused across threads and most likely end up being read from L2 cache (or global memory if the value is not cached).

**Solution: shared memory tiling** 
Shared memory (fast, on chip L1) allows a thread block to load and reuse data. Instead of every thread individually accessing global memory: 
1. We divide the matrix into tiles (16x16 blocks) 
2. Every block loads one tile of A and one tile of B into shared memory. 
3. All threads in that block compute partial products using only shared memory
4. This process is repeated until the full dot product is accumulated 

By doing this, each value from `A` and `B` is loaded from global memory once per tile instead of once per thread. Every thread in the naive kernel would load `N*2` values from global memory (one row of `A` and one column of `B`). With shared memory tiling, every value in a tile of `A` and `B` is loaded once per block and reused by all `TILE*TILE` threads in that block. It's an order of magnitude fewer global memory accesses. 

See the end of the post for a visualization of cache and memory usage for a tiled matmul kernel with shared memory. 

The launch parameters for this kernel are the same as the previous one. We're still launching one thread per output cell in C, and since each block is responsible for calculating a `16x16` tile of C, we have to launch 256 threads per block. `gridDim = (N/16, N/16)`, same as before. 

```cpp
__global__ void tiled_matmul(const float *a, const float *b, float *c) {
    const uint row = blockIdx.y * blockDim.y + threadIdx.y;
    const uint col = blockIdx.x * blockDim.x + threadIdx.x;
    __shared__ float tile_a[TILE][TILE];
    __shared__ float tile_b[TILE][TILE];

    float acc = 0.0f;
    for (int tile_idx = 0; tile_idx < N; tile_idx += TILE) {
      tile_a[threadIdx.y][threadIdx.x] = a[row * N + (tile_idx + threadIdx.x)];
      tile_b[threadIdx.y][threadIdx.x] = b[(tile_idx + threadIdx.y) * N + col];
      __syncthreads();

      for (int k = 0; k < TILE; ++k)
        acc += tile_a[threadIdx.y][k] * tile_b[k][threadIdx.x];
	  
      __syncthreads();
    }
    c[row * N + col] = acc;
}
```

Step by step: 
```cpp
 const uint row = blockIdx.y * blockDim.y + threadIdx.y;
 const uint col = blockIdx.x * blockDim.x + threadIdx.x;
 // global row and column of C that this thread writes to
```

```cpp
 for (int tile_idx = 0; tile_idx < N; tile_idx += TILE) {
	tile_a[threadIdx.y][threadIdx.x] = a[row * N + (tile_idx + threadIdx.x)];
	tile_b[threadIdx.y][threadIdx.x] = b[(tile_idx + threadIdx.y) * N + col];
	__syncthreads();
```

This loop goes through the tiles horizontally (only 1d) because the col is determined by the global `row` and `col` variables. To visualize this better, we'll simulate this part of the kernel for a `4x4` matrix with 4 `2x2` tiles.
$$
A = \begin{pmatrix}
a_{00} & a_{01} & a_{02} & a_{03} \\
a_{10} & a_{11} & a_{12} & a_{13} \\
a_{20} & a_{21} & a_{22} & a_{23} \\
a_{30} & a_{31} & a_{32} & a_{33}
\end{pmatrix}
,\quad
B = \begin{pmatrix}
b_{00} & b_{01} & b_{02} & b_{03} \\
b_{10} & b_{11} & b_{12} & b_{13} \\
b_{20} & b_{21} & b_{22} & b_{23} \\
b_{30} & b_{31} & b_{32} & b_{33}
\end{pmatrix}

$$
Every block in this kernel calculates a `2x2` tile of C. Assume we're simulating the block that calculates the tile containing $C_{20},C_{21},C_{30},C_{31}$ (`blockIdx = (0,1)`). 

To determine which tiles from A and B we need to calculate the bottom left tile of `C`, consider which rows and columns of A and B you would need to calculate each element individually: 

| Element in C | Row from A | Column from B |
| ------------ | ---------- | ------------- |
| $C_{20}$     | 2          | 0             |
| $C_{21}$     | 2          | 1             |
| $C_{30}$     | 3          | 0             |
| $C_{31}$     | 3          | 1             |

So you would need rows 2,3 from A and columns 0,1 from B. If we think about these like 2x2 tiles, you realize that we need the bottom half of A and the left half of B.
$$
\left[
\begin{array}{cc|cc}
a_{20} & a_{21} & a_{22} & a_{23} \\
a_{30} & a_{31} & a_{32} & a_{33}
\end{array}
\right]
$$
$$
\left[
\begin{array}{cc}
b_{00} & b_{01} \\
b_{10} & b_{11} \\
\hline
b_{20} & b_{21} \\
b_{30} & b_{31}
\end{array}
\right]
$$
Each thread in the block loads and multiplies elements from these tiles to calculate the value of C at the global row and column. During the first iteration where `tile_idx = 0` we load tiles: 
$$
tileA = \begin{pmatrix}
A_{20} & A_{21}  \\
A_{30} & A_{31} \\
\end{pmatrix}
,\quad
tileB = \begin{pmatrix}
B_{00} & B_{01}  \\
B_{10} & B_{11} \\
\end{pmatrix}
$$
The `__syncthreads()` instruction is the key component in this kernel. This instructs the GPU to wait for all threads in the block to reach this point before proceeding. It's important because the compute loop depends on all the data being loaded from global memory to the shared tiles. If you omit it, the accumulation loop will multiply tiles before all the threads have finished loading data.

Then, we compute: 
```cpp
for (int k = 0; k < TILE; ++k)
	// just a row from tile A times a column from tile B
	acc += tile_a[threadIdx.y][k] * tile_b[k][threadIdx.x];
__syncthreads();
```
> **A quick note on access patterns:** <br>
> While tile_b[k][threadIdx.x] can lead to minor bank conflicts due to column-wise access, the impact is typically small for float loads at this tile size. Optimizing further would require interleaved layouts or padding, which isn’t worth it here.

At this point, here is what we've added to `acc` for each thread. Keep in mind that `acc` is the final scalar value that every thread writes to C.  
- $C_{20}$ += $A_{20} \times B_{00} + A_{21} \times B_{10}$
- $C_{21}$ += $A_{20} \times B_{01} + A_{21} \times B_{11}$
- $C_{30}$ += $A_{30} \times B_{00} + A_{31} \times B_{10}$
- $C_{31}$ += $A_{30} \times B_{10} + A_{31} \times B_{11}$

It's partial because we haven't added the values from the second iteration of the loop, where `tile_idx = 2`. We're missing the last two tiles (or half of each row and column):
$$
tileA = \begin{pmatrix}
A_{22} & A_{23}  \\
A_{32} & A_{33} \\
\end{pmatrix}
,\quad
tileB = \begin{pmatrix}
B_{20} & B_{21}  \\
B_{30} & B_{31} \\
\end{pmatrix}
$$
We do the same computation and add the following values to `acc`: 
- $C_{20}$ += $A_{20} \times B_{20} + A_{21} \times B_{30}$
- $C_{21}$ += $A_{20} \times B_{21} + A_{21} \times B_{31}$
- $C_{30}$ += $A_{30} \times B_{20} + A_{31} \times B_{30}$
- $C_{31}$ += $A_{30} \times B_{21} + A_{31} \times B_{31}$

Now we've added the full dot product for each square to `acc`.

The second `__syncthreads()` is necessary because the tiles are overwritten every loop iteration. If we omit it, threads from different iterations could write to shared memory while we're accumulating, leading to race conditions and incorrect data. 

This kernel hovers around 3.9 TFLOPS (11.4% of theoretical) with 16x16 tiles.
#### 32×32 tile size and SM occupancy
Increasing the tile size (from 16 to 32) reduces global memory reads because there are fewer tiles and more data can be reused, but it comes at a cost. Each block now uses 4× more shared memory and launches 1024 threads (vs 256), which increases register pressure and limits how many blocks can fit on an SM. Performance drops to ~3.4 TFLOPS (vs. ~3.9 TFLOPS for `TILE=16`).

| Metric                      | TILE=16 | TILE=32 | Unit  |
| --------------------------- | ------- | ------- | ----- |
| Achieved Occupancy          | 99.71   | 66.72   | %     |
| Block Limit Shared Mem      | 21      | 1       | block |
| Block Limit Registers       | 6       | 1       | block |
| Static Shared Mem Per Block | 2.05    | 8.19    | KB    |
| Shared Mem Config Size      | 65.54   | 16.38   | KB    |
| Compute Throughput          | 96.17   | 74.75   | %     |
| L2 Cache Throughput         | 26.65   | 11.81   | %     |
| DRAM Throughput             | 47.63   | 19.01   | %     |

With `TILE=32`, occupancy tanks, only one block fits per SM, and compute throughput drops by ~20%. DRAM and L2 usage fall as expected, because shared memory reuse is higher.

The shared memory config (amount of shared memory per block) is lower for `TILE=32` because CUDA dynamically adjusts the shared:L1 split based on occupancy, register pressure, and shared memory usage. When shared usage is low (`TILE=16`), the driver defaults to a ~64K shared / 64K L1 split. But when more shared is needed (`TILE=32`) or register pressure is extremely high, it carves out only what’s required (~16KB) and gives the rest (~112KB) to L1. 
### Optimizations & part 2
Part 2 of this blog will push the performance of this kernel even further. We'll start reading PTX (Nvidia's GPU IR), examining assembly, and do more detailed profiling to understand how the previous kernel can be improved. We'll also compare our kernel to Tinygrad and PyTorch's code generation.
## Further reading
- [George Hotz - how do GPUs work?](https://youtu.be/OUzm06YaUsI) 
- [George Hotz - can you multiply a matrix?](https://youtu.be/VgSQ1GOC86s) 
- [GitHub repository](https://github.com/boopdotpng/cuda-matmuls)
- [modal.com gpu glossary](https://modal.com/gpu-glossary) 
- [Nvidia Blackwell Architecture Whitepaper](https://resources.nvidia.com/en-us-blackwell-architecture)
- [High Yield: 5090 deep dive](https://youtu.be/rCwgAGG2sZQ)
- [Visualization of cache/memory used for shared memory matmul kernel](https://x.com/Hesamation/status/1920141361531040152) 
- [Peter Messmer - Nvidia: Shared Memory Accesses](https://www.youtube.com/watch?v=qOCUQoF_-MM)
