
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

// v4 观测面：web 面板实时观测通道（视频帧 + 标量快照）。
//
// 实时观测回归 web（backend 读本块转 MJPEG / 时序 JSON）；Rerun 保留为
// 可选通道（显式设置 PULSESCOPE_RERUN_CONNECT / _SAVE 时才启用），
// 默认不再 spawn viewer（占资源且实时卡顿）。
//
// 一致性协议（seqlock）：
//   writer：sequence++（变奇）→ 写帧/JSON/header → sequence++（变偶）
//   reader：读 sequence 为偶 → 读数据 → 重读 sequence 不变则有效
// 控制面（ShmControlBlock）独立于本块，协议不变。
constexpr uint64_t kObsShmVersion = 4;
constexpr const char* kObsShmName = "/aurora_rm_obs";
constexpr size_t kObsShmSize = 10 * 1024 * 1024; // 10MB：1080p RGBA + JSON 余量
constexpr size_t kObsMaxJsonBytes = 64 * 1024;

struct ObsShmHeader {
    uint64_t magic_number;  // kShmMagicNumber
    uint64_t version;       // kObsShmVersion
    uint64_t sequence;      // 偶数=稳定，奇数=写入中
    uint64_t timestamp_ms;
    uint64_t frame_index;

    // 图像数据区（RGBA8，width*height*4 字节）
    uint64_t img_offset;
    uint64_t img_size;
    uint32_t width;
    uint32_t height;

    // 标量快照 JSON（{key: number}）
    uint64_t json_offset;
    uint64_t json_size;
};

static_assert(std::is_standard_layout<ObsShmHeader>::value, "ObsShmHeader must be standard-layout");
static_assert(sizeof(ObsShmHeader) <= 256, "observation header must stay small");

} // namespace vision
