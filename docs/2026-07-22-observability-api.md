# 观测面 API 扩展：从「标量 + 整帧图像」到结构化可视化

- 日期：2026-07-22
- 分支：`refactor/self-describing-params`（承接[控制面参数改造](2026-07-22-self-describing-control-params.md)）
- 范围：`vision_types.hpp`（新增）、`vision_monitor.hpp`、demo、观测面测试
- 用法文档：[观测面 API 指南](observability-api.md)

---

## 1. 改之前的缺口

`Monitor` 的观测面只有两种数据类型：

```cpp
std::unordered_map<std::string, double> scalar_buffer;   // 标量
std::vector<uint8_t> image_buffer;                       // 一路 RGBA 整帧
```

Rerun 提供 50 种 archetype，这层封装只用到了 `Scalars` / `Image` / `DepthImage` 三种。
`Boxes2D`、`Points2D/3D`、`Transform3D`、`Pinhole`、`LineStrips`、`TextLog` 全部没暴露。

三个具体后果：

**① 结构化数据被降级成像素。** demo 里识别框是逐像素画进 RGBA 的
（`drawPixel` 循环画四条边）。烧进去之后无法悬停查坐标、无法按时间筛选、
无法单独关掉图层——买了台示波器只用它的电压档。

**② 没有真实时间戳。** 只有 `set_time_sequence("frame", n)`。
自瞄调试的核心是时序对齐：相机曝光时刻、IMU 时刻、串口收发时刻、预测的未来时刻。
没有绝对时间轴就无法把它们对齐，也就无法回答「是识别慢了还是预测超前量不对」。

**③ 没有坐标系表达。** 自瞄本质是 相机系→云台系→世界系 的链式变换，
Rerun 的实体路径天然就是变换树，但完全没用上。

---

## 2. 设计

### 2.1 不再「隐藏 Rerun」，而是「翻译 + 放行」

前一轮评估时的结论是：不要继续加厚封装。Rerun 的价值在于它的类型系统，
把一切压成 `double` 等于把价值扔掉。但直接让业务代码全用 Rerun 类型又太重
（`Collection<components::Position2D>` 这种签名不适合天天写）。

采用的折中是**双层**：

- **便捷层**：`vision_types.hpp` 定义聚合初始化的 POD（`Vec2`/`Vec3`/`Box2D`/`Quat`…），
  不依赖 Rerun、OpenCV、Eigen。业务代码写 `{cx, cy, w, h}` 即可，
  也容易从 `cv::Point2f` / `Eigen::Vector3f` 转过来。`Monitor` 负责翻译成 archetype。
- **逃生舱**：`Monitor::stream()` 返回底层 `RecordingStream*`，
  时间轴已设置好，需要 `Mesh3D`/`Tensor` 这类未封装类型时直接 `log`。

便捷层覆盖常用路径，逃生舱保证不封顶。

### 2.2 三条时间轴

```cpp
rec->set_time_sequence("frame", frame_index);
rec->set_time_duration_secs("runtime", secondsSinceStart());
rec->set_time_timestamp_secs_since_epoch("capture_time", capture);
```

| 时间轴 | 用途 |
|---|---|
| `frame` | 逐帧步进，与算法迭代对齐 |
| `runtime` | 相对启动秒数，看长期趋势 |
| `capture_time` | **绝对时刻，跨数据源对齐的唯一依据** |

`beginFrame(capture_time_secs)` 可传入相机曝光时刻。不传则用当前时刻，
也可以完全不调用——任何 `push*` 会在本帧首次写入时懒惰确定时间轴（`timeline_applied_` 标志），
`commit()` 后失效。这样既保证时间语义正确，又不强制调用方改变现有写法。

### 2.3 图像不再缓冲

旧实现 `pushImageRGBA` 把整帧 `assign` 进 `image_buffer`，`commit()` 时才 log。
新实现直接 log——因为时间轴已由 `applyTimeline()` 保证正确，缓冲不再必要。

副作用是**省掉了每帧一次全图拷贝**（50Hz 下是实打实的收益），
并且天然支持多路图像（不同 entity 即可，旧设计只能一路）。

标量仍保留缓冲：`pushData` 的语义是同 key 覆盖，批量写更合适。

### 2.4 装饰用统一模板

7 个 archetype（Boxes2D/3D、Points2D/3D、LineStrips2D/3D、Arrows3D）
都有 `with_labels`/`with_colors`/`with_radii`，因此 `decorate()` 用一个模板处理，
不必逐类型重复。数量与元素个数不符时**告警并忽略该项装饰**，
几何本身照常写入——不静默截断，也不崩溃。告警限量 10 条，避免主循环刷屏。

---

## 3. 实现要点

新增 API：

```
帧边界    beginFrame(capture_time_secs = 0)
图像      pushImageRGBA(rgba, w, h, entity)   pushGrid(grid, w, h, entity)
2D 标注   pushBoxes2D  pushPoints2D  pushLines2D
3D        pushPoints3D  pushBoxes3D  pushLines3D  pushArrows3D
空间关系  setTransform  setPinhole
事件      logText
逃生舱    stream()
```

保留 `pushData`、`pushImageRGBA`（旧签名）、`updateMap` 以兼容既有业务代码。

