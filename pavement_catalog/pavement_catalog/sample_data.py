"""生成仿真巡查数据集（用于演示与端到端测试）。

场景：一条 3.6 km 跑道（03/21），车载巡查每 10 m 一帧，RTK GPS（σ≈1 m）。
预埋 55 处"真实"病害作为 ground truth：
  - 45 处初始病害，每次巡查以 85% 概率被拍到，标注位置带抖动；
  - 5 处在第 2 次巡查前新出现，5 处在第 3 次前新出现；
  - 4 处在第 2 次巡查后被修复（不再出现）；
  - 严重度随时间可能升级（低→中→高）；
  - 每次巡查另有 1 条一次性 FOD 记录（单次观测）。
"""
from __future__ import annotations

import json
import math
import random
from datetime import datetime, timedelta
from pathlib import Path

from .geo import LocalFrame, RunwayCenterline

RUNWAY = {
    "id": "RWY03",
    "name": "03/21",
    "width_m": 45.0,
    "start_latlon": (31.140000, 121.800000),
    "heading_deg": 60.0,
    "length_m": 3600.0,
}

SURVEYS = [
    {"id": "SV-20260310", "started_at": "2026-03-10T09:00:00", "weather": "晴",
     "operator": "张工", "device": "车载高清相机+RTK"},
    {"id": "SV-20260515", "started_at": "2026-05-15T09:00:00", "weather": "阴",
     "operator": "张工", "device": "车载高清相机+RTK"},
    {"id": "SV-20260820", "started_at": "2026-08-20T09:00:00", "weather": "晴",
     "operator": "李工", "device": "车载高清相机+RTK"},
]

_TYPE_POOL = [
    ("transverse_crack", 0.20), ("longitudinal_crack", 0.15), ("alligator_crack", 0.10),
    ("raveling", 0.10), ("patch", 0.08), ("rutting", 0.07), ("pothole", 0.06),
    ("joint_seal_failure", 0.06), ("joint_spalling", 0.05), ("bleeding", 0.05),
    ("depression", 0.04), ("paint_wear", 0.04),
]
_SEV_POOL = [("low", 0.50), ("medium", 0.35), ("high", 0.15)]
_SEV_UP = {"low": "medium", "medium": "high"}

GPS_SIGMA_M = 1.0          # GPS 定位噪声
OBS_JITTER_SIGMA_M = 0.5   # 病害标注位置抖动
OBS_PROB = 0.85            # 单次巡查拍到某病害的概率
SEV_UPGRADE_PROB = 0.15    # 相邻两次巡查间严重度升级概率
VEHICLE_OFFSET_M = -2.0    # 巡查车沿中心线左侧 2 m 行驶


def _weighted(rng: random.Random, pool):
    r = rng.random() * sum(w for _, w in pool)
    for v, w in pool:
        r -= w
        if r <= 0:
            return v
    return pool[-1][0]


def _seed_distresses(rng: random.Random):
    def make(i: int, first_survey: int) -> dict:
        dtype = _weighted(rng, _TYPE_POOL)
        d = {
            "uid": f"D{i:03d}",
            "type": dtype,
            "severity": _weighted(rng, _SEV_POOL),
            "chainage_m": rng.uniform(30.0, RUNWAY["length_m"] - 30.0),
            "offset_m": rng.uniform(-18.0, 18.0),
            "first_survey": first_survey,   # 从第几次巡查起存在
            "gone_after": None,             # 第几次巡查后被修复（不再出现）
        }
        if "crack" in dtype:
            d["length_m"] = round(rng.uniform(0.5, 8.0), 2)
            d["width_m"] = round(rng.uniform(0.003, 0.02), 3)
        elif dtype in ("rutting", "depression", "shoving"):
            d["length_m"] = round(rng.uniform(5.0, 40.0), 1)
            d["width_m"] = round(rng.uniform(0.3, 1.5), 2)
        else:
            d["area_m2"] = round(rng.uniform(0.05, 2.0), 2)
        return d

    items = [make(i, 0) for i in range(45)]
    items += [make(45 + i, 1) for i in range(5)]
    items += [make(50 + i, 2) for i in range(5)]
    for d in rng.sample([d for d in items if d["first_survey"] == 0], 4):
        d["gone_after"] = 1
    return items


