# 观测面 API — 二次开发指南

给自己的视觉/导航程序加可视化，只需要包含一个头文件、调几个函数。
数据流向 Rerun Viewer：可缩放、可回放、可按时间轴对齐、可离线复盘。

---

## 0. 接入你自己的工程

PulseScope 导出一个 header-only 的 CMake 接口库 `pulsescope`，
Rerun SDK 与 `rt`/`pthread` 会自动带上：

```cmake
cmake_minimum_required(VERSION 3.16)
project(my_vision_node LANGUAGES CXX)

add_subdirectory(path/to/PulseScope pulsescope_build EXCLUDE_FROM_ALL)

add_executable(my_vision_node main.cpp)
target_link_libraries(my_vision_node PRIVATE pulsescope)
```

`EXCLUDE_FROM_ALL` 让 PulseScope 自带的 demo/工具/测试不参与你的构建。
之后即可：

```cpp
#include "vision_monitor.hpp"
```

首次构建会通过 `FetchContent` 下载 Rerun C++ SDK 预编译包（约 40MB），需要网络。
**Viewer 版本必须与 SDK 一致**（当前 0.34.1），否则可能无法加载录制。

---

## 1. 五分钟接入

```cpp
auto& mon = vision::Monitor::getInstance();
mon.init();                              // 只需一次

while (running) {
    mon.beginFrame();                    // 帧边界（可选，见 §3）

    mon.pushData("ekf_x", state.x);      // 时序标量
    mon.pushImageRGBA(rgba, w, h, "camera/image");

    mon.commit();                        // 刷新心跳 + 周期性 flush
}

mon.shutdown();                          // 进程退出前必须调用（见 §7）
```

跑起来默认自动拉起本机 Viewer。远程部署或离线录制见 §6。

---

## 2. 核心概念：实体路径就是变换树

这是用好 Rerun 的关键，也是最容易忽略的一点。

**实体路径不是随便起的名字，它是一棵树。** 挂在父节点上的坐标变换会被所有子节点继承：

```
world/
  gimbal/                    ← setTransform() 设云台位姿
    camera/                  ← setPinhole() 设相机内参
      image                  ← 相机画面
      armors                 ← 识别框，自动叠加在 image 上
      corners                ← 角点，同样叠加
  target                     ← 世界系中的目标
    trail                    ← 目标轨迹
```

这样组织之后：

- 云台一转，`world/gimbal` 下的所有东西（相机、画面、标注）在 3D 视图里跟着转
- 设了 `Pinhole`，Rerun 就能把 2D 框投影进 3D 场景，并画出相机视锥
- 在 Viewer 里可以单独隐藏 `armors` 图层，只看原图

**自瞄的 相机系 → 云台系 → 世界系 链路，就是用这个路径层级表达的**，不需要自己做矩阵连乘。

```cpp
// 云台位姿（平移 + 四元数）
mon.setTransform("world/gimbal", {0, 0, 0.3f}, {0, 0, sin(yaw/2), cos(yaw/2)});

// 相机内参：焦距(px) + 分辨率
mon.setPinhole("world/gimbal/camera", 320.0f, 640, 480);
```

---

## 3. 时间轴：三条并行

每帧的数据会被打上三个时间戳，Viewer 里可自由切换横轴：

| 时间轴 | 类型 | 用途 |
|---|---|---|
| `frame` | 序号 | 逐帧步进，与算法迭代对齐 |
| `runtime` | 相对秒 | 「跑了多久」，看长期趋势 |
| `capture_time` | 绝对时刻 | **与外部数据源对齐**（IMU / 串口 / 下位机） |

`capture_time` 是排查延迟问题的唯一依据。真实系统应该传入**相机曝光时刻**，而不是让它默认取当前时间：

```cpp
// 图像采集发生在处理之前，把曝光时刻传进来
mon.beginFrame(exposure_timestamp_secs);
```

这样图像、IMU、串口回传的数据才会落在同一条时间轴的正确位置上——
「到底是识别慢了，还是预测超前量给小了」只有对齐后才能看出来。

