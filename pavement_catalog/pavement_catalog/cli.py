"""命令行界面：python -m pavement_catalog [--db 路径] <子命令> [参数]"""
from __future__ import annotations

import argparse
import sys
import unicodedata

from .archive import Archive
from .ingest import load_survey_file
from .models import DISTRESS_TYPES, chainage_label, severity_label, type_label

STATUS_LABELS = {"open": "待处置", "monitoring": "观察中", "repaired": "已修复"}


# ---------------------------------------------------------------- 表格打印
def _dw(s) -> int:
    """显示宽度：全角字符计 2。"""
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in str(s))


def _pad(s, width) -> str:
    s = str(s)
    return s + " " * max(0, width - _dw(s))


def _table(headers, rows) -> str:
    rows = [[str(c) for c in r] for r in rows]
    widths = [_dw(h) for h in headers]
    for r in rows:
        for i, c in enumerate(r):
            widths[i] = max(widths[i], _dw(c))
    lines = ["  ".join(_pad(h, widths[i]) for i, h in enumerate(headers)),
             "  ".join("-" * w for w in widths)]
    lines += ["  ".join(_pad(c, widths[i]) for i, c in enumerate(r)) for r in rows]
    return "\n".join(lines)


_DISTRESS_HEADERS = ["ID", "类型", "桩号", "偏移(m)", "严重度", "历史最高",
                     "观测数", "巡查数", "首次发现", "最近观测", "状态"]


def _distress_row(d):
    return [d["id"], type_label(d["distress_type"]), chainage_label(d["chainage_m"]),
            f'{d["offset_m"]:+.1f}', severity_label(d["severity"]),
            severity_label(d["max_severity"]), d["obs_count"], d["survey_count"],
            (d["first_seen"] or "")[:10], (d["last_seen"] or "")[:10],
            STATUS_LABELS.get(d["status"], d["status"])]


def _obs_table(observations):
    return _table(["观测时间", "巡查", "严重度", "桩号", "偏移(m)", "影像"],
                  [[o["captured_at"], o["survey_id"], severity_label(o["severity"]),
                    chainage_label(o["chainage_m"]), f'{o["offset_m"]:+.1f}', o["file_path"]]
                   for o in observations])


# ---------------------------------------------------------------- 子命令
def cmd_init_runway(a):
    centerline = []
    for part in a.centerline.split(";"):
        lat, lon = part.split(",")
        centerline.append([float(lat), float(lon)])
    with Archive(a.db) as ar:
        info = ar.add_runway(a.runway, a.name, centerline, a.width)
    print(f"跑道 {a.runway}（{a.name}）已登记：全长 {info['length_m']:.1f} m，道面宽 {a.width} m")


def cmd_ingest(a):
    with Archive(a.db) as ar:
        for path in a.files:
            survey = load_survey_file(path)
            st = ar.ingest_survey(survey)
            if st.get("skipped"):
                print(f"{st['survey_id']}: 已导入过，跳过（幂等）")
            else:
                extra = (f"，{st['observations_dropped']} 条因帧无定位被丢弃"
                         if st["observations_dropped"] else "")
                print(f"{st['survey_id']}: 导入 {st['frames']} 帧"
                      f"（{st['frames_bad_qc']} 帧定位异常），{st['observations']} 条病害观测{extra}")


def cmd_dedup(a):
    with Archive(a.db) as ar:
        st = ar.run_dedup(a.runway, eps_chainage=a.eps_chainage, eps_offset=a.eps_offset)
    print(f"去重完成：{st['observations']} 条观测 → {st['distresses']} 份病害档案"
          f"（{st['merged_clusters']} 份由多次观测合并；"
          f"容差 纵向±{st['eps_chainage']} m / 横向±{st['eps_offset']} m）")


