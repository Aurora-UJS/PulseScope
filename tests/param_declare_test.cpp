
// 参数注册（v4 自描述控制块）行为测试。
//
// Monitor 是故意不析构的单例，单个进程内无法重置，因此每个场景跑一个独立进程，
// 由 tests/run_param_tests.sh 编排。这样「producer 重启后沿用上次调过的值」
// 这条最关键的路径测的是真实进程生命周期，而不是模拟。
//
// 元数据校验一律通过独立 mmap 按字节解析，而非读 Monitor 内部状态——
// 这正是 backend 要做的事，顺带验证布局对外可解析。

#include "../include/vision_monitor.hpp"

#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>

namespace {

const char* kTestShm = "/pulsescope_param_test";

int g_failures = 0;

void ok(const std::string& what) {
    std::cout << "  [ok]   " << what << std::endl;
}

void fail(const std::string& what) {
    std::cout << "  [FAIL] " << what << std::endl;
    ++g_failures;
}

void check(bool cond, const std::string& what) {
    cond ? ok(what) : fail(what);
}

void checkNear(double got, double want, const std::string& what) {
    if (std::fabs(got - want) < 1e-9) {
        ok(what + " = " + std::to_string(got));
    } else {
        fail(what + ": got " + std::to_string(got) + ", want " + std::to_string(want));
    }
}

void checkStr(const char* got, const char* want, const std::string& what) {
    if (std::strcmp(got, want) == 0) {
        ok(what + " = \"" + got + "\"");
    } else {
        fail(what + ": got \"" + std::string(got) + "\", want \"" + want + "\"");
    }
}

// 以外部观察者身份只读映射控制块，模拟 backend 的解析路径
struct ShmView {
    int fd = -1;
    vision::ShmControlBlock* ctrl = nullptr;

    bool open() {
        fd = shm_open(kTestShm, O_RDONLY, 0666);
        if (fd == -1) return false;
        void* p = mmap(nullptr, vision::kControlShmSize, PROT_READ, MAP_SHARED, fd, 0);
        if (p == MAP_FAILED) {
            ::close(fd);
            fd = -1;
            return false;
        }
        ctrl = static_cast<vision::ShmControlBlock*>(p);
        return true;
    }

    void close() {
        if (ctrl) munmap(ctrl, vision::kControlShmSize);
        if (fd != -1) ::close(fd);
        ctrl = nullptr;
        fd = -1;
    }