不调 `beginFrame()` 也能工作：任何 `push*` 会在本帧首次写入时自动用当前时刻确定时间轴。

---

## 4. API 速查

所有 `push*` 的第一个参数都是实体路径。`Annotations` 可省略。

### 时序与图像

```cpp
mon.pushData("ekf_x", 1.5);                          // 单个标量
mon.pushData({{"ekf_x", 1.5}, {"ekf_y", 2.5}});      // 批量
mon.pushImageRGBA(rgba, w, h, "camera/image");       // RGBA 图像，多路用不同路径
mon.pushGrid(esdf, w, h, "esdf/map");                // 单通道 float 栅格（Turbo 伪彩）
```

### 2D 标注（图像空间）

路径挂在图像实体的**兄弟或子级**，Rerun 会叠加到画面上。

```cpp
mon.pushBoxes2D("camera/armors", {{cx, cy, w, h}});      // 中心 + 全尺寸
mon.pushPoints2D("camera/corners", {{x1,y1}, {x2,y2}});
mon.pushLines2D("camera/track", {{{{0,0},{10,10}}}});    // 折线（注意三层花括号）
```

### 3D（世界空间）

```cpp
mon.pushPoints3D("world/target", {{x, y, z}});           // 点云 / 目标
mon.pushLines3D("world/path", {{{{0,0,0},{1,1,0}}}});    // 路径 / 轨迹
mon.pushBoxes3D("world/obstacles", {{{cx,cy,cz},{sx,sy,sz}}});
mon.pushArrows3D("world/gradient", {{{ox,oy,oz},{vx,vy,vz}}});  // 起点 + 向量
```

### 空间关系与事件

```cpp
mon.setTransform("world/gimbal", translation, quaternion);
mon.setPinhole("world/gimbal/camera", focal_px, width, height);
mon.logText(vision::LogLevel::Warn, "target lost");      // 与曲线共享时间轴
```

### 装饰：标签、颜色、半径

```cpp
vision::Annotations ann;
ann.labels = {"armor_3"};
ann.colors = {{34, 211, 238, 255}};      // RGBA
ann.radii  = {0.05f};
mon.pushBoxes2D("camera/armors", boxes, ann);
```

数量必须与元素个数一致，否则该项装饰被忽略并打印告警（不会崩，也不会静默截断）。

---

## 5. 常见配方

### 自瞄：识别结果不要烧进像素

```cpp
// ✗ 不要这样：把框画进 RGBA 再推图像
draw_rectangle(rgba, x, y, w, h);
mon.pushImageRGBA(rgba, w, h);

// ✓ 这样：图像与标注分开
mon.pushImageRGBA(raw_rgba, w, h, "world/gimbal/camera/image");
vision::Annotations ann;
ann.labels = {fmt("conf=%.2f", conf)};
ann.colors = {conf > threshold ? vision::Rgba{34,211,238,255}
                               : vision::Rgba{251,191,36,255}};
mon.pushBoxes2D("world/gimbal/camera/armors", {{cx, cy, bw, bh}}, ann);
```

烧进像素的框无法悬停查坐标、无法按时间筛选、无法单独关掉图层——
等于把结构化数据降级成了一张图。分开之后颜色即状态，一眼看出锁定与否。

### 自瞄：预测 vs 观测同图对比

```cpp
mon.pushPoints3D("world/target/observed", {observed}, cyan);
mon.pushPoints3D("world/target/predicted", {predicted}, amber);
mon.pushLines3D("world/target/error", {{{observed, predicted}}});  // 连线即误差
```

一条灰线连接匹配点，误差的大小和方向直接可见，比看标量曲线直观得多。

### 导航：路径与代价地图叠在同一空间

```cpp
mon.pushGrid(esdf, w, h, "world/map/esdf");
mon.pushLines3D("world/path/planned", {{planned_waypoints}});
mon.pushLines3D("world/path/actual", {{odom_history}});
mon.pushArrows3D("world/map/gradient", gradient_field);
```

### 滚动轨迹

