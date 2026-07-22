#!/usr/bin/env bash
# v4 自描述控制块的参数注册测试。
#
# 场景之间存在顺序依赖：restore 系列要读上一个进程留在共享内存里的值，
# 因此必须串行执行，不能并行。中途用 shm_ctl 以外部进程身份写入，
# 模拟 backend 的调参行为。
#
# 用法: tests/run_param_tests.sh [build_dir]

set -uo pipefail

BUILD_DIR="${1:-build}"
TEST_BIN="$BUILD_DIR/param_declare_test"
CTL_BIN="$BUILD_DIR/shm_ctl"
SHM="/pulsescope_param_test"

if [[ ! -x "$TEST_BIN" || ! -x "$CTL_BIN" ]]; then
    echo "missing binaries in '$BUILD_DIR' - build first:"
    echo "  cmake -S . -B $BUILD_DIR && cmake --build $BUILD_DIR -j"
    exit 2
fi

failures=0

run() {
    echo
    echo "--- \$ $* ---"
    if ! "$@"; then
        echo ">>> FAILED: $*"
        failures=$((failures + 1))
    fi
}

# 断言命令成功退出且输出匹配给定模式
run_expect() {
    _expect_impl "ok" "$@"
}

# 断言命令以非零退出且输出匹配给定模式。
# 拒绝非法输入本身就是被测行为，非零退出是正确结果而非故障。
run_expect_fail() {
    _expect_impl "fail" "$@"
}

_expect_impl() {
    local want="$1"; shift
    local pattern="$1"; shift
    local expectation
    [[ "$want" == "ok" ]] && expectation="exit 0" || expectation="exit != 0"

    echo
    echo "--- \$ $* (expect $expectation + /$pattern/) ---"

    local out rc
    out="$("$@" 2>&1)"
    rc=$?
    echo "$out"

    if [[ "$want" == "ok" && $rc -ne 0 ]]; then
        echo ">>> FAILED (expected exit 0, got $rc): $*"
        failures=$((failures + 1))
        return
    fi
    if [[ "$want" == "fail" && $rc -eq 0 ]]; then
        echo ">>> FAILED (expected non-zero exit, got 0): $*"
        failures=$((failures + 1))
        return
    fi
    if ! grep -qE "$pattern" <<<"$out"; then
        echo ">>> FAILED (no match for /$pattern/): $*"
        failures=$((failures + 1))
    fi
}

trap '"$TEST_BIN" clean >/dev/null 2>&1 || true' EXIT

echo "=========================================="
echo " param registry tests (shm: $SHM)"
echo "=========================================="

# 1) 干净起点 + 全新注册
run "$TEST_BIN" clean
run "$TEST_BIN" basic

# 2) 外部进程（模拟 backend）能解析并修改参数表
run "$CTL_BIN" dump "$SHM"
run "$CTL_BIN" set pid_p 3.5 "$SHM"
run "$CTL_BIN" set exposure_time 12000 "$SHM"
run "$CTL_BIN" set fire_enabled 0 "$SHM"

# 3) 写入越界值应被钳制到 producer 声明的区间
run_expect "clamped" "$CTL_BIN" set pid_p 999 "$SHM"
run_expect "clamped" "$CTL_BIN" set exposure_time 1 "$SHM"
# 复位为 restore 场景期望的值
run "$CTL_BIN" set pid_p 3.5 "$SHM"
run "$CTL_BIN" set exposure_time 12000 "$SHM"

# 4) 未声明的 key 必须被拒绝
run_expect_fail "no such param" "$CTL_BIN" set nonexistent_key 1 "$SHM"

# 5) producer 重启：同名同类型沿用上一轮的值（pid_p=3.5 / exposure=12000 / fire=0）
run "$TEST_BIN" restore

# 6) 重启且范围收窄：pid_p 旧值 3.5 越界，钳制到新上限 2.0
run "$TEST_BIN" restore-clamp

# 7) 重启且类型改变：pid_p 由 float 变 int，旧值作废，取新默认值 7
run "$TEST_BIN" restore-type-change

# 8) 非法声明与槽位耗尽
run "$TEST_BIN" reject
run "$TEST_BIN" overflow

# 9) 控制块不可用时 producer 仍可运行（句柄回落默认值）
run "$TEST_BIN" unbound

# 10) 版本不匹配的控制块必须被拒绝，而不是当作有效数据解析。
#     直接改写 version 字段（offset 8）制造一个 v0 控制块。
run "$TEST_BIN" basic
printf '\x00' | dd of="/dev/shm${SHM}" bs=1 seek=8 count=1 conv=notrunc status=none
run_expect_fail "version mismatch" "$CTL_BIN" dump "$SHM"

run "$TEST_BIN" clean

echo
echo "=========================================="
if [[ $failures -eq 0 ]]; then
    echo " ALL PASSED"
else
    echo " $failures step(s) FAILED"
fi
echo "=========================================="
exit $((failures > 0))
