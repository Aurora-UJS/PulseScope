package main

// PulseScope 控制面后端。
//
// 观测面数据（时序/图像/地图）已迁移到 Rerun SDK（producer 直连 viewer），
// 本服务只负责控制面：
//   - 参数写回：前端 HTTP → SHM 控制块 → producer syncParams 读取
//   - 运维：producer 心跳/存活、CPU 负载/温度、进程终止
//
// SHM 布局必须与 C++ 端 include/shm_layout.hpp 的 ShmControlBlock 严格对齐。

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const (
	shmPath         = "/dev/shm/aurora_rm_ctrl"
	shmSize         = 8192
	expectedMagic   = 0x564953494F4E3031 // "VISION01"
	expectedVersion = 4

	maxParams   = 64
	paramKeyLen = 32
	paramUnitLn = 16

	// 槽位类型，与 C++ 端 vision::ParamType 一致
	paramTypeFloat = 1
	paramTypeInt   = 2
	paramTypeBool  = 3

	// producer 每帧 commit 刷新心跳（默认 50Hz），2s 无更新视为离线
	heartbeatTimeout = 2 * time.Second
)

// ParamSlot / ShmControlBlock 与 C++ 端 include/shm_layout.hpp 逐字节对齐。
// Go 不重排结构体字段，按声明顺序自然对齐即可匹配 C++ 的 pack(8) 布局；
// Reserved 字段是显式补齐，不能省略——它让 Value 落在 8 字节边界上。
//
// 两侧的偏移量由各自的检查锁定：C++ 是 shm_layout.hpp 里的 static_assert，
// Go 是 TestLayoutContract。任一侧改动布局，另一侧立即失败。
type ParamSlot struct {
	Key      [paramKeyLen]byte
	Unit     [paramUnitLn]byte
	Type     uint8
	Reserved [7]byte
	Value    float64
	MinValue float64
	MaxValue float64
	Step     float64
	Default  float64
}

type ShmControlBlock struct {
	MagicNumber uint64
	Version     uint64
	HeartbeatMs uint64
	ParamCount  uint32
	Reserved0   uint32
	Reserved1   [4]uint64
	Params      [maxParams]ParamSlot
}

// ParamInfo 是单个参数对外的完整描述。前端据此渲染控件并校验输入，
// 不再硬编码任何参数名或范围——真值来源是 producer 的 declare。
type ParamInfo struct {
	Key     string  `json:"key"`
	Type    string  `json:"type"` // float | int | bool
	Value   float64 `json:"value"`
	Min     float64 `json:"min"`
	Max     float64 `json:"max"`
	Step    float64 `json:"step"`
	Unit    string  `json:"unit"`
	Default float64 `json:"default"`
}

type ParamsResponse struct {
	Version uint64      `json:"version"`
	Count   int         `json:"count"`
	Params  []ParamInfo `json:"params"`
}

// ControlUpdate 是 key -> 新值的扁平映射，例如
// {"pid_p": 3.5, "fire_enabled": false}。
// 数值用 JSON number，布尔用 JSON bool，其余类型拒绝。
type ControlUpdate map[string]interface{}

// ControlResponse 在回读的参数表之外附带被拒绝的条目，
// 让前端能区分「值被钳制」与「key 根本不存在」。
type ControlResponse struct {
	ParamsResponse
	Rejected []string `json:"rejected"`
}

type StatusResponse struct {
	Timestamp      int64   `json:"timestamp"`
	ShmAttached    bool    `json:"shm_attached"`
	ShmValid       bool    `json:"shm_valid"`
	ProducerAlive  bool    `json:"producer_alive"`
	HeartbeatAgeMs int64   `json:"heartbeat_age_ms"` // -1 表示未知
	ParamCount     int     `json:"param_count"`      // 变化说明 producer 换了参数集，前端据此重拉
	NucCpuLoad     float64 `json:"nuc_cpu_load"`
	NucTemp        float64 `json:"nuc_temp"`
}

type HealthResponse struct {
	Status      string `json:"status"`
	ShmAttached bool   `json:"shm_attached"`
	Version     uint64 `json:"version"`
}

type KillProcessRequest struct {
	Name string `json:"name"`
}

type KillProcessResponse struct {
	Status      string `json:"status"`
	ProcessName string `json:"process_name"`
	KilledCount int    `json:"killed_count"`
}

