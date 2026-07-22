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

add_executable(vision_producer src_cpp/main.cpp)
target_include_directories(vision_producer PRIVATE include)
# rt: shm_open/shm_unlink (glibc < 2.34 兼容)
target_link_libraries(vision_producer PRIVATE rerun_sdk rt pthread)
