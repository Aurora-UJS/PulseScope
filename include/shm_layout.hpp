
#pragma once
#include <cstdint>
#include <cstddef>
#include <type_traits>

namespace vision {

// v4: 自描述控制块。
//
// v3 的参数区是硬编码结构体字段（pid_p/pid_i/pid_d/exposure_time/is_fire_enabled），
// 新增一个参数需要同时改 C++ 结构体、Go 结构体、TS 接口；且合法范围在 Go 的
// clamp() 与前端 slider 里各写了一份，没有任何机制保证两份同步。
//
// v4 改为 key-value 槽位表，每个槽位自带元数据（类型/范围/步进/单位/默认值）。
// 真值来源收敛到 producer：backend 与前端不再硬编码任何参数名或范围，
// 读表即可渲染 UI 并校验写入。新增参数只改 producer 一行 declare。
//
// 并发约定（重要）：
//   - producer 注册阶段写 key/unit/type/min/max/step/default，注册完成后这些字段只读；
//   - 运行期只有两个字段可变：backend 写 ParamSlot::value，producer 写 heartbeat_ms；
//   - param_count 由 producer 在「槽位内容写完之后」递增，充当发布屏障：
//     backend 读到的 count 以内的槽位，其元数据必然已完整写入；
//   - value 为 8 字节对齐的 double。x86-64 与 ARM64 上对齐的 8 字节 load/store
//     由硬件保证不撕裂，因此单个参数的读写无需锁。跨参数的一致性（例如 P/I/D
//     同批生效）仍不保证——与 v3 语义一致，调参场景可容忍。

constexpr uint64_t kShmMagicNumber = 0x564953494F4E3031ULL; // "VISION01"
constexpr uint64_t kShmVersion = 4;
constexpr const char* kControlShmName = "/aurora_rm_ctrl";

constexpr size_t kMaxParams = 64;
constexpr size_t kParamKeyLen = 32;
constexpr size_t kParamUnitLen = 16;

// 槽位值统一以 double 承载，type 只决定 UI 呈现与写入取整语义。
// double 能精确表示全部 int32 与 float32，不引入精度损失，
// 同时消除跨语言（Go/TS）解析 union 的复杂度。
enum ParamType : uint8_t {
    kParamFloat = 1,
    kParamInt   = 2,
    kParamBool  = 3,
};

#pragma pack(push, 8)

struct ParamSlot {
    char     key[kParamKeyLen];    // NUL 结尾；注册时写，之后只读
    char     unit[kParamUnitLen];  // NUL 结尾，可为空串；仅 UI 显示
    uint8_t  type;                 // ParamType
    uint8_t  reserved[7];          // 补齐，使 value 落在 8 字节边界
    double   value;                // 唯一运行时可变字段：backend 写 / producer 读
    double   min_value;
    double   max_value;
    double   step;                 // UI 步进；0 表示连续
    double   default_value;
};

struct ShmControlBlock {
    uint64_t  magic_number;   // kShmMagicNumber
    uint64_t  version;        // kShmVersion
    uint64_t  heartbeat_ms;   // producer 每次 commit 刷新（wall-clock 毫秒）
    uint32_t  param_count;    // 已就绪槽位数，<= kMaxParams（发布屏障，见上）
    uint32_t  reserved0;
    uint64_t  reserved1[4];   // 预留，并使 params 起始于 64 字节边界
    ParamSlot params[kMaxParams];
};

#pragma pack(pop)

// v4 控制块 6208 字节，一页放不下，取两页。
constexpr size_t kControlShmSize = 8192;

// ---------------------------------------------------------------------------
// 跨语言布局契约
//
// 下面这组数字是 C++ / Go 两侧共同遵守的 ABI。backend 侧的 TestLayoutContract
// 断言完全相同的值：任何一侧改动布局，另一侧的检查立即失败，避免静默错位
// （错位不会崩，只会读到垃圾参数值——是这类跨语言共享内存最难查的故障）。
// ---------------------------------------------------------------------------
static_assert(std::is_standard_layout<ParamSlot>::value, "ParamSlot must be standard-layout");
static_assert(std::is_standard_layout<ShmControlBlock>::value, "ShmControlBlock must be standard-layout");

static_assert(sizeof(double) == 8, "double must be IEEE-754 binary64");
static_assert(sizeof(ParamSlot) == 96, "ParamSlot size changed - update Go side");
static_assert(offsetof(ParamSlot, key) == 0, "ParamSlot::key offset changed");
static_assert(offsetof(ParamSlot, unit) == 32, "ParamSlot::unit offset changed");
static_assert(offsetof(ParamSlot, type) == 48, "ParamSlot::type offset changed");
static_assert(offsetof(ParamSlot, value) == 56, "ParamSlot::value offset changed");
static_assert(offsetof(ParamSlot, min_value) == 64, "ParamSlot::min_value offset changed");
static_assert(offsetof(ParamSlot, max_value) == 72, "ParamSlot::max_value offset changed");
static_assert(offsetof(ParamSlot, step) == 80, "ParamSlot::step offset changed");
static_assert(offsetof(ParamSlot, default_value) == 88, "ParamSlot::default_value offset changed");

// value 必须 8 字节对齐，否则跨进程读写可能撕裂（见文件头并发约定）。
static_assert(offsetof(ParamSlot, value) % 8 == 0, "ParamSlot::value must be 8-byte aligned");

static_assert(offsetof(ShmControlBlock, magic_number) == 0, "header layout changed");
static_assert(offsetof(ShmControlBlock, version) == 8, "header layout changed");
static_assert(offsetof(ShmControlBlock, heartbeat_ms) == 16, "header layout changed");
static_assert(offsetof(ShmControlBlock, param_count) == 24, "header layout changed");
static_assert(offsetof(ShmControlBlock, params) == 64, "params array offset changed");
static_assert(sizeof(ShmControlBlock) == 64 + 96 * kMaxParams, "ShmControlBlock size changed");
static_assert(sizeof(ShmControlBlock) <= kControlShmSize, "control block must fit in the mapping");

} // namespace vision
