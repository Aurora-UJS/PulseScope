# 控制面参数改为自描述 schema（SHM v3 → v4）

- 日期：2026-07-22
- 分支：`refactor/self-describing-params`（基线 `feat/rerun-integration` @ `788f695`）
- 范围：C++ producer、Go backend、前端控制页、新增 `shm_ctl` 工具与三层测试

> 同一分支上随后还做了**观测面 API 扩展**（结构化 archetype + 三时间轴），
> 记录见 [观测面扩展](2026-07-22-observability-api.md)，用法见
> [观测面 API 指南](observability-api.md)。

---

## 1. 为什么要改

v3 的控制块把参数写成硬编码结构体字段：

```cpp
struct ShmControlBlock {
    uint64_t magic_number, version, heartbeat_ms;
    float    pid_p, pid_i, pid_d;
    uint32_t exposure_time;
    uint8_t  is_fire_enabled;
    uint8_t  reserved[3];
};
```

新增一个可调参数，要同时改动 **4 个文件的 9 个位置**：

| 位置 | 内容 |
|---|---|
| `shm_layout.hpp` | 结构体字段 |
| `vision_monitor.hpp` `syncParams()` | fallback 默认值 |
| `vision_monitor.hpp` `initControlShm()` | 默认值初始化 ← **与上一处重复** |
| `backend/main.go` | `ShmControlBlock` / `ControlUpdate` / `ParamsResponse` 三个结构体 |
| `backend/main.go` `ApplyControl()` | `clamp(v, 0.0, 10.0)` ← **合法范围定义处 1** |
| `components/ParamPanel.tsx` | `{min:0, max:10, step:0.01}` ← **合法范围定义处 2** |
| `type.ts` / `App.tsx` | 字段名、日志格式串 |

两个真正的问题，而不只是"改起来麻烦"：

1. **合法范围有两份副本，无机制保证同步。** Go 的 `clamp` 与前端 slider 的 `min/max`
   当时恰好一致，纯属人工维持。任何一侧单独修改，UI 允许的值与 backend 实际写入的值
   就会分叉，且不会有任何报错。

2. **真值来源放错了地方。** 只有 producer 知道 `exposure_time` 的合法区间——它取决于
   相机型号。但 v3 里 C++ 侧对范围一无所知，范围由离硬件最远的两层（Go、TS）各自声明。

---

## 2. 设计

**核心决策：参数的完整描述由 producer 声明并写入共享内存，backend 与前端退化为哑终端。**

新增参数 = 在 producer 加一行 `declare`，其余两端自动适配，无需改动。

### 2.1 布局

```
ShmControlBlock (6208 B, 映射 8192 B = 2 页)
├─ magic_number   u64  @0
├─ version        u64  @8    = 4
├─ heartbeat_ms   u64  @16   producer 每帧刷新
├─ param_count    u32  @24   发布屏障，见 2.3
├─ reserved0      u32  @28
├─ reserved1    u64[4] @32
└─ params  ParamSlot[64] @64

ParamSlot (96 B)
├─ key       char[32]  @0    NUL 结尾
├─ unit      char[16]  @32   NUL 结尾，可空
├─ type      u8        @48   float=1 / int=2 / bool=3
├─ reserved  u8[7]     @49   补齐，使 value 落在 8 字节边界
├─ value     f64       @56   ← 唯一运行时可变字段
├─ min_value f64       @64
├─ max_value f64       @72
├─ step      f64       @80
└─ default   f64       @88
```

### 2.2 为什么值统一用 `double`

槽位不用 union 承载 float/int/bool，一律存 `double`，`type` 只决定 UI 呈现与写入取整语义。

- `double` 能**精确**表示全部 `int32` 与 `float32`，不引入精度损失
- 消除 Go 与 TS 解析 C union 的复杂度（union 的跨语言表达是错位重灾区）
- 代价是每槽多几十字节——在 8 KB 的控制面里无意义

### 2.3 并发模型

运行期只有两个字段可变：backend 写 `ParamSlot::value`，producer 写 `heartbeat_ms`。
其余字段在注册阶段写入，之后只读。这个不变式让整套机制不需要锁。

**发布屏障。** producer 在 `declare()` 中先写满槽位内容，再递增 `param_count`：

```cpp
std::atomic_thread_fence(std::memory_order_release);
ctrl->param_count = n + 1;
```

backend 以 acquire 语义读取：

```go
atomic.LoadUint32(&s.ctrl.ParamCount)
```

于是「读到的 count 以内，槽位元数据必然已完整写入」。中途 attach 的 backend
只会少看到几个参数，绝不会看到半初始化的槽位。

**值的读写。** `value` 是 8 字节对齐的 `double`。x86-64 与 ARM64 上对齐的 8 字节
load/store 由硬件保证不撕裂，因此单参数读写无需锁。两侧的写法不对称但目的相同：

- C++ 用 `volatile` 读——阻止编译器把跨进程可变的值缓存进寄存器或提出循环
- Go 用 `atomic.LoadUint64` / `StoreUint64`——额外阻止 Go 编译器重排或合并访问

