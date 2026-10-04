#!/usr/bin/env bash
set -euo pipefail
# Activate Emscripten 4.0.10 first; CMake 3.31.6 and Ninja 1.11.1.3 were used.
# No network is needed: complete fixed library sources are shipped alongside.
codec_root="$(cd "$(dirname "$0")/.." && pwd)"
codec_work="${HEIC_BUILD_DIR:-$(mktemp -d)}"
codec_jobs="${HEIC_BUILD_JOBS:-4}"
mkdir -p "$codec_work"
tar -xzf "$codec_root/source/kvazaar-2.3.2.tar.gz" -C "$codec_work"
tar -xzf "$codec_root/source/libheif-1.23.5.tar.gz" -C "$codec_work"
emcmake cmake -S "$codec_work/kvazaar-2.3.2" -B "$codec_work/kvazaar-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$codec_work/install" \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTS=OFF -DBUILD_KVAZAAR_BINARY=OFF -DGIT_SUBMODULE=OFF \
  -DCMAKE_C_FLAGS="-O3 -ffile-prefix-map=$codec_work=." -DCMAKE_CXX_FLAGS="-O3 -ffile-prefix-map=$codec_work=."
cmake --build "$codec_work/kvazaar-build" --parallel "$codec_jobs"
cmake --install "$codec_work/kvazaar-build"
emcmake cmake -S "$codec_work/libheif-1.23.5" -B "$codec_work/heif-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$codec_work/install" \
  -DCMAKE_C_FLAGS="-O3 -ffile-prefix-map=$codec_work=." -DCMAKE_CXX_FLAGS="-O3 -ffile-prefix-map=$codec_work=. -D__EMSCRIPTEN_STANDALONE_WASM__=1" \
  -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF -DBUILD_DOCUMENTATION=OFF -DBUILD_DEVELOPMENT_TOOLS=OFF \
  -DWITH_EXAMPLES=OFF -DWITH_GDK_PIXBUF=OFF -DENABLE_PLUGIN_LOADING=OFF \
  -DENABLE_MULTITHREADING_SUPPORT=OFF -DENABLE_PARALLEL_TILE_DECODING=OFF \
  -DWITH_LIBDE265=OFF -DWITH_X265=OFF -DWITH_X264=OFF -DWITH_OpenH264_DECODER=OFF \
  -DWITH_DAV1D=OFF -DWITH_AOM_DECODER=OFF -DWITH_AOM_ENCODER=OFF -DWITH_SvtEnc=OFF \
  -DWITH_RAV1E=OFF -DWITH_JPEG_DECODER=OFF -DWITH_JPEG_ENCODER=OFF \
  -DWITH_OpenJPEG_ENCODER=OFF -DWITH_OpenJPEG_DECODER=OFF -DWITH_OPENJPH_ENCODER=OFF \
  -DWITH_FFMPEG_DECODER=OFF -DWITH_UVG266=OFF -DWITH_VVDEC=OFF -DWITH_VVENC=OFF \
  -DWITH_WEBCODECS=OFF -DWITH_UNCOMPRESSED_CODEC=OFF -DWITH_LIBSHARPYUV=OFF -DWITH_HEADER_COMPRESSION=OFF \
  -DWITH_KVAZAAR=ON -DWITH_KVAZAAR_PLUGIN=OFF \
  -DKVAZAAR_INCLUDE_DIR="$codec_work/install/include" -DKVAZAAR_LIBRARY="$codec_work/install/lib/libkvazaar.a"
cmake --build "$codec_work/heif-build" --parallel "$codec_jobs"
cmake --install "$codec_work/heif-build"
em++ "$codec_root/build/encode.cpp" "$codec_work/install/lib/libheif.a" "$codec_work/install/lib/libkvazaar.a" \
  -I"$codec_work/install/include" -std=c++20 -O3 -fexceptions \
  -ffile-prefix-map="$codec_work"=. -ffile-prefix-map="$codec_root"=. \
  -sENVIRONMENT=worker -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createHeicEncoder \
  -sDYNAMIC_EXECUTION=0 -sDISABLE_EXCEPTION_CATCHING=0 -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=268435456 -sSTACK_SIZE=1048576 \
  -sFILESYSTEM=0 -sEXPORTED_RUNTIME_METHODS='["UTF8ToString","HEAPU8"]' \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_encode_heic","_get_result_data","_get_result_size","_get_error","_release_heic"]' \
  -o "$codec_root/heic-encoder.js"
echo "Built $codec_root/heic-encoder.js and heic-encoder.wasm"
