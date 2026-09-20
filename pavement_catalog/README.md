# 机场道面病害编目系统

把巡查影像按**跑道里程**精确定位，**自动去重**后形成**可供检索**的病害档案库。

```
巡查清单(JSON)                跑道中心线
     │                            │
     ▼                            ▼
 帧级 GPS 定位 ──────────► 里程(桩号) + 横向偏移
     │                            │
     ▼                            ▼
 原始观测 observations ──► 去重聚类 ──► 病害档案 distresses
                                            │
                              检索 / 统计 / 演化对比 / 影像回溯
```

纯 Python 标准库实现（3.9+），零第三方依赖，数据库用 SQLite，单文件交付。

## 快速开始

```bash
cd pavement_catalog
python3 demo.py        # 端到端演示：仿真数据 → 建库 → 导入 → 去重 → 检索/统计/对比
python3 -m unittest discover -s tests   # 22 个单元/集成测试
```

`demo.py` 会生成 `demo_data/`（3 份巡查清单 + 占位影像）和 `demo_catalog.db`，
并依次演示：幂等导入、去重建档、统计报告、组合检索、两次巡查的演化对比、单份档案的观测历史与影像回溯。

## 三个核心问题怎么解决

### 1. 里程定位（`geo.py`）

以跑道起点为原点建局部切平面坐标系，把帧的 GPS 坐标投影到跑道中心线折线上：

- **里程 chainage_m**：投影点沿中心线距 0 桩号端的累计距离（米），显示为 `K1+234.5` 桩号；
- **横向偏移 offset_m**：到中心线的有符号距离，面向里程增大方向**左正右负**；
- **质量控制**：距中心线超过「半幅宽 + 20 m」或投影落到端点外的帧标记 `off_runway`，缺 GPS 的帧标记 `no_gps`，异常帧不参与去重。

单条跑道尺度内切平面近似误差为毫米级，远小于 GPS 噪声。

### 2. 自动去重（`dedup.py`）

同一病害在多次巡查中会被反复拍到，位置因 GPS 噪声略有漂移。判据：

> **同一病害类型** 且 **|Δ里程| ≤ 5 m** 且 **|Δ横向偏移| ≤ 3 m**

里程排序后滑动窗口找邻近对，用并查集连通（链式邻近也能归并）。每簇合并为一份档案：

- 代表位置 = 按置信度加权的质心；
- 当前严重度 = 最近一次观测；历史最高严重度单独保留；
- 保留**全部**观测历史（时间、巡查、影像路径），支持演化分析与影像回溯；
- 容差可调：`dedup --eps-chainage 8 --eps-offset 4`（普通 GPS 调大，RTK 调小）。

去重是**全量重建**且幂等的：新巡查导入后再跑一次 `dedup` 即可，重复执行结果一致。

### 3. 可检索档案库（`archive.py`，SQLite）

五张表：`runways` / `surveys` / `frames` / `observations` / `distresses`。
支持按里程区间、病害类型、严重度、状态、发现时间、观测次数组合检索；
另有统计报告（类型/严重度分布、沿里程直方图）和两次巡查的演化对比（新出现 / 严重度升级 / 未再观测到）。

## 数据格式

### 登记跑道

```bash
python3 -m pavement_catalog --db catalog.db init-runway \
  --runway RWY03 --name 03/21 --width 45 \
  --centerline "31.140000,121.800000;31.156235,121.832692"
```

中心线从 **0 桩号端** 起给出，支持折线（多个控制点）。

### 巡查清单（JSON）

```json
{
  "survey": {"id": "SV-20260310", "runway_id": "RWY03",
             "started_at": "2026-03-10T09:00:00",
             "operator": "张工", "device": "车载高清相机+RTK", "weather": "晴"},
  "frames": [
    {"file": "images/SV-20260310/000000.jpg",
     "captured_at": "2026-03-10T09:00:00",
     "lat": 31.14001, "lon": 121.80002, "heading_deg": 60.0,
     "distresses": [
       {"type": "transverse_crack", "severity": "medium",
        "relative": {"forward_m": 3.2, "lateral_m": -5.0},
        "length_m": 2.5, "width_m": 0.008}
     ]}
  ]
}
```

