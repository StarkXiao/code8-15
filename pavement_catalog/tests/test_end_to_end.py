import json
import tempfile
import unittest
from pathlib import Path

from pavement_catalog.archive import Archive
from pavement_catalog.ingest import load_survey_file
from pavement_catalog.sample_data import generate_demo_dataset


class EndToEndTest(unittest.TestCase):
    """仿真数据全流程：生成 → 导入 → 去重 → 检索 / 统计 / 对比。"""

    def test_full_pipeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            info = generate_demo_dataset(tmp, seed=7, frame_step_m=20.0)
            rw = info["runway"]
            ar = Archive(Path(tmp) / "catalog.db")
            ar.add_runway(rw["id"], rw["name"], rw["centerline"], rw["width_m"])

            total_obs = 0
            for f in info["surveys"]:
                st = ar.ingest_survey(load_survey_file(f))
                self.assertFalse(st["skipped"])
                self.assertEqual(st["observations_dropped"], 0)
                total_obs += st["observations"]

            st = ar.run_dedup(rw["id"])
            truth = info["truth_distresses"]          # 55 处预埋病害
            n_distress = st["distresses"]             # 另含 3 条一次性 FOD
            self.assertEqual(st["observations"], total_obs)
            # 档案数应接近 ground truth：允许少量粘连 / 分裂
            self.assertGreaterEqual(n_distress, truth - 8)
            self.assertLessEqual(n_distress, truth + 12)
            self.assertGreater(st["merged_clusters"], truth // 2)

            # 检索
            all_d = ar.search(runway_id=rw["id"])
            self.assertEqual(len(all_d), n_distress)
            high = ar.search(runway_id=rw["id"], severity="high")
            self.assertTrue(high)
            self.assertTrue(all(d["severity"] == "high" for d in high))
            seg = ar.search(runway_id=rw["id"], ch_from=1000, ch_to=1100)
            self.assertTrue(all(1000 <= d["chainage_m"] <= 1100 for d in seg))
            detail = ar.distress_detail(all_d[0]["id"])
            self.assertTrue(detail["observations"])
            self.assertIn("file_path", detail["observations"][0])

            # 统计与对比
            rep = ar.report(rw["id"])
            self.assertEqual(rep["total"], n_distress)
            self.assertEqual(len(rep["surveys"]), 3)
            ids = info["survey_ids"]
            result = ar.compare_surveys(rw["id"], ids[0], ids[-1])
            self.assertGreater(len(result["new"]), 0)          # 第 3 次巡查前有新病害出现
            self.assertGreater(len(result["not_observed"]), 0)  # 有病害被修复

            ar.close()


if __name__ == "__main__":
    unittest.main()
