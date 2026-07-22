
#include "../include/vision_monitor.hpp"
#include <algorithm>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr size_t kEsdfWidth = 100;
constexpr size_t kEsdfHeight = 100;
constexpr size_t kEsdfCells = kEsdfWidth * kEsdfHeight;

// SIGINT/SIGTERM 时干净退出：让 RecordingStream 析构 flush 批处理器中
// 尚未落盘的小 chunk（标量等），否则录制尾部数据会丢。
volatile std::sig_atomic_t g_stop = 0;

void onStopSignal(int) {
    g_stop = 1;
}

int readEnvInt(const char* key, int fallback, int min_v, int max_v) {
    const char* raw = std::getenv(key);
    if (!raw) return fallback;

    char* end = nullptr;
    long value = std::strtol(raw, &end, 10);
    if (end == raw || *end != '\0') return fallback;
    if (value < min_v) return min_v;
    if (value > max_v) return max_v;
    return static_cast<int>(value);
}

} // namespace

int main() {
    std::signal(SIGINT, onStopSignal);
    std::signal(SIGTERM, onStopSignal);

    auto& monitor = vision::Monitor::getInstance();

    if (!monitor.init()) {
        std::cerr << "Failed to init monitor (rerun sink / control shm)!" << std::endl;
        return -1;
    }

    std::cout << "C++ Producer started." << std::endl;
    std::cout << "  Data plane   : Rerun (PULSESCOPE_RERUN_CONNECT / PULSESCOPE_RERUN_SAVE, default: spawn viewer)" << std::endl;
    std::cout << "  Control plane: /dev/shm" << vision::kControlShmName << std::endl;
    std::cout << "Env options: PULSESCOPE_UPDATE_HZ, PULSESCOPE_MAP_HZ, PULSESCOPE_STRESS_SERIES, PULSESCOPE_NOISE_LEVEL" << std::endl;

    const int update_hz = readEnvInt("PULSESCOPE_UPDATE_HZ", 50, 1, 240);
    const int map_hz = readEnvInt("PULSESCOPE_MAP_HZ", 10, 1, 120);
    const int stress_series = readEnvInt("PULSESCOPE_STRESS_SERIES", 24, 0, 512);
    const int noise_level = readEnvInt("PULSESCOPE_NOISE_LEVEL", 10, 0, 100);
    const int video_width = 320;
    const int video_height = 240;

    std::vector<float> esdf_map(kEsdfCells, 0.0f);
    std::vector<uint8_t> video_rgba(video_width * video_height * 4, 0);
    std::vector<std::string> stress_keys;
    stress_keys.reserve(stress_series);
    for (int i = 0; i < stress_series; ++i) {
        stress_keys.push_back("stress_" + std::to_string(i));
    }

    auto start = std::chrono::steady_clock::now();
    auto last_frame = start;
    auto next_frame = start;
    auto next_map = start;
    const auto frame_period = std::chrono::microseconds(1000000 / update_hz);
    const auto map_period = std::chrono::microseconds(1000000 / map_hz);
    uint64_t frame_id = 0;

    float last_p = -1.0f, last_i = -1.0f, last_d = -1.0f;
    uint32_t last_exposure = 0;
    bool last_fire = false;

    while (!g_stop) {
        next_frame += frame_period;
        const auto now = std::chrono::steady_clock::now();
        const float t = std::chrono::duration<float>(now - start).count();

        // 1. 模拟 ESDF 地图数据更新（较低频）
        if (now >= next_map) {
            for (size_t idx = 0; idx < kEsdfCells; ++idx) {
                const int x = static_cast<int>(idx % kEsdfWidth);
                const int y = static_cast<int>(idx / kEsdfWidth);

                const float ox1 = 50.0f + std::sin(t * 0.9f) * 18.0f;
                const float oy1 = 45.0f + std::cos(t * 0.8f) * 14.0f;
                const float ox2 = 24.0f + std::sin(t * 0.5f) * 12.0f;
                const float oy2 = 75.0f + std::cos(t * 0.4f) * 10.0f;

                const float d1 = std::hypot(static_cast<float>(x) - ox1, static_cast<float>(y) - oy1) / 18.0f;
                const float d2 = std::hypot(static_cast<float>(x) - ox2, static_cast<float>(y) - oy2) / 14.0f;
                const float wave = 0.35f
                    + 0.22f * std::sin(t * 1.4f + static_cast<float>(x) * 0.08f)
                    + 0.14f * std::cos(t * 1.1f + static_cast<float>(y) * 0.07f);

                esdf_map[idx] = std::clamp(std::min(d1, d2) + wave, 0.0f, 4.0f);
            }

            monitor.updateMap(esdf_map.data(), kEsdfWidth, kEsdfHeight);
            while (next_map <= now) {
                next_map += map_period;
            }
        }

        // 2. 参数同步（backend 通过 SHM 写入）
        float p = 0.0f, i = 0.0f, d = 0.0f;
        uint32_t exposure = 0;
        bool fire_enabled = false;
        monitor.syncParams(p, i, d, exposure, fire_enabled);
        if (p != last_p || i != last_i || d != last_d || exposure != last_exposure || fire_enabled != last_fire) {
            std::printf("[params] P=%.3f I=%.3f D=%.3f exposure=%u fire=%d\n",
                        p, i, d, exposure, fire_enabled ? 1 : 0);
            std::fflush(stdout);
            last_p = p; last_i = i; last_d = d;
            last_exposure = exposure; last_fire = fire_enabled;
        }

        // 3. 写入监控数据（核心+压力通道）
        const double dt = std::chrono::duration<double>(now - last_frame).count();
        last_frame = now;
        const double fps = dt > 0.0 ? 1.0 / dt : static_cast<double>(update_hz);

        monitor.pushData({
            {"ekf_x", 20.0 + std::sin(t * 1.7) * 6.0 + std::sin(t * 0.3) * 2.0},
            {"ekf_y", 24.0 + std::cos(t * 1.3) * 5.0 + std::cos(t * 0.4) * 3.0},
            {"target_dist", 2.2 + 0.7 * std::sin(t * 0.9)},
            {"fps", fps},
            {"latency", 1.2 + std::abs(std::sin(t * 2.8)) * 0.7},
            {"pid_error", std::sin(t * 2.3) * 1.6 + std::cos(t * 1.1) * 0.4},
            {"gimbal_yaw", std::sin(t * 1.1) * 28.0},
            {"gimbal_pitch", std::cos(t * 0.8) * 14.0},
            {"pid_p_feedback", p},
            {"pid_i_feedback", i},
            {"pid_d_feedback", d},
            {"exposure_feedback", static_cast<double>(exposure)},
            {"fire_enabled_feedback", fire_enabled ? 1.0 : 0.0},
            {"frame_id", static_cast<double>(frame_id)},
            {"stress_channel_count", static_cast<double>(stress_series)}
        });

        const double noise_amp = static_cast<double>(noise_level) / 100.0;
        for (int idx = 0; idx < stress_series; ++idx) {
            const double f = 0.4 + (idx % 13) * 0.17;
            const double phase = idx * 0.37;
            const double signal =
                std::sin(t * f + phase) * (1.0 + (idx % 7) * 0.15) +
                0.35 * std::cos(t * (f * 1.7) + phase * 0.4) +
                noise_amp * std::sin(t * 50.0 + idx * 1.9);
            monitor.pushData(stress_keys[idx], signal);
        }

        // 4. 生成并写入视频帧（RGBA）
        const int target_x = static_cast<int>((0.5f + 0.35f * std::sin(t * 0.9f)) * static_cast<float>(video_width));
        const int target_y = static_cast<int>((0.5f + 0.30f * std::cos(t * 1.1f)) * static_cast<float>(video_height));
        const int half_box_w = 28;
        const int half_box_h = 18;

        for (int y = 0; y < video_height; ++y) {
            for (int x = 0; x < video_width; ++x) {
                const size_t offset = (static_cast<size_t>(y) * video_width + static_cast<size_t>(x)) * 4;
                const float nx = static_cast<float>(x) / static_cast<float>(video_width);
                const float ny = static_cast<float>(y) / static_cast<float>(video_height);

                const uint8_t r = static_cast<uint8_t>(16 + 26 * ny + 8 * std::sin(t * 0.8f));
                const uint8_t g = static_cast<uint8_t>(28 + 80 * nx);
                const uint8_t b = static_cast<uint8_t>(42 + 48 * (0.5f + 0.5f * std::sin(t * 1.4f + nx * 6.0f)));

                video_rgba[offset + 0] = r;
                video_rgba[offset + 1] = g;
                video_rgba[offset + 2] = b;
                video_rgba[offset + 3] = 255;
            }
        }

        auto drawPixel = [&](int x, int y, uint8_t r, uint8_t g, uint8_t b) {
            if (x < 0 || x >= video_width || y < 0 || y >= video_height) return;
            const size_t offset = (static_cast<size_t>(y) * video_width + static_cast<size_t>(x)) * 4;
            video_rgba[offset + 0] = r;
            video_rgba[offset + 1] = g;
            video_rgba[offset + 2] = b;
            video_rgba[offset + 3] = 255;
        };

        for (int x = target_x - half_box_w; x <= target_x + half_box_w; ++x) {
            drawPixel(x, target_y - half_box_h, 34, 211, 238);
            drawPixel(x, target_y + half_box_h, 34, 211, 238);
        }
        for (int y = target_y - half_box_h; y <= target_y + half_box_h; ++y) {
            drawPixel(target_x - half_box_w, y, 34, 211, 238);
            drawPixel(target_x + half_box_w, y, 34, 211, 238);
        }
        for (int dxy = -10; dxy <= 10; ++dxy) {
            drawPixel(target_x + dxy, target_y, 255, 255, 255);
            drawPixel(target_x, target_y + dxy, 255, 255, 255);
        }

        monitor.pushImageRGBA(video_rgba.data(), static_cast<uint32_t>(video_width), static_cast<uint32_t>(video_height));
        monitor.commit();
        frame_id++;

        std::this_thread::sleep_until(next_frame);
    }

    std::cout << "Shutting down, flushing rerun buffers..." << std::endl;
    monitor.shutdown();
    return 0;
}
