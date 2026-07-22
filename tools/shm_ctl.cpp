
// 控制块命令行工具：不依赖 Rerun SDK，只 include shm_layout.hpp。
//
// 两个用途：
//   1. 运维：没有 backend / 前端时直接查看与修改 producer 的参数表
//   2. 测试：以「外部进程」身份按字节解析共享内存，验证 producer 写出的布局
//      确实能被独立解析——这正是 backend 要做的事。
//
// 用法:
//   shm_ctl dump [shm_name]
//   shm_ctl set <key> <value> [shm_name]

#include "../include/shm_layout.hpp"

#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>

namespace {

const char* typeName(uint8_t t) {
    switch (t) {
        case vision::kParamFloat: return "float";
        case vision::kParamInt:   return "int";
        case vision::kParamBool:  return "bool";
        default:                  return "?";
    }
}

// 以只读或读写方式映射控制块。失败返回 nullptr 并打印原因。
vision::ShmControlBlock* mapControl(const char* name, bool writable, int* out_fd) {
    const int flags = writable ? O_RDWR : O_RDONLY;
    int fd = shm_open(name, flags, 0666);
    if (fd == -1) {
        std::cerr << "shm_open(" << name << ") failed: " << std::strerror(errno) << std::endl;
        return nullptr;
    }

    struct stat st{};
    if (fstat(fd, &st) == -1) {
        std::cerr << "fstat failed: " << std::strerror(errno) << std::endl;
        close(fd);
        return nullptr;
    }
    // 映射长度不得超过文件实际大小，否则越界访问会触发 SIGBUS
    if (static_cast<size_t>(st.st_size) < sizeof(vision::ShmControlBlock)) {
        std::cerr << "shm too small: " << st.st_size << " bytes, need >= "
                  << sizeof(vision::ShmControlBlock) << " (stale v3 producer?)" << std::endl;
        close(fd);
        return nullptr;
    }

    const int prot = writable ? (PROT_READ | PROT_WRITE) : PROT_READ;
    void* ptr = mmap(nullptr, vision::kControlShmSize, prot, MAP_SHARED, fd, 0);
    if (ptr == MAP_FAILED) {
        std::cerr << "mmap failed: " << std::strerror(errno) << std::endl;
        close(fd);
        return nullptr;
    }

    *out_fd = fd;
    return static_cast<vision::ShmControlBlock*>(ptr);
}

bool checkHeader(const vision::ShmControlBlock* ctrl) {
    if (ctrl->magic_number != vision::kShmMagicNumber) {
        std::cerr << "bad magic: 0x" << std::hex << ctrl->magic_number << std::dec
                  << " (expected 0x" << std::hex << vision::kShmMagicNumber << std::dec << ")" << std::endl;
        return false;
    }
    if (ctrl->version != vision::kShmVersion) {
        std::cerr << "version mismatch: shm=" << ctrl->version
                  << " tool=" << vision::kShmVersion << std::endl;
        return false;
    }
    if (ctrl->param_count > vision::kMaxParams) {
        std::cerr << "corrupt param_count: " << ctrl->param_count << std::endl;
        return false;
    }
    return true;
}

int doDump(const char* name) {
    int fd = -1;
    vision::ShmControlBlock* ctrl = mapControl(name, false, &fd);
    if (!ctrl) return 1;
    if (!checkHeader(ctrl)) {
        munmap(ctrl, vision::kControlShmSize);
        close(fd);
        return 1;
    }

    std::printf("shm          : %s\n", name);
    std::printf("version      : %llu\n", static_cast<unsigned long long>(ctrl->version));
    std::printf("heartbeat_ms : %llu\n", static_cast<unsigned long long>(ctrl->heartbeat_ms));
    std::printf("param_count  : %u / %zu\n\n", ctrl->param_count, vision::kMaxParams);

    std::printf("%-3s %-24s %-6s %14s %14s %14s %12s %-8s\n",
                "#", "key", "type", "value", "min", "max", "step", "unit");
    for (uint32_t i = 0; i < ctrl->param_count; ++i) {
        const vision::ParamSlot& s = ctrl->params[i];
        // key/unit 必须是 NUL 结尾，否则是脏数据（不能直接当 C 字符串打印）
        const bool key_ok = std::memchr(s.key, '\0', vision::kParamKeyLen) != nullptr;
        const bool unit_ok = std::memchr(s.unit, '\0', vision::kParamUnitLen) != nullptr;
        std::printf("%-3u %-24s %-6s %14.6g %14.6g %14.6g %12.6g %-8s\n",
                    i,
                    key_ok ? s.key : "<unterminated>",
                    typeName(s.type),
                    s.value, s.min_value, s.max_value, s.step,
                    unit_ok ? s.unit : "?");
    }

    munmap(ctrl, vision::kControlShmSize);
    close(fd);
    return 0;
}

int doSet(const char* name, const char* key, const char* raw_value) {
    char* end = nullptr;
    const double value = std::strtod(raw_value, &end);
    if (end == raw_value || *end != '\0') {
        std::cerr << "invalid value: " << raw_value << std::endl;
        return 1;
    }

    int fd = -1;
    vision::ShmControlBlock* ctrl = mapControl(name, true, &fd);
    if (!ctrl) return 1;
    if (!checkHeader(ctrl)) {
        munmap(ctrl, vision::kControlShmSize);
        close(fd);
        return 1;
    }

    int rc = 1;
    for (uint32_t i = 0; i < ctrl->param_count; ++i) {
        vision::ParamSlot& s = ctrl->params[i];
        if (std::memchr(s.key, '\0', vision::kParamKeyLen) == nullptr) continue;
        if (std::strncmp(s.key, key, vision::kParamKeyLen) != 0) continue;

        // 与 backend 同样的规则：钳制到 producer 声明的区间，整数/布尔取整
        double v = value;
        if (v < s.min_value) v = s.min_value;
        if (v > s.max_value) v = s.max_value;
        if (s.type == vision::kParamInt)  v = static_cast<double>(static_cast<int64_t>(v < 0 ? v - 0.5 : v + 0.5));
        if (s.type == vision::kParamBool) v = (v != 0.0) ? 1.0 : 0.0;

        s.value = v;
        std::printf("%s = %g", s.key, v);
        if (v != value) std::printf("  (clamped from %g)", value);
        std::printf("\n");
        rc = 0;
        break;
    }

    if (rc != 0) std::cerr << "no such param: " << key << std::endl;

    munmap(ctrl, vision::kControlShmSize);
    close(fd);
    return rc;
}

void usage() {
    std::cerr << "usage:\n"
              << "  shm_ctl dump [shm_name]\n"
              << "  shm_ctl set <key> <value> [shm_name]\n"
              << "default shm_name: " << vision::kControlShmName << std::endl;
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        usage();
        return 2;
    }

    const std::string cmd = argv[1];
    if (cmd == "dump") {
        const char* name = (argc >= 3) ? argv[2] : vision::kControlShmName;
        return doDump(name);
    }
    if (cmd == "set") {
        if (argc < 4) {
            usage();
            return 2;
        }
        const char* name = (argc >= 5) ? argv[4] : vision::kControlShmName;
        return doSet(name, argv[2], argv[3]);
    }

    usage();
    return 2;
}
