#!/usr/bin/env bash
# 全链路端到端测试：C++ producer -> 共享内存 -> Go backend -> HTTP API。
#
# 这是唯一能真正验证跨语言布局的测试。C++ 的 static_assert 与 Go 的
# TestLayoutContract 各自断言的是「自己那侧的偏移等于我写下的数字」——
# 两边同时写错同一个数字仍会双双通过。这里让 C++ 写、Go 读，
# 断言读出的值等于 declare 时声明的值，布局错位无处可藏。
#
# 用法: tests/run_e2e_test.sh [build_dir]

set -uo pipefail

BUILD_DIR="${1:-build}"
PRODUCER="$BUILD_DIR/vision_producer"
BACKEND_DIR="backend"
PORT=5000
API="http://127.0.0.1:$PORT"
SHM_FILE="/dev/shm/aurora_rm_ctrl"
TMPDIR_E2E="$(mktemp -d)"

failures=0
producer_pid=""
backend_pid=""

fail() { echo ">>> FAILED: $*"; failures=$((failures + 1)); }
ok()   { echo "  [ok]   $*"; }

# 确认进程真的退出：SIGTERM 后等 2s，仍在则 SIGKILL。
# 残留进程会占着端口活到下一次运行，是「上一轮污染下一轮」的常见来源。
stop_proc() {
    local pid="$1" name="$2"
    [[ -z "$pid" ]] && return
    kill -TERM "$pid" 2>/dev/null || return
    for _ in $(seq 20); do
        kill -0 "$pid" 2>/dev/null || return
        sleep 0.1
    done
    echo "  ($name ignored SIGTERM, sending SIGKILL)"
    kill -9 "$pid" 2>/dev/null
}

cleanup() {
    stop_proc "$backend_pid" backend
    stop_proc "$producer_pid" producer
    wait 2>/dev/null
    rm -rf "$TMPDIR_E2E"
    rm -f "$SHM_FILE"
}
trap cleanup EXIT

for tool in jq curl go; do
    command -v "$tool" >/dev/null || { echo "missing required tool: $tool"; exit 2; }
done
[[ -x "$PRODUCER" ]] || { echo "missing $PRODUCER - build first"; exit 2; }

# 断言 JSON 表达式的求值结果
assert_jq() {
    local desc="$1" expr="$2" want="$3" json="$4"
    local got
    got="$(jq -r "$expr" <<<"$json" 2>/dev/null)"
    if [[ "$got" == "$want" ]]; then
        ok "$desc = $got"
    else
        fail "$desc: got '$got', want '$want'"
    fi
}

# 等待条件成立，最多 timeout 秒
wait_for() {
    local desc="$1" timeout="$2"; shift 2
    local waited=0
    while (( waited < timeout * 10 )); do
        if "$@" >/dev/null 2>&1; then
            ok "$desc ready"
            return 0
        fi
        sleep 0.1
        waited=$((waited + 1))
    done
    fail "$desc did not become ready in ${timeout}s"
    return 1
}

echo "=========================================="
echo " end-to-end: C++ producer <-> Go backend"
echo "=========================================="

rm -f "$SHM_FILE"

# --- 起 producer（观测面写文件，避免拉起 viewer）-----------------------------
echo
echo "--- starting producer ---"
PULSESCOPE_RERUN_SAVE="$TMPDIR_E2E/e2e.rrd" \
PULSESCOPE_UPDATE_HZ=50 \
"$PRODUCER" > "$TMPDIR_E2E/producer.log" 2>&1 &
producer_pid=$!
wait_for "control shm" 10 test -e "$SHM_FILE" || exit 1

# --- 起 backend --------------------------------------------------------------
# 端口必须空闲。否则 wait_for 的 /health 探测会被别人的服务应答，
# 测试误以为就绪，后续断言对着一个映射了旧共享内存的进程做，全部失效。
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
    echo "port $PORT already in use - refusing to run against a foreign backend:"
    ss -ltnp 2>/dev/null | grep ":$PORT "
    exit 2
