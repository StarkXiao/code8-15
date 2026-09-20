"""病害档案库：SQLite 存储、巡查导入、去重建档、检索与统计。

数据流：
    巡查清单(JSON) → ingest_survey()  → frames + observations（原始观测，逐帧定位）
                    → run_dedup()     → distresses（去重后的病害档案，观测回填 distress_id）
                    → search/report/compare_surveys（检索与统计）
"""
from __future__ import annotations

import json
import sqlite3
from collections import Counter, defaultdict

from .dedup import cluster_observations
from .geo import RunwayCenterline
from .models import SEVERITY_RANK, normalize_severity, normalize_type

SCHEMA = """
CREATE TABLE IF NOT EXISTS runways (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    width_m     REAL NOT NULL,
    centerline  TEXT NOT NULL          -- JSON [[lat, lon], ...]，从 0 桩号端起
);
CREATE TABLE IF NOT EXISTS surveys (
    id          TEXT PRIMARY KEY,
    runway_id   TEXT NOT NULL REFERENCES runways(id),
    started_at  TEXT NOT NULL,
    operator    TEXT,
    device      TEXT,
    weather     TEXT,
    notes       TEXT
);
CREATE TABLE IF NOT EXISTS frames (
    id          INTEGER PRIMARY KEY,
    survey_id   TEXT NOT NULL REFERENCES surveys(id),
    file_path   TEXT NOT NULL,
    captured_at TEXT,
    lat         REAL,
    lon         REAL,
    heading_deg REAL,
    chainage_m  REAL,                  -- 定位结果：里程
    offset_m    REAL,                  -- 定位结果：横向偏移
    qc_flag     TEXT NOT NULL DEFAULT 'ok',   -- ok / no_gps / off_runway
    UNIQUE (survey_id, file_path)
);
CREATE TABLE IF NOT EXISTS observations (
    id            INTEGER PRIMARY KEY,
    frame_id      INTEGER NOT NULL REFERENCES frames(id),
    distress_type TEXT NOT NULL,
    severity      TEXT NOT NULL,       -- low / medium / high
    chainage_m    REAL NOT NULL,
    offset_m      REAL NOT NULL,
    length_m      REAL,
    width_m       REAL,
    area_m2       REAL,
    confidence    REAL NOT NULL DEFAULT 1.0,
    note          TEXT,
    distress_id   INTEGER REFERENCES distresses(id)   -- 去重后回填
);
CREATE TABLE IF NOT EXISTS distresses (
    id            INTEGER PRIMARY KEY,
    runway_id     TEXT NOT NULL REFERENCES runways(id),
    distress_type TEXT NOT NULL,
    chainage_m    REAL NOT NULL,       -- 代表位置（按置信度加权的质心）
    offset_m      REAL NOT NULL,
    severity      TEXT NOT NULL,       -- 当前严重度（最近一次观测）
    max_severity  TEXT NOT NULL,       -- 历史最高严重度
    first_seen    TEXT NOT NULL,
    last_seen     TEXT NOT NULL,
    obs_count     INTEGER NOT NULL,
    survey_count  INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open',   -- open / monitoring / repaired
    best_frame_id INTEGER REFERENCES frames(id),  -- 最具代表性的一帧影像
    length_m      REAL,
    width_m       REAL,
    area_m2       REAL,
    note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_frames_survey  ON frames(survey_id);
CREATE INDEX IF NOT EXISTS idx_obs_frame      ON observations(frame_id);
CREATE INDEX IF NOT EXISTS idx_obs_chainage   ON observations(chainage_m);
CREATE INDEX IF NOT EXISTS idx_obs_distress   ON observations(distress_id);
CREATE INDEX IF NOT EXISTS idx_dist_chainage  ON distresses(runway_id, chainage_m);
"""

# 帧到中心线的距离超过 半幅宽 + 该余量 时判定为跑出跑道（定位异常）
OFF_RUNWAY_MARGIN_M = 20.0
# 里程允许超出起终点的小余量（端点附近投影）
END_TOLERANCE_M = 10.0

STATUSES = ("open", "monitoring", "repaired")


