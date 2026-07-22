
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

// 目标历史轨迹保留的帧数
constexpr size_t kTrailLength = 150;

// Rerun 实体路径构成一棵变换树：挂在 world/gimbal 上的位姿会被其下的
// camera 及 camera 下的 2D 标注继承。这正是自瞄 相机系→云台系→世界系 的表达。
const std::string kCamera        = "world/gimbal/camera";
const std::string kCameraImage   = kCamera + "/image";
const std::string kCameraArmors  = kCamera + "/armors";
const std::string kCameraCorners = kCamera + "/corners";

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

    // 参数注册：范围与步进在此声明一次，backend 与前端从共享内存读取，
    // 两侧都不再硬编码。新增可调参数只需在这里加一行 declare。
    auto param_p    = monitor.declareFloat("pid_p", 1.0, 0.0, 10.0, 0.01);
    auto param_i    = monitor.declareFloat("pid_i", 0.0, 0.0, 1.0, 0.001);
    auto param_d    = monitor.declareFloat("pid_d", 0.1, 0.0, 1.0, 0.001);
    auto param_exp  = monitor.declareInt("exposure_time", 5000, 100, 50000, 100, "us");
    auto param_fire = monitor.declareBool("fire_enabled", true);
    auto param_conf = monitor.declareFloat("min_confidence", 0.75, 0.0, 1.0, 0.01);

    std::cout << "C++ Producer started." << std::endl;
    std::cout << "  Data plane   : Rerun (PULSESCOPE_RERUN_CONNECT / PULSESCOPE_RERUN_SAVE, default: spawn viewer)" << std::endl;
    std::cout << "  Control plane: /dev/shm" << vision::kControlShmName
              << " (v" << vision::kShmVersion << ", " << monitor.paramCount() << " params declared)" << std::endl;
    std::cout << "Env options: PULSESCOPE_UPDATE_HZ, PULSESCOPE_MAP_HZ, PULSESCOPE_STRESS_SERIES, PULSESCOPE_NOISE_LEVEL" << std::endl;

    const int update_hz = readEnvInt("PULSESCOPE_UPDATE_HZ", 50, 1, 240);
    const int map_hz = readEnvInt("PULSESCOPE_MAP_HZ", 10, 1, 120);
    const int stress_series = readEnvInt("PULSESCOPE_STRESS_SERIES", 24, 0, 512);
    const int noise_level = readEnvInt("PULSESCOPE_NOISE_LEVEL", 10, 0, 100);
    const int video_width = 320;
    const int video_height = 240;

    std::vector<float> esdf_map(kEsdfCells, 0.0f);
    std::vector<uint8_t> video_rgba(video_width * video_height * 4, 0);
    std::vector<vision::Vec3> target_trail;   // 目标在世界系中的历史轨迹
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
    bool last_locked = false;

    while (!g_stop) {
        next_frame += frame_period;
        const auto now = std::chrono::steady_clock::now();
        const float t = std::chrono::duration<float>(now - start).count();

        // 0. 声明帧边界。本帧后续所有写入共享同一组时间戳。
        //    真实系统应传入相机曝光时刻 monitor.beginFrame(exposure_ts)，
        //    使图像、IMU、串口数据落在同一条 capture_time 轴上——
        //    排查「识别慢了还是预测超前量不对」全靠这个对齐。
        //    不调用也可以：任何 push* 会在首次写入时自动用当前时刻确定。
        monitor.beginFrame();

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

        // 2. 参数读取（backend 通过 SHM 写入，句柄直读，无字符串查找）
        const float p = param_p.getFloat();
        const float i = param_i.getFloat();
        const float d = param_d.getFloat();
        const uint32_t exposure = static_cast<uint32_t>(param_exp.getInt());
        const bool fire_enabled = param_fire.getBool();
        const float min_conf = param_conf.getFloat();
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
        const float target_dist = 2.2f + 0.7f * std::sin(t * 0.9f);

        monitor.pushData({
            {"ekf_x", 20.0 + std::sin(t * 1.7) * 6.0 + std::sin(t * 0.3) * 2.0},
            {"ekf_y", 24.0 + std::cos(t * 1.3) * 5.0 + std::cos(t * 0.4) * 3.0},
            {"target_dist", target_dist},
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

        // 4. 相机画面：只渲染场景本身。
        //    识别结果不再烧进像素——烧进去的框无法悬停查坐标、无法按时间筛选、
        //    无法单独开关图层，等于把结构化数据降级成了一张图。
        for (int y = 0; y < video_height; ++y) {
            for (int x = 0; x < video_width; ++x) {
                const size_t offset = (static_cast<size_t>(y) * video_width + static_cast<size_t>(x)) * 4;
                const float nx = static_cast<float>(x) / static_cast<float>(video_width);
                const float ny = static_cast<float>(y) / static_cast<float>(video_height);

                video_rgba[offset + 0] = static_cast<uint8_t>(16 + 26 * ny + 8 * std::sin(t * 0.8f));
                video_rgba[offset + 1] = static_cast<uint8_t>(28 + 80 * nx);
                video_rgba[offset + 2] = static_cast<uint8_t>(42 + 48 * (0.5f + 0.5f * std::sin(t * 1.4f + nx * 6.0f)));
                video_rgba[offset + 3] = 255;
            }
        }
        monitor.pushImageRGBA(video_rgba.data(),
                              static_cast<uint32_t>(video_width),
                              static_cast<uint32_t>(video_height),
                              kCameraImage.c_str());

        // 5. 识别结果作为结构化标注，挂在相机实体下 → Rerun 自动叠加到画面上
        const float target_x = (0.5f + 0.35f * std::sin(t * 0.9f)) * static_cast<float>(video_width);
        const float target_y = (0.5f + 0.30f * std::cos(t * 1.1f)) * static_cast<float>(video_height);
        const float box_w = 56.0f, box_h = 36.0f;
        const float confidence = 0.72f + 0.24f * (0.5f + 0.5f * std::sin(t * 1.6f));
        const bool  locked = confidence >= min_conf;

        char label[64];
        std::snprintf(label, sizeof(label), "armor conf=%.2f", confidence);

        vision::Annotations box_ann;
        box_ann.labels = {label};
        // 置信度过阈值用青色，否则用琥珀色——颜色即状态，不必看数字
        box_ann.colors = {locked ? vision::Rgba{34, 211, 238, 255}
                                 : vision::Rgba{251, 191, 36, 255}};
        monitor.pushBoxes2D(kCameraArmors.c_str(),
                            {{target_x, target_y, box_w, box_h}}, box_ann);

        // 装甲板四角（PnP 解算的输入，调试时最需要单独确认）
        monitor.pushPoints2D(kCameraCorners.c_str(), {
            {target_x - box_w * 0.5f, target_y - box_h * 0.5f},
            {target_x + box_w * 0.5f, target_y - box_h * 0.5f},
            {target_x + box_w * 0.5f, target_y + box_h * 0.5f},
            {target_x - box_w * 0.5f, target_y + box_h * 0.5f},
        });

        // 6. 3D 场景：变换树 + 目标位置 + 历史轨迹
        //    world/gimbal 上的变换会被其子实体（camera 及其下的 2D 标注）继承，
        //    这正是自瞄 相机系→云台系→世界系 的表达方式。
        const float yaw = std::sin(t * 1.1f) * 0.5f;
        monitor.setTransform("world/gimbal", {0.0f, 0.0f, 0.30f},
                             {0.0f, 0.0f, std::sin(yaw * 0.5f), std::cos(yaw * 0.5f)});
        // 相机内参：设置后 Rerun 能把上面的 2D 框投影进 3D 场景并画出视锥
        monitor.setPinhole(kCamera.c_str(), 320.0f,
                           static_cast<uint32_t>(video_width),
                           static_cast<uint32_t>(video_height));

        const vision::Vec3 target_3d{
            target_dist * std::cos(yaw), target_dist * std::sin(yaw),
            0.30f + 0.12f * std::sin(t * 1.4f)};

        vision::Annotations target_ann;
        target_ann.colors = {locked ? vision::Rgba{34, 211, 238, 255}
                                    : vision::Rgba{251, 191, 36, 255}};
        target_ann.radii = {0.05f};
        monitor.pushPoints3D("world/target", {target_3d}, target_ann);

        target_trail.push_back(target_3d);
        if (target_trail.size() > kTrailLength) {
            target_trail.erase(target_trail.begin());
        }
        if (target_trail.size() > 1) {
            monitor.pushLines3D("world/target/trail", {{target_trail}});
        }

        // 7. 事件日志：与曲线共享时间轴，可直接看出状态跳变发生在哪一帧
        if (locked != last_locked) {
            monitor.logText(locked ? vision::LogLevel::Info : vision::LogLevel::Warn,
                            locked ? "target locked" : "target lost (confidence below threshold)");
            last_locked = locked;
        }

        monitor.commit();
        frame_id++;

        std::this_thread::sleep_until(next_frame);
    }

    std::cout << "Shutting down, flushing rerun buffers..." << std::endl;
    monitor.shutdown();
    return 0;
}