// ShmRuntime 惰性挂载控制块：后端可先于 producer 启动，
// 首次访问参数时再尝试 attach。
type ShmRuntime struct {
	mu   sync.Mutex
	file *os.File
	data []byte
	ctrl *ShmControlBlock
}

func (s *ShmRuntime) attachLocked() error {
	if s.ctrl != nil {
		return nil
	}

	f, err := os.OpenFile(shmPath, os.O_RDWR, 0666)
	if err != nil {
		return err
	}

	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return err
	}
	// 必须按 mmap 长度校验，而不是结构体大小：映射超出文件末尾的部分，
	// 访问时会触发 SIGBUS 而非返回错误。v3 producer 建的是 4096 字节，
	// 在这里被挡下，不会进入按 v4 布局解析的路径。
	if info.Size() < int64(shmSize) {
		_ = f.Close()
		return fmt.Errorf("shm too small (%d bytes, need %d), stale v3 producer?", info.Size(), shmSize)
	}

	data, err := syscall.Mmap(int(f.Fd()), 0, shmSize, syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if err != nil {
		_ = f.Close()
		return err
	}

	s.file = f
	s.data = data
	s.ctrl = (*ShmControlBlock)(unsafe.Pointer(&data[0]))
	return nil
}

// EnsureAttached 尝试挂载（幂等）。返回 nil 表示 ctrl 可用。
func (s *ShmRuntime) EnsureAttached() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.attachLocked()
}

func (s *ShmRuntime) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data != nil {
		_ = syscall.Munmap(s.data)
		s.data = nil
	}
	if s.file != nil {
		_ = s.file.Close()
		s.file = nil
	}
	s.ctrl = nil
}

func (s *ShmRuntime) IsAttached() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ctrl != nil
}

func (s *ShmRuntime) Version() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctrl == nil {
		return 0
	}
	return s.ctrl.Version
}

func (s *ShmRuntime) Valid() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.validLocked()
}

// validLocked 判定控制块可解析：已挂载 + magic/version 匹配 + 计数合法。
//
// 所有触碰槽位的路径都必须先过这一关。v3 的 pid_p 恰好落在 v4 的 param_count
// 位置上：跳过校验去读会得到垃圾值，去写则直接破坏参数表计数——
// 这是 v3 版本 ReadParams/ApplyControl 的真实缺陷，此处一并堵死。
func (s *ShmRuntime) validLocked() bool {
	if s.ctrl == nil {
		return false
	}
	if s.ctrl.MagicNumber != expectedMagic || s.ctrl.Version != expectedVersion {
		return false
	}
	return s.paramCountLocked() <= maxParams
}

// paramCountLocked 以 acquire 语义读取计数，与 C++ 端 declare() 里的
// release fence 配对：读到的 count 以内，槽位元数据必然已完整写入。
func (s *ShmRuntime) paramCountLocked() uint32 {
	return atomic.LoadUint32(&s.ctrl.ParamCount)
}

func (s *ShmRuntime) findSlotLocked(key string, count uint32) *ParamSlot {
	// cString 对脏槽位（key 无 NUL 结尾）也返回空串，空 key 会误匹配上它们——
	// 那样读路径不暴露的槽位反而能被写路径改到。
	if key == "" {
		return nil
	}
	for i := uint32(0); i < count; i++ {
		if cString(s.ctrl.Params[i].Key[:]) == key {
			return &s.ctrl.Params[i]
		}
	}
	return nil
}

// ParamCount 必须与 ReadParams 同口径（都跳过脏槽位）。两者若不一致，前端拿
// /api/status 的 param_count 与 /api/params 的 count 相比会得到永久差值，
// 每秒误判「参数集变了」并重新拉取——新数组引用会冲掉用户正在拖动的草稿值。
func (s *ShmRuntime) ParamCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.validLocked() {
		return 0
	}
	count := s.paramCountLocked()
	n := 0
	for i := uint32(0); i < count; i++ {
		if cString(s.ctrl.Params[i].Key[:]) != "" {
			n++
		}
	}
	return n
}

// HeartbeatAgeMs 返回距 producer 上次 commit 的毫秒数，未知返回 -1。
func (s *ShmRuntime) HeartbeatAgeMs() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctrl == nil || s.ctrl.HeartbeatMs == 0 {
		return -1
	}
	age := time.Now().UnixMilli() - int64(s.ctrl.HeartbeatMs)
	if age < 0 {
		age = 0
	}
	return age
}

