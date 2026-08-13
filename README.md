
# PulseScope

机器人视觉程序的实时观测 + 调参工具。日常观测走 Web，Rerun 用于可选录制与深度分析：

```
                    ┌─ POSIX SHM（10MB 观测块）─→ Go Backend ─→ Web（同步时序图 / 视频）
C++ Producer ───────┤
                    ├─ POSIX SHM（4KB 控制块）──↔ Go Backend ─→ Web（调参 / 运维）
                    └─ Rerun SDK（显式启用）────→ Viewer / .rrd 录制回放
```

- **实时观测面（Web）**：producer 把标量与 RGBA 帧写入 10MB seqlock 共享内存；后端
  提供时序 JSON 与 MJPEG。前端使用递归分屏工作区，每个窗口可显示 Video 或 Plot，
  支持左右/上下拆分、关闭、拖动比例和单窗全屏；Plot 支持信号搜索/少量叠加、自动
  Y 轴、暂停、缩放/平移及复位。
- **控制面（Web）**：反向调参走独立的 4KB 共享内存控制块，包含进程 kill 与心跳监控。
- **深度分析（可选 Rerun）**：显式配置连接或保存路径后启用，用于地图、录制和离线回放。

数据面是**统一入口**：任何生产者（本仓库 demo、aim-rs 回放/真机）按
[TOPICS.md](TOPICS.md) 的 topic 契约发数据即可，viewer 用同一份 blueprint 呈现。

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

# 终端 1 - 默认只发布到 Web 观测共享内存，不拉起 Rerun Viewer
./build/vision_producer
```

Rerun sink 由环境变量选择（按优先级）：

| 环境变量 | 行为 |
|---|---|
| `PULSESCOPE_RERUN_CONNECT=rerun+http://<host>:9876/proxy` | 连接已运行的 viewer（远程部署：机器人上跑 producer，PC 上跑 `rerun --serve`） |
| `PULSESCOPE_RERUN_SAVE=run1.rrd` | 录制到文件，事后 `rerun run1.rrd` 回放 |
| （都不设） | 不启动 Rerun；实时观测走 Web |

压力工况环境变量：`PULSESCOPE_UPDATE_HZ`（默认 50）、`PULSESCOPE_MAP_HZ`（10）、
`PULSESCOPE_STRESS_SERIES`（24，最大 512）、`PULSESCOPE_NOISE_LEVEL`（10）。

### 步骤 B: 启动 Go 控制面后端

```bash
# 终端 2
cd backend && go run .   # 默认监听 127.0.0.1:5000，producer 未启动也能起（惰性挂载 SHM）
```

默认只绑回环——该端口无鉴权，却能改 `fire_enabled`、SIGTERM 任意进程，不应默认暴露
在局域网上。需要从其他机器访问（远程面板）时显式放开：

```bash
PULSESCOPE_BIND=0.0.0.0:5000 go run .
```

### 步骤 C: 启动前端控制面板

```bash
# 终端 3
npm install && npm run dev     # http://localhost:3000
```

生产部署也可由一个后端进程服务前端构建产物：

```bash
npm run build
cd backend && PULSESCOPE_WEB_DIST=../dist go run .   # http://127.0.0.1:5000
```

## 3. C++ 接口（业务代码接入）

接口与 SHM 时代保持不变，业务代码无需改动：

```cpp
#include "vision_monitor.hpp"

auto& mon = vision::Monitor::getInstance();
mon.init();                          // 初始化 Rerun sink + 控制 SHM（只需一次）

// 每帧：
mon.pushData("ekf_x", ekf_state.x);  // 任意 key-value 时序数据
mon.pushData({{"target_dist", 2.5}, {"gimbal_yaw", yaw}});
mon.pushImageRGBA(rgba_ptr, w, h);   // 相机画面
mon.commit();                        // 统一打帧号写入 Rerun + 刷新心跳

// 低频：
mon.updateMap(esdf, 100, 100);       // ESDF 地图（立即写入）

// 读取面板下发的参数：
float p, i, d; uint32_t exposure; bool fire;
mon.syncParams(p, i, d, exposure, fire);

// 进程退出前（重要，见下）：
mon.shutdown();
```

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
| `/api/params` | GET | 当前参数（SHM 实时值） |
| `/api/control` | POST | 写参数，body 任意字段可省：`{"pid_p":1.2,"pid_i":0.05,"pid_d":0.1,"exposure":5000,"fire_enabled":true}`；返回 clamp 后的生效值 |
| `/api/status` | GET | producer 心跳年龄/存活、CPU 负载、温度 |
| `/api/series?max_points=600` | GET | 对齐后的时序数据：`{time, <signal>...}` |
| `/api/video` | GET | 最新相机画面的 MJPEG 流 |
| `/api/process/kill` | POST | SIGTERM 目标进程，默认 `{"name":"vision_producer"}` |

参数范围（后端 clamp）：P ∈ [0,10]，I ∈ [0,1]，D ∈ [0,1]，exposure ∈ [100,50000]。

## 5. SHM 布局

### 控制块（v3）

`/dev/shm/aurora_rm_ctrl`，4KB 单页，布局见 `include/shm_layout.hpp`：

- producer 写 `heartbeat_ms`（每次 commit），backend 读 → 存活检测；
- backend 写参数字段，producer 每帧 `syncParams` 读；
- 单字段自然对齐写入，不保证跨字段一致性（调参场景可容忍）；
- producer 首次启动初始化默认参数；magic/version 有效时不重置——**参数跨重启保留**。

### 观测块（v4）

`/dev/shm/aurora_rm_obs`，10MB。布局见 `include/shm_layout.hpp`：

- producer 用 seqlock 写入当前 RGBA 帧和 `{key: number}` 标量快照；
- backend 一致性读取，标量按 frame 去重并补齐缺失值，最多保留 600 个时间点；
- backend 将视频编码为 JPEG，仅缓存最新一帧，不积压旧帧。
