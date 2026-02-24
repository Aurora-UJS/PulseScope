package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/gorilla/websocket"
)

const (
	shmPath         = "/dev/shm/vision_debug_shm"
	shmTotalSize    = 10 * 1024 * 1024 // 10MB
	esdfCells       = 10000
	esdfWidth       = 100
	esdfHeight      = 100
	expectedMagic   = 0x564953494F4E3031
	expectedVersion = 2

	dataPushInterval   = 40 * time.Millisecond  // 25Hz
	mapPushInterval    = 200 * time.Millisecond // 5Hz
	statusPushInterval = 1 * time.Second
	writeTimeout       = 2 * time.Second
)

// ShmHeader 必须与 C++ 端的 shm_layout.hpp 严格对齐。
type ShmHeader struct {
	MagicNumber uint64
	Version     uint64
	Sequence    uint64
	TimestampMs uint64

	ImgOffset uint64
	ImgSize   uint64
	Width     uint32
	Height    uint32

	JsonOffset uint64
	JsonSize   uint64

	EsdfMap [10000]float32

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

type MetadataMessage struct {
	Type            string   `json:"type"`
	AvailableSeries []string `json:"available_series"`
}

type DataMessage struct {
	Type      string             `json:"type"`
	Timestamp uint64             `json:"timestamp"`
	Series    map[string]float64 `json:"series"`
}

type MapMessage struct {
	Type      string    `json:"type"`
	Timestamp uint64    `json:"timestamp"`
	Width     int       `json:"width"`
	Height    int       `json:"height"`
	Grid      []float32 `json:"grid"`
}

type StatusMessage struct {
	Type             string  `json:"type"`
	Timestamp        int64   `json:"timestamp"`
	BackendConnected bool    `json:"backend_connected"`
	ShmActive        bool    `json:"shm_active"`
	SerialPort       string  `json:"serial_port"`
	NucCpuLoad       float64 `json:"nuc_cpu_load"`
	NucTemp          float64 `json:"nuc_temp"`
}

type HealthResponse struct {
	Status      string `json:"status"`
	ShmAttached bool   `json:"shm_attached"`
	Version     uint64 `json:"version"`
}

type ShmRuntime struct {
	mu     sync.Mutex
	file   *os.File
	data   []byte
	header *ShmHeader
}

func (s *ShmRuntime) Attach(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	f, err := os.OpenFile(path, os.O_RDWR, 0666)
	if err != nil {
		return err
	}

	data, err := syscall.Mmap(int(f.Fd()), 0, shmTotalSize, syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if err != nil {
		_ = f.Close()
		return err
	}

	if len(data) < int(unsafe.Sizeof(ShmHeader{})) {
		_ = syscall.Munmap(data)
		_ = f.Close()
		return errors.New("mapped shm too small for header")
	}

	header := (*ShmHeader)(unsafe.Pointer(&data[0]))
	s.file = f
	s.data = data
	s.header = header
	return nil
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
	s.header = nil
}

func (s *ShmRuntime) IsAttached() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.header != nil
}

func (s *ShmRuntime) Version() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.header == nil {
		return 0
	}
	return s.header.Version
}

func (s *ShmRuntime) HeaderValid() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.header == nil {
		return false
	}
	return s.header.MagicNumber == expectedMagic && s.header.Version == expectedVersion
}

func (s *ShmRuntime) ApplyControl(update ControlUpdate) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.header == nil {
		return
	}

	if update.PidP != nil {
		s.header.PidP = clamp(*update.PidP, 0.0, 10.0)
	}
	if update.PidI != nil {
		s.header.PidI = clamp(*update.PidI, 0.0, 1.0)
	}
	if update.PidD != nil {
		s.header.PidD = clamp(*update.PidD, 0.0, 1.0)
	}
	if update.Exposure != nil {
		s.header.ExposureTime = uint32(clamp(*update.Exposure, 100, 50000))
	}
	if update.FireEnabled != nil {
		if *update.FireEnabled {
			s.header.IsFireEnable = 1
		} else {
			s.header.IsFireEnable = 0
		}
	}
}

func (s *ShmRuntime) ReadSeriesSnapshot() (uint64, map[string]float64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.header == nil || s.data == nil {
		return 0, nil, false
	}

	for i := 0; i < 3; i++ {
		seq1 := s.header.Sequence
		if seq1%2 == 1 {
			runtime.Gosched()
			continue
		}

		jsonOffset := s.header.JsonOffset
		jsonSize := s.header.JsonSize
		timestamp := s.header.TimestampMs
		pidP := s.header.PidP
		pidI := s.header.PidI
		pidD := s.header.PidD
		exposure := s.header.ExposureTime
		fireEnabled := s.header.IsFireEnable

		seq2 := s.header.Sequence
		if seq1 != seq2 || seq2%2 == 1 {
			runtime.Gosched()
			continue
		}

		series := make(map[string]float64, 16)
		if jsonSize > 0 &&
			jsonSize < 65536 &&
			jsonOffset > 0 &&
			jsonOffset+jsonSize <= uint64(len(s.data)) {
			jsonBytes := s.data[jsonOffset : jsonOffset+jsonSize]
			for k, v := range parseSeriesJSON(jsonBytes) {
				series[k] = v
			}
		}

		series["pid_p"] = float64(pidP)
		series["pid_i"] = float64(pidI)
		series["pid_d"] = float64(pidD)
		series["exposure"] = float64(exposure)
		series["fire_enabled"] = float64(fireEnabled)

		return timestamp, series, true
	}

	return 0, nil, false
}

