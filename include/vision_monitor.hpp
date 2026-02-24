
#pragma once
#include "shm_layout.hpp"
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <algorithm>
#include <cstring>
#include <iostream>
#include <chrono>
#include <cerrno>
#include <string>
#include <initializer_list>
#include <type_traits>
#include <unordered_map>

namespace vision {

class Monitor {
public:
    static Monitor& getInstance() {
        static Monitor instance;
        return instance;
    }

    bool init(const char* shm_name = "/vision_debug_shm", size_t size = kDefaultShmSize) {
        if (size < sizeof(ShmHeader) + 1024) {
            std::cerr << "shm size too small: " << size << std::endl;
            return false;
        }

        // O_CREAT: 如果不存在则创建
        // shm_open 需要 POSIX 名称格式: "/name" (不能包含路径)
        int fd = shm_open(shm_name, O_CREAT | O_RDWR, 0666);
        if (fd == -1) {
            std::cerr << "shm_open failed: " << strerror(errno) << std::endl;
            return false;
        }
        
        if (ftruncate(fd, static_cast<off_t>(size)) == -1) {
            std::cerr << "ftruncate failed: " << strerror(errno) << std::endl;
            close(fd);
            return false;
        }

        shm_ptr = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        close(fd);
        if (shm_ptr == MAP_FAILED) {
            std::cerr << "mmap failed: " << strerror(errno) << std::endl;
            shm_ptr = nullptr;
            return false;
        }
        shm_size = size;

        header = static_cast<ShmHeader*>(shm_ptr);
        
        // 初始化默认参数，防止后端读到垃圾数据
        if (header->magic_number != kShmMagicNumber || header->version != kShmVersion) {
            std::memset(shm_ptr, 0, shm_size);
            header->magic_number = kShmMagicNumber;
            header->version = kShmVersion;
            header->pid_p = 1.0f;
            header->pid_i = 0.0f;
            header->pid_d = 0.1f;
            header->exposure_time = 5000;
            header->is_fire_enabled = 1;
            header->json_offset = sizeof(ShmHeader);
        }

        return true;
    }

    ~Monitor() {
        if (shm_ptr) {
            munmap(shm_ptr, shm_size);
            shm_ptr = nullptr;
            header = nullptr;
        }
    }

    void updateMap(const float* external_map, size_t cells = kEsdfCells) {
        if (!header || !external_map) return;
        beginWrite();
        const size_t copy_count = std::min(cells, static_cast<size_t>(kEsdfCells));
        std::memcpy(header->esdf_map, external_map, sizeof(float) * copy_count);
        if (copy_count < kEsdfCells) {
            std::memset(header->esdf_map + copy_count, 0, sizeof(float) * (kEsdfCells - copy_count));
        }
        header->timestamp_ms = nowMs();
        endWrite();
    }

    void syncParams(float& p, float& i, float& d, uint32_t& exposure, bool& fire_enabled) {
        if (!header) {
            p = 1.0f;
            i = 0.0f;
            d = 0.1f;
            exposure = 5000;
            fire_enabled = true;
            return;
        }
        p = header->pid_p;
        i = header->pid_i;
        d = header->pid_d;
        exposure = header->exposure_time;
        fire_enabled = header->is_fire_enabled != 0;
    }

    void syncParams(float& p, float& i, float& d) {
        uint32_t exposure = 0;
        bool fire_enabled = false;
        syncParams(p, i, d, exposure, fire_enabled);
    }

    // 推送任意 key-value 数据到前端可视化
    // 使用方法: Monitor::getInstance().pushData("ekf_x", 12.5);
    template<typename T, typename std::enable_if<std::is_arithmetic<T>::value && !std::is_same<T, bool>::value, int>::type = 0>
    void pushData(const std::string& key, T value) {
        json_buffer[key] = static_cast<double>(value);
    }

    void pushData(const std::string& key, bool value) {
        json_buffer[key] = value ? 1.0 : 0.0;
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
        const size_t json_offset = sizeof(ShmHeader);
        if (shm_size <= json_offset) return;
        
        // 构建 JSON 字符串
        std::string json_str;
        json_str.reserve(json_buffer.size() * 28 + 4);
        json_str.push_back('{');
        bool first = true;
        for (const auto& [key, value] : json_buffer) {
            if (!first) json_str.push_back(',');
            json_str += "\"";
            json_str += escapeJsonKey(key);
            json_str += "\":";
            json_str += std::to_string(value);
            first = false;
        }
        json_str.push_back('}');

        if (json_str.size() > kMaxJsonBytes) {
            json_str.resize(kMaxJsonBytes);
        }
        
        // 写入 SHM 的 JSON 区域 (紧跟在 header 后面)
        const size_t max_writable = shm_size - json_offset;
        size_t json_size = std::min(json_str.size(), max_writable);
        
        char* json_region = static_cast<char*>(shm_ptr) + json_offset;
        beginWrite();
        if (json_size > 0) {
            std::memcpy(json_region, json_str.c_str(), json_size);
        }
        header->json_offset = json_offset;
        header->json_size = json_size;
        header->timestamp_ms = nowMs();
        endWrite();
        
        json_buffer.clear();
    }

private:
    Monitor() : shm_ptr(nullptr), header(nullptr), shm_size(0) {}
    Monitor(const Monitor&) = delete;
    Monitor& operator=(const Monitor&) = delete;

    static uint64_t nowMs() {
        return static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()
            ).count()
        );
    }

    static std::string escapeJsonKey(const std::string& key) {
        std::string out;
        out.reserve(key.size());
        for (char c : key) {
            if (c == '\\' || c == '"') {
                out.push_back('\\');
            }
            out.push_back(c);
        }
        return out;
    }

    void beginWrite() {
        if (!header) return;
        header->sequence += 1;
        __sync_synchronize();
    }

    void endWrite() {
        if (!header) return;
        __sync_synchronize();
        header->sequence += 1;
    }

    void* shm_ptr;
    ShmHeader* header;
    size_t shm_size;
    std::unordered_map<std::string, double> json_buffer;
};

} // namespace vision