fi

echo
echo "--- starting backend ---"
# 必须先 build 再执行，不能用 `go run`：go run 会编译出临时二进制再 fork 执行，
# $! 拿到的是 go run 自身的 PID，kill 它并不会终止真正的服务进程——
# 残留进程会占着端口活到下一次测试，让后续运行对着上一轮的状态做断言。
# backend 是独立 module（自带 go.mod），必须在其目录内构建
( cd "$BACKEND_DIR" && go build -o "$TMPDIR_E2E/vision-backend" . ) \
    || { echo "go build failed"; exit 2; }
"$TMPDIR_E2E/vision-backend" > "$TMPDIR_E2E/backend.log" 2>&1 &
backend_pid=$!
wait_for "backend :$PORT" 30 curl -sf "$API/health" || {
    cat "$TMPDIR_E2E/backend.log"
    exit 1
}

# --- 1) backend 读出 producer 声明的元数据 ------------------------------------
echo
echo "--- 1) GET /api/params: metadata declared in C++ must survive the crossing ---"
params_json="$(curl -sf "$API/api/params")" || fail "GET /api/params"
echo "$params_json" | jq -c '.params[]' 2>/dev/null

# 参数个数不写死：从 producer 自己打印的声明数取，断言 backend 读到的与之一致。
# 这既是真正的跨端一致性检查，也让新增 declare 不必回来改测试。
declared="$(grep -oE '[0-9]+ params declared' "$TMPDIR_E2E/producer.log" | grep -oE '^[0-9]+')"
if [[ -z "$declared" ]]; then
    fail "cannot read declared param count from producer log"
    declared=0
fi
echo "  (producer declared $declared params)"

assert_jq "version"                '.version'                                   4       "$params_json"
assert_jq "count matches producer" '.count'                            "$declared"      "$params_json"
assert_jq "pid_p.type"             '.params[]|select(.key=="pid_p").type'       float   "$params_json"
assert_jq "pid_p.min"              '.params[]|select(.key=="pid_p").min'        0       "$params_json"
assert_jq "pid_p.max"              '.params[]|select(.key=="pid_p").max'        10      "$params_json"
assert_jq "pid_p.step"             '.params[]|select(.key=="pid_p").step'       0.01    "$params_json"
assert_jq "pid_p.default"          '.params[]|select(.key=="pid_p").default'    1       "$params_json"
assert_jq "pid_i.max"              '.params[]|select(.key=="pid_i").max'        1       "$params_json"
assert_jq "exposure_time.type"     '.params[]|select(.key=="exposure_time").type'  int  "$params_json"
assert_jq "exposure_time.unit"     '.params[]|select(.key=="exposure_time").unit'  us   "$params_json"
assert_jq "exposure_time.max"      '.params[]|select(.key=="exposure_time").max'   50000 "$params_json"
assert_jq "exposure_time.value"    '.params[]|select(.key=="exposure_time").value' 5000  "$params_json"
assert_jq "fire_enabled.type"      '.params[]|select(.key=="fire_enabled").type'   bool  "$params_json"
assert_jq "fire_enabled.value"     '.params[]|select(.key=="fire_enabled").value'  1     "$params_json"

# --- 2) 写入被 producer 声明的区间钳制 ---------------------------------------
echo
echo "--- 2) POST /api/control: clamping uses the producer's declared range ---"
ctrl_json="$(curl -sf -X POST "$API/api/control" \
    -H 'Content-Type: application/json' \
    -d '{"pid_p": 999, "exposure_time": 12000.6, "fire_enabled": false}')" || fail "POST /api/control"

assert_jq "pid_p clamped to declared max" '.params[]|select(.key=="pid_p").value'         10     "$ctrl_json"
assert_jq "exposure_time rounded"         '.params[]|select(.key=="exposure_time").value' 12001  "$ctrl_json"
assert_jq "fire_enabled false -> 0"       '.params[]|select(.key=="fire_enabled").value'  0      "$ctrl_json"
assert_jq "no rejections"                 '.rejected|length'                              0      "$ctrl_json"

