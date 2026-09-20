"""跑道中心线里程定位。

把巡查影像的 WGS-84 经纬度换算为跑道里程（桩号）+ 横向偏移：

1. 以跑道起点为原点建立局部切平面坐标系（x 向东、y 向北，单位米）；
2. 在该平面内做点到中心线折线的投影：
   - 里程 chainage_m：投影点沿中心线距 0 桩号端的累计距离（米）；
   - 偏移 offset_m：影像到投影点的有符号距离，面向里程增大方向左正右负（米）。

单条跑道尺度（<5 km）内切平面近似引入的误差为毫米级，远小于 GPS 噪声，可忽略。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

_WGS84_A = 6378137.0
_WGS84_F = 1 / 298.257223563
_WGS84_E2 = _WGS84_F * (2.0 - _WGS84_F)


def _m_per_deg_lat(lat_deg: float) -> float:
    s = math.sin(math.radians(lat_deg))
    return _WGS84_A * (1 - _WGS84_E2) / (1 - _WGS84_E2 * s * s) ** 1.5 * math.pi / 180.0


def _m_per_deg_lon(lat_deg: float) -> float:
    lat = math.radians(lat_deg)
    s = math.sin(lat)
    return _WGS84_A * math.cos(lat) / math.sqrt(1 - _WGS84_E2 * s * s) * math.pi / 180.0


class LocalFrame:
    """以 (lat0, lon0) 为原点的局部切平面坐标系。"""

    def __init__(self, lat0: float, lon0: float):
        self.lat0 = lat0
        self.lon0 = lon0
        self.m_per_deg_lat = _m_per_deg_lat(lat0)
        self.m_per_deg_lon = _m_per_deg_lon(lat0)

    def to_xy(self, lat: float, lon: float) -> tuple[float, float]:
        return (lon - self.lon0) * self.m_per_deg_lon, (lat - self.lat0) * self.m_per_deg_lat

    def to_latlon(self, x: float, y: float) -> tuple[float, float]:
        return self.lat0 + y / self.m_per_deg_lat, self.lon0 + x / self.m_per_deg_lon


@dataclass
class Projection:
    chainage_m: float  # 里程（桩号），米
    offset_m: float    # 横向偏移，左正右负，米
    dist_m: float      # 到中心线的距离（用于质量控制）
    seg_index: int     # 所在中心线段编号


class RunwayCenterline:
    """跑道中心线折线。points 从 0 桩号端开始：[(lat, lon), ...]"""

    def __init__(self, points):
        pts = [(float(lat), float(lon)) for lat, lon in points]
        if len(pts) < 2:
            raise ValueError("中心线至少需要 2 个控制点")
        self.frame = LocalFrame(*pts[0])
        self.xy = [self.frame.to_xy(lat, lon) for lat, lon in pts]
        self.cum = [0.0]
        for (ax, ay), (bx, by) in zip(self.xy, self.xy[1:]):
            self.cum.append(self.cum[-1] + math.hypot(bx - ax, by - ay))
        self.length_m = self.cum[-1]
        if self.length_m <= 0:
            raise ValueError("中心线长度为零")

    def project(self, lat: float, lon: float) -> Projection:
        """经纬度 → 里程 + 横向偏移。"""
        px, py = self.frame.to_xy(lat, lon)
        best = None
        for i, ((ax, ay), (bx, by)) in enumerate(zip(self.xy, self.xy[1:])):
            ux, uy = bx - ax, by - ay
            seg_len = self.cum[i + 1] - self.cum[i]
            t = ((px - ax) * ux + (py - ay) * uy) / (seg_len * seg_len)
            t = max(0.0, min(1.0, t))
            qx, qy = ax + t * ux, ay + t * uy
            dx, dy = px - qx, py - qy
            dist = math.hypot(dx, dy)
            if best is None or dist < best[0]:
                best = (dist, i, t, seg_len, ux / seg_len, uy / seg_len, dx, dy)
        dist, i, t, seg_len, ux, uy, dx, dy = best
        chainage = self.cum[i] + t * seg_len
        # 左法向 (-uy, ux)：点在其上投影为正 → 位于中心线左侧
        offset = dx * (-uy) + dy * ux
        return Projection(chainage_m=chainage, offset_m=offset, dist_m=dist, seg_index=i)

    def locate(self, chainage_m: float, offset_m: float = 0.0) -> tuple[float, float]:
        """里程 + 横向偏移 → (lat, lon)。project 的逆运算。"""
        s = max(0.0, min(self.length_m, chainage_m))
        i = self._segment_at(s)
        (ax, ay), (bx, by) = self.xy[i], self.xy[i + 1]
        seg_len = self.cum[i + 1] - self.cum[i]
        t = (s - self.cum[i]) / seg_len
        ux, uy = (bx - ax) / seg_len, (by - ay) / seg_len
        qx, qy = ax + t * (bx - ax), ay + t * (by - ay)
        return self.frame.to_latlon(qx - uy * offset_m, qy + ux * offset_m)

    def heading_at(self, chainage_m: float) -> float:
        """里程处中心线方位角（真北起顺时针，度）。"""
        s = max(0.0, min(self.length_m, chainage_m))
        i = self._segment_at(s)
        (ax, ay), (bx, by) = self.xy[i], self.xy[i + 1]
        return math.degrees(math.atan2(bx - ax, by - ay)) % 360.0

    def _segment_at(self, s: float) -> int:
        i = 0
        while i < len(self.cum) - 2 and self.cum[i + 1] < s:
            i += 1
        return i
