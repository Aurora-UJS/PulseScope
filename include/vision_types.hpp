
#pragma once
#include <cstdint>
#include <string>
#include <vector>

// PulseScope 观测面的几何/标注类型。
//
// 全部是聚合初始化的 POD，不依赖 Rerun、OpenCV 或 Eigen：
// 业务代码可以直接 {x, y} 构造，也容易从 cv::Point2f / Eigen::Vector3f 转过来，
// 例如 vision::Vec2{p.x, p.y} 或 vision::Vec3{v.x(), v.y(), v.z()}。
//
// Monitor 负责把这些类型翻译成对应的 Rerun archetype。

namespace vision {

struct Vec2 { float x = 0.0f, y = 0.0f; };
struct Vec3 { float x = 0.0f, y = 0.0f, z = 0.0f; };

// 单位四元数（x, y, z, w）。w 默认 1 即单位旋转。
struct Quat { float x = 0.0f, y = 0.0f, z = 0.0f, w = 1.0f; };

struct Rgba {
    uint8_t r = 255, g = 255, b = 255, a = 255;
};

// 以中心点 + 全尺寸描述的 2D 框（与目标检测输出的习惯一致）
struct Box2D {
    float cx = 0.0f, cy = 0.0f;   // 中心
    float w  = 0.0f, h  = 0.0f;   // 全宽 / 全高
};

// 以中心点 + 全尺寸描述的 3D 框
struct Box3D {
    Vec3 center;
    Vec3 size;                    // 全尺寸（非半尺寸）
};

// 折线：一串顶点。多条折线用 std::vector<Polyline2D>
struct Polyline2D { std::vector<Vec2> points; };
struct Polyline3D { std::vector<Vec3> points; };

// 箭头：起点 + 向量（用于梯度场、速度、受力）
struct Arrow3D {
    Vec3 origin;
    Vec3 vector;
};

// 可选的逐元素装饰。留空则使用 Rerun 默认样式。
// 长度要么为 0，要么与主体元素个数一致；不一致时 Monitor 会忽略并告警。
struct Annotations {
    std::vector<std::string> labels;
    std::vector<Rgba>        colors;
    std::vector<float>       radii;   // 点半径 / 线宽，单位与所在空间一致
};

enum class LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
};

} // namespace vision
