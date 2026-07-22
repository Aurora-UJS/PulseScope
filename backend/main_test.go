package main

import (
	"math"
	"testing"
	"unsafe"
)

// TestLayoutContract 锁定与 C++ 端的共享内存 ABI。
//
// 这里的每个数字都与 include/shm_layout.hpp 中的 static_assert 一一对应。
// 任一侧改动结构体，两侧的检查会同时失败——这是刻意的冗余：跨语言布局错位
// 不会崩溃，只会让 backend 把某个字段的字节当作另一个字段解析，
// 表现为「参数值莫名其妙」，是这类共享内存最难定位的故障。
func TestLayoutContract(t *testing.T) {
	var slot ParamSlot
	var block ShmControlBlock

	cases := []struct {
		name string
		got  uintptr
		want uintptr
	}{
		{"sizeof(ParamSlot)", unsafe.Sizeof(slot), 96},
		{"offsetof(ParamSlot.Key)", unsafe.Offsetof(slot.Key), 0},
		{"offsetof(ParamSlot.Unit)", unsafe.Offsetof(slot.Unit), 32},
		{"offsetof(ParamSlot.Type)", unsafe.Offsetof(slot.Type), 48},
		{"offsetof(ParamSlot.Value)", unsafe.Offsetof(slot.Value), 56},
		{"offsetof(ParamSlot.MinValue)", unsafe.Offsetof(slot.MinValue), 64},
		{"offsetof(ParamSlot.MaxValue)", unsafe.Offsetof(slot.MaxValue), 72},
		{"offsetof(ParamSlot.Step)", unsafe.Offsetof(slot.Step), 80},
		{"offsetof(ParamSlot.Default)", unsafe.Offsetof(slot.Default), 88},

		{"offsetof(ShmControlBlock.MagicNumber)", unsafe.Offsetof(block.MagicNumber), 0},
		{"offsetof(ShmControlBlock.Version)", unsafe.Offsetof(block.Version), 8},
		{"offsetof(ShmControlBlock.HeartbeatMs)", unsafe.Offsetof(block.HeartbeatMs), 16},
		{"offsetof(ShmControlBlock.ParamCount)", unsafe.Offsetof(block.ParamCount), 24},
		{"offsetof(ShmControlBlock.Params)", unsafe.Offsetof(block.Params), 64},
		{"sizeof(ShmControlBlock)", unsafe.Sizeof(block), 64 + 96*maxParams},
	}

	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s = %d, want %d (C++ shm_layout.hpp disagrees)", c.name, c.got, c.want)
		}
	}

	// Value 必须 8 字节对齐，否则跨进程读写可能撕裂
	if unsafe.Offsetof(slot.Value)%8 != 0 {
		t.Errorf("ParamSlot.Value not 8-byte aligned")
	}
	// ParamCount 用 atomic.LoadUint32 访问，需要 4 字节对齐
	if unsafe.Offsetof(block.ParamCount)%4 != 0 {
		t.Errorf("ShmControlBlock.ParamCount not 4-byte aligned")
	}
	// 控制块必须放得进映射长度
	if unsafe.Sizeof(block) > shmSize {
		t.Errorf("sizeof(ShmControlBlock)=%d exceeds shmSize=%d", unsafe.Sizeof(block), shmSize)
	}
}

func makeSlot(key string, typ uint8, value, min, max, def float64, unit string) ParamSlot {
	var s ParamSlot
	copy(s.Key[:], key)
	copy(s.Unit[:], unit)
	s.Type = typ
	s.Value = value
	s.MinValue = min
	s.MaxValue = max
	s.Default = def
	return s
}

// newFakeRuntime 构造一个不依赖真实共享内存的 ShmRuntime，
// 用于测试解析与写入逻辑（含版本校验这类拒绝路径）。
func newFakeRuntime(slots ...ParamSlot) *ShmRuntime {
	ctrl := &ShmControlBlock{
		MagicNumber: expectedMagic,
		Version:     expectedVersion,
		ParamCount:  uint32(len(slots)),
	}
	copy(ctrl.Params[:], slots)
	return &ShmRuntime{ctrl: ctrl}
}