> ⚠️ 「8 字节对齐不撕裂」是**架构假设**，对 x86-64 与 ARM64 成立。移植到其他架构
> （如 32 位 ARM）前必须重新评估。本次**只在 x86-64 上实测**。

**跨参数一致性不保证**（P/I/D 可能被 producer 分两帧读到）。这与 v3 语义一致，
调参场景可容忍。若将来需要同批生效，seqlock 是合适方案，但对当前场景是过度设计。

### 2.4 重启保值

producer 重启时，同名同类型参数沿用上一轮被调过的值，避免每次重编译都要重新调参。
范围可能已变，因此恢复时钳制回新区间；类型变了则丢弃旧值用新默认值。

这条不是锦上添花：RM 调参场景下 producer 频繁重编译重启，丢参数会显著拖慢迭代。

---

## 3. 实现

### C++（真值来源）

```cpp
auto param_p   = monitor.declareFloat("pid_p", 1.0, 0.0, 10.0, 0.01);
auto param_exp = monitor.declareInt("exposure_time", 5000, 100, 50000, 100, "us");
auto param_fire = monitor.declareBool("fire_enabled", true);

// 主循环：句柄直读，无字符串查找
const float p = param_p.getFloat();
```

`ParamHandle` 在 SHM 不可用时仍可读，回落到注册时的默认值——业务代码无需分支。

**移除了 `syncParams()`**（v3 API）。迁移见第 6 节。

### Go（哑终端）

`ApplyControl` 不再持有任何硬编码区间，钳制一律取自槽位声明：

```go
func clampToSlot(v float64, s *ParamSlot) float64 {
    if math.IsNaN(v) { return s.Default }   // NaN 比较恒为 false，会静默穿过区间判断
    if v < s.MinValue { v = s.MinValue }
    if v > s.MaxValue { v = s.MaxValue }
    switch s.Type {
    case paramTypeInt:  v = math.Round(v)   // 须与 C++ std::llround 一致
    case paramTypeBool: /* 归一化为 0/1 */
    }
    return v
}
```

API 变化：

| 端点 | v3 | v4 |
|---|---|---|
| `GET /api/params` | `{pid_p, pid_i, pid_d, exposure, fire_enabled}` | `{version, count, params:[{key,type,value,min,max,step,unit,default}]}` |
| `POST /api/control` | 同上固定字段 | 扁平映射 `{"pid_p":3.5,"fire_enabled":false}`，响应含 `rejected[]` |
| `GET /api/status` | — | 新增 `param_count` |

### 前端

`ParamPanel` 按 `type` 渲染：`bool` → 复选框，`float`/`int` → slider（`min`/`max`/`step`
全部来自 SHM）。显示小数位由 `step` 推导。只下发被改动过的参数，避免覆盖其他客户端
刚写入的值。

### 新增 `shm_ctl` 工具

```
shm_ctl dump [shm_name]
shm_ctl set <key> <value> [shm_name]
```

只依赖 `shm_layout.hpp`，**不链接 Rerun**。既是运维手段（无 backend 时直接调参），
也在测试中充当独立的外部解析者。

---

## 4. 顺带修掉的两个既有缺陷

均为 v3 已存在、与本次改动无关但会被放大的问题：

1. **`ReadParams()` / `ApplyControl()` 不校验 magic/version 就解析。**
   v3 的 `pid_p` 恰好落在 v4 的 `param_count` 位置上——旧 backend 遇上新 producer 会
   把计数当 float 读出，写入更会直接破坏参数表。现已统一走 `validLocked()`。

2. **`attachLocked()` 固定 `Mmap(fd, 0, 4096)`，但只校验文件 ≥ 结构体大小。**
   映射超出文件末尾的部分，访问时触发 **SIGBUS** 而非返回错误。现按映射长度校验。

---

## 5. 测试与证据

三层，各自覆盖不同的失效模式：

### 5.1 编译期布局契约

`shm_layout.hpp` 中 17 条 `static_assert` 锁定全部偏移与尺寸；
`backend/main_test.go` 的 `TestLayoutContract` 断言**完全相同的数字**。
任一侧改动布局，两边同时失败。

### 5.2 C++ 注册行为（`tests/run_param_tests.sh`，8 场景）

`Monitor` 是故意不析构的单例，单进程内无法重置，因此**每个场景一个独立进程**——
「重启后沿用旧值」这条路径测的是真实进程生命周期，不是模拟。

覆盖：全新注册、重启保值、范围收窄后钳制、类型变更丢弃旧值、非法声明拒绝
（空 key / 超长 key / 超长 unit / min>max / 重复 key）、槽位耗尽、SHM 不可用时的
优雅降级、版本被篡改后工具拒绝解析。

### 5.3 全链路端到端（`tests/run_e2e_test.sh`）

**这是唯一能真正验证跨语言布局的测试。** 5.1 的两侧各自断言的是「我这边的偏移等于
我写下的数字」——两边同时写错同一个数字仍会双双通过。端到端让 C++ 写、Go 读，
断言读出的值等于 `declare` 时声明的值，布局错位无处可藏。

