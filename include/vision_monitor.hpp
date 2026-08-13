
#pragma once
#include "shm_layout.hpp"

#include <rerun.hpp>

#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <algorithm>
#include <chrono>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <iostream>
#include <optional>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <vector>

namespace vision {

// 观测面双通道：
//   - 实时：观测 SHM（/aurora_rm_obs，v4）→ web 面板（backend 转 MJPEG/时序）
//   - 可选：Rerun（显式设置 PULSESCOPE_RERUN_CONNECT / _SAVE 时启用；
//     默认不再 spawn viewer——占资源且实时卡顿）
// 控制面走 SHM（backend 写参数，producer 读；producer 写心跳）。
class Monitor {
public:
    static Monitor& getInstance() {
        // 故意不析构（new 后不 delete）：静态析构阶段 Arrow 的全局内存池
        // 可能已先被销毁，RecordingStream 析构中的 flush 会崩溃
        // （"cannot create default memory pool" + core dump）。
        // 进程退出前请显式调用 shutdown() 以 flush 尾部数据。
        static Monitor* instance = new Monitor();
        return *instance;
    }

    bool init(const char* app_id = "pulsescope",
              const char* shm_name = kControlShmName,
              const char* obs_shm_name = kObsShmName) {
        // 观测块失败不致命：web 观测面板不可用，但 Rerun/控制面照常。
        const bool rerun_ok = initRerun(app_id);
        initObsShm(obs_shm_name);
        const bool ctrl_ok = initControlShm(shm_name);
        return rerun_ok && ctrl_ok;
    }

    // 在 main 返回前调用：flush 并关闭 Rerun 流、解除 SHM 映射。
    // 必须在 main 内（而非静态析构阶段）执行，原因见 getInstance() 注释。
    void shutdown() {
        rec.reset(); // RecordingStream 析构 → flush 批处理器中剩余数据
        if (ctrl) {
            munmap(ctrl, kControlShmSize);
            ctrl = nullptr;
        }
        if (obs) {
            munmap(obs, kObsShmSize);
            obs = nullptr;
        }
    }

    // 推送任意 key-value 数据，commit() 时统一按当前帧写入 Rerun
    // 使用方法: Monitor::getInstance().pushData("ekf_x", 12.5);
    template<typename T, typename std::enable_if<std::is_arithmetic<T>::value && !std::is_same<T, bool>::value, int>::type = 0>
    void pushData(const std::string& key, T value) {
        scalar_buffer[key] = static_cast<double>(value);
    }

    void pushData(const std::string& key, bool value) {
        scalar_buffer[key] = value ? 1.0 : 0.0;
    }

    // 批量推送数据 (使用 initializer_list)
    // 使用方法: Monitor::getInstance().pushData({{"ekf_x", 1.0}, {"ekf_y", 2.0}});
    void pushData(std::initializer_list<std::pair<std::string, double>> items) {
        for (const auto& item : items) {
            scalar_buffer[item.first] = item.second;
        }
    }

    // 推送 RGBA 图像帧。像素布局为 width*height*4，commit() 时写入 Rerun。
    void pushImageRGBA(const uint8_t* rgba, uint32_t width, uint32_t height) {
        if (!rgba || width == 0 || height == 0) {
            image_buffer.clear();
            image_width = 0;
            image_height = 0;
            return;
        }
        const size_t frame_size = static_cast<size_t>(width) * static_cast<size_t>(height) * 4;
        image_buffer.assign(rgba, rgba + frame_size);
        image_width = width;
        image_height = height;
    }

    // ESDF 地图（row-major float 栅格），更新频率低，立即写入 Rerun。
    void updateMap(const float* map, size_t width, size_t height) {
        if (!rec || !map || width == 0 || height == 0) return;
        rec->log("esdf/map",
                 rerun::DepthImage(map, {static_cast<uint32_t>(width), static_cast<uint32_t>(height)})
                     .with_colormap(rerun::components::Colormap::Turbo));
    }

