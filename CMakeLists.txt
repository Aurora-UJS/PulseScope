cmake_minimum_required(VERSION 3.16)
project(pulsescope LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Rerun C++ SDK（预编译静态库 + 头文件，版本需与 viewer 保持一致）
include(FetchContent)
FetchContent_Declare(rerun_sdk
    URL https://github.com/rerun-io/rerun/releases/download/0.34.1/rerun_cpp_sdk.zip
    DOWNLOAD_EXTRACT_TIMESTAMP ON
)
FetchContent_MakeAvailable(rerun_sdk)

# ---------------------------------------------------------------------------
# pulsescope: 供业务项目接入的接口库（header-only）
#
# 在你自己的工程里：
#   add_subdirectory(path/to/PulseScope)
#   target_link_libraries(my_vision_node PRIVATE pulsescope)
# 即可 #include "vision_monitor.hpp"，Rerun SDK 与 rt/pthread 自动带上。
# ---------------------------------------------------------------------------
add_library(pulsescope INTERFACE)
target_include_directories(pulsescope INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
# rt: shm_open/shm_unlink (glibc < 2.34 兼容)
target_link_libraries(pulsescope INTERFACE rerun_sdk rt pthread)
target_compile_features(pulsescope INTERFACE cxx_std_17)

add_executable(vision_producer src_cpp/main.cpp)
target_link_libraries(vision_producer PRIVATE pulsescope)

# shm_ctl: 控制块命令行工具（dump / set）。
# 只依赖 shm_layout.hpp，不链接 Rerun——这本身就验证了控制面可以被
# 不含观测面依赖的进程解析，正是 backend 所处的位置。
add_executable(shm_ctl tools/shm_ctl.cpp)
target_include_directories(shm_ctl PRIVATE include)
target_link_libraries(shm_ctl PRIVATE rt)
target_compile_features(shm_ctl PRIVATE cxx_std_17)

# 参数注册行为测试。由 tests/run_param_tests.sh 按场景多进程编排
# （Monitor 是不可重置的单例，重启相关路径只能跨进程验证）。
add_executable(param_declare_test tests/param_declare_test.cpp)
target_link_libraries(param_declare_test PRIVATE pulsescope)

# 观测面 API 测试。写出的 .rrd 由 tests/run_observability_tests.sh 检查内容——
# 「调用没崩」与「数据写对了」是两回事，两者都要验。
add_executable(observability_test tests/observability_test.cpp)
target_link_libraries(observability_test PRIVATE pulsescope)
