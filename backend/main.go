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
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	shmPath         = "/dev/shm/aurora_rm_ctrl"
	shmSize         = 4096
	expectedMagic   = 0x564953494F4E3031 // "VISION01"
	expectedVersion = 3

	// producer 每帧 commit 刷新心跳（默认 50Hz），2s 无更新视为离线
	heartbeatTimeout = 2 * time.Second
)

// ShmControlBlock 与 C++ 端 shm_layout.hpp 逐字段对齐（pack(8)，自然对齐无补齐）。
type ShmControlBlock struct {
	MagicNumber  uint64
	Version      uint64
	HeartbeatMs  uint64
	PidP         float32
	PidI         float32
	PidD         float32
	ExposureTime uint32
	IsFireEnable uint8
	Reserved     [3]byte
}

type ControlUpdate struct {
	PidP        *float32 `json:"pid_p"`
	PidI        *float32 `json:"pid_i"`
	PidD        *float32 `json:"pid_d"`
	Exposure    *float32 `json:"exposure"`
	FireEnabled *bool    `json:"fire_enabled"`
}

type ParamsResponse struct {
	PidP        float32 `json:"pid_p"`
	PidI        float32 `json:"pid_i"`
	PidD        float32 `json:"pid_d"`
	Exposure    uint32  `json:"exposure"`
	FireEnabled bool    `json:"fire_enabled"`
}

type StatusResponse struct {
	Timestamp      int64   `json:"timestamp"`
	ShmAttached    bool    `json:"shm_attached"`
	ShmValid       bool    `json:"shm_valid"`
	ProducerAlive  bool    `json:"producer_alive"`
	HeartbeatAgeMs int64   `json:"heartbeat_age_ms"` // -1 表示未知
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
	if info.Size() < int64(unsafe.Sizeof(ShmControlBlock{})) {
		_ = f.Close()
		return fmt.Errorf("shm too small (%d bytes), stale producer?", info.Size())
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
	return s.ctrl != nil && s.ctrl.MagicNumber == expectedMagic && s.ctrl.Version == expectedVersion
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

func (s *ShmRuntime) ReadParams() (ParamsResponse, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctrl == nil {
		return ParamsResponse{}, false
	}
	return ParamsResponse{
		PidP:        s.ctrl.PidP,
		PidI:        s.ctrl.PidI,
		PidD:        s.ctrl.PidD,
		Exposure:    s.ctrl.ExposureTime,
		FireEnabled: s.ctrl.IsFireEnable != 0,
	}, true
}

// ApplyControl 将参数写入 SHM（逐字段独立写，与 C++ 端约定一致：
// 单字段自然对齐写入，不保证跨字段一致性——调参场景可容忍）。
func (s *ShmRuntime) ApplyControl(update ControlUpdate) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctrl == nil {
		return false
	}

	if update.PidP != nil {
		s.ctrl.PidP = clamp(*update.PidP, 0.0, 10.0)
	}
	if update.PidI != nil {
		s.ctrl.PidI = clamp(*update.PidI, 0.0, 1.0)
	}
	if update.PidD != nil {
		s.ctrl.PidD = clamp(*update.PidD, 0.0, 1.0)
	}
	if update.Exposure != nil {
		s.ctrl.ExposureTime = uint32(clamp(*update.Exposure, 100, 50000))
	}
	if update.FireEnabled != nil {
		if *update.FireEnabled {
			s.ctrl.IsFireEnable = 1
		} else {
			s.ctrl.IsFireEnable = 0
		}
	}
	return true
}

// clamp 将值钳制到 [min, max] 区间内，防止非法参数写入 SHM
func clamp(v, min, max float32) float32 {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
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
		if !shm.ApplyControl(update) {
			http.Error(w, "control shm not available", http.StatusServiceUnavailable)
			return
		}

		// 回读生效值（含 clamp 结果），前端据此对齐 UI
		params, _ := shm.ReadParams()
		writeJSON(w, params)
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

	// 默认只绑回环：这个端口无鉴权，却能改 fire_enabled、SIGTERM 任意进程，
	// 不能默认暴露在赛场 LAN 上。远程部署显式设 PULSESCOPE_BIND=0.0.0.0:5000。
	addr := os.Getenv("PULSESCOPE_BIND")
	if addr == "" {
		addr = "127.0.0.1:5000"
	}
	fmt.Println("PulseScope control-plane backend running on", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
