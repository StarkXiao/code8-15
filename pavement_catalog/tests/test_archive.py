import unittest

from pavement_catalog.archive import Archive
from pavement_catalog.geo import LocalFrame, RunwayCenterline


def _centerline():
    end = LocalFrame(31.0, 121.0).to_latlon(0.0, 3600.0)
    return [[31.0, 121.0], list(end)]


class ArchiveTest(unittest.TestCase):
    def setUp(self):
        self.ar = Archive(":memory:")
        self.centerline = _centerline()
        self.ar.add_runway("RWY03", "03/21", self.centerline, 45.0)
        self.cl = RunwayCenterline(self.centerline)

    def tearDown(self):
        self.ar.close()

    def _frame(self, name, ch, off=-2.0, captured="2026-03-10T09:00:00"):
        lat, lon = self.cl.locate(ch, off)
        return {"file": f"img/{name}.jpg", "captured_at": captured,
                "lat": lat, "lon": lon, "distresses": []}

    def _survey(self, sid, started, frames):
        return {"survey": {"id": sid, "runway_id": "RWY03", "started_at": started},
                "frames": frames}

    def test_ingest_locates_frames(self):
        st = self.ar.ingest_survey(self._survey("S1", "2026-03-10T09:00:00",
                                                [self._frame("a", 500.0)]))
        self.assertEqual(st["frames"], 1)
        row = self.ar.conn.execute("SELECT * FROM frames").fetchone()
        self.assertAlmostEqual(row["chainage_m"], 500.0, places=1)
        self.assertAlmostEqual(row["offset_m"], -2.0, places=1)
        self.assertEqual(row["qc_flag"], "ok")

    def test_ingest_idempotent(self):
        survey = self._survey("S1", "2026-03-10T09:00:00", [self._frame("a", 500.0)])
        st1 = self.ar.ingest_survey(survey)
        st2 = self.ar.ingest_survey(survey)
        self.assertFalse(st1["skipped"])
        self.assertTrue(st2["skipped"])
        n = self.ar.conn.execute("SELECT COUNT(*) FROM frames").fetchone()[0]
        self.assertEqual(n, 1)

    def test_ingest_qc_flags(self):
        far = {"file": "img/far.jpg", "captured_at": "2026-03-10T09:00:00",
               "lat": 31.5, "lon": 121.5, "distresses": []}   # 远离跑道
        nogps = {"file": "img/nogps.jpg", "captured_at": "2026-03-10T09:00:01",
                 "distresses": []}
        st = self.ar.ingest_survey(self._survey("S1", "2026-03-10T09:00:00", [far, nogps]))
        self.assertEqual(st["frames_bad_qc"], 2)
        flags = {r["file_path"]: r["qc_flag"] for r in self.ar.conn.execute("SELECT * FROM frames")}
        self.assertEqual(flags["img/far.jpg"], "off_runway")
        self.assertEqual(flags["img/nogps.jpg"], "no_gps")

    def _two_surveys_with_shared_pothole(self):
        # 同一坑槽在两次巡查中各被拍到一次（位置有抖动），另有一处独立裂缝
        lat1, lon1 = self.cl.locate(500.0, 3.0)
        lat2, lon2 = self.cl.locate(501.5, 3.5)
        lat3, lon3 = self.cl.locate(800.0, -5.0)
        s1 = self._survey("S1", "2026-03-10T09:00:00", [
            {"file": "img/1.jpg", "captured_at": "2026-03-10T09:01:00",
             "lat": lat1, "lon": lon1,
             "distresses": [{"type": "坑槽", "severity": "中",
                             "position": {"lat": lat1, "lon": lon1}, "area_m2": 0.3}]},
            {"file": "img/2.jpg", "captured_at": "2026-03-10T09:02:00",
             "lat": lat3, "lon": lon3,
             "distresses": [{"type": "transverse_crack", "severity": "low",
                             "position": {"lat": lat3, "lon": lon3}, "length_m": 3.0}]},
        ])
        s2 = self._survey("S2", "2026-05-15T09:00:00", [
            {"file": "img/1.jpg", "captured_at": "2026-05-15T09:01:00",
             "lat": lat2, "lon": lon2,
             "distresses": [{"type": "pothole", "severity": "high",
                             "position": {"lat": lat2, "lon": lon2}, "area_m2": 0.5}]},
        ])
        return s1, s2

    def test_dedup_merges_across_surveys(self):
        s1, s2 = self._two_surveys_with_shared_pothole()
        self.ar.ingest_survey(s1)
        self.ar.ingest_survey(s2)
        st = self.ar.run_dedup("RWY03")
        self.assertEqual(st["observations"], 3)
        self.assertEqual(st["distresses"], 2)   # 坑槽合并，裂缝独立

        pothole = self.ar.search(runway_id="RWY03", dtype="pothole")
        self.assertEqual(len(pothole), 1)
        p = pothole[0]
        self.assertEqual(p["obs_count"], 2)
        self.assertEqual(p["survey_count"], 2)
        self.assertEqual(p["severity"], "high")        # 当前严重度取最近一次
        self.assertEqual(p["max_severity"], "high")
        self.assertEqual(p["area_m2"], 0.5)            # 尺寸取历史最大
        self.assertAlmostEqual(p["chainage_m"], 500.75, delta=0.2)
        self.assertEqual(p["first_seen"][:10], "2026-03-10")
        self.assertEqual(p["last_seen"][:10], "2026-05-15")

        # 观测已回填 distress_id
        linked = self.ar.conn.execute(
            "SELECT COUNT(*) FROM observations WHERE distress_id IS NOT NULL").fetchone()[0]
        self.assertEqual(linked, 3)

        # 去重可重复执行且结果稳定
        st2 = self.ar.run_dedup("RWY03")
        self.assertEqual(st2["distresses"], 2)

    def test_search_filters(self):
        s1, s2 = self._two_surveys_with_shared_pothole()
        self.ar.ingest_survey(s1)
        self.ar.ingest_survey(s2)
        self.ar.run_dedup("RWY03")

        self.assertEqual(len(self.ar.search(runway_id="RWY03", severity="high")), 1)
        self.assertEqual(len(self.ar.search(runway_id="RWY03", ch_from=0, ch_to=600)), 1)
        self.assertEqual(len(self.ar.search(runway_id="RWY03", ch_from=600, ch_to=900)), 1)
        self.assertEqual(len(self.ar.search(runway_id="RWY03", dtype="横向裂缝")), 1)
        self.assertEqual(len(self.ar.search(runway_id="RWY03", dtype="rutting")), 0)
        with self.assertRaises(ValueError):
            self.ar.search(runway_id="RWY03", dtype="不存在的类型")

    def test_compare_surveys(self):
        s1, s2 = self._two_surveys_with_shared_pothole()
        self.ar.ingest_survey(s1)
        self.ar.ingest_survey(s2)
        self.ar.run_dedup("RWY03")
        result = self.ar.compare_surveys("RWY03", "S1", "S2")
        # 坑槽 中→高：升级；横向裂缝第二次未拍到：未再观测；无新增
        self.assertEqual(len(result["worsened"]), 1)
        self.assertEqual(len(result["not_observed"]), 1)
        self.assertEqual(len(result["new"]), 0)

    def test_set_status(self):
        s1, _ = self._two_surveys_with_shared_pothole()
        self.ar.ingest_survey(s1)
        self.ar.run_dedup("RWY03")
        did = self.ar.search(runway_id="RWY03")[0]["id"]
        self.ar.set_status(did, "repaired", note="已铣刨重铺")
        d = self.ar.distress_detail(did)
        self.assertEqual(d["status"], "repaired")
        self.assertEqual(d["note"], "已铣刨重铺")
        with self.assertRaises(ValueError):
            self.ar.set_status(did, "bad_status")
        with self.assertRaises(KeyError):
            self.ar.set_status(9999, "open")


if __name__ == "__main__":
    unittest.main()