// ReadParams 读出 producer 声明的完整参数表（含元数据）。
// backend 不知道也不需要知道参数的名字与含义，只做搬运。
func (s *ShmRuntime) ReadParams() (ParamsResponse, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.validLocked() {
		return ParamsResponse{}, false
	}

	count := s.paramCountLocked()
	resp := ParamsResponse{
		Version: s.ctrl.Version,
		Params:  make([]ParamInfo, 0, count),
	}
	for i := uint32(0); i < count; i++ {
		slot := &s.ctrl.Params[i]
		key := cString(slot.Key[:])
		if key == "" {
			continue // key 无 NUL 结尾或为空：脏槽位，跳过而不是当作有效参数
		}
		resp.Params = append(resp.Params, ParamInfo{
			Key:     key,
			Type:    typeName(slot.Type),
			Value:   loadValue(slot),
			Min:     slot.MinValue,
			Max:     slot.MaxValue,
			Step:    slot.Step,
			Unit:    cString(slot.Unit[:]),
			Default: slot.Default,
		})
	}
	resp.Count = len(resp.Params)
	return resp, true
}

// ApplyControl 按 key 写入参数值。合法区间与类型来自共享内存中 producer 的
// 声明，backend 不再持有任何硬编码范围。
//
// 逐个参数独立写入：单个槽位的 value 是 8 字节对齐的原子写，
// 但跨参数不保证同批生效（例如 P/I/D 可能被 producer 分两帧读到）——
// 与 v3 语义一致，调参场景可容忍。
//
// 返回被拒绝的条目描述；未知 key 或非法类型不会中断其余参数的写入。
func (s *ShmRuntime) ApplyControl(update ControlUpdate) ([]string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.validLocked() {
		return nil, false
	}

	count := s.paramCountLocked()
	rejected := make([]string, 0)

	for key, raw := range update {
		value, err := toFloat(raw)
		if err != nil {
			rejected = append(rejected, fmt.Sprintf("%s: %v", key, err))
			continue
		}
		slot := s.findSlotLocked(key, count)
		if slot == nil {
			rejected = append(rejected, fmt.Sprintf("%s: no such param", key))
			continue
		}
		storeValue(slot, clampToSlot(value, slot))
	}
	return rejected, true
}

// cString 将定长 NUL 结尾字节数组转为 Go 字符串。
// 缺少 NUL 视为脏数据，返回空串由调用方跳过——绝不把整个定长数组当字符串用。
func cString(b []byte) string {
	n := bytes.IndexByte(b, 0)
	if n < 0 {
		return ""
	}
	return string(b[:n])
}

func typeName(t uint8) string {
	switch t {
	case paramTypeFloat:
		return "float"
	case paramTypeInt:
		return "int"
	case paramTypeBool:
		return "bool"
	default:
		return "unknown"
	}
}

// loadValue / storeValue 原子读写槽位值。
//
// C++ 端对同一位置做 volatile 读。两侧都依赖同一条硬件保证：8 字节对齐的
// load/store 在 x86-64 与 ARM64 上不会撕裂。atomic 在此之上额外阻止
// Go 编译器缓存或重排这次访问。
func loadValue(s *ParamSlot) float64 {
	return math.Float64frombits(atomic.LoadUint64((*uint64)(unsafe.Pointer(&s.Value))))
}

func storeValue(s *ParamSlot, v float64) {
	atomic.StoreUint64((*uint64)(unsafe.Pointer(&s.Value)), math.Float64bits(v))
}

// clampToSlot 按 producer 声明的区间与类型规整待写入的值。
// 取整规则必须与 C++ 端 ParamHandle::getInt()（std::llround，四舍五入）一致，
// 否则前端显示值与 producer 实际使用值会出现偏差。
func clampToSlot(v float64, s *ParamSlot) float64 {
	// NaN 与任何数比较都为 false，会静默穿过下面的区间钳制，必须先挡掉
	if math.IsNaN(v) {
		return s.Default
	}
	if v < s.MinValue {
		v = s.MinValue
	}
	if v > s.MaxValue {
		v = s.MaxValue
	}
	switch s.Type {
	case paramTypeInt:
		v = math.Round(v)
	case paramTypeBool:
		if v != 0 {
			v = 1
		} else {
			v = 0
		}
	}
	return v
}