    const vision::ParamSlot* find(const char* key) const {
        if (!ctrl) return nullptr;
        for (uint32_t i = 0; i < ctrl->param_count; ++i) {
            if (std::strncmp(ctrl->params[i].key, key, vision::kParamKeyLen) == 0) {
                return &ctrl->params[i];
            }
        }
        return nullptr;
    }
};

// 观测面在测试中无关紧要，但 init() 要求 sink 初始化成功。
// 指向临时 .rrd 避免 spawn 一个真的 viewer。
void silenceRerun() {
    setenv("PULSESCOPE_RERUN_SAVE", "/tmp/pulsescope_param_test.rrd", 1);
    unsetenv("PULSESCOPE_RERUN_CONNECT");
}

vision::Monitor& initMonitor() {
    silenceRerun();
    auto& m = vision::Monitor::getInstance();
    if (!m.init("param_test", kTestShm)) {
        std::cerr << "monitor.init failed" << std::endl;
        std::exit(3);
    }
    return m;
}

// 与 main.cpp 一致的一组声明，供 basic / restore 场景复用
void declareStandardSet(vision::Monitor& m) {
    m.declareFloat("pid_p", 1.0, 0.0, 10.0, 0.01);
    m.declareFloat("pid_i", 0.0, 0.0, 1.0, 0.001);
    m.declareFloat("pid_d", 0.1, 0.0, 1.0, 0.001);
    m.declareInt("exposure_time", 5000, 100, 50000, 100, "us");
    m.declareBool("fire_enabled", true);
}

// --- 场景 -------------------------------------------------------------------

// 全新注册：元数据完整写入，值取默认值
int scenarioBasic() {
    auto& m = initMonitor();
    declareStandardSet(m);

    check(m.paramCount() == 5, "paramCount == 5");

    ShmView v;
    if (!v.open()) { fail("cannot map shm as external reader"); return 1; }
    check(v.ctrl->magic_number == vision::kShmMagicNumber, "magic written");
    check(v.ctrl->version == vision::kShmVersion, "version == 4");
    check(v.ctrl->param_count == 5, "external reader sees 5 params");

    const vision::ParamSlot* p = v.find("pid_p");
    if (!p) { fail("pid_p not found"); v.close(); return 1; }
    checkStr(p->key, "pid_p", "pid_p.key");
    check(p->type == vision::kParamFloat, "pid_p.type == float");
    checkNear(p->value, 1.0, "pid_p.value (default)");
    checkNear(p->min_value, 0.0, "pid_p.min");
    checkNear(p->max_value, 10.0, "pid_p.max");
    checkNear(p->step, 0.01, "pid_p.step");
    checkStr(p->unit, "", "pid_p.unit (empty)");
    checkNear(p->default_value, 1.0, "pid_p.default");

    const vision::ParamSlot* e = v.find("exposure_time");
    if (!e) { fail("exposure_time not found"); v.close(); return 1; }
    check(e->type == vision::kParamInt, "exposure_time.type == int");
    checkNear(e->value, 5000.0, "exposure_time.value");
    checkNear(e->max_value, 50000.0, "exposure_time.max");
    checkStr(e->unit, "us", "exposure_time.unit");

    const vision::ParamSlot* f = v.find("fire_enabled");
    if (!f) { fail("fire_enabled not found"); v.close(); return 1; }
    check(f->type == vision::kParamBool, "fire_enabled.type == bool");
    checkNear(f->value, 1.0, "fire_enabled.value (true)");
    checkNear(f->min_value, 0.0, "fire_enabled.min");
    checkNear(f->max_value, 1.0, "fire_enabled.max");

    // count 以内的槽位 key 必须已完整写入（发布屏障的可观测不变式）
    bool all_named = true;
    for (uint32_t i = 0; i < v.ctrl->param_count; ++i) {
        if (v.ctrl->params[i].key[0] == '\0') all_named = false;
    }
    check(all_named, "every slot within param_count has a non-empty key");

    v.close();
    return 0;
}

// 重启：同名同类型参数沿用上一轮被改过的值，而不是回到默认值
int scenarioRestore() {
    auto& m = initMonitor();
    declareStandardSet(m);

    ShmView v;
    if (!v.open()) { fail("cannot map shm"); return 1; }

    const vision::ParamSlot* p = v.find("pid_p");
    const vision::ParamSlot* e = v.find("exposure_time");
    const vision::ParamSlot* f = v.find("fire_enabled");
    if (!p || !e || !f) { fail("params missing after restart"); v.close(); return 1; }

    // run_param_tests.sh 在本场景前用 shm_ctl 写入了这些值
    checkNear(p->value, 3.5, "pid_p restored across restart");
    checkNear(e->value, 12000.0, "exposure_time restored across restart");
    checkNear(f->value, 0.0, "fire_enabled restored across restart");
    // 元数据仍来自本轮声明，不是从旧表继承
    checkNear(p->default_value, 1.0, "default_value still from this run's declare");

    v.close();
    return 0;
}

// 重启且范围收窄：旧值越界时钳制回新区间
int scenarioRestoreClamp() {
    auto& m = initMonitor();
    // pid_p 上次是 3.5，这轮上限降到 2.0
    m.declareFloat("pid_p", 1.0, 0.0, 2.0, 0.01);

    ShmView v;
    if (!v.open()) { fail("cannot map shm"); return 1; }
    const vision::ParamSlot* p = v.find("pid_p");
    if (!p) { fail("pid_p missing"); v.close(); return 1; }

    checkNear(p->value, 2.0, "out-of-range restored value clamped to new max");
    checkNear(p->max_value, 2.0, "new max in effect");
    v.close();
    return 0;
}

// 重启但类型变了：不恢复，用新默认值（旧值语义已不适用）
int scenarioRestoreTypeChange() {
    auto& m = initMonitor();
    // pid_p 上一轮是 float(=2.0)，这轮声明为 int
    m.declareInt("pid_p", 7, 0, 100, 1);

    ShmView v;
    if (!v.open()) { fail("cannot map shm"); return 1; }
    const vision::ParamSlot* p = v.find("pid_p");
    if (!p) { fail("pid_p missing"); v.close(); return 1; }

    check(p->type == vision::kParamInt, "type changed to int");
    checkNear(p->value, 7.0, "type change discards old value, uses new default");
    v.close();
    return 0;
}

// 非法声明被拒绝，且不污染参数表
int scenarioReject() {
    auto& m = initMonitor();

    m.declareFloat("good", 1.0, 0.0, 10.0);
    check(m.paramCount() == 1, "valid declare accepted");

    std::string too_long_key(vision::kParamKeyLen, 'k');
    std::string too_long_unit(vision::kParamUnitLen, 'u');

    auto h_empty = m.declareFloat("", 1.0, 0.0, 10.0);
    auto h_long  = m.declareFloat(too_long_key.c_str(), 1.0, 0.0, 10.0);
    auto h_unit  = m.declareFloat("with_unit", 1.0, 0.0, 10.0, 0.0, too_long_unit.c_str());
    auto h_range = m.declareFloat("bad_range", 1.0, 10.0, 0.0);
    auto h_dup   = m.declareFloat("good", 2.0, 0.0, 10.0);

    check(m.paramCount() == 1, "all invalid declares rejected, count unchanged");
    check(!h_empty.bound(), "empty key -> unbound handle");
    check(!h_long.bound(),  "over-long key -> unbound handle");
    check(!h_unit.bound(),  "over-long unit -> unbound handle");
    check(!h_range.bound(), "min > max -> unbound handle");
    check(!h_dup.bound(),   "duplicate key -> unbound handle");

    // 未绑定句柄仍返回注册时给的默认值，业务代码无需分支
    checkNear(h_range.get(), 1.0, "unbound handle falls back to default");
    checkNear(h_dup.get(), 2.0, "unbound duplicate falls back to its own default");

    ShmView v;
    if (!v.open()) { fail("cannot map shm"); return 1; }
    check(v.ctrl->param_count == 1, "external reader sees only the valid param");
    const vision::ParamSlot* g = v.find("good");
    if (g) checkNear(g->value, 1.0, "surviving param keeps first declare's default");
    else fail("good param missing");
    v.close();
    return 0;
}

// 槽位耗尽：第 kMaxParams+1 个被拒绝，已注册的不受影响
int scenarioOverflow() {
    auto& m = initMonitor();

    for (size_t i = 0; i < vision::kMaxParams; ++i) {
        m.declareFloat(("p" + std::to_string(i)).c_str(), static_cast<double>(i), 0.0, 1000.0);
    }
    check(m.paramCount() == vision::kMaxParams, "table filled to kMaxParams");

    auto overflow = m.declareFloat("one_too_many", 1.0, 0.0, 10.0);
    check(!overflow.bound(), "declare beyond kMaxParams -> unbound handle");
    check(m.paramCount() == vision::kMaxParams, "count not incremented past limit");

    ShmView v;
    if (!v.open()) { fail("cannot map shm"); return 1; }
    check(v.ctrl->param_count == vision::kMaxParams, "external count == kMaxParams");
    const vision::ParamSlot* last = v.find(("p" + std::to_string(vision::kMaxParams - 1)).c_str());
    if (last) checkNear(last->value, static_cast<double>(vision::kMaxParams - 1), "last valid slot intact");
    else fail("last valid slot missing");
    check(v.find("one_too_many") == nullptr, "rejected param absent from table");
    v.close();
    return 0;
}

// 控制块不可用时 producer 仍能跑：句柄未绑定但读得到默认值
int scenarioUnbound() {
    silenceRerun();
    auto& m = vision::Monitor::getInstance();
    // shm_open 要求名字形如 "/name"，内部再含 '/' 会 EINVAL
    const bool inited = m.init("param_test", "/bad/shm/name");
    check(!inited, "init fails when control shm cannot be opened");

    auto h = m.declareFloat("pid_p", 2.5, 0.0, 10.0);
    check(!h.bound(), "declare without shm -> unbound handle");
    checkNear(h.get(), 2.5, "unbound handle still yields declared default");
    check(m.paramCount() == 0, "paramCount == 0 without shm");
    return 0;
}

int scenarioClean() {
    shm_unlink(kTestShm);
    std::remove("/tmp/pulsescope_param_test.rrd");
    std::cout << "  [ok]   cleaned " << kTestShm << std::endl;
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: param_declare_test <basic|restore|restore-clamp|"
                     "restore-type-change|reject|overflow|unbound|clean>" << std::endl;
        return 2;
    }

    const std::string scenario = argv[1];
    std::cout << "== " << scenario << " ==" << std::endl;

    int rc = 0;
    if      (scenario == "basic")               rc = scenarioBasic();
    else if (scenario == "restore")             rc = scenarioRestore();
    else if (scenario == "restore-clamp")       rc = scenarioRestoreClamp();
    else if (scenario == "restore-type-change") rc = scenarioRestoreTypeChange();
    else if (scenario == "reject")              rc = scenarioReject();
    else if (scenario == "overflow")            rc = scenarioOverflow();
    else if (scenario == "unbound")             rc = scenarioUnbound();
    else if (scenario == "clean")               rc = scenarioClean();
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