    // 提交当前帧：时序数据 + 图像统一打上帧号写入 Rerun，并刷新 SHM 心跳。
    void commit() {
        const uint64_t now_ms = nowMs();

        if (rec) {
            rec->set_time_sequence("frame", static_cast<int64_t>(frame_index));

            for (const auto& [key, value] : scalar_buffer) {
                rec->log("telemetry/" + key, rerun::Scalars(value));
            }

            const size_t expected_size = static_cast<size_t>(image_width) * static_cast<size_t>(image_height) * 4;
            if (!image_buffer.empty() && image_buffer.size() == expected_size) {
                rec->log("camera/image",
                         rerun::Image::from_rgba32(image_buffer, {image_width, image_height}));
            }

            // Rerun 批处理器的定时 flush 在大图像流量下会被大小阈值 flush 饿死，
            // 小 chunk（标量/小地图）长期滞留，进程被杀时全部丢失（实测只有图像落盘）。
            // 周期性显式 flush：标量实时可达 viewer，异常退出的丢失也有上界。
            // 带超时，避免 sink 阻塞（如 viewer 断连）拖垮视觉主循环。
            if (now_ms - last_flush_ms >= kFlushIntervalMs) {
                rec->flush_blocking(0.2f).handle();
                last_flush_ms = now_ms;
            }
        }

        if (ctrl) {
            ctrl->heartbeat_ms = now_ms;
        }

        publishObs(now_ms);

        scalar_buffer.clear();
        frame_index++;
    }

    // 读取调参参数（backend 通过 SHM 写入）
    void syncParams(float& p, float& i, float& d, uint32_t& exposure, bool& fire_enabled) {
        if (!ctrl) {
            p = 1.0f;
            i = 0.0f;
            d = 0.1f;
            exposure = 5000;
            fire_enabled = true;
            return;
        }
        p = ctrl->pid_p;
        i = ctrl->pid_i;
        d = ctrl->pid_d;
        exposure = ctrl->exposure_time;
        fire_enabled = ctrl->is_fire_enabled != 0;
    }

    void syncParams(float& p, float& i, float& d) {
        uint32_t exposure = 0;
        bool fire_enabled = false;
        syncParams(p, i, d, exposure, fire_enabled);
    }

private:
    Monitor() : ctrl(nullptr), obs(nullptr), image_width(0), image_height(0), frame_index(0), last_flush_ms(0) {}
    Monitor(const Monitor&) = delete;
    Monitor& operator=(const Monitor&) = delete;

    bool initRerun(const char* app_id) {
        rec.emplace(app_id);

        const char* connect_url = std::getenv("PULSESCOPE_RERUN_CONNECT");
        const char* save_path = std::getenv("PULSESCOPE_RERUN_SAVE");

        rerun::Error err = rerun::Error::ok();
        if (connect_url && *connect_url) {
            err = rec->connect_grpc(connect_url);
        } else if (save_path && *save_path) {
            err = rec->save(save_path);
        } else {
            // 默认关闭实时 Rerun（spawn viewer 占资源且实时卡顿）；
            // 实时观测走 web 面板，需要深度分析/回放时显式设上述环境变量。
            rec.reset();
            return true;
        }

        if (err.is_err()) {
            std::cerr << "rerun sink init failed: " << err.description << std::endl;
            rec.reset();
            return false;
        }
        return true;
    }