demo（`src_cpp/main.cpp`）改成了接近真实的自瞄场景：
建立 `world/gimbal/camera` 变换树、图像与识别框分离、3D 目标位置与滚动轨迹、
置信度过阈值切换标注颜色、状态跳变写 `TextLog`。它同时是最完整的用法示例。

---

## 4. 测试与证据

### 4.1 两层验证

`tests/observability_test.cpp`（3 场景）验证**调用不崩、边界安全、告警正确**：
空容器、空指针、零尺寸、annotation 尺寸不符、控制面缺失时观测面仍可用。

`tests/run_observability_tests.sh` 验证**数据真的写对了**——
解析 `.rrd` 中的明文，断言实体路径、archetype 类型、时间轴名称确实存在。

第二层不可省。早先就实测到过 Rerun 批处理器在大图像流量下饿死小 chunk、
导致标量整批丢失的情况：**push 调用返回正常，不代表数据落盘了**。

实测覆盖：3 条时间轴、14 种 archetype、13 条实体路径。

### 4.1b 二次开发路径实测

新增 header-only 接口库 target `pulsescope`，业务工程两行接入：

```cmake
add_subdirectory(path/to/PulseScope pulsescope_build EXCLUDE_FROM_ALL)
target_link_libraries(my_vision_node PRIVATE pulsescope)
```

已用一个**位于仓库之外的最小工程**实测走通：构建成功、写出的 `.rrd` 含完整变换树与
三条时间轴、`declare` 的参数被另一进程的 `shm_ctl` 正确读出。
即观测面与控制面对外部使用者都可用，不只是在本仓库的 demo 里可用。

### 4.2 可视化验证

用 `rerun --serve-web` 起网页版 Viewer，Chrome headless 截图确认渲染结果：
3D 视图里的目标轨迹与相机视锥、图像上叠加的识别框与 `armor conf=0.85` 标签、
`TextLog` 的 INFO/WARN 事件、ESDF 伪彩图、时间轴上 9243 行数据、49 个实体。

> 截图方法值得记一笔：`chrome --headless --screenshot` **截不出来**，
> 因为 Rerun Viewer 是 WASM + WebGL，`--virtual-time-budget` 会冻结真实时间，
> 反而让 WASM 卡在「Loading Application Bundle 100%」。
> 必须用 CDP（`--remote-debugging-port` + `Page.captureScreenshot`），
> 等真实时间过去再截。本机无 GPU，需 `--enable-unsafe-swiftshader --use-angle=swiftshader`
> 软件渲染（Viewer 左上角会显示 "Software rasterizer" 提示，不影响功能验证）。

---

## 5. 踩到的坑（都是测试脚本的，不是产品代码）

**`set -o pipefail` + `grep -q` = 大文件时假阴性。**
`strings big.rrd | grep -qE pattern` —— `grep -q` 命中后立即退出，
上游 `strings` 收到 SIGPIPE（退出码 141），`pipefail` 把整条管道判为失败。
于是**匹配成功反而报 FAIL**。更阴险的是只有输出超过管道缓冲的大文件才触发：
112KB 的 smoke.rrd 全部失败，几 KB 的 edge.rrd 全部通过，看起来像是代码有问题。
修法：先 `strings > file` 落盘，再单独 `grep file`。

**`go run` 的 PID 不是服务进程的 PID。**（见控制面记录）

**`pkill -f <pattern>` 会自杀**，如果 pattern 出现在执行它的命令行里。

**测试里写死参数个数会随业务变化而失败。** e2e 原本断言 `count == 5`，
demo 加了一个 `min_confidence` 就红了。改成从 producer 启动日志读它自己声明的数量，
再断言 backend 读到的与之一致——这既是真正的跨端一致性检查，
也让以后新增 `declare` 不必回来改测试。

---

## 6. 已知限制与未做的事

**限制**：

- `Annotations` 只支持 labels/colors/radii。其他组件（`class_ids`、`fill_mode`、
  `show_labels`）需要走 `stream()` 逃生舱。
- 图像只支持 RGBA8。灰度、YUV、JPEG 需自行转换或走逃生舱
  （Rerun 支持 `Image::from_grayscale8` 等，未封装）。
- `setTransform` 只接受平移 + 四元数。需要缩放或矩阵形式的走逃生舱。
- 未做性能基准。图像改直接 log 省掉了一次全帧拷贝，但**没有实测数据**支撑收益量化。

**未修**（沿用上一轮的结论，需要你定夺）：

- **Rerun sink 初始化失败仍会导致 producer 直接退出**。本轮测试已确认
  「控制面缺失时观测面仍工作」，但反过来不成立：`init()` 里 `initRerun` 失败会让
  整个 `init()` 返回 false，demo 的 `main()` 随即 `return -1`。
  比赛现场 viewer 没起来就整个 producer 挂掉。改法是两个平面各自返回状态、互不阻断，
  属于行为变更。
- backend 惰性 attach 后不检测共享内存文件被替换（详见控制面记录）。

**未验证**：

- ARM64（Jetson / 树莓派）上未实测。
- 未做长时间稳定性与高频写入压力测试；`kFlushIntervalMs=1000` 的 flush 策略
  在新增大量结构化数据后是否仍合适，没有数据。
