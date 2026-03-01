
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
#include <vector>

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
	            header->img_offset = 0;
	            header->img_size = 0;
	            header->width = 0;
	            header->height = 0;
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

	    // 推送 RGBA 图像帧。像素布局为 width*height*4。
	    void pushImageRGBA(const uint8_t* rgba, uint32_t width, uint32_t height) {
	        if (!rgba || width == 0 || height == 0) {
	            image_buffer.clear();
	            image_width = 0;
	            image_height = 0;
	            return;
	        }

	        const size_t frame_size = static_cast<size_t>(width) * static_cast<size_t>(height) * 4;
	        if (frame_size == 0) {
	            image_buffer.clear();
	            image_width = 0;
	            image_height = 0;
	            return;
	        }

	        image_buffer.assign(rgba, rgba + frame_size);
	        image_width = width;
	        image_height = height;
	    }

	    // 提交数据到 SHM (应在每帧结束时调用一次)
	    void commit() {
	        if (!header) return;
	        const size_t header_size = sizeof(ShmHeader);
	        if (shm_size <= header_size) return;
	        
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

	        beginWrite();

	        size_t cursor = header_size;
	        const size_t expected_frame_size = static_cast<size_t>(image_width) * static_cast<size_t>(image_height) * 4;
	        if (!image_buffer.empty() &&
	            expected_frame_size == image_buffer.size() &&
	            expected_frame_size > 0 &&
	            cursor + expected_frame_size <= shm_size) {
	            char* frame_region = static_cast<char*>(shm_ptr) + cursor;
	            std::memcpy(frame_region, image_buffer.data(), expected_frame_size);
	            header->img_offset = cursor;
	            header->img_size = expected_frame_size;
	            header->width = image_width;
	            header->height = image_height;
	            cursor += expected_frame_size;
	        } else {
	            header->img_offset = 0;
	            header->img_size = 0;
	            header->width = 0;
	            header->height = 0;
	        }

	        size_t json_size = 0;
	        if (cursor < shm_size) {
	            const size_t max_writable = shm_size - cursor;
	            json_size = std::min(json_str.size(), max_writable);
	            if (json_size > 0) {
	                char* json_region = static_cast<char*>(shm_ptr) + cursor;
	                std::memcpy(json_region, json_str.c_str(), json_size);
	            }
	        }
	        header->json_offset = cursor;
	        header->json_size = json_size;
	        header->timestamp_ms = nowMs();
	        endWrite();
        
	        json_buffer.clear();
	    }

private:
	    Monitor() : shm_ptr(nullptr), header(nullptr), shm_size(0), image_width(0), image_height(0) {}
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
	    std::vector<uint8_t> image_buffer;
	    uint32_t image_width;
	    uint32_t image_height;
};

} // namespace vision
