from abc import ABC
from typing import TYPE_CHECKING

if TYPE_CHECKING:
  from typing import type_check_only

class _MyPyright(ABC):
  ...

@type_check_only
class Map[F, *Ts](_MyPyright):
  ...
