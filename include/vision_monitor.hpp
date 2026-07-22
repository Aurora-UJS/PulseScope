
#pragma once
#include "shm_layout.hpp"
#include "vision_types.hpp"

#include <rerun.hpp>

#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <atomic>
#include <chrono>
#include <cerrno>
#include <cmath>
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

// 参数句柄：declare 时返回，主循环中直接读，避免每帧按 key 做字符串查找。
//
// SHM 不可用时（producer 未能挂载控制块）句柄仍然有效可读，
// get() 回落到注册时给定的默认值——业务代码无需区分两种情况。
class ParamHandle {
public:
    ParamHandle() : slot_(nullptr), fallback_(0.0) {}
    ParamHandle(const ParamSlot* slot, double fallback)
        : slot_(slot), fallback_(fallback) {}

    // 是否真正绑定到共享内存槽位（false 表示只能读到默认值）
    bool bound() const { return slot_ != nullptr; }

    double get() const {
        if (!slot_) return fallback_;
        // volatile 读：阻止编译器将跨进程可变的值缓存进寄存器或提出循环。
        // 8 字节对齐的 load 在 x86-64 / ARM64 上由硬件保证不撕裂（见 shm_layout.hpp）。
        return *static_cast<const volatile double*>(&slot_->value);
    }

    float   getFloat() const { return static_cast<float>(get()); }
    int32_t getInt()   const { return static_cast<int32_t>(std::llround(get())); }
    bool    getBool()  const { return get() != 0.0; }

private:
    const ParamSlot* slot_;
    double fallback_;
};

