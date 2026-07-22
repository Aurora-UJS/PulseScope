#!/usr/bin/env bash
# 观测面 API 测试。
#
# 两层验证：
#   1. observability_test 负责「调用不崩、边界安全、告警正确」
#   2. 本脚本检查写出的 .rrd 里确实出现了预期的实体路径、archetype 与时间轴
#
# 第 2 层不可省：push 调用返回正常不代表数据真的落盘——早先就实测到过
# Rerun 批处理器在大图像流量下饿死小 chunk、导致标量整批丢失的情况。
#
# 用法: tests/run_observability_tests.sh [build_dir]

set -uo pipefail

BUILD_DIR="${1:-build}"
TEST_BIN="$BUILD_DIR/observability_test"
OUT_DIR="$(mktemp -d)"

failures=0
ok()   { echo "  [ok]   $*"; }
fail() { echo "  [FAIL] $*"; failures=$((failures + 1)); }

cleanup() {
    rm -rf "$OUT_DIR"
    rm -f /dev/shm/pulsescope_obs_test
}
trap cleanup EXIT

[[ -x "$TEST_BIN" ]] || { echo "missing $TEST_BIN - build first"; exit 2; }
command -v strings >/dev/null || { echo "missing 'strings' (binutils)"; exit 2; }

run_scenario() {
    local name="$1" rrd="$2"
    echo
    echo "--- \$ $TEST_BIN $name ---"
    if ! "$TEST_BIN" "$name" "$rrd"; then
        fail "scenario '$name' exited non-zero"
        return 1
    fi
    if [[ ! -s "$rrd" ]]; then
        fail "scenario '$name' produced no .rrd"
        return 1
    fi
    # 预先把可打印字符串落盘，后续断言直接 grep 文件。
    # 不能写成 `strings ... | grep -q ...`：grep -q 命中即退出，上游 strings
    # 随之收到 SIGPIPE（退出码 141），在 set -o pipefail 下整条管道被判为失败——
    # 于是「匹配成功」反而报 FAIL。且只有输出超过管道缓冲的大文件才触发，
    # 小文件正常通过，极具迷惑性。
    strings -n 4 "$rrd" > "$rrd.txt"
    return 0
}

# 断言 .rrd 中出现某个模式（实体路径 / archetype 名 / 时间轴名均为明文）
assert_in_rrd() {
    local rrd="$1" pattern="$2" desc="$3"
    if grep -qE -- "$pattern" "$rrd.txt"; then
        ok "$desc"
    else
        fail "$desc — /$pattern/ absent from $(basename "$rrd")"
    fi
}

# 断言 .rrd 中不出现某个模式
assert_not_in_rrd() {
    local rrd="$1" pattern="$2" desc="$3"
    if grep -qE -- "$pattern" "$rrd.txt"; then
        fail "$desc — /$pattern/ unexpectedly present in $(basename "$rrd")"
    else
        ok "$desc"
    fi
}

echo "=========================================="
echo " observability API tests"
echo "=========================================="

SMOKE="$OUT_DIR/smoke.rrd"
run_scenario smoke "$SMOKE"

echo
echo "--- .rrd content: timelines ---"
# 三条时间轴缺一不可：capture_time 是与外部数据源对齐的唯一依据
for tl in frame runtime capture_time; do
    assert_in_rrd "$SMOKE" "\\b$tl\\b" "timeline '$tl' present"
done

echo
echo "--- .rrd content: archetypes ---"
for at in Boxes2D Points2D LineStrips2D Points3D Boxes3D LineStrips3D Arrows3D \
          Transform3D Pinhole Image DepthImage TextLog Scalars TextDocument; do
    assert_in_rrd "$SMOKE" "rerun\\.archetypes\\.$at" "archetype $at logged"
done

echo
echo "--- .rrd content: entity paths (transform tree) ---"
for ent in "world/gimbal" "world/gimbal/camera" "world/gimbal/camera/image" \
           "world/gimbal/camera/binary" "world/gimbal/camera/armors" \
           "world/gimbal/camera/corners" "world/gimbal/camera/track" \
           "world/target" "world/target/trail" "world/obstacles" \
           "world/gradient" "esdf/map" "custom/text"; do
    assert_in_rrd "$SMOKE" "$ent" "entity '$ent'"
done

echo
echo "--- .rrd content: annotations ---"
assert_in_rrd "$SMOKE" "armor" "box label written"

# 边界场景：非法输入不得崩溃，也不得写出空实体
EDGE="$OUT_DIR/edge.rrd"
run_scenario edge "$EDGE"
echo
echo "--- edge: empty inputs must not create entities ---"
for ent in "edge/empty_boxes" "edge/empty_points" "edge/empty_lines" \
           "edge/null_image" "edge/zero_size" "edge/null_grid"; do
    assert_not_in_rrd "$EDGE" "$ent" "no entity for '$ent' (correctly skipped)"
done
# 但尺寸不符的 annotations 只丢装饰，几何本身仍要写入
assert_in_rrd "$EDGE" "edge/mismatched" "geometry still logged despite bad annotations"

# 控制面缺失时观测面必须照常工作
NOSHM="$OUT_DIR/no_shm.rrd"
run_scenario no-shm "$NOSHM"
assert_in_rrd "$NOSHM" "telemetry/still_working" "telemetry logged without control plane"
assert_in_rrd "$NOSHM" "world/target" "3d data logged without control plane"

echo
echo "=========================================="
if [[ $failures -eq 0 ]]; then
    echo " ALL PASSED"
else
    echo " $failures check(s) FAILED"
fi
echo "=========================================="
exit $((failures > 0))
