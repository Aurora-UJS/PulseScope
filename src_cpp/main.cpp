
#include "../include/vision_monitor.hpp"
#include <chrono>
#include <thread>
#include <cmath>

int main() {
    auto& monitor = vision::Monitor::getInstance();
    
    if (!monitor.init()) {
        std::cerr << "Failed to init SHM!" << std::endl;
        return -1;
    }

    std::cout << "C++ Producer started. Writing to /dev/shm/vision_debug_shm..." << std::endl;

    float t = 0;
    while (true) {
        // 1. 模拟 ESDF 地图数据更新
        float mock_map[10000];
        for (int i = 0; i < 10000; ++i) {
            int x = i % 100;
            int y = i / 100;
            mock_map[i] = std::sqrt(std::pow(x - 50, 2) + std::pow(y - 50, 2)) / 10.0f 
                          + std::sin(t + x/10.0f);
        }

        // 2. 模拟参数同步 (从前端读)
        float p, i, d;
        monitor.syncParams(p, i, d);
        // std::cout << "Current PID from Web: " << p << ", " << i << ", " << d << std::endl;

        // 3. 写入监控数据
        monitor.updateMap(mock_map);
        
        t += 0.1f;
        std::this_thread::sleep_for(std::chrono::milliseconds(20)); // 50FPS
    }

    return 0;
}
