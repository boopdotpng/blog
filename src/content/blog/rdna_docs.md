---
title: "rdna docs"
pubDate: "2025-12-30"
published: true 
pinned: true 
description: "human readable explained rdna documentation"
cat: "code"
---

# rdna documentation 
This was taken from the RDNA3.5 ISA pdf. 

## states we need to keep track of 

### per program 
- Global memory (allocate 512mb box to start)
- Program counter (PC) points to first instruction when wave is created 

| State        | Description                                                         | Width / Range    |
| ------------ | ------------------------------------------------------------------- | ---------------- |
| TBA          | trap base address                                                   | 48-bit           |
| TMA          | Trap memory address                                                 | 48-bit           |

**a note about branch jumps** 
- branches jump to pc_of_the_instruction_after_the_branch + offset*4
- get_pc and swap_pc are relative to the next instruction, not the current one.
- all prior instructions have been issued but may or may not have completed execution

### state per wave 

| State        | Description                                                         | Width / Range    |
| ------------ | ------------------------------------------------------------------- | ---------------- |
| SGPRs        | scalar general purpose registers                                    | s0–s105          |
| VGPRs        | vector general purpose registers                                    | v0–v255 (32-bit) |
| LDS          | do we need to emulate cache? scratch ram                            | —                |
| EXEC         | top half not used in wave32                                         | 64-bit           |
| EXECZ        | exec is zero                                                        | 1-bit            |
| VCC          | vector condition code                                               | 64-bit           |
| VCCZ         | vcc is zero                                                         | 1-bit            |
| SCC          | scalar condition code                                               | 1-bit            |
| Flat_scratch | base address for scratch memory used this wave (overflow registers) | 48-bit           |
| M0           | misc reg                                                            | 32-bit           |
| TRAPSTS      | trap status                                                         | 32-bit           |
| TTMP0-TTMP15 | trap temporary SGPRs                                                | 32-bit           |
| VMcnt        | vmem load and sample instructions issued but not yet completed      | 6-bit            |
| VScnt        | vmem store instructions...                                          | 6-bit            |
| EXPcnt       | export/gds instructions (do we need this)                           | 3-bit            |
| LGKMcnt      | lds, gds, constant and message count                                | 6-bit            |

**PC**
Program counter: Next shader instruction to execute. Read/write only via scalar control flow instructions and indirectly using branch. 2 LSBs are forced to zero. (what does that mean?)

**EXECute Mask**

Controls which threads in the vector are executed. 1=execute, 0=do not execute. Exec can be read/written via scalar instructions. 
Can be written as a result of vector-alu compare. 

Exec affects: vector-alu, vector-memory, LDS, GDS, and export instructions. No effect on scalar execution / branches. 

Wave64 uses all 64 bits, wave32 only uses 31:0. 

*Instruction skipping (exec=0):*
**todo: this makes no sense right now**

**SGPRs**

106 normal SGPRs. vcc_hi and vcc_low are technically stored in SGPR 106 and 107. 

Alignment for SGPRs: 
- any time 64-bit data is used
- scalar memory reads when the address-base comes from an SGPR pair (loading in arguments, i guess) 

Other notes: 
- Writes to an out-of-range SGPR are ignored

**VCC**
Vector condition code written by V_CMP and integer vector add/sub instructions. vcc is read by many instructions. 
named SGPR pair, subject to same dependency checks (?) as toher SGPRs. 


**VGPRs**
Can be modeled by a 32-long array of 32-bit values. 

## data types 
- b32 (binary untyped 32-bit), this is not really used 
- b64
- f16
- f32
- f64. 
- bf16
- i8
- i16
- i32
- i64
- u16
- u32
- u64

## what changes in wave64 vs wave32

- Every thread gets u
- exec uses the entire 64 bits
- vcc uses the entire 64 bits 
- 