```cpp
trail.push_back(current_pos);
if (trail.size() > 150) trail.erase(trail.begin());
if (trail.size() > 1) mon.pushLines3D("world/target/trail", {{trail}});
```

---

## 6. Sink：数据往哪走

由环境变量决定，优先级从上到下：

| 环境变量 | 行为 |
|---|---|
| `PULSESCOPE_RERUN_CONNECT=rerun+http://<host>:9876/proxy` | 连接已运行的 Viewer（远程部署常用） |
| `PULSESCOPE_RERUN_SAVE=run.rrd` | 录制到文件，事后 `rerun run.rrd` 回放 |
| 都不设 | 自动拉起本机 Viewer |

录制文件可以直接分享给队友复盘，也可以用 `rerun --serve-web run.rrd` 起一个网页版供浏览器查看。

### 固定一套顺手的布局

Viewer 默认布局是自动生成的：实体一多就会把 `camera/image` 和 `camera/armors`
拆成两个面板，看不到标注叠加在画面上的效果。手动拖好布局后可以存下来复用：

1. 在 Viewer 里调整面板（把 `world/gimbal/camera` 整个拖进一个 2D 视图，
   标注就会叠加在图像上）
2. 菜单里保存 blueprint，得到 `.rbl` 文件
3. 之后带着布局启动：

```bash
rerun layout.rbl run.rrd          # 已验证：CLI 接受 .rbl 作为输入
```

> 保存这一步在 Viewer 图形界面里操作，本文未实测；`rerun` 接受 `.rbl` 输入
> 这一点已从 CLI 帮助确认。C++ SDK 只有底层 `StoreKind::Blueprint`，
> 没有 Python 那样的 `send_blueprint()` 高层 API，用代码固化布局代价较高。

---

## 7. 必须知道的两个坑

**① 进程退出前必须调 `shutdown()`。**

Rerun 批处理器在大图像流量下会被 1MiB 大小阈值持续触发，小 chunk（标量）依赖的定时
flush 被饿死，进程被杀时整批丢失——实测过只有图像落盘、曲线全空的情况。
`commit()` 内置每秒一次显式 flush 兜底（异常退出最多丢 ~1s），但尾部数据仍需干净退出。
demo 里有 SIGINT/SIGTERM 处理示例。

**② 不要依赖静态析构去 flush。**

Arrow 的全局内存池可能先于单例析构，触发 `cannot create default memory pool` 崩溃。
所以 `Monitor` 是**故意泄漏的单例**，`shutdown()` 必须在 `main` 返回前显式调用。

---

## 8. 逃生舱：直接用 Rerun

本类只封装了最常用的一批 archetype。Rerun 还有 50 种（`Mesh3D`、`Tensor`、
`AnnotationContext`、`Asset3D`、`SeriesLines` 等），需要时直接拿底层流：

```cpp
if (auto* rec = mon.stream()) {
    rec->log("world/mesh", rerun::Mesh3D(vertices).with_vertex_colors(colors));
}
```

`stream()` 返回前会确保本帧时间轴已设置，直接 `log` 即可。
返回 `nullptr` 表示 sink 未就绪（例如 Viewer 连不上），照常判空即可。

完整 archetype 列表见 [Rerun 文档](https://rerun.io/docs/reference/types/archetypes)。
SDK 版本 0.34.1，**Viewer 版本必须与之一致**，否则可能无法加载。

---

## 9. 控制面：让参数可在线调

观测之外，PulseScope 还提供在线调参：producer 声明参数，Web 面板自动出现控件。

```cpp
auto gain = mon.declareFloat("pid_p", 1.0, 0.0, 10.0, 0.01);
auto exp  = mon.declareInt("exposure_time", 5000, 100, 50000, 100, "us");
auto fire = mon.declareBool("fire_enabled", true);

// 主循环里直读，无字符串查找
const float p = gain.getFloat();
```

范围、步进、单位只在这里声明一次，backend 与前端自动适配，
两端都不含硬编码。详见 [控制面参数设计](2026-07-22-self-describing-control-params.md)。
