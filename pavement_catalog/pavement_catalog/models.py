"""病害分类、严重度与展示格式定义。

病害类型参考 MH/T 5024《民用机场道面评价管理技术规范》与
ASTM D5340（PCI 体系）做了简化，覆盖沥青/水泥道面常见病害。
"""
from __future__ import annotations

DISTRESS_TYPES = {
    # 裂缝类
    "longitudinal_crack": "纵向裂缝",
    "transverse_crack": "横向裂缝",
    "diagonal_crack": "斜向裂缝",
    "alligator_crack": "网状裂缝",
    "reflective_crack": "反射裂缝",
    "block_crack": "块状裂缝",
    # 变形类
    "rutting": "车辙",
    "depression": "沉陷",
    "shoving": "推移拥包",
    # 表面缺陷
    "pothole": "坑槽",
    "raveling": "松散脱皮",
    "bleeding": "泛油",
    "polishing": "集料磨光",
    "patch": "补丁",
    # 接缝类（水泥道面）
    "joint_spalling": "接缝碎裂",
    "joint_seal_failure": "填缝料失效",
    "slab_faulting": "错台",
    # 其他
    "paint_wear": "标志线磨损",
    "fod": "外来物",
}

SEVERITIES = {"low": "低", "medium": "中", "high": "高"}
SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2}

# 中文名/别名 → 标准代码，导入时归一化
_TYPE_ALIASES = {}
for _code, _zh in DISTRESS_TYPES.items():
    _TYPE_ALIASES[_code] = _code
    _TYPE_ALIASES[_zh] = _code
_TYPE_ALIASES.update({
    "龟裂": "alligator_crack",
    "网裂": "alligator_crack",
    "坑洞": "pothole",
    "松散": "raveling",
})

_SEVERITY_ALIASES = {
    "low": "low", "低": "low", "轻": "low",
    "medium": "medium", "中": "medium",
    "high": "high", "高": "high", "重": "high",
}


def normalize_type(raw: str) -> str:
    key = str(raw).strip()
    if key in _TYPE_ALIASES:
        return _TYPE_ALIASES[key]
    raise ValueError(f"未知病害类型: {raw!r}（可用代码: {sorted(DISTRESS_TYPES)}）")


def normalize_severity(raw: str) -> str:
    key = str(raw).strip()
    if key in _SEVERITY_ALIASES:
        return _SEVERITY_ALIASES[key]
    raise ValueError(f"未知严重度: {raw!r}（可用 low/medium/high 或 低/中/高）")


def type_label(code: str) -> str:
    return DISTRESS_TYPES.get(code, code)


def severity_label(code: str) -> str:
    return SEVERITIES.get(code, code)


def chainage_label(m: float) -> str:
    """桩号格式化：1234.5 → 'K1+234.5'。"""
    return f"K{int(m // 1000)}+{m % 1000:05.1f}"
