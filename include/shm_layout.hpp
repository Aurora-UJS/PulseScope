
#pragma once
#include <cstdint>

// 确保二进制对齐 (64-bit)
#pragma pack(push, 8)

struct ShmHeader {
    uint64_t magic_number;  // 0x564953494F4E3031 (VISION01)
    uint64_t version;
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
    float esdf_map[10000]; 
    
    // 动态参数区 (用于反向调参)
    float pid_p;
    float pid_i;
    float pid_d;
    uint32_t exposure_time;
    bool is_fire_enabled;
};

#pragma pack(pop)
