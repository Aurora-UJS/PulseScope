
#pragma once
#include <cstdint>
#include <cstddef>
#include <type_traits>

namespace vision {

constexpr uint64_t kShmMagicNumber = 0x564953494F4E3031ULL; // "VISION01"
constexpr uint64_t kShmVersion = 2;
constexpr size_t kEsdfWidth = 100;
constexpr size_t kEsdfHeight = 100;
constexpr size_t kEsdfCells = kEsdfWidth * kEsdfHeight;
constexpr size_t kDefaultShmSize = 10 * 1024 * 1024; // 10MB
constexpr size_t kMaxJsonBytes = 64 * 1024;

// 确保二进制对齐 (64-bit)
#pragma pack(push, 8)

struct ShmHeader {
    uint64_t magic_number;  // kShmMagicNumber
    uint64_t version;
    uint64_t sequence;      // 偶数=稳定，奇数=写入中
    uint64_t timestamp_ms;
    
    // 图像数据偏移量与大小
    uint64_t img_offset;
    uint64_t img_size;
    uint32_t width;
    uint32_t height;

    // 状态数据偏移量与大小 (JSON)
    uint64_t json_offset;
    uint64_t json_size;

    // 地图数据 (ESDF slice: 100x100 grid)
    float esdf_map[kEsdfCells];
    
    // 动态参数区 (用于反向调参)
    float pid_p;
    float pid_i;
    float pid_d;
    uint32_t exposure_time;
    uint8_t is_fire_enabled;
    uint8_t reserved[3];
};

#pragma pack(pop)

static_assert(sizeof(float) == 4, "float must be 4 bytes");
static_assert(std::is_standard_layout<ShmHeader>::value, "ShmHeader must be standard-layout");
static_assert(offsetof(ShmHeader, esdf_map) % alignof(float) == 0, "esdf_map must be aligned");

} // namespace vision
