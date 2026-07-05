---
title: blackhole-py progress update
pubDate: "2026-07-03"
published: false
description: "blackhole-py progress update"
cat: tenstorrent
---

# preface
Progress has been slower than usual for the past month or two, mostly because most of the "easy" stuff has already been done, and now what remains are all the architectural decisions around the IR, microbenching certain parts of the card, and getting every sfpu and fpu instruction to execute and work properly. 

I spent quite a bit of time microbenching the NoC on blackhole, attempting to write a scheduler that could take a list of NoC operations and output arrival times for all packets, latency, bandwidth, and completion order reliably. Later, when we actually try to optimize kernels, this will be useful. The takeaway is that the NoC is really quite simple, and there are only a few "options" you can change when you use it. There was a blog post about it at one point, but it's not as interesting as I hoped. You can read documentation for the NoC (and other parts of blackhole) (here)[https://github.com/boopdotpng/tenstorrent-docs/tree/master/microbenching]. Ask your Claude to summarize it and explain it, there are detailed hardware outputs from a lot of different benchmarks in there that should give you a clear picture about how the NoC works–I think it has enough information for someone to write an implementation of it in Verilog. 

## llama3
> The current goal is to get llama3.2 1b to run on blackhole-py with (relatively) no major hacks. KV cache too. 

I want to do this pre-tinygrad integration because I'm not sure what an embedding gather or RoPE kernel would look like on blackhole, and beyond the matmul (it's faster than `ttnn` now!), I don't really know what kernels / ops are required to run llama. The bigger issue was that I never actually wrote or studied a transformer until about a week ago, so I had no understanding of what was actually happening in the forward pass. I wrote a transformer and attention from scratch in tinygrad, similar to llama3, and now it looks a lot more doable. 

Once we have llama3 working end to end, that gives me a list of all kernels and ops used, which I can convert into a nice `ttir` and make everything re-usable and composable instead of one-off kernels. More importantly, we'll have working implementations of 95% of operations that tinygrad requires from a backend. 