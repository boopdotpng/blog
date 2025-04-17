---
title: "nn.conv2d in tinygrad"
pubDate: "2025-04-16"
description: "how does conv2d work in tinygrad?"
cat: "machine learning"
---

**Input**: shape $(N, C_{in}, H, W)$ where $N$: batch size, $C_{in}$: input channels (3 for RGB images), and $H$,$W$: height and width of the image. 

**Weights**: shape $(C_{out}, C_{in}, K_h, K_w)$ where $C_{out}$ = number of filters (output channels) and $K_h, K_w$: kernel dimensions. 

For an 3-channel image and a 3x3 kernel size, each kernel is $(3,3,3)$. Each kernel slides across the whole image (all input channels) and computes a single output channel. Think of each kernel as a specialized feature detector. One might detect horizontal edges, one might detect vertical edges. 

**Bias**: shape $(C_{out},)$ (one bias per filter). The bias here works the same way as the bias in the linear layer. It's just a scalar quantity added on after summing the contributions from the input channels at each position. Each output channel has its own bias. If you have a batch norm layer right after a convolution, you can remove the convolution layer's bias. See [[nn.py#nn.BatchNorm]] for more information. 

For every output pixel: $\text{output}(h, w) = \text{weighted sum} + \text{bias}$

**Output**: shape $(N, C_{out}, H', W')$ where 
$$ 
H' = \frac{H - K_{h} + 2P}{S} + 1,\quad W'=\frac{W - K_{w} + 2P}{S} + 1
$$
$P$: padding, $S$: stride

Intuitively, at every output pixel $(h,w)$, 
1. the kernel (filter) is centered over a region of the input (a patch)
2. the input patch (all channels) is 
	1. multiplied element-wise with the kernel (filter weights)
	2. summed to compute a **single value** (dot product)
3. the bias is added to this sum. 
4. This resulting value becomes the output pixel at $(h,w)$. 

**Example**
*Assume for these examples that the input patch has been duplicated three times (i.e there are three or more channels in each image that are also included in the dot product)*.
This will be important later when we discuss groups. 

Input patch = $\begin{bmatrix}1&2\\3&4\end{bmatrix}$
Kernel: $\begin{bmatrix}0&1\\1&0\end{bmatrix}$
Bias: $1$

dot product: $(1 \cdot 0) + (2 \cdot 1) + (3 \cdot 1) + (4 \cdot 0) = 5$
add bias: $5+1=6$ 

so, the pixel at $(h,w) = 6$. 

This calculation is repeated for every pixel in the image by sliding the kernel over the input. This is where padding and stride become important. Padding adds a border of zeros around the input, to preserve spatial dimensions. Without padding, the output size would shrink too quickly, since convolutions slice off the edges of the image. 

Our previous input patch, with padding = 1: 

$\begin{bmatrix}0&0&0&0\\0&1&2&0\\0&3&4&0\\0&0&0&0\end{bmatrix}$

Stride controls how far the kernel moves after each step. With stride=1, the kernel moves one pixel at a time, which leads to a lot of overlap. Example (stride=2)

Overlay kernel at $(0,0)$:
$\begin{bmatrix}1 & 2 \\ 4 & 5\end{bmatrix}$

dot product: $(1\cdot1) + (2\cdot0) + (4\cdot0) + (5\cdot-1) = -4$

Overlay kernel at $(0,2)$:
$\begin{bmatrix}3 \\ 6\end{bmatrix}$

dot product: $(3\cdot1) + (6\cdot-1) = -3$

Then we would add the bias. Keep in mind that increasing the stride reduces the size of the output image. We can use padding to somewhat mitigate this.

There's one last parameter for conv2d called dilation. Dilation inserts zeros into the kernels. It increases the area of the input that the kernel sees without actually increasing the number of parameters in the kernel. A 3x3 kernel with dilation 1 has $(d-1)$ zeroes between each kernel parameter. 

$\begin{bmatrix}w_{11} & 0 & w_{12} & 0 & w_{13} \\0 & 0 & 0 & 0 & 0 &  \\ w_{21} & 0 & w_{22} & 0 & w_{23} \\ 0 & 0 & 0 & 0 & 0  \\ w_{31} & 0 & w_{32} & 0 & w_{33} \end{bmatrix}$


Nope, there's actually on more parameter called `groups`. In a standard convolution, like I described above, every input channel contributes to each output channel. If you set `groups=3`, for example, the input channels are split into 3 groups (one for red, green and blue if you're dealing with an image). Each group has its own separate set of filters, which only operate on their assigned channels. The outputs from these groups are concatenated together. This drastically reduces computation, the number of parameters, and lets the model learn separate sub-features (color, texture, etc). There are three common uses for groups.

1. **depthwise convolutions (groups = $C_{in}$)**:
	1. each input channel has its own dedicated filter
	2. used in MobileNet
2. **grouped convolutions (1 < groups < $C_{in}$) **
	1. acts like multiple parallel convolutions over different channel subsets.
3. **pointwise ($1\cdot{1}$) convolutions after depthwise (dw + pw convolutions)**
	1. a depthwise convolution captures spatial information separately for each channel
	2. then a $1\cdot{1}$ convolution (fully connected across channels) re-mixes everything.

Groups also changes the output shape. 

Now we can look at tinygrad's `Tensor.conv2d`. There are three branches in this conv2d function.  One branch is for image convolutions (we will look at this later), one is for winograd convolutions, and one is for regular convolutions that don't fall into the above categories (general convolutions). 

Padding is determined using the [[tensor.py#_resolve_pool_pads]] function. Then we check if the number of groups are 
The result from `Tensor.imageconv2d` is returned when the `IMAGE` environment variable is set. Not sure why this exists or what it does differently from the traditional implementation. 

**Normal Convolution**
It's interesting to note that tinygrad's conv2d supports more than 2 dimensions. 



**Winograd convolutions**
This is a specially optimized convolution specifically for 3x3 matrices with stride 1 and dilation 1. It also depends on `WINO`, which is read from the environment variables. 
