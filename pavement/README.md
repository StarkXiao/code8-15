# 机场道面病害编目系统

把巡查影像按**跑道里程**精确定位，**自动去重**之后形成可供检索的**病害档案库**。

零外部服务、零原生依赖：Node.js 内置 `http` + WASM SQLite（sql.js）+ 无构建前端（原生 ES Module）。

---

## 它做什么

巡查员一次巡查拍几十上百张照片，系统对每张照片做四件事：

```
巡查影像（JPEG/PNG/WebP，可含 GPS）
   │
   ├─ 1. 定位：GPS 投影到跑道坐标系 → 里程 K1+234.56 + 横距（左/右 m）
   │         无 GPS 时手工填里程（支持 "K1+234.56" 或米数）
   │
   ├─ 2. 字节去重：SHA-256 完全相同 → 拦截，不产生新观测
   │
   ├─ 3. 感知去重：64bit pHash 汉明距离 ≤ 10 且位置 ≤ 3m
   │              → 同一病害的重拍，挂到既有档案
   │
   └─ 4. 档案匹配：同类型且里程 ≤ 2.5m → 复发，并入既有档案
                 否则 → 新病害建档，自动编号 18R-2026-0001
```

- **一个病害 = 一条档案**：编号、类型、严重程度、状态、精确里程、首次/最近发现时间、历次观测照片时间线。
- **修复后复发**：已修复档案上再次发现，状态自动回到「未处理」。
- **可检索**：跑道 / 类型 / 严重程度 / 状态 / 里程区间 / 关键字（编号、板号、描述）。
- **可纠错**：自动匹配判错时，支持人工把两条档案合并；全部变更进审计日志。
- **影像即证据**：原图以内容哈希命名落盘，只增不覆。

## 快速开始

环境：Node.js ≥ 18（用内置 `fetch`；sql.js 为纯 WASM，无需编译工具链）。

```bash
npm install
npm run seed     # 写入演示数据：1 条跑道 + 2 次巡查 + 程序化病害影像
npm start        # http://localhost:4200
```

演示数据覆盖所有判定路径：

| 场景 | 演示内容 |
| --- | --- |
| 新病害建档 | 9-15 巡查发现 6 处病害 |
| 感知近重复/复发 | 9-19 对 K0+420 纵缝等的重拍（字节不同、画面相似） |
| 字节重复 | 同一张接缝照片被重复上传 |
| 修复后复发 | K2+610 网裂标记已修复（再次拍到会自动转未处理） |

生产使用可跳过 seed：启动后在「跑道与定位」页登记跑道，再建巡查任务即可。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动服务（默认 4200，`PORT` 可改） |
| `npm run dev` | 同 `start`（`--watch` 热重载） |
| `npm run seed` | 写入/跳过演示数据（幂等） |
| `npm test` | 26 个测试：几何定位 / pHash / 入库闭环 / HTTP 端到端 |

环境变量：`PORT`（默认 4200）、`PAVEMENT_DATA`（默认 `./data`）、`MAX_UPLOAD_MB`（默认 30）。

## 结构

```
pavement/
├─ server/
│  ├─ index.js          HTTP 服务 + 静态托管（纯 node:http）
│  ├─ db.js             sql.js 封装（防抖原子落盘）+ 表结构
│  ├─ geo.js            WGS84 ↔ 跑道坐标系（里程/横距），haversine
│  ├─ phash.js          感知哈希（32×32 DCT → 64bit），前后端同算法
│  ├─ png.js            PNG 编解码（无依赖，zlib 内置）
│  ├─ exif.js           JPEG EXIF：拍摄时间 + GPS
│  ├─ multipart.js      multipart/form-data 解析
│  ├─ ingest.js         入库核心：三级去重 + 建档/复发
│  ├─ catalog.js        病害类型/严重程度/状态字典
│  ├─ seed.js           演示数据（程序化病害影像）
│  └─ routes/index.js   全部 API
├─ web/                 前端 SPA（原生 ES Module，无构建）
│  └─ app/{pages,components}
├─ test/                node:test
└─ data/                app.db + images/（运行时生成）
```

## API 摘要

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/meta` | 病害字典、去重阈值 |
| `POST /api/runways` / `GET /api/runways/:id` | 跑道登记（阈值点坐标+方位角+长宽） |
| `POST /api/runways/:id/locate` | GPS ↔ 里程换算 |
| `GET/POST /api/inspections` | 巡查任务 |
| `POST /api/inspections/:id/images` | **multipart 影像入库**，返回 `decision` |
| `GET /api/defects` | 档案检索（多条件过滤） |
| `GET /api/defects/:id` | 档案详情：观测时间线 + 审计记录 |
| `PATCH /api/defects/:id` | 改类型/程度/状态/里程/描述 |
| `POST /api/defects/:id/merge` | 人工合并档案 |
| `GET /api/runways/:id/defect-map` | 纵断面病害分布 |
| `GET /api/stats/overview` | 总览统计、去重计数 |

入库响应的 `decision`：`new_defect` / `near_duplicate` / `recurrence` / `exact_duplicate`。

## 几个设计决定

**里程是一等坐标，GPS 只是来源之一。** 跑道用「阈值点 + 方位角 + 长度」登记；GPS 点沿跑道方位投影得到里程与横距。道面调查通常按里程组织，且手机 GPS 有米级误差——同一条裂缝两次定位相差几十厘米，必须投影到里程轴后用距离阈值归并，而不是比对经纬度原值。

**去重分三级，各管一件事。** SHA-256 管"同一个文件"；pHash+空间半径管"同一处病害的重拍"（机位、光照变化但画面相似）；里程+类型管"同处病害跨巡查复发"。单纯字节哈希会把真实重拍当成新照片，单纯图像相似会把相邻两处同款裂缝并掉——所以感知判定**要求位置也邻近**，无类型信息时还要求哈希相似作佐证。

**pHash 在浏览器先算一遍。** 同一份 DCT 算法前后端各有一份（`server/phash.js` 与 `web/app/phash.js` 逐行一致），上传即带哈希；服务端对 PNG 会解码复算，JPEG 走 EXIF。这样即使将来接入的客户端不解码图片，库中哈希口径仍一致。

**同任务重传与跨巡查重传语义不同。** 前者是误操作，只登记、不产生观测；后者（相机缓存、拷贝复用）是一次真实的重复观测，会挂到既有档案上。

**原图以内容哈希命名。** 文件不可变，重复上传不占双份空间；档案里引用的任何历史影像都可回放。

**阈值集中可调。** `HASH_DUP_BITS=10`、`SPATIAL_DUP_M=3`、`ARCHIVE_MATCH_M=2.5` 在 `server/ingest.js` 顶部，并通过 `/api/meta` 暴露给界面。不同机场道面板块尺寸、拍摄习惯不同，建议先用真实照片抽查距离分布再定值。

## 局限 / 后续

- EXIF 仅解析 JPEG（HEIC/视频帧需转码接入）。
- 无鉴权与多用户：适合内网单机或由网关统一鉴权后部署。
- pHash 为 64bit DCT 实现；若后续加入目标检测（框出裂缝 ROI 再哈希），近重复判定会更稳，接口已预留 `confidence`/`detector` 字段。