// 观测面走 Rerun（时序/图像/地图 → Rerun Viewer），
// 控制面走 SHM（backend 写参数，producer 读；producer 写心跳）。
//
// Rerun sink 由环境变量选择（按优先级）：
//   PULSESCOPE_RERUN_CONNECT=rerun+http://<host>:9876/proxy  连接已运行的 viewer
//   PULSESCOPE_RERUN_SAVE=<path>.rrd                          录制到文件（可事后回放）
//   （都未设置）                                               spawn 本机 viewer
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
              const char* shm_name = kControlShmName) {
        return initRerun(app_id) && initControlShm(shm_name);
    }

    // 在 main 返回前调用：flush 并关闭 Rerun 流、解除 SHM 映射。
    // 必须在 main 内（而非静态析构阶段）执行，原因见 getInstance() 注释。
    void shutdown() {
        rec.reset(); // RecordingStream 析构 → flush 批处理器中剩余数据
        if (ctrl) {
            munmap(ctrl, kControlShmSize);
            ctrl = nullptr;
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

    // ---- 帧边界 ------------------------------------------------------------

    // 开始新一帧。可选传入该帧数据的采集时刻（Unix 秒，例如相机曝光时间戳），
    // 用于与其他数据源（IMU / 串口 / 下位机）在时间轴上对齐；不传则用当前时刻。
    //
    // 不显式调用也可以：任何 push* 都会在首次写入前自动确定本帧的时间轴。
    // 需要精确对齐时（自瞄尤其需要）才显式调用并传入采集时刻。
    void beginFrame(double capture_time_secs = 0.0) {
        capture_time_override_ = capture_time_secs;
        timeline_applied_ = false;
        applyTimeline();
    }

    // ---- 图像 --------------------------------------------------------------

    // 推送 RGBA 图像帧（width*height*4）。支持多路：用不同 entity 区分，
    // 例如 "camera/raw"、"camera/binary"、"camera/debug"。
    void pushImageRGBA(const uint8_t* rgba, uint32_t width, uint32_t height,
                       const char* entity = "camera/image") {
        if (!rec || !rgba || width == 0 || height == 0) return;
        applyTimeline();
        // rerun::Collection 会从这段内存拷贝一份，无需自己再缓冲一次
        const size_t n = static_cast<size_t>(width) * static_cast<size_t>(height) * 4;
        rec->log(entity, rerun::Image::from_rgba32(
                             rerun::Collection<uint8_t>(std::vector<uint8_t>(rgba, rgba + n)),
                             {width, height}));
    }

    // 单通道 float 栅格（ESDF / 代价地图 / 深度）。以 Turbo 伪彩呈现。
    void pushGrid(const float* grid, uint32_t width, uint32_t height,
                  const char* entity = "esdf/map") {
        if (!rec || !grid || width == 0 || height == 0) return;
        applyTimeline();
        rec->log(entity, rerun::DepthImage(grid, {width, height})
                             .with_colormap(rerun::components::Colormap::Turbo));
    }

    // 兼容旧签名
    void updateMap(const float* map, size_t width, size_t height) {
        pushGrid(map, static_cast<uint32_t>(width), static_cast<uint32_t>(height), "esdf/map");
    }

    // ---- 2D 标注（图像空间）------------------------------------------------
    // entity 建议挂在图像下，例如 "camera/image/armors"，这样标注会叠加在画面上。

    void pushBoxes2D(const char* entity, const std::vector<Box2D>& boxes,
                     const Annotations& ann = {}) {
        if (!rec || boxes.empty()) return;
        applyTimeline();
        std::vector<rerun::datatypes::Vec2D> centers, half_sizes;
        centers.reserve(boxes.size());
        half_sizes.reserve(boxes.size());
        for (const auto& b : boxes) {
            centers.push_back({b.cx, b.cy});
            half_sizes.push_back({b.w * 0.5f, b.h * 0.5f});
        }
        rec->log(entity, decorate(rerun::Boxes2D::from_centers_and_half_sizes(centers, half_sizes),
                                  ann, boxes.size(), entity));
    }

    void pushPoints2D(const char* entity, const std::vector<Vec2>& points,
                      const Annotations& ann = {}) {
        if (!rec || points.empty()) return;
        applyTimeline();
        std::vector<rerun::components::Position2D> pos;
        pos.reserve(points.size());
        for (const auto& p : points) pos.emplace_back(p.x, p.y);
        rec->log(entity, decorate(rerun::Points2D(pos), ann, points.size(), entity));
    }

    void pushLines2D(const char* entity, const std::vector<Polyline2D>& lines,
                     const Annotations& ann = {}) {
        if (!rec || lines.empty()) return;
        applyTimeline();
        std::vector<rerun::components::LineStrip2D> strips;
        strips.reserve(lines.size());
        for (const auto& line : lines) {
            std::vector<rerun::datatypes::Vec2D> pts;
            pts.reserve(line.points.size());
            for (const auto& p : line.points) pts.push_back({p.x, p.y});
            strips.emplace_back(std::move(pts));
        }
        rec->log(entity, decorate(rerun::LineStrips2D(strips), ann, lines.size(), entity));
    }

    // ---- 3D（世界空间）-----------------------------------------------------

    void pushPoints3D(const char* entity, const std::vector<Vec3>& points,
                      const Annotations& ann = {}) {
        if (!rec || points.empty()) return;
        applyTimeline();
        std::vector<rerun::components::Position3D> pos;
        pos.reserve(points.size());
        for (const auto& p : points) pos.emplace_back(p.x, p.y, p.z);
        rec->log(entity, decorate(rerun::Points3D(pos), ann, points.size(), entity));
    }

    void pushBoxes3D(const char* entity, const std::vector<Box3D>& boxes,
                     const Annotations& ann = {}) {
        if (!rec || boxes.empty()) return;
        applyTimeline();
        std::vector<rerun::datatypes::Vec3D> centers, half_sizes;
        centers.reserve(boxes.size());
        half_sizes.reserve(boxes.size());
        for (const auto& b : boxes) {
            centers.push_back({b.center.x, b.center.y, b.center.z});
            half_sizes.push_back({b.size.x * 0.5f, b.size.y * 0.5f, b.size.z * 0.5f});
        }
        rec->log(entity, decorate(rerun::Boxes3D::from_centers_and_half_sizes(centers, half_sizes),
                                  ann, boxes.size(), entity));
    }

    void pushLines3D(const char* entity, const std::vector<Polyline3D>& lines,
                     const Annotations& ann = {}) {
        if (!rec || lines.empty()) return;
        applyTimeline();
        std::vector<rerun::components::LineStrip3D> strips;
        strips.reserve(lines.size());
        for (const auto& line : lines) {
            std::vector<rerun::datatypes::Vec3D> pts;
            pts.reserve(line.points.size());
            for (const auto& p : line.points) pts.push_back({p.x, p.y, p.z});
            strips.emplace_back(std::move(pts));
        }
        rec->log(entity, decorate(rerun::LineStrips3D(strips), ann, lines.size(), entity));
    }

    // 箭头：梯度场、速度、受力方向
    void pushArrows3D(const char* entity, const std::vector<Arrow3D>& arrows,
                      const Annotations& ann = {}) {
        if (!rec || arrows.empty()) return;
        applyTimeline();
        std::vector<rerun::components::Vector3D> vectors;
        std::vector<rerun::components::Position3D> origins;
        vectors.reserve(arrows.size());
        origins.reserve(arrows.size());
        for (const auto& a : arrows) {
            vectors.emplace_back(a.vector.x, a.vector.y, a.vector.z);
            origins.emplace_back(a.origin.x, a.origin.y, a.origin.z);
        }
        rec->log(entity, decorate(rerun::Arrows3D::from_vectors(vectors).with_origins(origins),
                                  ann, arrows.size(), entity));
    }

    // ---- 空间关系 ----------------------------------------------------------

    // 设置实体相对其父实体的位姿。Rerun 的实体路径本身就是变换树：
    // 在 "world/gimbal" 上设变换，其子实体 "world/gimbal/camera" 自动继承。
    // 自瞄的 相机系→云台系→世界系 链路正是这样表达。
    void setTransform(const char* entity, const Vec3& translation, const Quat& rotation = {}) {
        if (!rec) return;
        applyTimeline();
        rec->log(entity, rerun::Transform3D::from_translation_rotation(
                             rerun::datatypes::Vec3D{translation.x, translation.y, translation.z},
                             rerun::Rotation3D(rerun::datatypes::Quaternion::from_xyzw(
                                 rotation.x, rotation.y, rotation.z, rotation.w))));
    }

    // 相机内参。设置后 Rerun 能把该实体下的 2D 标注投影进 3D 场景，
    // 也能在 3D 视图里画出视锥——2D 检测与 3D 世界打通的关键一步。
    void setPinhole(const char* entity, float focal_px, uint32_t width, uint32_t height) {
        if (!rec || width == 0 || height == 0) return;
        applyTimeline();
        rec->log(entity, rerun::Pinhole::from_focal_length_and_resolution(
                             {focal_px, focal_px},
                             {static_cast<float>(width), static_cast<float>(height)}));
    }

    // ---- 事件日志 ----------------------------------------------------------

    // 带级别的文本事件，在 Rerun 里按时间轴排列，可与曲线对照查看
    // （例如「切换目标」「丢失跟踪」发生在哪一帧）。
    void logText(LogLevel level, const std::string& message, const char* entity = "events") {
        if (!rec) return;
        applyTimeline();
        rec->log(entity, rerun::TextLog(message).with_level(toRerunLevel(level)));
    }

    // ---- 逃生舱 ------------------------------------------------------------

    // 直接访问底层 RecordingStream，用于本类未封装的 archetype
    // （Mesh3D、Tensor、AnnotationContext 等）。时间轴已由本帧设置好，
    // 直接 log 即可；返回 nullptr 表示 Rerun sink 未就绪。
    //
    //   if (auto* rec = monitor.stream()) {
    //       rec->log("world/mesh", rerun::Mesh3D(vertices));
    //   }
    rerun::RecordingStream* stream() {
        if (!rec) return nullptr;
        applyTimeline();
        return &rec.value();
    }

    // 提交当前帧：时序数据 + 图像统一打上帧号写入 Rerun，并刷新 SHM 心跳。
    void commit() {
        const uint64_t now_ms = nowMs();

        if (rec) {
            if (!scalar_buffer.empty()) {
                applyTimeline();
                for (const auto& [key, value] : scalar_buffer) {
                    rec->log("telemetry/" + key, rerun::Scalars(value));
                }
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

        scalar_buffer.clear();
        frame_index++;

        // 下一帧重新确定时间轴；清除本帧的采集时刻覆盖值
        timeline_applied_ = false;
        capture_time_override_ = 0.0;
    }

    // ---- 参数注册 ----------------------------------------------------------
    // 在 init() 之后、主循环之前声明。backend 与前端从共享内存读取这些元数据
    // 自动渲染 UI 并校验写入，两侧都不再硬编码参数名或范围。
    //
    // 使用方法:
    //   auto gain = monitor.declareFloat("pid_p", 1.0, 0.0, 10.0, 0.01);
    //   auto exp  = monitor.declareInt("exposure_time", 5000, 100, 50000, 100, "us");
    //   auto fire = monitor.declareBool("fire_enabled", true);
    //   ... 主循环中: gain.getFloat() / exp.getInt() / fire.getBool()

    ParamHandle declareFloat(const char* key, double default_value,
                             double min_value, double max_value,
                             double step = 0.0, const char* unit = "") {
        return declare(key, kParamFloat, default_value, min_value, max_value, step, unit);
    }

    ParamHandle declareInt(const char* key, int64_t default_value,
                           int64_t min_value, int64_t max_value,
                           int64_t step = 1, const char* unit = "") {
        return declare(key, kParamInt,
                       static_cast<double>(default_value),
                       static_cast<double>(min_value),
                       static_cast<double>(max_value),
                       static_cast<double>(step), unit);
    }

    ParamHandle declareBool(const char* key, bool default_value) {
        return declare(key, kParamBool, default_value ? 1.0 : 0.0, 0.0, 1.0, 1.0, "");
    }

    // 已注册的参数个数（<= kMaxParams）
    uint32_t paramCount() const { return ctrl ? ctrl->param_count : 0; }

private:
    // 注册单个参数。失败（SHM 不可用 / 槽位耗尽 / key 非法或重复）时返回
    // 未绑定句柄，业务代码照常读到 default_value，只是无法在线调参。
    ParamHandle declare(const char* key, ParamType type, double default_value,
                        double min_value, double max_value, double step, const char* unit) {
        if (!key || !*key) {
            std::cerr << "declare: empty key" << std::endl;
            return ParamHandle(nullptr, default_value);
        }
        if (std::strlen(key) >= kParamKeyLen) {
            std::cerr << "declare: key too long (>= " << kParamKeyLen << "): " << key << std::endl;
            return ParamHandle(nullptr, default_value);
        }
        if (unit && std::strlen(unit) >= kParamUnitLen) {
            std::cerr << "declare: unit too long (>= " << kParamUnitLen << "): " << key << std::endl;
            return ParamHandle(nullptr, default_value);
        }
        if (min_value > max_value) {
            std::cerr << "declare: min > max for key: " << key << std::endl;
            return ParamHandle(nullptr, default_value);
        }
        if (!ctrl) {
            // SHM 未挂载：仍返回可读的默认值句柄，producer 能独立运行
            return ParamHandle(nullptr, default_value);
        }

        const uint32_t n = ctrl->param_count;
        if (n >= kMaxParams) {
            std::cerr << "declare: slot table full (" << kMaxParams << "), dropped: " << key << std::endl;
            return ParamHandle(nullptr, default_value);
        }
        for (uint32_t i = 0; i < n; ++i) {
            if (std::strncmp(ctrl->params[i].key, key, kParamKeyLen) == 0) {
                std::cerr << "declare: duplicate key: " << key << std::endl;
                return ParamHandle(nullptr, default_value);
            }
        }

        ParamSlot& slot = ctrl->params[n];
        std::memset(&slot, 0, sizeof(ParamSlot));
        std::strncpy(slot.key, key, kParamKeyLen - 1);
        if (unit) std::strncpy(slot.unit, unit, kParamUnitLen - 1);
        slot.type = static_cast<uint8_t>(type);
        slot.min_value = min_value;
        slot.max_value = max_value;
        slot.step = step;
        slot.default_value = default_value;

        // 同名同类型的参数在上一轮 producer 生命周期里已被调过，沿用其值，
        // 避免每次重编译重启 producer 都要重新调参。范围可能已变，钳制回区间内。
        double initial = default_value;
        for (const auto& prev : restored_) {
            if (prev.type == static_cast<uint8_t>(type) && prev.key == key) {
                initial = prev.value < min_value ? min_value
                        : (prev.value > max_value ? max_value : prev.value);
                break;
            }
        }
        slot.value = initial;

        // 发布屏障：槽位内容必须先于 param_count 可见，
        // 否则 backend 可能读到计数已增、内容尚未写入的槽位。
        std::atomic_thread_fence(std::memory_order_release);
        ctrl->param_count = n + 1;

        return ParamHandle(&slot, default_value);
    }

    Monitor()
        : ctrl(nullptr), frame_index(0), last_flush_ms(0),
          start_time_(std::chrono::steady_clock::now()),
          capture_time_override_(0.0), timeline_applied_(false), annotation_warnings_(0) {}
    Monitor(const Monitor&) = delete;
    Monitor& operator=(const Monitor&) = delete;

    // 确定本帧的时间轴。每帧首次写入前调用一次，commit() 后失效。
    //
    // 三条时间轴各有用途：
    //   frame        逐帧步进，与算法迭代对齐
    //   runtime      距进程启动的秒数，看「跑了多久」
    //   capture_time 绝对 wall-clock，与 IMU / 串口 / 下位机等外部数据源对齐
    //                （自瞄排查「识别慢了还是预测超前量不对」全靠它）
    void applyTimeline() {
        if (timeline_applied_ || !rec) return;

        rec->set_time_sequence("frame", static_cast<int64_t>(frame_index));
        rec->set_time_duration_secs("runtime", secondsSinceStart());
        rec->set_time_timestamp_secs_since_epoch(
            "capture_time",
            capture_time_override_ > 0.0 ? capture_time_override_ : nowSecs());

        timeline_applied_ = true;
    }

    // 把可选的 labels/colors/radii 应用到 archetype。
    // 长度与元素个数不符时忽略并告警，而不是静默截断或崩溃。
    template <typename Archetype>
    Archetype decorate(Archetype archetype, const Annotations& ann,
                       size_t count, const char* entity) {
        if (!ann.labels.empty()) {
            if (ann.labels.size() == count) {
                std::vector<rerun::components::Text> texts;
                texts.reserve(count);
                for (const auto& s : ann.labels) texts.emplace_back(s);
                archetype = std::move(archetype).with_labels(std::move(texts));
            } else {
                warnAnnotation(entity, "labels", ann.labels.size(), count);
            }
        }
        if (!ann.colors.empty()) {
            if (ann.colors.size() == count) {
                std::vector<rerun::components::Color> colors;
                colors.reserve(count);
                for (const auto& c : ann.colors) colors.emplace_back(c.r, c.g, c.b, c.a);
                archetype = std::move(archetype).with_colors(std::move(colors));
            } else {
                warnAnnotation(entity, "colors", ann.colors.size(), count);
            }
        }
        if (!ann.radii.empty()) {
            if (ann.radii.size() == count) {
                std::vector<rerun::components::Radius> radii;
                radii.reserve(count);
                for (float r : ann.radii) radii.emplace_back(r);
                archetype = std::move(archetype).with_radii(std::move(radii));
            } else {
                warnAnnotation(entity, "radii", ann.radii.size(), count);
            }
        }
        return archetype;
    }

    // 尺寸不匹配是调用方的编程错误，应当可见；但主循环每帧都会重复，
    // 因此限量输出，避免刷屏淹没其他日志。
    void warnAnnotation(const char* entity, const char* what, size_t got, size_t want) {
        if (annotation_warnings_ >= kMaxAnnotationWarnings) return;
        ++annotation_warnings_;
        std::cerr << "pulsescope: " << entity << ": " << what << " count " << got
                  << " != element count " << want << ", ignored" << std::endl;
        if (annotation_warnings_ == kMaxAnnotationWarnings) {
            std::cerr << "pulsescope: further annotation warnings suppressed" << std::endl;
        }
    }

    static rerun::TextLogLevel toRerunLevel(LogLevel level) {
        switch (level) {
            case LogLevel::Trace: return rerun::TextLogLevel::Trace;
            case LogLevel::Debug: return rerun::TextLogLevel::Debug;
            case LogLevel::Warn:  return rerun::TextLogLevel::Warning;
            case LogLevel::Error: return rerun::TextLogLevel::Error;
            case LogLevel::Info:
            default:              return rerun::TextLogLevel::Info;
        }
    }

    double secondsSinceStart() const {
        return std::chrono::duration<double>(
                   std::chrono::steady_clock::now() - start_time_).count();
    }

    static double nowSecs() {
        return std::chrono::duration<double>(
                   std::chrono::system_clock::now().time_since_epoch()).count();
    }

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
            err = rec->spawn();
        }

        if (err.is_err()) {
            std::cerr << "rerun sink init failed: " << err.description << std::endl;
            rec.reset();
            return false;
        }
        return true;
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

        // 上一轮 producer 若留下同版本的参数表，先快照其调过的值，
        // 供随后的 declare 复用（见 declare 中的 restored_ 查找）。
        restored_.clear();
        if (ctrl->magic_number == kShmMagicNumber && ctrl->version == kShmVersion) {
            const uint32_t prev_count = ctrl->param_count <= kMaxParams ? ctrl->param_count : 0;
            restored_.reserve(prev_count);
            for (uint32_t i = 0; i < prev_count; ++i) {
                const ParamSlot& slot = ctrl->params[i];
                // key 必须是 NUL 结尾的合法字符串，否则视为脏数据跳过
                if (std::memchr(slot.key, '\0', kParamKeyLen) == nullptr || slot.key[0] == '\0') {
                    continue;
                }
                restored_.push_back({std::string(slot.key), slot.type, slot.value});
            }
        }

        // 无条件重建：本轮 declare 的参数集可能与上一轮不同（增删改名），
        // 沿用旧表会残留已废弃的槽位。清零后由 declare 逐个重新发布。
        std::memset(ctrl, 0, kControlShmSize);
        ctrl->version = kShmVersion;
        ctrl->param_count = 0;

        // magic 最后写：backend 以 magic + version 判定控制块可用，
        // 先写头部字段再放行，避免读到半初始化的块。
        std::atomic_thread_fence(std::memory_order_release);
        ctrl->magic_number = kShmMagicNumber;
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
    static constexpr int kMaxAnnotationWarnings = 10;

    // 上一轮 producer 生命周期遗留的参数值，供 declare 按 key+type 恢复
    struct RestoredParam {
        std::string key;
        uint8_t     type;
        double      value;
    };

    std::optional<rerun::RecordingStream> rec;
    ShmControlBlock* ctrl;
    std::vector<RestoredParam> restored_;
    std::unordered_map<std::string, double> scalar_buffer;
    uint64_t frame_index;
    uint64_t last_flush_ms;

    std::chrono::steady_clock::time_point start_time_;
    double capture_time_override_;   // >0 表示本帧由调用方指定了采集时刻
    bool   timeline_applied_;        // 本帧是否已确定时间轴
    int    annotation_warnings_;
};

} // namespace vision
