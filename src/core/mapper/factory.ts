// マッパー番号からマッパーを生成するファクトリ（移植元 cppnes `mapper.cpp` の make_mapper）。
// 循環 import を避けるため、Mapper 基底（mapper.ts）とは別ファイルに置く。
import type { CartridgeData, Mapper } from "../mapper.ts";
import { Mapper0 } from "./mapper0.ts";
import { Mapper1 } from "./mapper1.ts";
import { Mapper10 } from "./mapper10.ts";
import { Mapper2 } from "./mapper2.ts";
import { Mapper3 } from "./mapper3.ts";
import { Mapper4 } from "./mapper4.ts";
import { Mapper5 } from "./mapper5.ts";
import { Mapper69 } from "./mapper69.ts";
import { Mapper70 } from "./mapper70.ts";

export function make_mapper(number_: number, data: CartridgeData): Mapper {
  switch (number_) {
    case 0: return new Mapper0(data);
    case 1: return new Mapper1(data);
    case 2: return new Mapper2(data);
    case 3: return new Mapper3(data);
    case 4: return new Mapper4(data);
    case 5: return new Mapper5(data);
    case 10: return new Mapper10(data);
    case 69: return new Mapper69(data);
    case 70: return new Mapper70(data);
    default:
      throw new Error(`unsupported mapper: ${number_}`);
  }
}