func TestClampToSlot(t *testing.T) {
	floatSlot := makeSlot("pid_p", paramTypeFloat, 1, 0, 10, 1, "")
	intSlot := makeSlot("exposure_time", paramTypeInt, 5000, 100, 50000, 5000, "us")
	boolSlot := makeSlot("fire_enabled", paramTypeBool, 1, 0, 1, 1, "")

	cases := []struct {
		name string
		slot *ParamSlot
		in   float64
		want float64
	}{
		{"float within range unchanged", &floatSlot, 3.5, 3.5},
		{"float above max clamped", &floatSlot, 999, 10},
		{"float below min clamped", &floatSlot, -5, 0},
		{"float at boundary kept", &floatSlot, 10, 10},
		{"+Inf clamps to max", &floatSlot, math.Inf(1), 10},
		{"-Inf clamps to min", &floatSlot, math.Inf(-1), 0},
		// NaN 与任何值比较都为 false，会静默穿过区间判断，必须回落默认值
		{"NaN falls back to default", &floatSlot, math.NaN(), 1},

		// 取整规则须与 C++ ParamHandle::getInt() 的 std::llround 一致
		{"int rounds up at .6", &intSlot, 12000.6, 12001},
		{"int rounds down at .4", &intSlot, 12000.4, 12000},
		{"int rounds half away from zero", &intSlot, 12000.5, 12001},
		{"int clamped before rounding", &intSlot, 1e9, 50000},

		{"bool nonzero becomes 1", &boolSlot, 0.7, 1},
		{"bool zero stays 0", &boolSlot, 0, 0},
		{"bool out-of-range clamped then normalized", &boolSlot, 5, 1},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := clampToSlot(c.in, c.slot)
			if got != c.want {
				t.Errorf("clampToSlot(%v) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

func TestToFloat(t *testing.T) {
	cases := []struct {
		name    string
		in      interface{}
		want    float64
		wantErr bool
	}{
		{"json number", float64(3.5), 3.5, false},
		{"json true", true, 1, false},
		{"json false", false, 0, false},
		{"string rejected", "3.5", 0, true},
		{"null rejected", nil, 0, true},
		{"object rejected", map[string]interface{}{}, 0, true},
		{"array rejected", []interface{}{1.0}, 0, true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := toFloat(c.in)
			if c.wantErr {
				if err == nil {
					t.Errorf("toFloat(%v) expected error, got %v", c.in, got)
				}
				return
			}
			if err != nil {
				t.Errorf("toFloat(%v) unexpected error: %v", c.in, err)
			}
			if got != c.want {
				t.Errorf("toFloat(%v) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

func TestCString(t *testing.T) {
	var normal [paramKeyLen]byte
	copy(normal[:], "pid_p")

	var empty [paramKeyLen]byte

	// 填满且无 NUL：脏数据，绝不能当作 32 字符的 key 返回
	var unterminated [paramKeyLen]byte
	for i := range unterminated {
		unterminated[i] = 'x'
	}

	if got := cString(normal[:]); got != "pid_p" {
		t.Errorf("cString(normal) = %q, want %q", got, "pid_p")
	}
	if got := cString(empty[:]); got != "" {
		t.Errorf("cString(empty) = %q, want empty", got)
	}
	if got := cString(unterminated[:]); got != "" {
		t.Errorf("cString(unterminated) = %q, want empty (dirty slot)", got)
	}
}

func TestReadParamsExposesDeclaredMetadata(t *testing.T) {
	rt := newFakeRuntime(
		makeSlot("pid_p", paramTypeFloat, 3.5, 0, 10, 1, ""),
		makeSlot("exposure_time", paramTypeInt, 12000, 100, 50000, 5000, "us"),
		makeSlot("fire_enabled", paramTypeBool, 0, 0, 1, 1, ""),
	)

	resp, ok := rt.ReadParams()
	if !ok {
		t.Fatal("ReadParams failed on a valid control block")
	}
	if resp.Count != 3 || len(resp.Params) != 3 {
		t.Fatalf("Count = %d, len(Params) = %d, want 3", resp.Count, len(resp.Params))
	}
	if resp.Version != expectedVersion {
		t.Errorf("Version = %d, want %d", resp.Version, expectedVersion)
	}

	p := resp.Params[0]
	if p.Key != "pid_p" || p.Type != "float" || p.Value != 3.5 || p.Min != 0 || p.Max != 10 {
		t.Errorf("params[0] = %+v, metadata not passed through", p)
	}
	e := resp.Params[1]
	if e.Type != "int" || e.Unit != "us" || e.Max != 50000 {
		t.Errorf("params[1] = %+v, int metadata wrong", e)
	}
	if resp.Params[2].Type != "bool" {
		t.Errorf("params[2].Type = %q, want bool", resp.Params[2].Type)
	}
}

// v3 控制块的 pid_p 正好落在 v4 的 param_count 位置上。
// 若不校验版本就解析，读会得到垃圾、写会破坏参数表计数。
func TestVersionMismatchIsRejected(t *testing.T) {
	rt := newFakeRuntime(makeSlot("pid_p", paramTypeFloat, 1, 0, 10, 1, ""))
	rt.ctrl.Version = 3

	if _, ok := rt.ReadParams(); ok {
		t.Error("ReadParams accepted a v3 control block")
	}
	if _, ok := rt.ApplyControl(ControlUpdate{"pid_p": 5.0}); ok {
		t.Error("ApplyControl accepted a v3 control block")
	}
	if rt.Valid() {
		t.Error("Valid() true for a v3 control block")
	}
	if rt.ParamCount() != 0 {
		t.Error("ParamCount non-zero for a v3 control block")
	}
	// 关键：拒绝之后计数字段必须原封不动
	if rt.ctrl.ParamCount != 1 {
		t.Errorf("ParamCount corrupted to %d by a rejected write", rt.ctrl.ParamCount)
	}
}

func TestBadMagicIsRejected(t *testing.T) {
	rt := newFakeRuntime(makeSlot("pid_p", paramTypeFloat, 1, 0, 10, 1, ""))
	rt.ctrl.MagicNumber = 0xDEADBEEF

	if _, ok := rt.ReadParams(); ok {
		t.Error("ReadParams accepted a block with bad magic")
	}
	if _, ok := rt.ApplyControl(ControlUpdate{"pid_p": 5.0}); ok {
		t.Error("ApplyControl accepted a block with bad magic")
	}
}

func TestCorruptParamCountIsRejected(t *testing.T) {
	rt := newFakeRuntime(makeSlot("pid_p", paramTypeFloat, 1, 0, 10, 1, ""))
	rt.ctrl.ParamCount = maxParams + 1

	if _, ok := rt.ReadParams(); ok {
		t.Error("ReadParams accepted param_count beyond maxParams")
	}
}

func TestApplyControlUsesDeclaredRange(t *testing.T) {
	rt := newFakeRuntime(
		makeSlot("pid_p", paramTypeFloat, 1, 0, 10, 1, ""),
		makeSlot("exposure_time", paramTypeInt, 5000, 100, 50000, 5000, "us"),
		makeSlot("fire_enabled", paramTypeBool, 1, 0, 1, 1, ""),
	)

	rejected, ok := rt.ApplyControl(ControlUpdate{
		"pid_p":         999.0, // 超上限 -> 10
		"exposure_time": 777.4, // 取整 -> 777
		"fire_enabled":  false, // bool -> 0
	})
	if !ok {
		t.Fatal("ApplyControl failed on a valid block")
	}
	if len(rejected) != 0 {
		t.Errorf("unexpected rejections: %v", rejected)
	}

	resp, _ := rt.ReadParams()
	got := map[string]float64{}
	for _, p := range resp.Params {
		got[p.Key] = p.Value
	}
	if got["pid_p"] != 10 {
		t.Errorf("pid_p = %v, want 10 (clamped to declared max)", got["pid_p"])
	}
	if got["exposure_time"] != 777 {
		t.Errorf("exposure_time = %v, want 777", got["exposure_time"])
	}
	if got["fire_enabled"] != 0 {
		t.Errorf("fire_enabled = %v, want 0", got["fire_enabled"])
	}
}

func TestApplyControlReportsRejectionsWithoutBlockingOthers(t *testing.T) {
	rt := newFakeRuntime(makeSlot("pid_p", paramTypeFloat, 1, 0, 10, 1, ""))

	rejected, ok := rt.ApplyControl(ControlUpdate{
		"pid_p":       4.0,     // 合法
		"unknown_key": 1.0,     // 未声明
		"bad_type":    "hello", // 类型非法
	})
	if !ok {
		t.Fatal("ApplyControl failed on a valid block")
	}
	if len(rejected) != 2 {
		t.Errorf("rejected = %v, want 2 entries", rejected)
	}

	// 非法条目不应阻断合法条目的写入
	resp, _ := rt.ReadParams()
	if resp.Params[0].Value != 4 {
		t.Errorf("pid_p = %v, want 4 (valid update must still apply)", resp.Params[0].Value)
	}
}

// 只有 param_count 以内的槽位算数：超出部分即便有内容也不得被暴露。
func TestSlotsBeyondCountAreIgnored(t *testing.T) {
	rt := newFakeRuntime(makeSlot("pid_p", paramTypeFloat, 1, 0, 10, 1, ""))
	rt.ctrl.Params[1] = makeSlot("ghost", paramTypeFloat, 42, 0, 100, 0, "")

	resp, _ := rt.ReadParams()
	if len(resp.Params) != 1 {
		t.Fatalf("len(Params) = %d, want 1", len(resp.Params))
	}
	if resp.Params[0].Key != "pid_p" {
		t.Errorf("params[0].Key = %q, want pid_p", resp.Params[0].Key)
	}

	if _, ok := rt.ApplyControl(ControlUpdate{"ghost": 1.0}); !ok {
		t.Fatal("ApplyControl failed")
	}
	if rt.ctrl.Params[1].Value != 42 {
		t.Errorf("slot beyond count was written: %v", rt.ctrl.Params[1].Value)
	}
}

// 无 NUL 结尾的 key 是脏槽位，跳过而不是把整个定长数组当 key 暴露出去。
func TestDirtySlotIsSkipped(t *testing.T) {
	dirty := ParamSlot{Type: paramTypeFloat, MinValue: 0, MaxValue: 1}
	for i := range dirty.Key {
		dirty.Key[i] = 'x'
	}

	rt := newFakeRuntime(
		makeSlot("pid_p", paramTypeFloat, 1, 0, 10, 1, ""),
		dirty,
	)

	resp, ok := rt.ReadParams()
	if !ok {
		t.Fatal("ReadParams failed")
	}
	if resp.Count != 1 || len(resp.Params) != 1 {
		t.Errorf("Count = %d, len = %d, want 1 (dirty slot must be skipped)", resp.Count, len(resp.Params))
	}
}
