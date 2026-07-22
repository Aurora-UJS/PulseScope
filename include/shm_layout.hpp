
#pragma once
#include <cstdint>
#include <cstddef>
#include <type_traits>

namespace vision {

// v3: SHM 只承载控制面（反向调参 + 生产者心跳）。
// 观测面数据（时序/图像/地图）已迁移到 Rerun SDK，不再经过共享内存。
constexpr uint64_t kShmMagicNumber = 0x564953494F4E3031ULL; // "VISION01"
constexpr uint64_t kShmVersion = 3;
constexpr const char* kControlShmName = "/aurora_rm_ctrl";
constexpr size_t kControlShmSize = 4096; // 一页即可

// 确保二进制对齐 (64-bit)
#pragma pack(push, 8)

// 双向字段各自独立更新：
//   producer 写 heartbeat_ms，backend 读；
//   backend 写参数区，producer 读。
// 每个字段本身按自然对齐写入，跨字段的一致性（例如 P/I/D 同批生效）
// 不做保证——与 v2 的参数区语义一致，调参场景可以容忍。
struct ShmControlBlock {
    uint64_t magic_number;  // kShmMagicNumber
    uint64_t version;       // kShmVersion
    uint64_t heartbeat_ms;  // producer 每次 commit 刷新（wall-clock 毫秒）

    // 动态参数区 (backend → producer)
    float pid_p;
    float pid_i;
    float pid_d;
    uint32_t exposure_time;
    uint8_t is_fire_enabled;
    uint8_t reserved[3];
};

#pragma pack(pop)

static_assert(sizeof(float) == 4, "float must be 4 bytes");
static_assert(std::is_standard_layout<ShmControlBlock>::value, "ShmControlBlock must be standard-layout");
static_assert(sizeof(ShmControlBlock) <= kControlShmSize, "control block must fit in one page");

} // namespace vision
