// Brclio's encoder-only C ABI. Distributed under the MIT license in NOTICE.md.
#include <libheif/heif.h>
#include <cstdint>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
std::vector<uint8_t> result;
std::string error;
void check(heif_error value) {
  if (value.code != heif_error_Ok) throw std::runtime_error(value.message ? value.message : "HEIC encoding failed");
}
struct Runtime {
  Runtime() { check(heif_init(nullptr)); }
  ~Runtime() { heif_deinit(); }
};
heif_error write_bytes(heif_context*, const void* data, size_t size, void*) {
  try {
    if (size > 20 * 1024 * 1024 || result.size() > 20 * 1024 * 1024 - size)
      return {heif_error_Encoding_error, heif_suberror_Unspecified, "HEIC output exceeds limit"};
    const auto* bytes = static_cast<const uint8_t*>(data);
    if (size) result.insert(result.end(), bytes, bytes + size);
    return {heif_error_Ok, heif_suberror_Unspecified, "OK"};
  } catch (...) { return {heif_error_Memory_allocation_error, heif_suberror_Unspecified, "HEIC output allocation failed"}; }
}
}

extern "C" {
int encode_heic(const uint8_t* rgba, int length, int width, int height) {
  result.clear(); error.clear();
  try {
    if (!rgba || width < 1 || height < 1 || width > 1440 || height > 1440 || length != width * height * 4)
      throw std::runtime_error("Invalid RGBA dimensions");
    Runtime runtime;
    std::unique_ptr<heif_context, decltype(&heif_context_free)> context(heif_context_alloc(), heif_context_free);
    if (!context) throw std::runtime_error("HEIC context allocation failed");
    heif_image* raw_image = nullptr;
    check(heif_image_create(width, height, heif_colorspace_RGB, heif_chroma_interleaved_RGB, &raw_image));
    std::unique_ptr<heif_image, decltype(&heif_image_release)> image(raw_image, heif_image_release);
    check(heif_image_add_plane(image.get(), heif_channel_interleaved, width, height, 8));
    int stride = 0;
    auto* plane = heif_image_get_plane(image.get(), heif_channel_interleaved, &stride);
    if (!plane || stride < width * 3) throw std::runtime_error("HEIC pixel allocation failed");
    for (int y = 0; y < height; ++y) {
      for (int x = 0; x < width; ++x) {
        const auto* pixel = rgba + (y * width + x) * 4;
        for (int c = 0; c < 3; ++c)
          plane[y * stride + x * 3 + c] = (pixel[c] * pixel[3] + 255 * (255 - pixel[3]) + 127) / 255;
      }
    }
    std::unique_ptr<heif_color_profile_nclx, decltype(&heif_nclx_color_profile_free)> profile(heif_nclx_color_profile_alloc(), heif_nclx_color_profile_free);
    if (!profile) throw std::runtime_error("HEIC color profile allocation failed");
    check(heif_nclx_color_profile_set_color_primaries(profile.get(), 1));
    check(heif_nclx_color_profile_set_transfer_characteristics(profile.get(), 13));
    check(heif_nclx_color_profile_set_matrix_coefficients(profile.get(), 1));
    profile->full_range_flag = 1;
    check(heif_image_set_nclx_color_profile(image.get(), profile.get()));
    heif_encoder* raw_encoder = nullptr;
    check(heif_context_get_encoder_for_format(context.get(), heif_compression_HEVC, &raw_encoder));
    std::unique_ptr<heif_encoder, decltype(&heif_encoder_release)> encoder(raw_encoder, heif_encoder_release);
    check(heif_encoder_set_lossy_quality(encoder.get(), 92));
    check(heif_context_encode_image(context.get(), image.get(), encoder.get(), nullptr, nullptr));
    heif_writer writer = {1, write_bytes};
    check(heif_context_write(context.get(), &writer, nullptr));
    if (result.size() < 24) throw std::runtime_error("Incomplete HEIC output");
    return 1;
  } catch (const std::exception& value) { error = value.what(); }
  catch (...) { error = "HEIC encoder failed"; }
  result.clear(); return 0;
}
const uint8_t* get_result_data() { return result.data(); }
int get_result_size() { return static_cast<int>(result.size()); }
const char* get_error() { return error.c_str(); }
void release_heic() { std::vector<uint8_t>().swap(result); std::string().swap(error); }
}
