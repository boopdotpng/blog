---
title: "Reverse engineering the Crane 3s"
pubDate: "2025-07-21"
published: true
description: "Controlling the Crane 3s using raw bluetooth packets."
cat: "programming"
---

Short post, but if anyone bought a Crane 3s and wants to control it without using the ZY play app, here's how: [github](https://github.com/boopdotpng/crane3s-reversed).

This was quite an interesting and challenging journey. The structure of the packets and the checksum took a while to figure out, but otherwise this was a very straightforward reverse engineering effort. 

This [article](https://petermaguire.xyz/posts/zhiyun-weebil-s-ble-protocol/) by Peter Maguire covers most of the initial effort, including using Android's Bluetooth HCI snoop functionality to read all the packets being sent to the Crane 3s. However, I think it includes a lot of unnecessary information and gets the packet structure slightly wrong. He also doesn't go over how to generate the checksum for the packets, meaning you're stuck just replaying whatever packets are sent by the app instead of being able to finetune the speed and timing (by generating your own packets). 

## how it works (i think)
Here's how I think each packet is structured: 

### frame breakdown
| **Byte Range** | **Field**        | **Description**                                             |
| -------------- | ---------------- | ----------------------------------------------------------- |
| `0–1`          | `24 3C`          | **Header / magic value** (always fixed)                     |
| `2–3`          | `08 00`          | **Payload length** (always `8`, little-endian)              |
| `4–5`          | `18 12`          | **Command group** — always this for motion control          |
| `6`            | Sequence number  | Increments with every packet (wraps at 255)                 |
| `7`            | Sub-command type | Always `01` = "joystick axis update"                        |
| `8`            | Axis ID          | `01` = **Tilt**, `02` = **Roll** (centred), `03` = **Pan**  |
| `9`            | Frame type       | Always `10` = interpreted as absolute target position/speed |
| `10–11`        | Axis value (LE)  | 2-byte **axis deflection value** (see below)                |
| `12–13`        | CRC-16 (XModem)  | Calculated over **bytes 4–11**, little-endian               |

## finding the checksum algorithm
The checksum is a CRC-16 based checksum with polynomial `0x1021` and initial value `0x0`. CRC-16 is by far the most popular checksum used in embedded systems and development (I've used it many times), and the most common polynomial is `0x1021`. Since I had no way of guessing the initial value, I wrote a python script to brute force every possible initial value, and since there are only ~65k possible values, this took almost no time. 

```py
from itertools import product
def crc16(data, poly=0x1021, init=0x0000, xor_out=0x0000):
  crc = init
  for b in data:
    crc ^= b << 8
    for _ in range(8):
      crc = ((crc << 1) ^ poly) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
  return crc ^ xor_out

frames = [bytes.fromhex(line) for line in ...]  # your dump
samples = [(f[:-2], int.from_bytes(f[-2:], "little")) for f in frames]

for poly in (0x1021, 0x8005, 0xA001): 
  for init in range(0x10000):
    ok = all(crc16(d, poly, init) == c for d, c in samples[:4])
    if ok:
      if all(crc16(d, poly, init) == c for d, c in samples):
        print(hex(poly), hex(init), "works")
        raise SystemExit
```

I realized a little later on that I was calculating the checksum on the wrong set of bytes. The checksum is usually only calculated on the payload, not the surrounding data (which usually stays the same because the protocol is static). According to the length parameter in the packet above (always 8), the payload is bytes 4-11 (inclusive). Running the script with this modification produced the correct initial value. 

### intensity and axis selection
The next insight came from simply replaying the packets that I saw in the wireshark log. I made 4 different captures, moving the joystick in a different direction each time (up, down, left, right). I then sent those same packets to the gimbal and observed how it moved. It turned out that there was a huge difference in movement speed between the first 15 packets and the last 15 packets. Now I knew that there was some kind of "speed" parameter in the payload that encoded how far the joystick was pushed in a certain direction. Since I had started each capture with the joystick close to center and slowly moved toward the edge, this made sense. Then, I noticed another pattern: 

```
// packets with opcode 52 (write) from the tail end of the pan-left capture 
// non-changing bytes removed
20 01 01 10 00 08 70 5f
21 01 02 10 00 08 0c 81
22 01 03 10 2c 01 fa eb
23 01 01 10 00 08 90 91
24 01 02 10 00 08 0d c2
25 01 03 10 2c 01 bb 23
26 01 01 10 00 08 91 d2
27 01 02 10 00 08 ed 0c
28 01 03 10 2c 01 f8 6d
```

The first byte is the counter, which just increments by one and then wraps. The next one is static, so we'll also ignore that. The third byte, however, seems to indicate that these packets are being sent in groups of three. Every "tick", a group of three packets is sent--one for tilt, one for pan, and one for roll, each with an intensity (the next two bytes). In this capture, the intensity is much higher for axis three than the other two, suggesting that axis 3 corresponds to pan. 

```
// packets with opcode 52 (write) from the tail end of the tilt-up capture 
// non-changing bytes removed
1a 01 01 10 d4 0e db 4f
1b 01 02 10 00 08 82 28
1c 01 03 10 00 08 77 96
1d 01 01 10 d4 0e 9a 87
1e 01 02 10 00 08 83 6b
1f 01 03 10 00 08 97 58
20 01 01 10 d4 0e 55 e6
21 01 02 10 00 08 0c 81
22 01 03 10 00 08 58 39
```

Similarly, the intensity value is higher for axis one, meaning that axis 1 corresponds to tilt. Axis two goes unused, as far as I can tell. It seems that the gimbal manages its own roll; there's no option to roll in the app and sending intensity values with ais 2 doesn't seem to do anything. I'm not sure why Zhiyun chose to include it in the transmission protocol.

The intensity value is an unsigned 16-bit value, but only the lowest 12 bits are used. The center is `0x0800` (2048), and the range is `0x0000` to `0x0FFF` (4095). If the value sent is less than 2048 it's treated as a negative value (down and left are encoded like this). 

## notifications
The gimbal sends notifications back (the script prints them out), but I don't think there's a way to figure out the structure of those packets. Figuring out the gimbal's battery, how far it's been moved in a certain direction, and where it is in space (relative to origin) are out of the question. To reliably control it, you need to attach some sort of IMU to the gimbal and track how far you've moved the gimbal in each direction so you know where it is. I initially went down the rabbit hole of trying to decompile and read the source code for the .apk file for their android app, but it's incredibly obfuscated. The app includes code for accessing a lot of other Zhiyun products, and seems to pull a lot of information from the internet during startup (like fetching the gimbal models and protocols). The protocol information might not even be stored in the apk.  

## unanswered questions 
1. Why did they include axis 02? Is it possible to control roll? 
2. Can you encode multiple directions at once? Sending non-centered intensity values for two axes? 
3. Is there a heartbeat packet? From looking at my packet captures, there doesn't appear to be. There are a couple of oddball packets (like one that reads "support" midway through), but the gimbal seems to work just fine without including them. The script I wrote only sends the movement packets.