    bool initObsShm(const char* shm_name) {
        int fd = shm_open(shm_name, O_CREAT | O_RDWR, 0666);
        if (fd == -1) {
            std::cerr << "obs shm_open failed: " << strerror(errno) << std::endl;
            return false;
        }
        if (ftruncate(fd, static_cast<off_t>(kObsShmSize)) == -1) {
            std::cerr << "obs ftruncate failed: " << strerror(errno) << std::endl;
            close(fd);
            return false;
        }
        void* ptr = mmap(NULL, kObsShmSize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        close(fd);
        if (ptr == MAP_FAILED) {
            std::cerr << "obs mmap failed: " << strerror(errno) << std::endl;
            return false;
        }
        obs = static_cast<ObsShmHeader*>(ptr);
        obs->magic_number = kShmMagicNumber;
        obs->version = kObsShmVersion;
        obs->sequence = 0;
        obs->img_offset = 0;
        obs->img_size = 0;
        obs->width = 0;
        obs->height = 0;
        obs->json_offset = 0;
        obs->json_size = 0;
        return true;
    }

    // 把当前帧（图像 + 标量快照）写入观测 SHM（seqlock：奇=写，偶=稳）。
    void publishObs(uint64_t now_ms) {
        if (!obs) return;

        // 构建 JSON 快照（与后端约定：{key: number}，无嵌套）
        std::string json_str;
        json_str.reserve(scalar_buffer.size() * 28 + 4);
        json_str.push_back('{');
        bool first = true;
        for (const auto& [key, value] : scalar_buffer) {
            if (!first) json_str.push_back(',');
            json_str.push_back('"');
            json_str += key;
            json_str += "\":";
            json_str += std::to_string(value);
            first = false;
        }
        json_str.push_back('}');
        if (json_str.size() > kObsMaxJsonBytes) {
            json_str.resize(kObsMaxJsonBytes);
        }

        const size_t expected_size =
            static_cast<size_t>(image_width) * static_cast<size_t>(image_height) * 4;
        const bool have_image =
            !image_buffer.empty() && image_buffer.size() == expected_size && expected_size > 0;

        // begin write
        obs->sequence = frame_index * 2 + 1;
        __sync_synchronize();

        char* base = reinterpret_cast<char*>(obs);
        size_t cursor = sizeof(ObsShmHeader);
        if (have_image && cursor + expected_size <= kObsShmSize) {
            std::memcpy(base + cursor, image_buffer.data(), expected_size);
            obs->img_offset = cursor;
            obs->img_size = expected_size;
            obs->width = image_width;
            obs->height = image_height;
            cursor += expected_size;
        } else {
            obs->img_offset = 0;
            obs->img_size = 0;
            obs->width = 0;
            obs->height = 0;
        }

        size_t json_size = 0;
        if (cursor < kObsShmSize) {
            json_size = std::min(json_str.size(), kObsShmSize - cursor);
            if (json_size > 0) {
                std::memcpy(base + cursor, json_str.data(), json_size);
            }
        }
        obs->json_offset = cursor;
        obs->json_size = json_size;
        obs->timestamp_ms = now_ms;
        obs->frame_index = frame_index;

        // end write
        __sync_synchronize();
        obs->sequence = frame_index * 2 + 2;
    }

    bool initControlShm(const char* shm_name) {
        int fd = shm_open(shm_name, O_CREAT | O_RDWR, 0666);
        if (fd == -1) {
            std::cerr << "shm_open failed: " << strerror(errno) << std::endl;
            return false;
        }
        if (ftruncate(fd, static_cast<off_t>(kControlShmSize)) == -1) {
            std::cerr << "ftruncate failed: " << strerror(errno) << std::endl;
            close(fd);
            return false;
        }

        void* ptr = mmap(NULL, kControlShmSize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        close(fd);
        if (ptr == MAP_FAILED) {
            std::cerr << "mmap failed: " << strerror(errno) << std::endl;
            return false;
        }

        ctrl = static_cast<ShmControlBlock*>(ptr);

        // 初始化默认参数，防止后端读到垃圾数据
        if (ctrl->magic_number != kShmMagicNumber || ctrl->version != kShmVersion) {
            std::memset(ctrl, 0, kControlShmSize);
            ctrl->magic_number = kShmMagicNumber;
            ctrl->version = kShmVersion;
            ctrl->pid_p = 1.0f;
            ctrl->pid_i = 0.0f;
            ctrl->pid_d = 0.1f;
            ctrl->exposure_time = 5000;
            ctrl->is_fire_enabled = 1;
        }
        return true;
    }

    static uint64_t nowMs() {
        return static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()
            ).count()
        );
    }

    static constexpr uint64_t kFlushIntervalMs = 1000;

    std::optional<rerun::RecordingStream> rec;
    ShmControlBlock* ctrl;
    ObsShmHeader* obs;
    std::unordered_map<std::string, double> scalar_buffer;
    std::vector<uint8_t> image_buffer;
    uint32_t image_width;
    uint32_t image_height;
    uint64_t frame_index;
    uint64_t last_flush_ms;
};

} // namespace vision
