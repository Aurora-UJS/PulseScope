
# PulseScope 部署指南

> [!CAUTION]
> **本项目仍在深度开发中，目前尚未进行完整测试，请谨慎使用！**

## 1. 准备工作
- **操作系统**: 推荐 Ubuntu 20.04/22.04/24.04 (必须支持 `/dev/shm`)。
- **依赖**:
  - C++: `g++`, `cmake`
  - Go: `golang-1.20+`
  - Node.js: `v18+`

## 2. 运行步骤

### 步骤 A: 启动 C++ 模拟生产者
在 `src_cpp` 目录下编译运行示例程序：
```bash
# 终端 1 - C++ 生产者
g++ -std=c++17 src_cpp/main.cpp -o vision_producer -lrt -lpthread
./vision_producer
```
这将创建 `/dev/shm/vision_debug_shm` 并开始写入数据。

可选压力工况环境变量（用于大数据量测试）：
```bash
# 示例：120Hz、32个压力通道、20Hz地图更新
PULSESCOPE_UPDATE_HZ=120 \
PULSESCOPE_STRESS_SERIES=32 \
PULSESCOPE_MAP_HZ=20 \
PULSESCOPE_NOISE_LEVEL=20 \
./vision_producer
```

### 步骤 B: 启动 Go 后端
```bash
# 终端 2 - Go 后端
cd backend
go run main.go
```
后端将监听 `5000` 端口。

### 步骤 C: 启动前端
```bash
# 终端 3 - 前端
npm run dev
```
在浏览器打开 `http://localhost:3000`。

## 3. 架构核心

```
C++ Producer ──→ POSIX SHM (10MB, 零拷贝) ──→ Go Backend ──→ WebSocket ──→ React 前端
                                                  ↑                           │
                                                  └── 参数写回 (WS JSON) ──────┘
```

- **低耦合**: C++ 进程崩溃不会影响后端，后端重启会自动重新挂载 SHM。
- **高性能**: 图像数据通过内存偏移量直接读取，无需序列化；视频帧通过 WS 二进制通道推送（JPEG 编码），避免 HTTP 轮询开销。
- **协议扩展**: 后端 WebSocket 推送 `metadata/data/map/status` 四类 JSON 消息 + `video` 二进制帧，前端实时订阅。
- **反向调参**: 前端参数通过同一条 WS 链路写回 SHM，C++ 可在下一帧 `syncParams` 读取。
- **渲染优化**: 前端使用 `requestAnimationFrame` 批量刷新时序数据，高 series 数（512+）下保持流畅。

## 4. C++ 接口

``` cpp
#include "vision_monitor.hpp"

// 初始化 (只需一次)
vision::Monitor::getInstance().init();

// 每帧推送数据
vision::Monitor::getInstance().pushData("ekf_x", ekf_state.x);
vision::Monitor::getInstance().pushData("ekf_y", ekf_state.y);
vision::Monitor::getInstance().pushData("fps", current_fps);

// 或批量推送
vision::Monitor::getInstance().pushData({
    {"target_dist", 2.5},
    {"gimbal_yaw", yaw_angle}
});

// 帧结束时提交
vision::Monitor::getInstance().commit();
```

读取调参参数：
```cpp
float p, i, d;
uint32_t exposure;
bool fire_enabled;
vision::Monitor::getInstance().syncParams(p, i, d, exposure, fire_enabled);
```

## 5. WebSocket 消息约定

前端自动连接 `ws://<当前页面地址>/ws`（开发时由 Vite 代理到 `:5000`）。

### JSON 消息（TextMessage）

| 类型 | 方向 | 频率 | 说明 |
|------|------|------|------|
| `metadata` | 后端→前端 | 连接时 + 动态更新 | 可用数据序列列表 |
| `data` | 后端→前端 | 25Hz | 时序数据（`series` key-value） |
| `map` | 后端→前端 | 5Hz | ESDF 栅格数据（100x100） |
| `status` | 后端→前端 | 1Hz | 后端/SHM 状态、CPU 负载、温度 |

### 二进制帧（BinaryMessage）— 视频

后端以 10Hz 推送 JPEG 编码的视频帧，二进制格式如下：

```
Offset  Size  Field
0       4     Magic: 0x56494400 ("VID\0", little-endian)
4       8     Timestamp (uint64, little-endian, 毫秒)
12      2     Width (uint16, little-endian)
14      2     Height (uint16, little-endian)
16      N     JPEG 图像数据
```

前端通过 `ws.binaryType = 'arraybuffer'` 接收，解析 header 后创建 Blob URL 显示。

### 前端写回参数

发送 JSON 到同一个 WS 连接：
```json
{
  "pid_p": 1.2,
  "pid_i": 0.05,
  "pid_d": 0.1,
  "exposure": 5000,
  "fire_enabled": true
}
```

## 6. HTTP 接口

- `GET /health`: 后端健康状态
- `POST /api/control`: 控制参数写回（与 WS 写回字段一致）
- `GET /api/video/latest`: 获取最新视频帧（JPEG，调试用途）
- `POST /api/process/kill`: 终止目标进程（默认 `vision_producer`）

## 7. 性能特性

- **rAF 批量刷新**: 前端使用 `requestAnimationFrame` 合并多条 WS 数据消息，每渲染帧只触发一次 state 更新，大幅降低 GC 压力
- **JPEG 视频推送**: 相比 PNG，JPEG 编码速度提升 5-10x，带宽降低 10-15x
- **组件记忆化**: 图表组件（`DynamicChart`）和数据列表项（`SeriesItem`）使用 `React.memo` 避免不必要的重渲染
- **压力测试**: 通过 `PULSESCOPE_STRESS_SERIES=512` 可模拟高通道数工况
