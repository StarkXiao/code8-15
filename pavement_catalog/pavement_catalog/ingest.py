"""巡查清单文件（JSON）的读取与校验。

清单格式：
{
  "survey": {"id": "SV-20260310", "runway_id": "RWY03",
             "started_at": "2026-03-10T09:00:00",
             "operator": "...", "device": "...", "weather": "..."},
  "frames": [
    {"file": "images/SV-20260310/000000.jpg",
     "captured_at": "2026-03-10T09:00:00",
     "lat": 31.14, "lon": 121.8, "heading_deg": 60.0,
     "distresses": [
        {"type": "transverse_crack", "severity": "medium",
         "relative": {"forward_m": 3.2, "lateral_m": -5.0},
         "length_m": 2.5, "width_m": 0.008}
     ]}
  ]
}

病害位置三选一：
  position:  {"lat": ..., "lon": ...}   直接给出经纬度
  relative:  {"forward_m": ..., "lateral_m": ...}   相对拍摄帧（沿里程向前为正，横向左正右负）
  chainage_m / offset_m                  直接给出桩号
"""
from __future__ import annotations

import json


def load_survey_file(path) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    errors = validate_survey(data)
    if errors:
        raise ValueError(f"巡查清单 {path} 校验失败:\n" + "\n".join(f"  - {e}" for e in errors))
    return data


def validate_survey(data) -> list[str]:
    errors: list[str] = []
    meta = data.get("survey") if isinstance(data, dict) else None
    if not isinstance(meta, dict):
        return ["缺少 survey 元信息段"]
    for key in ("id", "runway_id", "started_at"):
        if not meta.get(key):
            errors.append(f"survey.{key} 缺失")
    frames = data.get("frames")
    if not isinstance(frames, list) or not frames:
        errors.append("frames 为空或不是列表")
        return errors
    seen = set()
    for i, f in enumerate(frames):
        if not isinstance(f, dict):
            errors.append(f"frames[{i}] 不是对象")
            continue
        if not f.get("file"):
            errors.append(f"frames[{i}].file 缺失")
        elif f["file"] in seen:
            errors.append(f"frames[{i}].file 重复: {f['file']}")
        else:
            seen.add(f["file"])
        if ("lat" in f) != ("lon" in f):
            errors.append(f"frames[{i}] 的 lat/lon 必须成对出现")
        for j, d in enumerate(f.get("distresses", [])):
            if not d.get("type"):
                errors.append(f"frames[{i}].distresses[{j}] 缺少 type")
            if not any(k in d for k in ("position", "relative", "chainage_m")):
                errors.append(
                    f"frames[{i}].distresses[{j}] 缺少位置（position / relative / chainage_m 三选一）")
    return errors