// toFloat 接受 JSON number 与 bool，其余类型（字符串/对象/数组/null）拒绝。
func toFloat(raw interface{}) (float64, error) {
	switch v := raw.(type) {
	case float64:
		return v, nil
	case bool:
		if v {
			return 1, nil
		}
		return 0, nil
	default:
		return 0, fmt.Errorf("unsupported value type %T", raw)
	}
}

func killProcessesByName(name string) (int, error) {
	if name == "" {
		return 0, errors.New("empty process name")
	}

	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, err
	}

	killed := 0
	selfPID := os.Getpid()
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid == selfPID {
			continue
		}

		exePath, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
		if err != nil {
			continue
		}
		if filepath.Base(exePath) != name {
			continue
		}

		proc, err := os.FindProcess(pid)
		if err != nil {
			continue
		}
		if err := proc.Signal(syscall.SIGTERM); err == nil {
			killed++
		}
	}

	if killed == 0 {
		return 0, fmt.Errorf("no process named %q found", name)
	}
	return killed, nil
}

func readCPULoadPct() float64 {
	raw, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 1 {
		return 0
	}

	loadAvg, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0
	}
	cores := float64(runtime.NumCPU())
	if cores <= 0 {
		return 0
	}
	return (loadAvg / cores) * 100.0
}

func readCPUTempC() float64 {
	paths := []string{
		"/sys/class/thermal/thermal_zone0/temp",
		"/sys/class/hwmon/hwmon0/temp1_input",
	}

	for _, p := range paths {
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}

		temp, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
		if err != nil {
			continue
		}
		if temp > 1000 {
			return temp / 1000.0
		}
		return temp
	}
	return 0
}

func writeJSON(w http.ResponseWriter, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}

func main() {
	shm := &ShmRuntime{}
	if err := shm.EnsureAttached(); err != nil {
		fmt.Println("SHM not available yet (producer offline?), will retry on demand:", err)
	}
	defer shm.Close()

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_ = shm.EnsureAttached()
		writeJSON(w, HealthResponse{
			Status:      "ok",
			ShmAttached: shm.IsAttached(),
			Version:     shm.Version(),
		})
	})

	http.HandleFunc("/api/params", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := shm.EnsureAttached(); err != nil {
			http.Error(w, "control shm not available (producer offline?)", http.StatusServiceUnavailable)
			return
		}
		params, ok := shm.ReadParams()
		if !ok {
			http.Error(w, "control shm not available", http.StatusServiceUnavailable)
			return
		}
		writeJSON(w, params)
	})

	http.HandleFunc("/api/control", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var update ControlUpdate
		if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
			http.Error(w, "invalid json payload", http.StatusBadRequest)
			return
		}
		if err := shm.EnsureAttached(); err != nil {
			http.Error(w, "control shm not available (producer offline?)", http.StatusServiceUnavailable)
			return
		}
		rejected, ok := shm.ApplyControl(update)
		if !ok {
			http.Error(w, "control shm unavailable or version mismatch (expected v4)", http.StatusServiceUnavailable)
			return
		}

		// 回读生效值（含 clamp 结果），前端据此对齐 UI
		params, _ := shm.ReadParams()
		writeJSON(w, ControlResponse{ParamsResponse: params, Rejected: rejected})
	})

	http.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		_ = shm.EnsureAttached()

		age := shm.HeartbeatAgeMs()
		writeJSON(w, StatusResponse{
			Timestamp:      time.Now().UnixMilli(),
			ShmAttached:    shm.IsAttached(),
			ShmValid:       shm.Valid(),
			ProducerAlive:  age >= 0 && age < heartbeatTimeout.Milliseconds(),
			HeartbeatAgeMs: age,
			ParamCount:     shm.ParamCount(),
			NucCpuLoad:     readCPULoadPct(),
			NucTemp:        readCPUTempC(),
		})
	})

	http.HandleFunc("/api/process/kill", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		request := KillProcessRequest{Name: "vision_producer"}
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil && !errors.Is(err, io.EOF) {
			http.Error(w, "invalid json payload", http.StatusBadRequest)
			return
		}
		if request.Name == "" {
			request.Name = "vision_producer"
		}

		killed, err := killProcessesByName(request.Name)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}

		writeJSON(w, KillProcessResponse{
			Status:      "ok",
			ProcessName: request.Name,
			KilledCount: killed,
		})
	})

	fmt.Println("PulseScope control-plane backend running on :5000")
	log.Fatal(http.ListenAndServe(":5000", nil))
}
