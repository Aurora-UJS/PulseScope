#pragma once

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstring>
#include <iostream>
#include <memory>
#include <string>

#include "shm_layout.hpp"

namespace pulsescope {

/**
 * @brief PulseScope Producer
 * 
 * 用于上位机算法中暴露数据。
 */
class Producer {
public:
    static Producer& getInstance() {
        static Producer instance;
        return instance;
    }

    bool init() {
        // 创建共享内存文件 (在 /dev/shm 下)
        int shm_fd = shm_open(SHM_NAME, O_CREAT | O_RDWR, 0666);
        if (shm_fd == -1) {
            perror("shm_open");
            return false;
        }

        // 设置大小
        if (ftruncate(shm_fd, SHM_SIZE) == -1) {
            perror("ftruncate");
            close(shm_fd);
            return false;
        }

        // 映射到进程地址空间
        void* ptr = mmap(0, SHM_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, shm_fd, 0);
        if (ptr == MAP_FAILED) {
            perror("mmap");
            close(shm_fd);
            return false;
        }

        shm_ = static_cast<ShmLayout*>(ptr);
        close(shm_fd); // 映射后关闭 fd

        // 初始化 Header
        shm_->magic = 0x50534350;
        shm_->version = 1;

        return true;
    }

    /**
     * @brief 导出图像 (JPG 格式)
     */
    void exposeImage(const uint8_t* data, size_t size, uint32_t width, uint32_t height) {
        if (!shm_ || size > sizeof(shm_->image.data)) return;
        
        std::memcpy(shm_->image.data, data, size);
        shm_->image.size = static_cast<uint32_t>(size);
        shm_->image.width = width;
        shm_->image.height = height;
        shm_->image.seq.fetch_add(1, std::memory_order_release);
    }

    /**
     * @brief 导出遥测数据 (JSON 字符串)
     */
    void exposeTelemetry(const std::string& json) {
        if (!shm_ || json.size() >= sizeof(shm_->telemetry.json_data)) return;

        std::memcpy(shm_->telemetry.json_data, json.c_str(), json.size());
        shm_->telemetry.json_data[json.size()] = '\0';
        shm_->telemetry.size = static_cast<uint32_t>(json.size());
        shm_->telemetry.seq.fetch_add(1, std::memory_order_release);
    }

    /**
     * @brief 记录串口原始数据
     */
    void mirrorSerial(const uint8_t* data, size_t size) {
        if (!shm_ || size > sizeof(shm_->serial.raw_data)) return;

        std::memcpy(shm_->serial.raw_data, data, size);
        shm_->serial.size = static_cast<uint32_t>(size);
        shm_->serial.seq.fetch_add(1, std::memory_order_release);
    }

    /**
     * @brief 获取最新参数
     * @return JSON 字符串
     */
    std::string getParameters() {
        if (!shm_) return "{}";
        // 如果 bridge 有更新，则拷贝
        return std::string(shm_->params.json_data, shm_->params.size);
    }

private:
    Producer() : shm_(nullptr) {}
    ~Producer() {
        if (shm_) {
            munmap(shm_, SHM_SIZE);
        }
    }

    Producer(const Producer&) = delete;
    Producer& operator=(const Producer&) = delete;

    ShmLayout* shm_;
};

} // namespace pulsescope