病害位置三选一：

| 方式 | 字段 | 说明 |
| --- | --- | --- |
| 经纬度 | `position: {lat, lon}` | 直接给出病害 GPS 位置 |
| 相对帧 | `relative: {forward_m, lateral_m}` | 相对拍摄帧，沿里程向前为正、横向左正右负 |
| 桩号 | `chainage_m` / `offset_m` | 直接给出里程与横向偏移 |

`type` 接受代码或中文名（如 `pothole` / `坑槽`），`severity` 接受 `low/medium/high` 或 `低/中/高`。
导入幂等：同一 `survey.id` 重复导入自动跳过；单事务写入，中途失败可安全重试。

## CLI 一览

```bash
python3 -m pavement_catalog [--db catalog.db] <子命令>
```

| 子命令 | 作用 |
| --- | --- |
| `init-runway` | 登记跑道中心线 |
| `ingest <json...>` | 导入巡查清单（幂等） |
| `dedup --runway RWY03 [--eps-chainage 5] [--eps-offset 3]` | 去重，重建病害档案 |
| `search [--type 坑槽] [--severity high] [--from 1000 --to 1500] [--status open] [--min-obs 2] [--obs]` | 组合检索 |
| `show --id 12` | 档案详情 + 观测历史 + 影像回溯 |
| `report --runway RWY03` | 统计报告（类型/严重度/沿里程分布） |
| `compare --runway RWY03 SV-A SV-B` | 演化对比：新出现 / 升级 / 未再观测 |
| `surveys` | 巡查记录列表 |
| `set-status --id 12 --status repaired` | 更新处置状态（open/monitoring/repaired） |
| `types` | 病害类型编码表 |

## 病害类型

裂缝类（纵向/横向/斜向/网状/反射/块状）、变形类（车辙/沉陷/推移拥包）、
表面缺陷（坑槽/松散脱皮/泛油/集料磨光/补丁）、接缝类（接缝碎裂/填缝料失效/错台）、
其他（标志线磨损/外来物）。分类参考 MH/T 5024 与 ASTM D5340 简化，
在 `pavement_catalog/models.py` 中一处定义，可按本场道面类型增删。

## 目录结构

```
pavement_catalog/
├─ pavement_catalog/
│  ├─ geo.py          里程定位：GPS → 桩号 + 横向偏移
│  ├─ dedup.py        去重：滑动窗口 + 并查集聚类
│  ├─ archive.py      SQLite 档案库：导入 / 建档 / 检索 / 统计 / 对比
│  ├─ ingest.py       巡查清单读取与校验
│  ├─ models.py       病害分类、严重度、桩号格式
│  ├─ sample_data.py  仿真巡查数据生成器
│  └─ cli.py          命令行界面
├─ tests/             22 个单元 + 端到端测试
└─ demo.py            一键演示
```

## 设计说明与边界

- **幂等优先**：导入按 `survey.id` 去重、去重全量重建，任何一步都可安全重跑；
- **观测与档案分离**：原始观测永不修改，档案只是观测的聚类视图，重算不丢信息；
- **真实系统接入点**：帧定位目前用清单里的 GPS；生产环境可换 EXIF/POS 数据、
  相机标定参数把影像内 bbox 反投影到道面平面（`_resolve_position` 已预留三种位置方式）；
  病害识别可接检测模型，清单格式不变；
- **局限**：单跑道直中心线场景优化；联络道/滑行道可各建一条"跑道"记录；
  去重为空间+类型约束，不处理病害类型随时间被改判的情况（如裂缝发展成坑槽会建两份档案，靠人工 `set-status` 关联）。
