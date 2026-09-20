"""病害观测去重：把多次巡查中指向同一病害的观测合并为一份档案。

判据：同一病害类型，且空间上邻近 ——
    |Δ里程| ≤ eps_chainage 且 |Δ横向偏移| ≤ eps_offset

里程轴上满足条件的观测对通过并查集（union-find）连通，因此链式邻近的
观测会并入同一簇（A-B 相距 4 m、B-C 相距 4 m、eps=5 m 时 A/B/C 同簇）。

默认容差（纵向 5 m / 横向 3 m）对应车载巡查 RTK GPS（σ≈1 m）叠加人工
标注抖动的误差水平，可按设备精度在 CLI 中调整。
"""
from __future__ import annotations


def cluster_observations(obs, eps_chainage: float = 5.0, eps_offset: float = 3.0):
    """对观测列表聚类。

    obs: dict 列表，需含 chainage_m / offset_m / distress_type 三个键。
    返回 list[list[int]]：每个簇是 obs 的下标列表。
    """
    n = len(obs)
    order = sorted(range(n), key=lambda i: obs[i]["chainage_m"])
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    # 里程排序后滑动窗口：只需比较里程差在容差内的观测对
    for pos, i in enumerate(order):
        ci, oi, ti = obs[i]["chainage_m"], obs[i]["offset_m"], obs[i]["distress_type"]
        for j in order[pos + 1:]:
            if obs[j]["chainage_m"] - ci > eps_chainage:
                break
            if obs[j]["distress_type"] == ti and abs(obs[j]["offset_m"] - oi) <= eps_offset:
                union(i, j)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())
