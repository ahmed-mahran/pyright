from abc import ABC
from typing import TYPE_CHECKING, Callable, Concatenate, Type

if TYPE_CHECKING:
  from typing import type_check_only

class _MyPyright(ABC):
  ...

@type_check_only
class Map[F, *Ts](_MyPyright):
  ...

class subscriptable[*T, **P, R]:
  def __init__(self, fn: Callable[Concatenate[Map[Type, *T], P], R]) -> None:
    ...

  def __getitem__(self, tp: Map[Type, *T]) -> Callable[P, R]:
    ...
