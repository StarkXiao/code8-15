#!/usr/bin/env python3
"""端到端演示：仿真数据 → 建库 → 导入 → 去重 → 检索 / 统计 / 对比。

用法：
    python demo.py
"""
from __future__ import annotations

import shutil
from pathlib import Path

from pavement_catalog.archive import Archive
from pavement_catalog.cli import main as cli
from pavement_catalog.sample_data import generate_demo_dataset

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "demo_data"
DB_PATH = ROOT / "demo_catalog.db"


def section(title: str) -> None:
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def main() -> None:
    if DATA_DIR.exists():
        shutil.rmtree(DATA_DIR)
    DB_PATH.unlink(missing_ok=True)

    section("1. 生成仿真巡查数据（3 次巡查，车载 10 m/帧，GPS σ≈1 m）")
    info = generate_demo_dataset(DATA_DIR)
    rw = info["runway"]
    print(f"跑道 {rw['id']}（{rw['name']}）：全长 {rw['length_m']:.0f} m，宽 {rw['width_m']:.0f} m")
    print(f"预埋真实病害 {info['truth_distresses']} 处；巡查清单 {len(info['surveys'])} 份 → {DATA_DIR}")

    section("2. 登记跑道中心线")
    with Archive(DB_PATH) as ar:
        ar.add_runway(rw["id"], rw["name"], rw["centerline"], rw["width_m"])
    print(f"跑道 {rw['id']} 已登记，中心线 {len(rw['centerline'])} 个控制点，全长 {rw['length_m']:.1f} m")

    section("3. 导入巡查影像清单（幂等，重复导入自动跳过）")
    for f in info["surveys"]:
        cli(["--db", str(DB_PATH), "ingest", f])
    print("-- 重复导入第 1 份，验证幂等 --")
    cli(["--db", str(DB_PATH), "ingest", info["surveys"][0]])

    section("4. 自动去重，建立病害档案")
    cli(["--db", str(DB_PATH), "dedup", "--runway", rw["id"]])

    section("5. 统计报告")
    cli(["--db", str(DB_PATH), "report", "--runway", rw["id"]])

    section("6. 检索示例")
    print("\n[6a] K1+000 ~ K1+500 区段的所有病害")
    cli(["--db", str(DB_PATH), "search", "--runway", rw["id"], "--from", "1000", "--to", "1500"])
    print("\n[6b] 全部高严重度病害")
    cli(["--db", str(DB_PATH), "search", "--runway", rw["id"], "--severity", "high"])
    print("\n[6c] 坑槽（中文名检索）")
    cli(["--db", str(DB_PATH), "search", "--runway", rw["id"], "--type", "坑槽"])

    section("7. 病害演化对比：第 1 次巡查 → 第 3 次巡查")
    ids = info["survey_ids"]
    cli(["--db", str(DB_PATH), "compare", "--runway", rw["id"], ids[0], ids[-1]])

    section("8. 单份档案详情（观测历史 + 影像回溯）")
    with Archive(DB_PATH) as ar:
        rows = ar.search(runway_id=rw["id"], min_obs=3, limit=1)
    if rows:
        cli(["--db", str(DB_PATH), "show", "--id", str(rows[0]["id"])])

    print(f"\n演示完成。档案库: {DB_PATH}")
    print("可继续探索，例如：")
    print(f"  python -m pavement_catalog --db {DB_PATH} search --type 横向裂缝 --obs")
    print(f"  python -m pavement_catalog --db {DB_PATH} report --runway {rw['id']}")
    print(f"  python -m pavement_catalog --db {DB_PATH} set-status --id 1 --status repaired")


if __name__ == "__main__":
    main()