def generate_demo_dataset(out_dir, seed: int = 20260920, frame_step_m: float = 10.0) -> dict:
    """在 out_dir 下生成 runway.json、survey_XX_*.json 与占位影像文件。"""
    rng = random.Random(seed)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    geo = LocalFrame(*RUNWAY["start_latlon"])
    end = geo.to_latlon(
        math.sin(math.radians(RUNWAY["heading_deg"])) * RUNWAY["length_m"],
        math.cos(math.radians(RUNWAY["heading_deg"])) * RUNWAY["length_m"])
    centerline = [list(RUNWAY["start_latlon"]), list(end)]
    cl = RunwayCenterline(centerline)

    runway_json = {"id": RUNWAY["id"], "name": RUNWAY["name"],
                   "width_m": RUNWAY["width_m"], "centerline": centerline}
    (out / "runway.json").write_text(
        json.dumps(runway_json, ensure_ascii=False, indent=2), "utf-8")

    distresses = _seed_distresses(rng)
    sev_state = {d["uid"]: d["severity"] for d in distresses}

    survey_files = []
    for si, sv in enumerate(SURVEYS):
        # 严重度随时间演化（只升不降）
        if si > 0:
            for d in distresses:
                if si > d["first_survey"] and rng.random() < SEV_UPGRADE_PROB:
                    sev_state[d["uid"]] = _SEV_UP.get(sev_state[d["uid"]], sev_state[d["uid"]])

        t0 = datetime.fromisoformat(sv["started_at"])
        n_frames = int(RUNWAY["length_m"] // frame_step_m) + 1
        img_dir = out / "images" / sv["id"]
        img_dir.mkdir(parents=True, exist_ok=True)

        frames = []
        for k in range(n_frames):
            ch = k * frame_step_m
            veh_off = VEHICLE_OFFSET_M + rng.uniform(-0.3, 0.3)
            lat, lon = cl.locate(ch, veh_off)
            lat += rng.gauss(0.0, GPS_SIGMA_M) / geo.m_per_deg_lat
            lon += rng.gauss(0.0, GPS_SIGMA_M) / geo.m_per_deg_lon
            file_rel = f"images/{sv['id']}/{k:06d}.jpg"
            (img_dir / f"{k:06d}.jpg").touch()
            frames.append({
                "file": file_rel,
                "captured_at": (t0 + timedelta(seconds=2 * k)).isoformat(),
                "lat": round(lat, 8), "lon": round(lon, 8),
                "heading_deg": round((RUNWAY["heading_deg"] + rng.gauss(0.0, 2.0)) % 360.0, 1),
                "distresses": [],
            })

        # 把本次巡查可见的病害挂到最近的一帧上（相对帧位置标注）
        for d in distresses:
            if si < d["first_survey"]:
                continue
            if d["gone_after"] is not None and si > d["gone_after"]:
                continue
            if rng.random() > OBS_PROB:
                continue
            k = min(round(d["chainage_m"] / frame_step_m), n_frames - 1)
            obs = {
                "type": d["type"],
                "severity": sev_state[d["uid"]],
                "relative": {
                    "forward_m": round(d["chainage_m"] - k * frame_step_m
                                       + rng.gauss(0.0, OBS_JITTER_SIGMA_M), 2),
                    "lateral_m": round(d["offset_m"] - VEHICLE_OFFSET_M
                                       + rng.gauss(0.0, OBS_JITTER_SIGMA_M), 2),
                },
            }
            for key in ("length_m", "width_m", "area_m2"):
                if key in d:
                    obs[key] = d[key]
            frames[k]["distresses"].append(obs)

        # 一次性 FOD（单次观测，考验去重对孤立点的处理）
        k = rng.randrange(n_frames)
        frames[k]["distresses"].append({
            "type": "fod", "severity": "low",
            "relative": {"forward_m": round(rng.uniform(-3, 3), 2),
                         "lateral_m": round(rng.uniform(-10, 10), 2)},
            "note": "道面零星杂物，已现场清除"})

        meta = {"id": sv["id"], "runway_id": RUNWAY["id"]}
        meta.update({k2: v for k2, v in sv.items() if k2 != "id"})
        path = out / f"survey_{si + 1:02d}_{sv['id']}.json"
        path.write_text(json.dumps({"survey": meta, "frames": frames}, ensure_ascii=False),
                        "utf-8")
        survey_files.append(str(path))

    return {"runway": {**runway_json, "length_m": cl.length_m},
            "surveys": survey_files,
            "survey_ids": [sv["id"] for sv in SURVEYS],
            "truth_distresses": len(distresses)}