func (s *ShmRuntime) ReadMapSnapshot() (uint64, []float32, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.header == nil {
		return 0, nil, false
	}

	for i := 0; i < 3; i++ {
		seq1 := s.header.Sequence
		if seq1%2 == 1 {
			runtime.Gosched()
			continue
		}

		ts := s.header.TimestampMs
		grid := make([]float32, esdfCells)
		copy(grid, s.header.EsdfMap[:])

		seq2 := s.header.Sequence
		if seq1 != seq2 || seq2%2 == 1 {
			runtime.Gosched()
			continue
		}
		return ts, grid, true
	}
	return 0, nil, false
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

func parseSeriesJSON(raw []byte) map[string]float64 {
	out := make(map[string]float64)
	var payload map[string]interface{}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return out
	}

	for key, value := range payload {
		switch v := value.(type) {
		case float64:
			out[key] = v
		case bool:
			if v {
				out[key] = 1
			} else {
				out[key] = 0
			}
		}
	}
	return out
}

func writeJSON(conn *websocket.Conn, payload interface{}) error {
	conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	return conn.WriteJSON(payload)
}

func sortedSeriesKeys(series map[string]struct{}) []string {
	keys := make([]string, 0, len(series))
	for k := range series {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
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

// 限制 WebSocket 连接只允许来自本机前端，防止局域网恶意页面访问。
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		return origin == "http://localhost:3000" ||
			origin == "http://127.0.0.1:3000" ||
			origin == "http://localhost:5173" ||
			origin == "http://127.0.0.1:5173"
	},
}

func main() {
	shm := &ShmRuntime{}

	var attachErr error
	for i := 0; i < 30; i++ {
		attachErr = shm.Attach(shmPath)
		if attachErr == nil {
			break
		}
		fmt.Println("Waiting for SHM file...", attachErr)
		time.Sleep(1 * time.Second)
	}
	if attachErr != nil {
		log.Fatal("Could not open SHM. Is producer running?")
	}
	defer shm.Close()

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()

		knownSeries := map[string]struct{}{
			"pid_p":        {},
			"pid_i":        {},
			"pid_d":        {},
			"exposure":     {},
			"fire_enabled": {},
		}
		if err := writeJSON(conn, MetadataMessage{
			Type:            "metadata",
			AvailableSeries: sortedSeriesKeys(knownSeries),
		}); err != nil {
			return
		}

		// 接收前端参数更新。
		go func() {
			defer cancel()
			for {
				select {
				case <-ctx.Done():
					return
				default:
					_, message, err := conn.ReadMessage()
					if err != nil {
						return
					}
					var update ControlUpdate
					if err := json.Unmarshal(message, &update); err == nil {
						shm.ApplyControl(update)
					}
				}
			}
		}()

		dataTicker := time.NewTicker(dataPushInterval)
		mapTicker := time.NewTicker(mapPushInterval)
		statusTicker := time.NewTicker(statusPushInterval)
		defer dataTicker.Stop()
		defer mapTicker.Stop()
		defer statusTicker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-dataTicker.C:
				ts, series, ok := shm.ReadSeriesSnapshot()
				if !ok {
					continue
				}

				metadataDirty := false
				for key := range series {
					if _, exists := knownSeries[key]; !exists {
						knownSeries[key] = struct{}{}
						metadataDirty = true
					}
				}
				if metadataDirty {
					if err := writeJSON(conn, MetadataMessage{
						Type:            "metadata",
						AvailableSeries: sortedSeriesKeys(knownSeries),
					}); err != nil {
						return
					}
				}

				if err := writeJSON(conn, DataMessage{
					Type:      "data",
					Timestamp: ts,
					Series:    series,
				}); err != nil {
					return
				}
			case <-mapTicker.C:
				ts, grid, ok := shm.ReadMapSnapshot()
				if !ok {
					continue
				}

				if err := writeJSON(conn, MapMessage{
					Type:      "map",
					Timestamp: ts,
					Width:     esdfWidth,
					Height:    esdfHeight,
					Grid:      grid,
				}); err != nil {
					return
				}
			case <-statusTicker.C:
				if err := writeJSON(conn, StatusMessage{
					Type:             "status",
					Timestamp:        time.Now().UnixMilli(),
					BackendConnected: true,
					ShmActive:        shm.HeaderValid(),
					SerialPort:       "/dev/ttyACM0",
					NucCpuLoad:       readCPULoadPct(),
					NucTemp:          readCPUTempC(),
				}); err != nil {
					return
				}
			}
		}
	})

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(HealthResponse{
			Status:      "ok",
			ShmAttached: shm.IsAttached(),
			Version:     shm.Version(),
		})
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
		shm.ApplyControl(update)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	fmt.Println("PulseScope Backend running on :5000")
	log.Fatal(http.ListenAndServe(":5000", nil))
}
