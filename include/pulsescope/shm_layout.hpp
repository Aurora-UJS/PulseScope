#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>

namespace pulsescope {

/**
 * @brief PulseScope 共享内存布局定义 (Memory Contract)
 * 
 * 采用固定大小的缓冲区以实现零分配和极低延迟。
 */
struct ShmLayout {
    // ---------------- Header ----------------
    uint32_t magic = 0x50534350; // 'PSCP'
    uint32_t version = 1;

    // ---------------- Image Section ----------------
    struct ImageSection {
        std::atomic<uint64_t> seq{0};
        uint32_t size{0};
        uint32_t width{0};
        uint32_t height{0};
        uint8_t data[1024 * 1024 * 2]; 
        uint8_t _padding[4]; // Ensure 8-byte alignment for next section
    } image;

    // ---------------- Telemetry Section (JSON) ----------------
    struct TelemetrySection {
        std::atomic<uint64_t> seq{0};
        uint32_t size{0};
        char json_data[64 * 1024];
        uint8_t _padding[4]; // Ensure 8-byte alignment for next section
    } telemetry;

    // ---------------- Serial Log Section ----------------
    struct SerialSection {
        std::atomic<uint64_t> seq{0};
        uint32_t size{0};
        uint8_t raw_data[16 * 1024];
        uint8_t _padding[4]; // Ensure 8-byte alignment for next section
    } serial;

    // ---------------- Parameter Section (Bidirectional) ----------------
    struct ParameterSection {
        std::atomic<uint64_t> producer_seq{0};
        std::atomic<uint64_t> bridge_seq{0};
        uint32_t size{0};
        char json_data[32 * 1024];
        uint8_t _padding[4]; 
    } params;
};

// 共享内存默认挂载路径及名称
static constexpr const char* SHM_NAME = "/pulsescope_shm";
static constexpr std::size_t SHM_SIZE = sizeof(ShmLayout);

} // namespace pulsescope