实测输出（x86-64，2026-07-22）：

```
--- 1) GET /api/params ---
{"key":"pid_p","type":"float","value":1,"min":0,"max":10,"step":0.01,"unit":"","default":1}
{"key":"exposure_time","type":"int","value":5000,"min":100,"max":50000,"step":100,"unit":"us","default":5000}
{"key":"fire_enabled","type":"bool","value":1,"min":0,"max":1,"step":1,"unit":"","default":1}

--- 2) 钳制用 producer 声明的范围 ---
  pid_p clamped to declared max = 10          (写入 999)
  exposure_time rounded = 12001               (写入 12000.6)

--- 3) 非法条目被拒，合法条目照常写入 ---
  rejected: ["no_such_param: no such param","pid_d: unsupported value type string"]

--- 4) producer 侧读回 ---
  [params] P=10.000 I=0.250 D=0.100 exposure=12001 fire=0

--- 6) 版本守卫 ---
  GET /api/params -> 503 / POST /api/control -> 503
  param_count intact after refused writes (5)
```

### 5.4 复现

```bash
cmake -S . -B build && cmake --build build -j
./tests/run_param_tests.sh build     # C++ 注册行为
(cd backend && go test ./...)        # Go 单元测试 + 布局契约
./tests/run_e2e_test.sh build        # 全链路
pnpm build                           # 前端 tsc + vite
```

**环境**：cmake 3.28.3 / g++ 13.3.0 (C++17) / go 1.22.2 / node v20.20.2 / pnpm 10.26.0
/ Rerun C++ SDK 0.34.1 / Linux x86-64。

---

## 6. 迁移

`syncParams()` 已移除。业务代码改为：

```cpp
// 旧
float p, i, d; uint32_t exp; bool fire;
monitor.syncParams(p, i, d, exp, fire);

// 新：init() 后声明一次
auto param_p = monitor.declareFloat("pid_p", 1.0, 0.0, 10.0, 0.01);
// 主循环
const float p = param_p.getFloat();
```

**部署注意**：v3 与 v4 不互通。producer 与 backend 必须同版本上线。混用时 backend 会
报 `shm_valid=false`、`/api/params` 返回 503——这是设计的拒绝行为，不是故障。
升级前请清理残留控制块：`rm -f /dev/shm/aurora_rm_ctrl`。

---

## 7. 已知限制与未做的事

**限制**（当前设计的边界，非缺陷）：

- 跨参数不保证同批生效（与 v3 同）
- 参数上限 64 个、key ≤ 31 字符、unit ≤ 15 字符；超出会被拒绝并打印到 stderr
- 前端靠 `param_count` 变化触发重拉参数表。**若 producer 重启后参数个数不变但内容变了
  （改名/改范围），前端不会自动感知**，需手动刷新。若成为实际困扰，可用 `reserved0`
  放一个 generation 计数器，producer 每次 init 递增。
- 「8 字节对齐不撕裂」的架构假设仅在 x86-64 实测

**发现但未修**（均为 v3 已存在的问题，不在本次范围，需你定夺）：

- **backend 惰性 attach 后不检测共享内存文件被替换。**
  界面演示时实测到：`rm -f /dev/shm/aurora_rm_ctrl` 后重启 producer，producer 打印
  `7 params declared`，而 backend 仍返回上一轮的 5 个参数。原因是 producer 创建的是
  **新 inode**，backend 的 mmap 仍持有已被删除的旧 inode（文件已 unlink，但 mmap
  保持引用计数，内存内容依然可读）。

  故障表现有误导性：参数表陈旧、`heartbeat_ms` 不再更新 → 界面显示
  `PRODUCER_OFFLINE`，而 producer 其实跑得好好的；此时写入的参数进了孤儿内存，
  producer 永远收不到。

  正常重启不触发（`initControlShm` 用 `O_CREAT` 打开已存在文件，inode 不变），
  只有文件被 unlink 后重建才会。改法：attach 时记下 `st_dev`/`st_ino`，
  在 `/api/status` 轮询里 stat 对比，变化则 munmap 后重新 attach（约 30 行）。

- **Rerun sink 初始化失败会导致 producer 直接退出**（`main()` 里 `init()` 返回 false →
  `return -1`）。这意味着 viewer 连不上时，控制面也一并失去，
  `ParamHandle` 为此设计的「SHM 不可用时回落默认值」优雅降级实际上用不到。
  比赛现场 viewer 没起来就整个 producer 挂掉，风险不小。
  改法是让观测面与控制面的初始化各自返回状态、互不阻断——但这会改变 producer 的
  失败语义，属于行为变更，没有你的确认我不动。

- 多个 producer 实例抢同一块控制 SHM 时会互相清零（v3 即如此，未处理）

**未验证**：

- ARM64（Jetson / 树莓派）上未实测。布局与原子性假设在该平台应当成立，但**没有证据**
- 未做长时间稳定性测试，未做高频写入压力测试