def cmd_search(a):
    with Archive(a.db) as ar:
        rows = ar.search(runway_id=a.runway, dtype=a.type, severity=a.severity,
                         ch_from=a.ch_from, ch_to=a.ch_to, status=a.status,
                         min_obs=a.min_obs, limit=a.limit, with_obs=a.obs)
    if not rows:
        print("没有符合条件的病害档案")
        return
    print(_table(_DISTRESS_HEADERS, [_distress_row(d) for d in rows]))
    print(f"\n共 {len(rows)} 份档案")
    if a.obs:
        for d in rows:
            print(f"\n# {d['id']} {type_label(d['distress_type'])} @ {chainage_label(d['chainage_m'])}")
            print(_obs_table(d["observations"]))


def cmd_show(a):
    with Archive(a.db) as ar:
        d = ar.distress_detail(a.id)
    print(f"病害档案 #{d['id']}  {type_label(d['distress_type'])}  跑道 {d['runway_id']}")
    print(f"  位置: {chainage_label(d['chainage_m'])}  横向 {d['offset_m']:+.1f} m")
    print(f"  严重度: {severity_label(d['severity'])}（历史最高 {severity_label(d['max_severity'])}）"
          f"  状态: {STATUS_LABELS.get(d['status'], d['status'])}")
    dims = []
    if d["length_m"] is not None:
        dims.append(f"长 {d['length_m']} m")
    if d["width_m"] is not None:
        dims.append(f"宽 {d['width_m']} m")
    if d["area_m2"] is not None:
        dims.append(f"面积 {d['area_m2']} m²")
    if dims:
        print(f"  尺寸: {'，'.join(dims)}")
    print(f"  首次发现 {d['first_seen']}，最近观测 {d['last_seen']}，"
          f"共 {d['obs_count']} 次观测 / {d['survey_count']} 次巡查")
    if d["observations"]:
        print("\n观测历史:")
        print(_obs_table(d["observations"]))


def cmd_report(a):
    with Archive(a.db) as ar:
        rep = ar.report(a.runway)
    rw = rep["runway"]
    print(f"跑道 {rw['id']}（{rw['name']}）  全长 {rw['length_m']:.0f} m  病害档案 {rep['total']} 份\n")
    if not rep["total"]:
        return
    print("按类型:")
    rows = sorted(rep["by_type"].items(), key=lambda kv: -kv[1])
    print(_table(["类型", "数量", "占比"],
                 [[type_label(t), n, f"{n / rep['total'] * 100:.0f}%"] for t, n in rows]))
    print("\n按当前严重度:")
    print(_table(["严重度", "数量"],
                 [[severity_label(s), rep["by_severity"].get(s, 0)] for s in ("low", "medium", "high")]))
    print(f"\n沿里程分布（每 {rep['chainage_bin_m']:.0f} m 一段）:")
    for i, n in enumerate(rep["chainage_bins"]):
        if n:
            print(f"  {chainage_label(i * rep['chainage_bin_m']):>9}  {'█' * n} {n}")
    print("\n巡查记录:")
    print(_table(["巡查", "时间", "帧数", "观测数", "操作员", "天气"],
                 [[s["id"], s["started_at"], s["frames"], s["observations"],
                   s.get("operator") or "-", s.get("weather") or "-"] for s in rep["surveys"]]))


def cmd_compare(a):
    with Archive(a.db) as ar:
        result = ar.compare_surveys(a.runway, a.survey_a, a.survey_b)
    print(f"对比 {result['survey_a']} → {result['survey_b']}\n")
    for title, key in (("新出现", "new"),
                       ("严重度升级", "worsened"),
                       ("本次未观测到（可能已修复或漏检）", "not_observed")):
        items = result[key]
        print(f"{title}: {len(items)}")
        if items:
            print(_table(["ID", "类型", "桩号", "偏移(m)"],
                         [[it["id"], type_label(it["distress_type"]),
                           chainage_label(it["chainage_m"]), f'{it["offset_m"]:+.1f}']
                          for it in items]))
        print()


def cmd_surveys(a):
    with Archive(a.db) as ar:
        rows = ar.list_surveys(a.runway)
    if not rows:
        print("尚无巡查记录")
        return
    print(_table(["巡查", "跑道", "时间", "帧数", "观测数", "操作员"],
                 [[s["id"], s["runway_id"], s["started_at"], s["frames"], s["observations"],
                   s.get("operator") or "-"] for s in rows]))


