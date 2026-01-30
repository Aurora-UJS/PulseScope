#pragma once

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <iostream>
#include <string>
#include <vector>

#include "shm_layout.hpp"

namespace pulsescope {

/**
 * @brief PulseScope Monitor (C++ Client)
 * 
 * 用于从共享内存中读取 Producer 暴露的数据。
 */
class Monitor {
public:
    Monitor() : shm_(nullptr) {}
    ~Monitor() {
        if (shm_) {
            munmap(const_cast<ShmLayout*>(shm_), SHM_SIZE);
        }
    }

    bool init() {
        // 打开已存在的共享内存
        int shm_fd = shm_open(SHM_NAME, O_RDONLY, 0666);
        if (shm_fd == -1) {
            return false;
        }

        void* ptr = mmap(0, SHM_SIZE, PROT_READ, MAP_SHARED, shm_fd, 0);
        if (ptr == MAP_FAILED) {
            close(shm_fd);
            return false;
        }

        shm_ = static_cast<const ShmLayout*>(ptr);
        close(shm_fd);
        return true;
    }

    /**
     * @brief 获取最新图像
     * @param buffer 目标缓冲区
     * @return 实际读取的大小
     */
    size_t getImage(std::vector<uint8_t>& buffer, uint32_t& width, uint32_t& height) {
        if (!shm_) return 0;
        
        uint32_t size = shm_->image.size;
        if (size > 0 && size <= sizeof(shm_->image.data)) {
            buffer.assign(shm_->image.data, shm_->image.data + size);
            width = shm_->image.width;
            height = shm_->image.height;
            return size;
        }
        return 0;
    }

    /**
     * @brief 获取最新遥测 JSON
     */
    std::string getTelemetry() {
        if (!shm_ || shm_->telemetry.size == 0) return "{}";
        return std::string(shm_->telemetry.json_data, shm_->telemetry.size);
    }

    /**
     * @brief 检查数据是否有更新 (通过 seq)
     */
    uint64_t getImageSeq() const { return shm_ ? shm_->image.seq.load(std::memory_order_acquire) : 0; }
    uint64_t getTelemetrySeq() const { return shm_ ? shm_->telemetry.seq.load(std::memory_order_acquire) : 0; }

private:
    const ShmLayout* shm_;
};

} // namespace pulsescope