# --- 3) 非法输入被拒，且不影响合法条目 ---------------------------------------
echo
echo "--- 3) POST /api/control: invalid entries rejected, valid ones still applied ---"
mixed_json="$(curl -sf -X POST "$API/api/control" \
    -H 'Content-Type: application/json' \
    -d '{"pid_i": 0.25, "no_such_param": 1, "pid_d": "not a number"}')" || fail "POST mixed"

assert_jq "valid entry applied"    '.params[]|select(.key=="pid_i").value' 0.25 "$mixed_json"
assert_jq "two rejections"         '.rejected|length'                      2    "$mixed_json"
echo "  rejected: $(jq -c '.rejected' <<<"$mixed_json")"
jq -e '.rejected|any(test("no such param"))'      <<<"$mixed_json" >/dev/null \
    && ok "unknown key reported" || fail "unknown key not reported"
jq -e '.rejected|any(test("unsupported value type"))' <<<"$mixed_json" >/dev/null \
    && ok "bad type reported" || fail "bad type not reported"

# --- 4) producer 确实读到了这些值 --------------------------------------------
echo
echo "--- 4) producer side must observe the written values ---"
sleep 0.5
if grep -qE '^\[params\] P=10\.000 I=0\.250 D=0\.100 exposure=12001 fire=0' "$TMPDIR_E2E/producer.log"; then
    ok "producer read back: P=10.000 I=0.250 exposure=12001 fire=0"
else
    fail "producer did not observe expected values"
    echo "  --- producer.log [params] lines ---"
    grep -E '^\[params\]' "$TMPDIR_E2E/producer.log" | tail -5
fi

# --- 5) status 暴露参数规模 --------------------------------------------------
echo
echo "--- 5) GET /api/status ---"
status_json="$(curl -sf "$API/api/status")" || fail "GET /api/status"
assert_jq "shm_valid"     '.shm_valid'      true "$status_json"
assert_jq "producer_alive" '.producer_alive' true "$status_json"
assert_jq "param_count"   '.param_count'  "$declared" "$status_json"

# --- 6) 版本不匹配的控制块必须被拒绝，而不是按 v4 解析 -----------------------
echo
echo "--- 6) version guard: a non-v4 block must be refused, not misparsed ---"
kill -TERM "$producer_pid" 2>/dev/null; wait "$producer_pid" 2>/dev/null; producer_pid=""
printf '\x03' | dd of="$SHM_FILE" bs=1 seek=8 count=1 conv=notrunc status=none

bad_status="$(curl -sf "$API/api/status")"
assert_jq "shm_valid false for v3 block" '.shm_valid'   false "$bad_status"
assert_jq "param_count 0 for v3 block"   '.param_count' 0     "$bad_status"

code="$(curl -s -o /dev/null -w '%{http_code}' "$API/api/params")"
[[ "$code" == "503" ]] && ok "GET /api/params -> 503 on version mismatch" \
                       || fail "GET /api/params -> $code, want 503"

code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/control" \
        -H 'Content-Type: application/json' -d '{"pid_p": 5}')"
[[ "$code" == "503" ]] && ok "POST /api/control -> 503 on version mismatch" \
                       || fail "POST /api/control -> $code, want 503"

# 被拒绝的写入不得改动控制块：param_count 仍应是 5
count_after="$(od -An -tu4 -j24 -N4 "$SHM_FILE" | tr -d ' ')"
[[ "$count_after" == "$declared" ]] && ok "param_count intact after refused writes ($count_after)" \
                            || fail "param_count corrupted: $count_after (want $declared)"

echo
echo "=========================================="
if [[ $failures -eq 0 ]]; then
    echo " ALL PASSED"
else
    echo " $failures check(s) FAILED"
fi
echo "=========================================="
exit $((failures > 0))
