
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

private:
    Monitor() : shm_ptr(nullptr), header(nullptr) {}
    void* shm_ptr;
    ShmHeader* header;
};

} // namespace vision
