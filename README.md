
# PulseScope 部署指南

> [!CAUTION]
> ⚠️ **本项目仍在深度开发中，目前尚未进行完整测试，请谨慎使用！**

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
cd /home/neomelt/PulseScope
./vision_producer
```
这将创建 `/dev/shm/vision_debug_shm` 并开始写入数据。

### 步骤 B: 启动 Go 后端
```bash
# 终端 2 - Go 后端
cd /home/neomelt/PulseScope/backend
go run main.go
```
后端将监听 `5000` 端口。

### 步骤 C: 启动前端
```bash
# 终端 3 - 前端
cd /home/neomelt/PulseScope
npm run dev
```
在浏览器打开 `http://localhost:3000`。

## 3. 架构核心
- **低耦合**: C++ 进程崩溃不会影响后端，后端重启会自动重新挂载 SHM。
- **高性能**: 图像数据通过内存偏移量直接读取，无需经过序列化。


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