package main

// 观测面 SHM 读取（/aurora_rm_obs，v4）：
//   - seqlock 一致性读（sequence 偶 + 二次一致）
//   - RGBA 帧 → JPEG（MJPEG 流端点）
//   - 标量快照 JSON → 时序 ring buffer（曲线端点）
//
// 布局与 include/shm_layout.hpp 的 ObsShmHeader 严格对齐（pack(8)）。

import (
	"bytes"
	"encoding/json"
	"image"
	"image/jpeg"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const (
	obsShmPath      = "/dev/shm/aurora_rm_obs"
	obsShmSize      = 10 * 1024 * 1024
	obsMagic        = 0x564953494F4E3031 // "VISION01"
	obsVersion      = 4
	obsHistoryMax   = 600 // 每条曲线保留点数
	obsJpegQuality  = 70
	obsStreamMinGap = 33 * time.Millisecond // ~30fps 上限
)

// ObsShmHeader 与 C++ ObsShmHeader 逐字段对齐。
type ObsShmHeader struct {
	MagicNumber uint64
	Version     uint64
	Sequence    uint64
	TimestampMs uint64
	FrameIndex  uint64
	ImgOffset   uint64
	ImgSize     uint64
	Width       uint32
	Height      uint32
	JsonOffset  uint64
	JsonSize    uint64
}

// ObsShm 惰性挂载观测块；backend 可先于 producer 启动。
type ObsShm struct {
	mu       sync.Mutex
	file     *os.File
	data     []byte
	header   *ObsShmHeader
	attached bool

	// 曲线历史：time 轴 + 各 key 环形序列
	histMu     sync.Mutex
	histTime   []float64 // 相对本进程启动的秒数
	histSeries map[string][]*float64
	histCursor int
	lastFrame  uint64
	haveFrame  bool

	// JPEG 缓存（最新一帧）
	jpegMu    sync.Mutex
	jpegSeq   uint64
	jpegBytes []byte
	jpegAt    time.Time
}

func NewObsShm() *ObsShm {
	return &ObsShm{histSeries: make(map[string][]*float64)}
}

func (o *ObsShm) attachLocked() error {
	if o.attached {
		return nil
	}
	f, err := os.OpenFile(obsShmPath, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return err
	}
	if info.Size() < obsShmSize {
		_ = f.Close()
		return errShortShm
	}
	data, err := syscall.Mmap(int(f.Fd()), 0, obsShmSize, syscall.PROT_READ, syscall.MAP_SHARED)
	if err != nil {
		_ = f.Close()
		return err
	}
	o.file = f
	o.data = data
	o.header = (*ObsShmHeader)(unsafe.Pointer(&data[0]))
	if atomic.LoadUint64(&o.header.MagicNumber) != obsMagic || atomic.LoadUint64(&o.header.Version) != obsVersion {
		_ = syscall.Munmap(data)
		_ = f.Close()
		o.file = nil
		o.data = nil
		o.header = nil
		return os.ErrInvalid
	}
	o.attached = true
	return nil
}

var errShortShm = os.ErrInvalid

// readConsistent 返回一致快照（frame, img 区间, json 区间）。
func (o *ObsShm) readConsistent() (frame uint64, ts uint64, img []byte, w, h uint32, jsonRaw []byte, ok bool) {
	hdr := o.header
	for i := 0; i < 4; i++ {
		s1 := atomic.LoadUint64(&hdr.Sequence)
		if s1&1 != 0 {
			continue
		}
		fi := atomic.LoadUint64(&hdr.FrameIndex)
		tsv := atomic.LoadUint64(&hdr.TimestampMs)
		iof := atomic.LoadUint64(&hdr.ImgOffset)
		isz := atomic.LoadUint64(&hdr.ImgSize)
		wv := atomic.LoadUint32(&hdr.Width)
		hv := atomic.LoadUint32(&hdr.Height)
		jof := atomic.LoadUint64(&hdr.JsonOffset)
		jsz := atomic.LoadUint64(&hdr.JsonSize)
		if isz > 0 && iof+isz <= uint64(len(o.data)) && wv > 0 && hv > 0 && wv*hv*4 == uint32(isz) {
			img = append([]byte(nil), o.data[iof:iof+isz]...)
		}
		if jsz > 0 && jof+jsz <= uint64(len(o.data)) {
			jsonRaw = append([]byte(nil), o.data[jof:jof+jsz]...)
		}
		// The writer may have started after the offsets were read. Validate only
		// after copying both payloads so a returned snapshot cannot be torn.
		if atomic.LoadUint64(&hdr.Sequence) != s1 {
			img = nil
			jsonRaw = nil
			continue
		}
		return fi, tsv, img, wv, hv, jsonRaw, true
	}
	return 0, 0, nil, 0, 0, nil, false
}

// poll 每帧调用：更新历史 + JPEG 缓存。
func (o *ObsShm) poll() {
	o.mu.Lock()
	if !o.attached {
		_ = o.attachLocked()
		if !o.attached {
			o.mu.Unlock()
			return
		}
	}
	frame, _, img, w, h, jsonRaw, ok := o.readConsistent()
	o.mu.Unlock()
	if !ok {
		return
	}

	if len(jsonRaw) > 0 {
		var snap map[string]float64
		if err := json.Unmarshal(jsonRaw, &snap); err == nil {
			o.pushHistory(frame, snap)
		}
	}
	if len(img) > 0 {
		o.updateJpeg(frame, img, int(w), int(h))
	}
}

func (o *ObsShm) pushHistory(frame uint64, snap map[string]float64) {
	o.histMu.Lock()
	defer o.histMu.Unlock()

	// poll runs faster than some producers. Do not turn one producer frame into
	// several identical time samples just because the backend observed it twice.
	if o.haveFrame && frame == o.lastFrame {
		return
	}
	o.lastFrame = frame
	o.haveFrame = true

	now := time.Since(processStart).Seconds()
	previousLength := len(o.histTime)
	if len(o.histTime) < obsHistoryMax {
		o.histTime = append(o.histTime, now)
	} else {
		o.histTime[o.histCursor] = now
	}

	// First write a gap at this timestamp for every known signal. Values present
	// in the snapshot replace that gap below, keeping all series time-aligned.
	for key, values := range o.histSeries {
		if previousLength < obsHistoryMax {
			o.histSeries[key] = append(values, nil)
		} else {
			values[o.histCursor] = nil
		}
	}

	for k, v := range snap {
		vv := v
		series, seen := o.histSeries[k]
		if !seen {
			// A late-appearing key needs gaps for every earlier timestamp.
			o.histSeries[k] = make([]*float64, previousLength, obsHistoryMax)
			series = o.histSeries[k]
		}
		if previousLength < obsHistoryMax {
			o.histSeries[k] = append(series, &vv)
		} else {
			series[o.histCursor] = &vv
		}
	}
	o.histCursor = (o.histCursor + 1) % obsHistoryMax
}

// seriesJSON 返回 {time:[...], <key>:[...]}（awakening /data 同构）。
func (o *ObsShm) seriesJSON(maxPoints int) map[string]interface{} {
	if maxPoints <= 0 || maxPoints > obsHistoryMax {
		maxPoints = obsHistoryMax
	}
	o.histMu.Lock()
	defer o.histMu.Unlock()

	n := len(o.histTime)
	if n > maxPoints {
		n = maxPoints
	}
	out := map[string]interface{}{}
	if o.histCursor == 0 || len(o.histTime) < obsHistoryMax {
		start := len(o.histTime) - n
		if start < 0 {
			start = 0
		}
		out["time"] = append([]float64(nil), o.histTime[start:]...)
		for k, series := range o.histSeries {
			vals := make([]*float64, 0, n)
			vals = append(vals, series[start:]...)
			out[k] = vals
		}
		return out
	}
	// 环形拼接
	idx := func(i int) int { return (o.histCursor + i) % obsHistoryMax }
	t := make([]float64, n)
	for i := 0; i < n; i++ {
		t[i] = o.histTime[idx(len(o.histTime)-n+i)]
	}
	out["time"] = t
	for k, series := range o.histSeries {
		vals := make([]*float64, n)
		for i := 0; i < n; i++ {
			vals[i] = series[idx(len(series)-n+i)]
		}
		out[k] = vals
	}
	return out
}

func (o *ObsShm) updateJpeg(frame uint64, rgba []byte, w, h int) {
	o.jpegMu.Lock()
	defer o.jpegMu.Unlock()
	if frame == o.jpegSeq {
		return
	}
	img := &image.RGBA{Pix: rgba, Stride: 4 * w, Rect: image.Rect(0, 0, w, h)}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: obsJpegQuality}); err != nil {
		return
	}
	o.jpegSeq = frame
	o.jpegBytes = buf.Bytes()
	o.jpegAt = time.Now()
}

func (o *ObsShm) latestJpeg() (uint64, []byte, time.Time) {
	o.jpegMu.Lock()
	defer o.jpegMu.Unlock()
	return o.jpegSeq, o.jpegBytes, o.jpegAt
}

var processStart = time.Now()
