# PulseScope Topic 契约(数据面统一入口)

观测面的原则:**viewer 不认生产者,只认 topic**。任何进程(C++ demo、aim-rs
回放工具、真机 live)只要按本契约发数据,就得到同一套面板呈现。demo 也不特殊
——它只是契约的一个参考实现。

## 1. 统一入口的机制

- **application_id 固定为 `pulsescope`**(所有生产者一致)。Rerun viewer 的
  blueprint(面板布局)按 application_id 绑定——app-id 统一后,一份布局服务
  所有生产者。覆盖用 `PULSESCOPE_APP_ID`(临时对比实验时才需要)。
- **recording name = 工具名**(如 `replay-video`、`run-video`、demo producer),
  用于在 viewer 左侧列表区分同一 app 下的多次运行。
  - C++ 端:`Monitor::init(app_id)` 默认已是 `pulsescope`;
  - Rust 端:`telemetry::RerunSink::from_env(tool)`,app-id 自动取
    `pulsescope`,`tool` 成为 recording name。
- **timeline**:统一 `frame` 序列(`set_time_sequence("frame", i)`)。跨进程
  对齐时间轴时,frame 语义由生产者自定,同一 recording 内自洽即可。

## 2. Sink 选择(所有生产者一致,按优先级)

| 环境变量 | 行为 |
|---|---|
| `PULSESCOPE_RERUN_CONNECT=rerun+http://<host>:9876/proxy` | 连已运行的 viewer(实时) |
| `PULSESCOPE_RERUN_SAVE=<path>.rrd` | 录制到文件,事后回放 |
| (都不设) | spawn 本机 viewer(实时) |

## 3. Topic 表

| entity path | Rerun 类型 | 语义 |
|---|---|---|
| `camera/image` | `Image`(BGR/RGBA) | 相机原始帧(见 §5 内存告诫) |
| `camera/image/detections` | `LineStrips2D` | 识别器直出的四角点,闭合四边形(不是 AABB) |
| `camera/image/keypoints` | `Points2D` | 角点散点 |
| `telemetry/<name>` | `Scalars` | 任意标量时序;单位放后缀(`_deg`/`_ms`/`_px`) |
| `telemetry/golden_*` / `telemetry/delta_*` | `Scalars` | **回放专属**对拍层:oracle 参考值与残差。真机 live 不产生这些 topic |
| `esdf/map` | `DepthImage` | 低频栅格图 |

新 topic 先加进本表再使用;viewer 端布局(blueprint)依赖路径稳定。

## 4. Blueprint 流程

1. 任一生产者推一次数据,在 viewer 里把面板排好;
2. 菜单 → Save blueprint,存为仓库根的 `pulsescope.rbl`;
3. 之后任何人 `rerun pulsescope.rbl` 启动 viewer,所有 `pulsescope`
   app-id 的 recording(demo / 回放 / 真机)自动套用同一布局。

## 5. 内存告诫(实测踩坑)

未压缩 1440×1080 BGR 每帧 ~4.5MB,620 帧一次回放 ≈ 2.8GB;连推几轮会吃爆
viewer 内存,ingest 通道背压会**永久阻塞发送端**(发送端卡在 flush,机器随之
卡死)。规矩:

- viewer 一律带上限启动:`rerun --memory-limit 6GB`(满了丢最旧数据,不冻结);
- 流式大图的正解是压缩(`EncodedImage`/JPEG,体积 ~1/40)或降采样——列入
  迭代计划,落地后本表的 `camera/image` 升级为 EncodedImage;
- 控制面(SHM/HTTP,见 README)与此无关,不受影响。
