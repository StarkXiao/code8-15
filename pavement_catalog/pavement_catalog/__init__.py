"""机场道面病害编目系统。

巡查影像 → 跑道里程精确定位 → 自动去重 → 可检索的病害档案库。
"""
from .archive import Archive
from .geo import LocalFrame, Projection, RunwayCenterline

__version__ = "0.1.0"
__all__ = ["Archive", "RunwayCenterline", "LocalFrame", "Projection", "__version__"]
