from abc import ABC


class _MyPyright(ABC):
  pass

class Map[F, *Ts](_MyPyright):
  """
  Map[type, int]          ==== type[int]
  Map[type, int, str]     ==== *tuple[type[int], type[str]]
  Map[type, T]            ==== type[T]
  Map[type, T: int]       ==== type[T: int]
  Map[type, *Ts]          ==== *Ts: type
  Map[type, int, T, *Ts]  ==== *tuple[type[int], type[T], *Ts: type]
  """
  pass

