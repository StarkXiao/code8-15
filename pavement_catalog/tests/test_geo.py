import math
import unittest

from pavement_catalog.geo import LocalFrame, RunwayCenterline


class GeoTest(unittest.TestCase):
    def setUp(self):
        # 正北向跑道：起点 (31.0, 121.0)，长 3600 m
        end = LocalFrame(31.0, 121.0).to_latlon(0.0, 3600.0)
        self.cl = RunwayCenterline([(31.0, 121.0), end])

    def test_endpoints(self):
        p0 = self.cl.project(31.0, 121.0)
        self.assertAlmostEqual(p0.chainage_m, 0.0, places=6)
        self.assertAlmostEqual(p0.offset_m, 0.0, places=6)
        p1 = self.cl.project(*self.cl.locate(3600.0))
        self.assertAlmostEqual(p1.chainage_m, 3600.0, places=3)

    def test_length(self):
        self.assertAlmostEqual(self.cl.length_m, 3600.0, places=3)

    def test_offset_sign(self):
        left = self.cl.project(*self.cl.locate(1800.0, 10.0))
        right = self.cl.project(*self.cl.locate(1800.0, -5.0))
        self.assertAlmostEqual(left.offset_m, 10.0, places=3)
        self.assertAlmostEqual(right.offset_m, -5.0, places=3)
        self.assertAlmostEqual(left.chainage_m, 1800.0, places=3)

    def test_roundtrip(self):
        for ch, off in [(0.0, 0.0), (123.4, 7.5), (1800.0, -22.4), (3599.9, -20.0)]:
            p = self.cl.project(*self.cl.locate(ch, off))
            self.assertAlmostEqual(p.chainage_m, ch, places=2)
            self.assertAlmostEqual(p.offset_m, off, places=2)

    def test_beyond_end_clamps(self):
        # 超出终点的点：投影到终点，dist 反映超出距离
        lat, lon = LocalFrame(31.0, 121.0).to_latlon(0.0, 3800.0)
        p = self.cl.project(lat, lon)
        self.assertAlmostEqual(p.chainage_m, 3600.0, places=3)
        self.assertAlmostEqual(p.dist_m, 200.0, places=1)

    def test_heading(self):
        self.assertAlmostEqual(self.cl.heading_at(100.0), 0.0, places=6)
        frame = LocalFrame(31.0, 121.0)
        end = frame.to_latlon(math.sin(math.radians(60)) * 1000,
                              math.cos(math.radians(60)) * 1000)
        cl = RunwayCenterline([(31.0, 121.0), end])
        self.assertAlmostEqual(cl.heading_at(500.0), 60.0, places=3)

    def test_invalid_centerline(self):
        with self.assertRaises(ValueError):
            RunwayCenterline([(31.0, 121.0)])


if __name__ == "__main__":
    unittest.main()
