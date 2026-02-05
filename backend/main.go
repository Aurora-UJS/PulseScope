package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
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

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
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

	size := 10 * 1024 * 1024
	data, err := syscall.Mmap(int(f.Fd()), 0, size, syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
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

		// 接收前端参数更新
		go func() {
			for {
				_, message, err := conn.ReadMessage()
				if err != nil {
					break
				}
				var update map[string]float32
				if err := json.Unmarshal(message, &update); err == nil {
					if v, ok := update["pid_p"]; ok {
						header.PidP = v
					}
					if v, ok := update["pid_i"]; ok {
						header.PidI = v
					}
					if v, ok := update["pid_d"]; ok {
						header.PidD = v
					}
					fmt.Printf("Updated PID from Web: P=%.2f I=%.2f D=%.2f\n", header.PidP, header.PidI, header.PidD)
				}
			}
		}()

		// 主循环：读取 SHM 中的 JSON 数据并转发给前端
		ticker := time.NewTicker(40 * time.Millisecond) // 25Hz
		defer ticker.Stop()

		for range ticker.C {
			// 读取算法写入的 JSON 数据
			jsonOffset := header.JsonOffset
			jsonSize := header.JsonSize

			var series map[string]interface{}

			if jsonSize > 0 && jsonSize < 10000 && jsonOffset > 0 {
				// 从 SHM 读取 JSON 字符串
				jsonBytes := data[jsonOffset : jsonOffset+jsonSize]
				if err := json.Unmarshal(jsonBytes, &series); err != nil {
					// JSON 解析失败，使用空 series
					series = make(map[string]interface{})
				}
			} else {
				series = make(map[string]interface{})
			}

			// 添加固定字段（PID 参数）作为可视化数据
			series["pid_p"] = header.PidP
			series["pid_i"] = header.PidI
			series["pid_d"] = header.PidD

			// 发送前端期望的格式
			payload := map[string]interface{}{
				"type":      "data",
				"timestamp": header.TimestampMs,
				"series":    series,
			}

			if err := conn.WriteJSON(payload); err != nil {
				break
			}
		}
	})

	fmt.Println("PulseScope Backend running on :5000")
	log.Fatal(http.ListenAndServe(":5000", nil))
}
