package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"github.com/gorilla/websocket"
)

// ShmHeader 必须与 C++ 端的 shm_layout.hpp 严格对齐
type ShmHeader struct {
	MagicNumber uint64
	Version     uint64
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
	IsFireEnable bool
}

const shmTotalSize = 10 * 1024 * 1024 // 10MB

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

// FIX [安全]: 限制 WebSocket 连接只允许来自本机前端，防止局域网恶意页面访问
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
	shmPath := "/dev/shm/vision_debug_shm"

	// 等待 SHM 文件被 C++ 创建
	var f *os.File
	var err error
	for i := 0; i < 10; i++ {
		f, err = os.OpenFile(shmPath, os.O_RDWR, 0666)
		if err == nil {
			break
		}
		fmt.Println("Waiting for SHM file...")
		time.Sleep(1 * time.Second)
	}
	if err != nil {
		log.Fatal("Could not open SHM. Is producer running?")
	}
	defer f.Close()

	data, err := syscall.Mmap(int(f.Fd()), 0, shmTotalSize, syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if err != nil {
		log.Fatal(err)
	}

	header := (*ShmHeader)(unsafe.Pointer(&data[0]))

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		// FIX [goroutine泄漏]: 使用 context 管控读 goroutine 生命周期
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		// 接收前端参数更新
		go func() {
			defer cancel() // 读端断开时也触发取消
			for {
				select {
				case <-ctx.Done():
					return
				default:
					_, message, err := conn.ReadMessage()
					if err != nil {
						return
					}
					var update map[string]float32
					if err := json.Unmarshal(message, &update); err == nil {
						// FIX [安全]: 对写入 SHM 的参数进行范围校验，防止异常值导致硬件失控
						if v, ok := update["pid_p"]; ok {
							header.PidP = clamp(v, 0.0, 10.0)
						}
						if v, ok := update["pid_i"]; ok {
							header.PidI = clamp(v, 0.0, 1.0)
						}
						if v, ok := update["pid_d"]; ok {
							header.PidD = clamp(v, 0.0, 1.0)
						}
						if v, ok := update["exposure"]; ok {
							header.ExposureTime = uint32(clamp(v, 100, 50000))
						}
						fmt.Printf("Updated PID from Web: P=%.2f I=%.2f D=%.2f\n", header.PidP, header.PidI, header.PidD)
					}
				}
			}
		}()

		// 主循环：读取 SHM 中的 JSON 数据并转发给前端
		ticker := time.NewTicker(40 * time.Millisecond) // 25Hz
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// FIX [数据竞争]: 读两次并比较，检测 C++ 正在写入时的撕裂值
				jsonOffset1 := header.JsonOffset
				jsonSize1 := header.JsonSize
				runtime.Gosched() // 让出 CPU，给 C++ 完成写入
				jsonOffset2 := header.JsonOffset
				jsonSize2 := header.JsonSize
				if jsonOffset1 != jsonOffset2 || jsonSize1 != jsonSize2 {
					continue // 跳过这帧，下帧再读
				}
				jsonOffset := jsonOffset1
				jsonSize := jsonSize1

				var series map[string]interface{}

				// FIX [越界访问]: 同时验证 jsonOffset + jsonSize 不超出 SHM 映射总大小
				if jsonSize > 0 && jsonSize < 65536 &&
					jsonOffset > 0 &&
					jsonOffset+jsonSize <= uint64(shmTotalSize) {
					jsonBytes := data[jsonOffset : jsonOffset+jsonSize]
					if err := json.Unmarshal(jsonBytes, &series); err != nil {
						series = make(map[string]interface{})
					}
				} else {
					series = make(map[string]interface{})
				}

				// 添加固定字段（PID 参数）作为可视化数据
				series["pid_p"] = header.PidP
				series["pid_i"] = header.PidI
				series["pid_d"] = header.PidD

				payload := map[string]interface{}{
					"type":      "data",
					"timestamp": header.TimestampMs,
					"series":    series,
				}

				// FIX [性能]: 设置写超时，防止慢客户端阻塞 ticker 节奏
				conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
				if err := conn.WriteJSON(payload); err != nil {
					return
				}
			}
		}
	})

	fmt.Println("PulseScope Backend running on :5000")
	log.Fatal(http.ListenAndServe(":5000", nil))
}