def cmd_set_status(a):
    with Archive(a.db) as ar:
        ar.set_status(a.id, a.status, note=a.note)
    print(f"病害 #{a.id} 状态已更新为 {STATUS_LABELS[a.status]}")


def cmd_types(_a):
    print(_table(["代码", "中文名"], sorted(DISTRESS_TYPES.items())))


# ---------------------------------------------------------------- 入口
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pavement_catalog",
        description="机场道面病害编目系统：巡查影像 → 里程定位 → 自动去重 → 可检索档案库")
    p.add_argument("--db", default="catalog.db", help="SQLite 档案库路径（默认 catalog.db）")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("init-runway", help="登记跑道中心线")
    sp.add_argument("--runway", required=True, help="跑道编号，如 RWY03")
    sp.add_argument("--name", required=True, help="跑道名称，如 03/21")
    sp.add_argument("--width", type=float, required=True, help="道面宽（米）")
    sp.add_argument("--centerline", required=True,
                    help='中心线控制点 "lat,lon;lat,lon[;...]"，从 0 桩号端起')
    sp.set_defaults(fn=cmd_init_runway)

    sp = sub.add_parser("ingest", help="导入巡查清单（JSON，幂等）")
    sp.add_argument("files", nargs="+")
    sp.set_defaults(fn=cmd_ingest)

    sp = sub.add_parser("dedup", help="对观测去重，重建病害档案")
    sp.add_argument("--runway", required=True)
    sp.add_argument("--eps-chainage", type=float, default=5.0, help="纵向合并容差（米，默认 5）")
    sp.add_argument("--eps-offset", type=float, default=3.0, help="横向合并容差（米，默认 3）")
    sp.set_defaults(fn=cmd_dedup)

    sp = sub.add_parser("search", help="检索病害档案")
    sp.add_argument("--runway")
    sp.add_argument("--type", help="病害类型（代码或中文）")
    sp.add_argument("--severity", help="当前严重度 low/medium/high 或 低/中/高")
    sp.add_argument("--from", dest="ch_from", type=float, help="起始里程（米）")
    sp.add_argument("--to", dest="ch_to", type=float, help="结束里程（米）")
    sp.add_argument("--status", choices=list(STATUS_LABELS))
    sp.add_argument("--min-obs", type=int, help="最少观测次数")
    sp.add_argument("--limit", type=int)
    sp.add_argument("--obs", action="store_true", help="同时列出每份档案的观测历史")
    sp.set_defaults(fn=cmd_search)

    sp = sub.add_parser("show", help="查看病害档案详情")
    sp.add_argument("--id", type=int, required=True)
    sp.set_defaults(fn=cmd_show)

    sp = sub.add_parser("report", help="跑道病害统计报告")
    sp.add_argument("--runway", required=True)
    sp.set_defaults(fn=cmd_report)

    sp = sub.add_parser("compare", help="对比两次巡查（新增/升级/未再见）")
    sp.add_argument("--runway", required=True)
    sp.add_argument("survey_a", help="较早的巡查 ID")
    sp.add_argument("survey_b", help="较晚的巡查 ID")
    sp.set_defaults(fn=cmd_compare)

    sp = sub.add_parser("surveys", help="列出巡查记录")
    sp.add_argument("--runway")
    sp.set_defaults(fn=cmd_surveys)

    sp = sub.add_parser("set-status", help="更新病害处置状态")
    sp.add_argument("--id", type=int, required=True)
    sp.add_argument("--status", required=True, choices=list(STATUS_LABELS))
    sp.add_argument("--note")
    sp.set_defaults(fn=cmd_set_status)

    sp = sub.add_parser("types", help="列出病害类型编码")
    sp.set_defaults(fn=cmd_types)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        args.fn(args)
    except (KeyError, ValueError, FileNotFoundError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2
    return 0
