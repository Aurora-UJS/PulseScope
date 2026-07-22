
# PulseScope

机器人视觉程序的观测 + 调参工具。**观测面走 [Rerun](https://rerun.io)，控制面自建**：

```
                    ┌─ Rerun SDK ──→ Rerun Viewer（时序曲线 / 相机画面 / ESDF 地图 / .rrd 录制回放）
C++ Producer ───────┤
                    └─ POSIX SHM（4KB 控制块）──→ Go Backend（:5000）──→ React 控制面板（:3000）
                          ↑                            │
                          └──── 参数写回（HTTP POST）────┘
```

- **观测面（Rerun）**：producer 通过 Rerun C++ SDK 直接把时序数据、视频帧、ESDF 地图
  记录到 Rerun Viewer，支持时间轴回溯和 `.rrd` 文件录制/离线回放。
- **控制面（自建）**：Rerun 是单向的（SDK → viewer），反向调参走 4KB 共享内存控制块，
  Go 后端提供 HTTP API，前端是一个纯调参 + 运维面板（含进程 kill、心跳监控）。

## 1. 依赖

- **操作系统**: Linux（需要 `/dev/shm` 与 `/proc`）
- **C++**: g++ (C++17), cmake ≥ 3.16，联网（首次构建 FetchContent 拉取 Rerun C++ SDK 与 Arrow）
- **Go**: 1.20+
- **Node.js**: v18+
- **Rerun Viewer**（可选，用于查看/回放）: `pipx install rerun-sdk` 或 `cargo install rerun-cli`

## 2. 构建与运行

### 步骤 A: 构建并启动 C++ 生产者

```bash
cmake -B build
# CMake ≥ 4.0 需要兼容开关：Arrow 内嵌的 mimalloc 子构建声明了过旧的 cmake_minimum_required
CMAKE_POLICY_VERSION_MINIMUM=3.5 cmake --build build -j$(nproc)

# 终端 1 - 默认自动拉起本机 Rerun Viewer
./build/vision_producer
```

Rerun sink 由环境变量选择（按优先级）：

| 环境变量 | 行为 |
|---|---|
| `PULSESCOPE_RERUN_CONNECT=rerun+http://<host>:9876/proxy` | 连接已运行的 viewer（远程部署：机器人上跑 producer，PC 上跑 `rerun --serve`） |
| `PULSESCOPE_RERUN_SAVE=run1.rrd` | 录制到文件，事后 `rerun run1.rrd` 回放 |
| （都不设） | spawn 本机 viewer |

压力工况环境变量：`PULSESCOPE_UPDATE_HZ`（默认 50）、`PULSESCOPE_MAP_HZ`（10）、
`PULSESCOPE_STRESS_SERIES`（24，最大 512）、`PULSESCOPE_NOISE_LEVEL`（10）。

### 步骤 B: 启动 Go 控制面后端

```bash
# 终端 2
cd backend && go run main.go   # 监听 :5000，producer 未启动也能起（惰性挂载 SHM）
```

### 步骤 C: 启动前端控制面板

```bash
# 终端 3
npm install && npm run dev     # http://localhost:3000
```

## 3. C++ 接口（业务代码接入）

完整用法见 **[观测面 API 指南](docs/observability-api.md)**，这里只列骨架：

```cpp
#include "vision_monitor.hpp"

auto& mon = vision::Monitor::getInstance();
mon.init();                                   // Rerun sink + 控制 SHM，只需一次

// 声明可在线调节的参数（范围/步进/单位只在这里写一次，
// backend 与前端自动生成控件，两端都不含硬编码）
auto gain = mon.declareFloat("pid_p", 1.0, 0.0, 10.0, 0.01);
auto exp  = mon.declareInt("exposure_time", 5000, 100, 50000, 100, "us");

while (running) {
    mon.beginFrame(exposure_timestamp);       // 传入采集时刻以便与 IMU/串口对齐

    const float p = gain.getFloat();          // 读面板下发的参数，句柄直读

    mon.pushData("ekf_x", state.x);           // 时序标量
    mon.pushImageRGBA(rgba, w, h, "world/gimbal/camera/image");

    // 识别结果作为结构化标注，不要烧进像素
    mon.pushBoxes2D("world/gimbal/camera/armors", {{cx, cy, bw, bh}}, ann);
    mon.pushPoints3D("world/target", {{x, y, z}});
    mon.setTransform("world/gimbal", translation, quaternion);

    mon.commit();
}

mon.shutdown();                               // 进程退出前必须调用（见下）
```

**实体路径是一棵变换树**：挂在 `world/gimbal` 上的位姿会被其下的 camera 及 2D 标注继承，
自瞄的 相机系→云台系→世界系 就是这样表达的。每帧数据带三条时间轴
（`frame` / `runtime` / `capture_time`），最后一条用于跨数据源对齐。

本类未封装的 archetype（`Mesh3D`、`Tensor` 等）通过 `mon.stream()` 直接访问底层 Rerun。

### 数据完整性注意事项（实测踩坑）

1. **退出前必须调 `shutdown()`（或干净退出让它被调到）**。Rerun 的批处理器在大图像
   流量下只有图像会因 1MiB 大小阈值持续落盘；标量等小 chunk 依赖的定时 flush 会被
   饿死。`Monitor::commit()` 内置每 1s 一次显式 flush 兜底（异常被杀最多丢 ~1s），
   但录制尾部数据仍需干净退出来 flush。demo（`src_cpp/main.cpp`）已带 SIGINT/SIGTERM
   处理示例。
2. **不要依赖静态析构去 flush**。Arrow 的全局内存池可能先于单例析构，会触发
   `cannot create default memory pool` 崩溃——所以 `Monitor` 是故意泄漏的单例，
   `shutdown()` 必须在 `main` 返回前显式调用。

## 4. 控制面 HTTP API（:5000）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | `{status, shm_attached, version}` |
| `/api/params` | GET | 参数表**含元数据**：`{version, count, params:[{key,type,value,min,max,step,unit,default}]}` |
| `/api/control` | POST | 扁平映射 `{"pid_p":1.2,"fire_enabled":false}`；返回回读的生效值与被拒条目 `rejected[]` |
| `/api/status` | GET | 心跳年龄/存活、`param_count`、CPU 负载、温度 |
| `/api/process/kill` | POST | SIGTERM 目标进程，默认 `{"name":"vision_producer"}` |

**合法范围不在 backend 也不在前端**——由 producer 在共享内存中声明，两端读表执行。
新增参数只需在 producer 加一行 `declare`，无需改动 backend 或前端。

## 5. SHM 控制块（v4）

`/dev/shm/aurora_rm_ctrl`，8KB，自描述槽位表，布局见 `include/shm_layout.hpp`：

- 64 个 `ParamSlot`，每个自带 key/type/min/max/step/unit/default；
- producer 写 `heartbeat_ms`（每次 commit），backend 读 → 存活检测；
- 运行期只有 `ParamSlot::value` 可变（backend 写、producer 读），8 字节对齐无锁；
- `param_count` 是发布屏障：读到的计数以内，槽位元数据必然已完整写入；
- 单字段原子，不保证跨参数同批生效（调参场景可容忍）；
- producer 重启时同名同类型参数**沿用上次调过的值**，越界则钳制到新范围。

设计与取舍详见 [控制面参数设计](docs/2026-07-22-self-describing-control-params.md)。

不带 backend 也能查看/修改参数：

```bash
./build/shm_ctl dump              # 打印完整参数表
./build/shm_ctl set pid_p 3.5     # 按 producer 声明的范围钳制后写入
```

v2 时代的 10MB 数据 SHM（图像/JSON/地图 + seqlock）已整体退役，由 Rerun 取代。
