# Local HEIC encoder

This directory contains a self-hosted software HEVC still-image encoder. It uses
libheif **1.23.5** (LGPL-3.0-or-later) and Kvazaar **2.3.2** (BSD-3-Clause).
The licenses apply to those libraries; they are not covered by the application's
license. The original libheif COPYING includes both LGPL v3 and GPL v3 texts.
Kvazaar's original copyright notice and license are reproduced separately.
The generated Emscripten runtime and linked standard libraries retain their
own notices: Emscripten (MIT/NCSA), musl (MIT and its listed component notices),
libc++ and libc++abi (Apache-2.0 with LLVM exception and legacy notices), and
compiler-rt (Apache-2.0 with LLVM exception). Copies of the original license
files accompany this directory. Kvazaar's bundled libmd5 notices are also kept.

The runtime files are `heic-encoder.js` and `heic-encoder.wasm`. They were built
from the full, unmodified source archives in `source/` and the small application
C ABI in `build/encode.cpp`. No elheif binary, libde265 decoder, decoder plugin,
or Embind wrapper is used. The earlier elheif investigation was replaced by this
encoder-only build to keep library versions fixed and results alive until copied.

The only public C ABI accepts bounded RGBA pixels and produces a genuine HEIC
container with an HEVC coded image. It does not accept or decode HEIC files.
libheif's encoder performs color conversion; opaque canvas pixels are encoded
as 8-bit sRGB with a color profile. Transparency is composited over white.
The worker is terminated after every result and on cancellation. The runtime is
built with `DYNAMIC_EXECUTION=0`; JavaScript `unsafe-eval` is not required.

To rebuild, activate Emscripten **4.0.10**, put CMake **3.31.6** and Ninja
**1.11.1.3** (Python distribution version; binary reports
`1.11.1.git.kitware.jobserver-1`) on PATH, and run
`bash assets/vendor/heic/build/rebuild.sh` from the
repository. It uses only the shipped source archives, builds static libraries,
and links the complete application C ABI. It can relink against modified library
sources by replacing either source archive while preserving its directory name.
No source patches are applied. The compiler define
`__EMSCRIPTEN_STANDALONE_WASM__=1` disables libheif's unused JavaScript bindings;
this is the same switch used in libheif's upstream `build-emscripten.sh`.
Output hashes and exact source commits are recorded in `provenance.json`.

Complete corresponding library sources, application source for this module, and
rebuilding instructions accompany the binaries here. You may replace or modify
the module in accordance with the applicable licenses. Nothing in this notice
restricts reverse engineering for debugging modifications to the LGPL library.

## Application C ABI license

Copyright (c) 2026 Brclio contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
