import unittest

from pavement_catalog.dedup import cluster_observations


def obs(ch, off=0.0, dtype="pothole"):
    return {"chainage_m": ch, "offset_m": off, "distress_type": dtype}


class DedupTest(unittest.TestCase):
    def test_close_same_type_merges(self):
        clusters = cluster_observations([obs(100), obs(102.5)], eps_chainage=5, eps_offset=3)
        self.assertEqual(len(clusters), 1)

    def test_far_splits(self):
        clusters = cluster_observations([obs(100), obs(110)], eps_chainage=5, eps_offset=3)
        self.assertEqual(len(clusters), 2)

    def test_different_type_never_merges(self):
        clusters = cluster_observations(
            [obs(100, 0, "pothole"), obs(100.5, 0.2, "raveling")], 5, 3)
        self.assertEqual(len(clusters), 2)

    def test_lateral_split(self):
        clusters = cluster_observations([obs(100, 0), obs(101, 8)], eps_chainage=5, eps_offset=3)
        self.assertEqual(len(clusters), 2)

    def test_chain_transitivity(self):
        # A-B 4 m、B-C 4 m，A-C 8 m > eps：通过 B 连通为一簇
        clusters = cluster_observations([obs(100), obs(104), obs(108)], eps_chainage=5, eps_offset=3)
        self.assertEqual(sorted(sorted(c) for c in clusters), [[0, 1, 2]])

    def test_mixed(self):
        o = [obs(100), obs(103),            # 合并
             obs(200), obs(200, 10),        # 同里程但横向相距 10 m → 分裂
             obs(300, 0, "raveling"), obs(302, 0.5, "raveling")]  # 合并
        clusters = cluster_observations(o, eps_chainage=5, eps_offset=3)
        sizes = sorted(len(c) for c in clusters)
        self.assertEqual(sizes, [1, 1, 2, 2])

    def test_empty(self):
        self.assertEqual(cluster_observations([]), [])


if __name__ == "__main__":
    unittest.main()