class Archive:
    """病害档案库。db_path 可为文件路径或 ':memory:'。"""

    def __init__(self, db_path):
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(SCHEMA)

    def close(self):
        self.conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ------------------------------------------------------------------ 跑道
    def add_runway(self, runway_id: str, name: str, centerline, width_m: float) -> dict:
        cl = RunwayCenterline(centerline)  # 先校验，非法中心线直接抛错
        with self.conn:
            self.conn.execute(
                "INSERT OR REPLACE INTO runways (id, name, width_m, centerline) VALUES (?,?,?,?)",
                (runway_id, name, float(width_m),
                 json.dumps([[float(lat), float(lon)] for lat, lon in centerline])),
            )
        return {"id": runway_id, "length_m": cl.length_m}

    def get_runway(self, runway_id: str) -> dict:
        row = self.conn.execute("SELECT * FROM runways WHERE id=?", (runway_id,)).fetchone()
        if row is None:
            raise KeyError(f"跑道不存在: {runway_id}")
        d = dict(row)
        d["centerline"] = json.loads(d["centerline"])
        d["length_m"] = RunwayCenterline(d["centerline"]).length_m
        return d

    # ------------------------------------------------------------------ 导入
    def ingest_survey(self, survey: dict) -> dict:
        """导入一次巡查。幂等：同一 survey.id 重复导入会被整体跳过。"""
        meta = survey["survey"]
        runway = self.get_runway(meta["runway_id"])
        cl = RunwayCenterline(runway["centerline"])
        half_w = runway["width_m"] / 2.0

        if self.conn.execute("SELECT 1 FROM surveys WHERE id=?", (meta["id"],)).fetchone():
            return {"survey_id": meta["id"], "skipped": True, "reason": "该巡查已导入"}

        stats = {"survey_id": meta["id"], "skipped": False, "frames": 0,
                 "frames_bad_qc": 0, "observations": 0, "observations_dropped": 0}
        with self.conn:  # 单事务：中途失败整体回滚，可安全重试
            self.conn.execute(
                "INSERT INTO surveys (id, runway_id, started_at, operator, device, weather, notes)"
                " VALUES (?,?,?,?,?,?,?)",
                (meta["id"], meta["runway_id"], meta.get("started_at", ""),
                 meta.get("operator"), meta.get("device"), meta.get("weather"), meta.get("notes")))
            for f in survey.get("frames", []):
                lat, lon = f.get("lat"), f.get("lon")
                qc, ch, off = "ok", None, None
                if lat is None or lon is None:
                    qc = "no_gps"
                else:
                    pr = cl.project(lat, lon)
                    ch, off = pr.chainage_m, pr.offset_m
                    if (pr.dist_m > half_w + OFF_RUNWAY_MARGIN_M
                            or not (-END_TOLERANCE_M <= ch <= cl.length_m + END_TOLERANCE_M)):
                        qc = "off_runway"
                self.conn.execute(
                    "INSERT OR IGNORE INTO frames"
                    " (survey_id, file_path, captured_at, lat, lon, heading_deg, chainage_m, offset_m, qc_flag)"
                    " VALUES (?,?,?,?,?,?,?,?,?)",
                    (meta["id"], f["file"], f.get("captured_at"), lat, lon,
                     f.get("heading_deg"), ch, off, qc))
                frame_id = self.conn.execute(
                    "SELECT id FROM frames WHERE survey_id=? AND file_path=?",
                    (meta["id"], f["file"])).fetchone()[0]
                stats["frames"] += 1
                if qc != "ok":
                    stats["frames_bad_qc"] += 1
                for d in f.get("distresses", []):
                    pos = self._resolve_position(d, ch, off, cl)
                    if pos is None:
                        stats["observations_dropped"] += 1
                        continue
                    dch, doff = pos
                    self.conn.execute(
                        "INSERT INTO observations"
                        " (frame_id, distress_type, severity, chainage_m, offset_m,"
                        "  length_m, width_m, area_m2, confidence, note)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (frame_id, normalize_type(d["type"]),
                         normalize_severity(d.get("severity", "low")),
                         dch, doff, d.get("length_m"), d.get("width_m"), d.get("area_m2"),
                         float(d.get("confidence", 1.0)), d.get("note")))
                    stats["observations"] += 1
        return stats

    @staticmethod
    def _resolve_position(d: dict, frame_ch, frame_off, cl: RunwayCenterline):
        """病害标注 → (里程, 偏移)。三种位置方式：经纬度 / 相对帧 / 直接桩号。"""
        if "position" in d:
            pr = cl.project(d["position"]["lat"], d["position"]["lon"])
            return pr.chainage_m, pr.offset_m
        if "relative" in d:
            if frame_ch is None:  # 帧本身无定位，无法推算
                return None
            rel = d["relative"]
            return (frame_ch + float(rel.get("forward_m", 0.0)),
                    frame_off + float(rel.get("lateral_m", 0.0)))
        if "chainage_m" in d:
            return float(d["chainage_m"]), float(d.get("offset_m", 0.0))
        return None

    # ------------------------------------------------------------------ 去重
    def run_dedup(self, runway_id: str, eps_chainage: float = 5.0, eps_offset: float = 3.0) -> dict:
        """对该跑道全部有效观测重新聚类，重建病害档案（幂等，可反复执行）。"""
        rows = self.conn.execute(
            """SELECT o.id, o.distress_type, o.severity, o.chainage_m, o.offset_m,
                      o.length_m, o.width_m, o.area_m2, o.confidence,
                      f.id AS frame_id, f.survey_id, f.captured_at
               FROM observations o
               JOIN frames  f ON f.id = o.frame_id
               JOIN surveys s ON s.id = f.survey_id
               WHERE s.runway_id = ? AND f.qc_flag = 'ok'
               ORDER BY o.chainage_m""", (runway_id,)).fetchall()
        obs = [dict(r) for r in rows]
        clusters = cluster_observations(obs, eps_chainage, eps_offset) if obs else []

        merged = 0
        with self.conn:
            self.conn.execute(
                """UPDATE observations SET distress_id = NULL
                   WHERE frame_id IN (SELECT f.id FROM frames f
                                      JOIN surveys s ON s.id = f.survey_id
                                      WHERE s.runway_id = ?)""", (runway_id,))
            self.conn.execute("DELETE FROM distresses WHERE runway_id=?", (runway_id,))
            for members in clusters:
                items = [obs[i] for i in members]
                agg = self._aggregate(items)
                cur = self.conn.execute(
                    """INSERT INTO distresses
                       (runway_id, distress_type, chainage_m, offset_m, severity, max_severity,
                        first_seen, last_seen, obs_count, survey_count, status, best_frame_id,
                        length_m, width_m, area_m2)
                       VALUES (?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?)""",
                    (runway_id, agg["distress_type"], agg["chainage_m"], agg["offset_m"],
                     agg["severity"], agg["max_severity"], agg["first_seen"], agg["last_seen"],
                     agg["obs_count"], agg["survey_count"], agg["best_frame_id"],
                     agg["length_m"], agg["width_m"], agg["area_m2"]))
                distress_id = cur.lastrowid
                self.conn.executemany(
                    "UPDATE observations SET distress_id=? WHERE id=?",
                    [(distress_id, it["id"]) for it in items])
                if len(items) > 1:
                    merged += 1
        return {"runway_id": runway_id, "observations": len(obs),
                "distresses": len(clusters), "merged_clusters": merged,
                "eps_chainage": eps_chainage, "eps_offset": eps_offset}

    @staticmethod
    def _aggregate(items) -> dict:
        """把一簇观测汇总成一份病害档案。"""
        wsum = sum(it["confidence"] for it in items) or 1.0
        latest = max(items, key=lambda it: (it["captured_at"] or "", it["id"]))
        best = max(items, key=lambda it: (SEVERITY_RANK[it["severity"]],
                                          it["captured_at"] or "", it["id"]))

        def _max(key):
            vals = [it[key] for it in items if it[key] is not None]
            return max(vals) if vals else None

        return {
            "distress_type": latest["distress_type"],
            "chainage_m": sum(it["chainage_m"] * it["confidence"] for it in items) / wsum,
            "offset_m": sum(it["offset_m"] * it["confidence"] for it in items) / wsum,
            "severity": latest["severity"],
            "max_severity": max(items, key=lambda it: SEVERITY_RANK[it["severity"]])["severity"],
            "first_seen": min((it["captured_at"] or "") for it in items),
            "last_seen": max((it["captured_at"] or "") for it in items),
            "obs_count": len(items),
            "survey_count": len({it["survey_id"] for it in items}),
            "best_frame_id": best["frame_id"],
            "length_m": _max("length_m"),
            "width_m": _max("width_m"),
            "area_m2": _max("area_m2"),
        }

    # ------------------------------------------------------------------ 检索
    def search(self, runway_id=None, dtype=None, severity=None, ch_from=None, ch_to=None,
               status=None, min_obs=None, first_seen_after=None, last_seen_before=None,
               with_obs=False, limit=None):
        """组合条件检索病害档案，按里程排序。"""
        sql = ["SELECT * FROM distresses WHERE 1=1"]
        args: list = []
        if runway_id:
            sql.append("AND runway_id=?"); args.append(runway_id)
        if dtype:
            sql.append("AND distress_type=?"); args.append(normalize_type(dtype))
        if severity:
            sql.append("AND severity=?"); args.append(normalize_severity(severity))
        if ch_from is not None:
            sql.append("AND chainage_m>=?"); args.append(float(ch_from))
        if ch_to is not None:
            sql.append("AND chainage_m<=?"); args.append(float(ch_to))
        if status:
            sql.append("AND status=?"); args.append(status)
        if min_obs is not None:
            sql.append("AND obs_count>=?"); args.append(int(min_obs))
        if first_seen_after:
            sql.append("AND first_seen>=?"); args.append(first_seen_after)
        if last_seen_before:
            sql.append("AND last_seen<=?"); args.append(last_seen_before)
        sql.append("ORDER BY chainage_m")
        if limit:
            sql.append("LIMIT ?"); args.append(int(limit))
        rows = [dict(r) for r in self.conn.execute(" ".join(sql), args)]
        if with_obs:
            for d in rows:
                d["observations"] = self.observations_of(d["id"])
        return rows

    def observations_of(self, distress_id: int):
        return [dict(r) for r in self.conn.execute(
            """SELECT o.*, f.file_path, f.survey_id, f.captured_at
               FROM observations o JOIN frames f ON f.id = o.frame_id
               WHERE o.distress_id=? ORDER BY f.captured_at""", (distress_id,))]

    def distress_detail(self, distress_id: int) -> dict:
        row = self.conn.execute("SELECT * FROM distresses WHERE id=?", (distress_id,)).fetchone()
        if row is None:
            raise KeyError(f"病害档案不存在: {distress_id}")
        d = dict(row)
        d["observations"] = self.observations_of(distress_id)
        return d

    def list_surveys(self, runway_id=None):
        sql = ["""SELECT s.*,
                    (SELECT COUNT(*) FROM frames f WHERE f.survey_id = s.id) AS frames,
                    (SELECT COUNT(*) FROM observations o JOIN frames f ON f.id = o.frame_id
                      WHERE f.survey_id = s.id) AS observations
                  FROM surveys s"""]
        args: list = []
        if runway_id:
            sql.append("WHERE s.runway_id=?"); args.append(runway_id)
        sql.append("ORDER BY s.started_at")
        return [dict(r) for r in self.conn.execute(" ".join(sql), args)]

    def set_status(self, distress_id: int, status: str, note: str | None = None):
        if status not in STATUSES:
            raise ValueError(f"status 须为 {'/'.join(STATUSES)}")
        with self.conn:
            cur = self.conn.execute(
                "UPDATE distresses SET status=?, note=COALESCE(?, note) WHERE id=?",
                (status, note, distress_id))
        if cur.rowcount == 0:
            raise KeyError(f"病害档案不存在: {distress_id}")

    # ------------------------------------------------------------------ 统计
    def report(self, runway_id: str, bin_m: float = 300.0) -> dict:
        runway = self.get_runway(runway_id)
        rows = self.conn.execute(
            "SELECT * FROM distresses WHERE runway_id=?", (runway_id,)).fetchall()
        n_bins = int(runway["length_m"] // bin_m) + 1
        bins = [0] * n_bins
        for r in rows:
            bins[min(int(r["chainage_m"] // bin_m), n_bins - 1)] += 1
        return {
            "runway": runway,
            "total": len(rows),
            "by_type": dict(Counter(r["distress_type"] for r in rows)),
            "by_severity": dict(Counter(r["severity"] for r in rows)),
            "chainage_bin_m": bin_m,
            "chainage_bins": bins,
            "surveys": self.list_surveys(runway_id),
        }

    def compare_surveys(self, runway_id: str, survey_a: str, survey_b: str) -> dict:
        """对比两次巡查（a 早 b 晚）：新出现 / 严重度升级 / 未再观测到的病害。"""
        rows = self.conn.execute(
            """SELECT d.id, d.distress_type, d.chainage_m, d.offset_m,
                      o.severity, f.survey_id
               FROM distresses d
               JOIN observations o ON o.distress_id = d.id
               JOIN frames f ON f.id = o.frame_id
               WHERE d.runway_id=? AND f.survey_id IN (?,?)""",
            (runway_id, survey_a, survey_b)).fetchall()
        ranks: dict[int, dict[str, int]] = defaultdict(lambda: {survey_a: -1, survey_b: -1})
        info: dict[int, sqlite3.Row] = {}
        for r in rows:
            ranks[r["id"]][r["survey_id"]] = max(ranks[r["id"]][r["survey_id"]],
                                                 SEVERITY_RANK[r["severity"]])
            info[r["id"]] = r
        new, worsened, missing = [], [], []
        for did, s in ranks.items():
            ra, rb = s[survey_a], s[survey_b]
            r = info[did]
            item = {"id": did, "distress_type": r["distress_type"],
                    "chainage_m": r["chainage_m"], "offset_m": r["offset_m"]}
            if ra < 0 and rb >= 0:
                new.append(item)
            elif rb > ra >= 0:
                worsened.append(item)
            elif ra >= 0 and rb < 0:
                missing.append(item)
        by_chainage = lambda it: it["chainage_m"]  # noqa: E731
        return {"survey_a": survey_a, "survey_b": survey_b,
                "new": sorted(new, key=by_chainage),
                "worsened": sorted(worsened, key=by_chainage),
                "not_observed": sorted(missing, key=by_chainage)}
