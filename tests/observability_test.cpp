
// 观测面 API 行为测试。
//
// 分工：本程序负责「调用不崩、边界安全、告警正确」，
// 写出的 .rrd 由 tests/run_observability_tests.sh 用 strings 检查内容
// （实体路径 / archetype 类型 / 时间轴是否真的落盘）。
// 二者合起来才算验证：能跑通不等于数据写对了。

#include "../include/vision_monitor.hpp"

#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace {

int g_failures = 0;

void ok(const std::string& what)   { std::cout << "  [ok]   " << what << std::endl; }
void fail(const std::string& what) { std::cout << "  [FAIL] " << what << std::endl; ++g_failures; }
void check(bool cond, const std::string& what) { cond ? ok(what) : fail(what); }

vision::Monitor& initMonitor(const char* rrd_path, const char* shm_name) {
    setenv("PULSESCOPE_RERUN_SAVE", rrd_path, 1);
    unsetenv("PULSESCOPE_RERUN_CONNECT");
    auto& m = vision::Monitor::getInstance();
    if (!m.init("observability_test", shm_name)) {
        std::cerr << "monitor.init failed" << std::endl;
        std::exit(3);
    }
    return m;
}

// 覆盖全部结构化 API 各一次，构成 .rrd 内容检查的样本
int scenarioSmoke(const char* rrd) {
    auto& m = initMonitor(rrd, "/pulsescope_obs_test");

    for (int frame = 0; frame < 3; ++frame) {
        m.beginFrame();

        // 变换树
        m.setTransform("world/gimbal", {0.0f, 0.0f, 0.3f}, {0.0f, 0.0f, 0.0f, 1.0f});
        m.setPinhole("world/gimbal/camera", 320.0f, 64, 48);

        // 图像（多路）
        std::vector<uint8_t> rgba(64 * 48 * 4, 128);
        m.pushImageRGBA(rgba.data(), 64, 48, "world/gimbal/camera/image");
        m.pushImageRGBA(rgba.data(), 64, 48, "world/gimbal/camera/binary");

        std::vector<float> grid(32 * 32, 1.0f);
        m.pushGrid(grid.data(), 32, 32, "esdf/map");

        // 2D 标注
        vision::Annotations box_ann;
        box_ann.labels = {"armor"};
        box_ann.colors = {{34, 211, 238, 255}};
        m.pushBoxes2D("world/gimbal/camera/armors", {{32.0f, 24.0f, 20.0f, 12.0f}}, box_ann);
        m.pushPoints2D("world/gimbal/camera/corners", {{10, 10}, {20, 10}, {20, 20}, {10, 20}});
        m.pushLines2D("world/gimbal/camera/track", {{{{0, 0}, {10, 10}, {20, 5}}}});

        // 3D
        vision::Annotations pt_ann;
        pt_ann.radii = {0.05f};
        m.pushPoints3D("world/target", {{1.0f, 0.5f, 0.3f}}, pt_ann);
        m.pushLines3D("world/target/trail", {{{{0, 0, 0}, {1, 0.5f, 0.3f}}}});
        m.pushBoxes3D("world/obstacles", {{{2.0f, 0.0f, 0.5f}, {0.4f, 0.4f, 1.0f}}});
        m.pushArrows3D("world/gradient", {{{0, 0, 0}, {1, 0, 0}}});

        // 标量与事件
        m.pushData("ekf_x", 1.5);
        m.pushData({{"ekf_y", 2.5}, {"latency", 0.3}});
        m.logText(vision::LogLevel::Info, "frame " + std::to_string(frame));

        // 逃生舱：本类未封装的 archetype 也应可用
        if (auto* rec = m.stream()) {
            rec->log("custom/text", rerun::TextDocument("escape hatch works"));
        } else {
            fail("stream() returned nullptr with an active sink");
        }

        m.commit();
    }

    ok("all structured APIs called across 3 frames without crashing");
    m.shutdown();  // flush，否则尾部数据可能不落盘
    return 0;
}

// 边界输入必须安全：不崩溃、不写入垃圾
int scenarioEdge(const char* rrd) {
    auto& m = initMonitor(rrd, "/pulsescope_obs_test");
    m.beginFrame();

    // 空容器：应当直接跳过
    m.pushBoxes2D("edge/empty_boxes", {});
    m.pushPoints2D("edge/empty_points", {});
    m.pushPoints3D("edge/empty_points3d", {});
    m.pushLines2D("edge/empty_lines", {});
    m.pushLines3D("edge/empty_lines3d", {});
    m.pushBoxes3D("edge/empty_boxes3d", {});
    m.pushArrows3D("edge/empty_arrows", {});
    ok("empty containers handled without crashing");

    // 空指针与零尺寸图像
    m.pushImageRGBA(nullptr, 64, 48, "edge/null_image");
    std::vector<uint8_t> rgba(16, 0);
    m.pushImageRGBA(rgba.data(), 0, 0, "edge/zero_size");
    m.pushGrid(nullptr, 32, 32, "edge/null_grid");
    ok("null pointers and zero dimensions handled without crashing");

    // Annotations 数量与元素数不符：应告警并忽略装饰，但主体仍写入
    std::cout << "  --- expecting annotation warnings below ---" << std::endl;
    vision::Annotations bad;
    bad.labels = {"a", "b", "c"};           // 3 个标签配 1 个框
    bad.colors = {{255, 0, 0, 255}, {0, 255, 0, 255}};
    bad.radii  = {1.0f, 2.0f};
    m.pushBoxes2D("edge/mismatched", {{1.0f, 1.0f, 2.0f, 2.0f}}, bad);
    ok("mismatched annotation sizes warned and ignored, geometry still logged");

    m.commit();
    m.shutdown();
    return 0;
}

// 控制面不可用时观测面必须照常工作（两个平面互不依赖）
int scenarioNoShm(const char* rrd) {
    setenv("PULSESCOPE_RERUN_SAVE", rrd, 1);
    unsetenv("PULSESCOPE_RERUN_CONNECT");
    auto& m = vision::Monitor::getInstance();

    // shm_open 要求名字形如 "/name"，内部再含 '/' 会 EINVAL
    const bool inited = m.init("observability_test", "/bad/shm/name");
    check(!inited, "init reports failure when control shm is unavailable");

    // 但观测面此时应当已经可用
    check(m.stream() != nullptr, "observability plane still usable without control shm");

    m.beginFrame();
    m.pushData("still_working", 42.0);
    m.pushPoints3D("world/target", {{1, 2, 3}});
    m.commit();
    ok("observability writes succeed without the control plane");

    m.shutdown();
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: observability_test <smoke|edge|no-shm> <out.rrd>" << std::endl;
        return 2;
    }

    const std::string scenario = argv[1];
    const char* rrd = argv[2];
    std::cout << "== " << scenario << " ==" << std::endl;

    int rc = 0;
    if      (scenario == "smoke")  rc = scenarioSmoke(rrd);
    else if (scenario == "edge")   rc = scenarioEdge(rrd);
    else if (scenario == "no-shm") rc = scenarioNoShm(rrd);
    else {
        std::cerr << "unknown scenario: " << scenario << std::endl;
        return 2;
    }

    if (g_failures > 0) {
        std::cout << "  " << g_failures << " check(s) failed" << std::endl;
        return 1;
    }
    return rc;
}
