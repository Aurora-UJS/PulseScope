package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/gorilla/websocket"
)

// 常量定义，需与 C++ shm_layout.hpp 保持一致
const (
	SHM_NAME = "/dev/shm/pulsescope_shm"
	// 严格匹配 C++ ShmLayout 结构
	// magic(4) + version(4) = 8
	IMAGE_OFFSET = 8
	// seq(8) + size(4) + w(4) + h(4) + data(2MB) + padding(4) = 2,097,176
	TELEMETRY_OFFSET = IMAGE_OFFSET + 2097176
)

type Bridge struct {
	shm     []byte
	clients map[*websocket.Conn]bool
	mu      sync.Mutex
}

func (b *Bridge) addClient(c *websocket.Conn) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.clients[c] = true
}

func (b *Bridge) removeClient(c *websocket.Conn) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.clients, c)
}

func (b *Bridge) broadcast(msg interface{}) {
	b.mu.Lock()
	defer b.mu.Unlock()
	data, _ := json.Marshal(msg)
	for c := range b.clients {
		c.WriteMessage(websocket.TextMessage, data)
	}
}

type Message struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload"`
	Seq     uint64      `json:"seq,omitempty"`
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func main() {
	bridge := &Bridge{
		clients: make(map[*websocket.Conn]bool),
	}

	// 1. 映射共享内存
	f, err := os.OpenFile(SHM_NAME, os.O_RDWR, 0666)
	if err != nil {
		log.Printf("Warning: Could not open SHM %s: %v. Waiting for Producer...", SHM_NAME, err)
	} else {
		defer f.Close()
		info, _ := f.Stat()
		data, err := syscall.Mmap(int(f.Fd()), 0, int(info.Size()), syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
		if err != nil {
			log.Fatalf("Mmap failed: %v", err)
		}
		bridge.shm = data
		defer syscall.Munmap(data)
	}

	// 启动广播协程
	go bridge.runBroadcaster()

	// 2. 路由设置
	http.HandleFunc("/video", bridge.handleMJPEG)
	http.HandleFunc("/ws", bridge.handleWS)
	http.HandleFunc("/debug/seq", bridge.handleDebugSeq)

	// 挂载真正的 Vue 前端静态文件
	fs := http.FileServer(http.Dir("../frontend/dist"))
	http.Handle("/", fs)

	fmt.Println("PulseScope Bridge started at :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func (b *Bridge) handleDebugSeq(w http.ResponseWriter, r *http.Request) {
	if b.shm == nil {
		fmt.Fprintf(w, "OFFLINE")
		return
	}
	seq := *(*uint64)(unsafe.Pointer(&b.shm[IMAGE_OFFSET]))
	fmt.Fprintf(w, "%d", seq)
}

func (b *Bridge) handleMJPEG(w http.ResponseWriter, r *http.Request) {
	if b.shm == nil {
		http.Error(w, "Shared memory not initialized", http.StatusInternalServerError)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming not supported", http.StatusInternalServerError)
		return
	}

	// 标准 MJPEG 头部
	w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary=boundary")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Pragma", "no-cache")

	lastSeq := uint64(0)
	ticker := time.NewTicker(33 * time.Millisecond)
	defer ticker.Stop()

	// 写入第一个边界
	fmt.Fprintf(w, "--boundary\r\n")

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			seq := *(*uint64)(unsafe.Pointer(&b.shm[IMAGE_OFFSET]))
			if seq != lastSeq {
				lastSeq = seq
				size := *(*uint32)(unsafe.Pointer(&b.shm[IMAGE_OFFSET+8]))
				if size > 0 && size < 1024*1024*2 {
					data := b.shm[IMAGE_OFFSET+20 : IMAGE_OFFSET+20+int(size)]

					// 严格的 MJPEG 帧格式：必须以 \r\n 结尾
					header := fmt.Sprintf("Content-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n", len(data))
					w.Write([]byte(header))
					w.Write(data)
					w.Write([]byte("\r\n--boundary\r\n"))
					flusher.Flush()
				}
			}
		}
	}
}

func (b *Bridge) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	b.addClient(conn)
	defer func() {
		b.removeClient(conn)
		conn.Close()
	}()

	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			break
		}
	}
}

func (b *Bridge) runBroadcaster() {
	lastTelSeq := uint64(0)
	lastLogSeq := uint64(0)
	ticker := time.NewTicker(33 * time.Millisecond)
	defer ticker.Stop()

	for range ticker.C {
		if b.shm == nil {
			continue
		}

		// 1. Telemetry
		telSeq := *(*uint64)(unsafe.Pointer(&b.shm[TELEMETRY_OFFSET]))
		if telSeq != lastTelSeq {
			lastTelSeq = telSeq
			size := *(*uint32)(unsafe.Pointer(&b.shm[TELEMETRY_OFFSET+8]))
			jsonBytes := b.shm[TELEMETRY_OFFSET+12 : TELEMETRY_OFFSET+12+int(size)]
			var payload interface{}
			json.Unmarshal(jsonBytes, &payload)
			b.broadcast(Message{Type: "telemetry", Payload: payload, Seq: telSeq})
		}

		// 2. Serial Logs (Mirror)
		// telemetry 布局: seq(8) + size(4) + data(64KB) + padding(4) = 65552
		serialOffset := TELEMETRY_OFFSET + 65552
		logSeq := *(*uint64)(unsafe.Pointer(&b.shm[serialOffset]))
		if logSeq != lastLogSeq {
			lastLogSeq = logSeq
			size := *(*uint32)(unsafe.Pointer(&b.shm[serialOffset+8]))
			data := b.shm[serialOffset+12 : serialOffset+12+int(size)]
			b.broadcast(Message{Type: "log", Payload: string(data)})
		}
	}
}
