
#pragma once
#include "shm_layout.hpp"
#include <sys/ipc.h>
#include <sys/shm.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstring>
#include <iostream>
#include <chrono>
#include <cerrno>
#include <string>
#include <unordered_map>

namespace vision {

class Monitor {
public:
    static Monitor& getInstance() {
        static Monitor instance;
        return instance;
    }

    bool init(const char* shm_name = "/vision_debug_shm", size_t size = 1024 * 1024 * 10) {
        // O_CREAT: 如果不存在则创建
        // shm_open 需要 POSIX 名称格式: "/name" (不能包含路径)
        int fd = shm_open(shm_name, O_CREAT | O_RDWR, 0666);
        if (fd == -1) {
            std::cerr << "shm_open failed: " << strerror(errno) << std::endl;
            return false;
        }
        
        if (ftruncate(fd, size) == -1) return false;

        shm_ptr = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (shm_ptr == MAP_FAILED) return false;

        header = static_cast<ShmHeader*>(shm_ptr);
        
        // 初始化默认参数，防止后端读到垃圾数据
        if (header->magic_number != 0x564953494F4E3031) {
            std::memset(header, 0, sizeof(ShmHeader));
            header->magic_number = 0x564953494F4E3031;
            header->version = 1;
            header->pid_p = 1.0f;
            header->pid_i = 0.0f;
            header->pid_d = 0.1f;
        }
        return true;
    }

    void updateMap(float* external_map) {
        if (!header) return;
        std::memcpy(header->esdf_map, external_map, sizeof(float) * 10000);
        header->timestamp_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()
        ).count();
    }

    void syncParams(float& p, float& i, float& d) {
        if (!header) return;
        p = header->pid_p;
        i = header->pid_i;
        d = header->pid_d;
    }

    // 推送任意 key-value 数据到前端可视化
    // 使用方法: Monitor::getInstance().pushData("ekf_x", 12.5);
    void pushData(const std::string& key, double value) {
        json_buffer[key] = value;
    }

    // 批量推送数据 (使用 initializer_list)
    // 使用方法: Monitor::getInstance().pushData({{"ekf_x", 1.0}, {"ekf_y", 2.0}});
    void pushData(std::initializer_list<std::pair<std::string, double>> items) {
        for (const auto& item : items) {
            json_buffer[item.first] = item.second;
        }
    }

    // 提交数据到 SHM (应在每帧结束时调用一次)
    void commit() {
        if (!header) return;
        
        // 构建 JSON 字符串
        std::string json_str = "{";
        bool first = true;
        for (const auto& [key, value] : json_buffer) {
            if (!first) json_str += ",";
            json_str += "\"" + key + "\":" + std::to_string(value);
            first = false;
        }
        json_str += "}";
        
        // 写入 SHM 的 JSON 区域 (紧跟在 header 后面)
        size_t json_offset = sizeof(ShmHeader);
        size_t json_size = json_str.size();
        
        char* json_region = static_cast<char*>(shm_ptr) + json_offset;
        std::memcpy(json_region, json_str.c_str(), json_size);
        
        header->json_offset = json_offset;
        header->json_size = json_size;
        header->timestamp_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()
        ).count();
        
        json_buffer.clear();
    }

private:
    Monitor() : shm_ptr(nullptr), header(nullptr) {}
    void* shm_ptr;
    ShmHeader* header;
    std::unordered_map<std::string, double> json_buffer;
};

} // namespace vision
