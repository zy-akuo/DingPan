/**
 * 东方财富网页/App 筹码分布算法（CYQCalculator）移植。
 * range=120 对齐东财展示口径；价格域 150 档，换手衰减 + 三角分布。
 */

export type CyqKBar = {
  open: number;
  high: number;
  low: number;
  close: number;
  /** 换手率，单位 %（与东财 hsl 一致） */
  turnover?: number | null;
};

export type CyqPercentChip = {
  priceRange: [number, number];
  concentration: number;
};

export type CyqResult = {
  /** 各档筹码量 */
  chips: number[];
  /** 各档价格 */
  prices: number[];
  /** 获利比例 0~1 */
  benefitPart: number;
  /** 平均成本（50%筹码成本） */
  avgCost: number;
  percentChips: {
    "70": CyqPercentChip;
    "90": CyqPercentChip;
  };
};

const FACTOR = 150;
const DEFAULT_RANGE = 120;

function createNumberArray(count: number): number[] {
  return Array.from({ length: count }, () => 0);
}

/**
 * @param index 当前选中的 K 线索引
 * @param bars 日K 序列（需含 OHLC + turnover%）
 * @param range 回看窗口，默认 120；传 0 表示从首根累计
 */
export function calcCyq(
  index: number,
  bars: CyqKBar[],
  range: number = DEFAULT_RANGE,
): CyqResult | null {
  if (!bars.length || index < 0 || index >= bars.length) return null;

  const start = range ? Math.max(0, index - range + 1) : 0;
  const kdata = bars.slice(start, Math.max(1, index + 1));
  if (!kdata.length) return null;

  let maxprice = 0;
  let minprice = 0;
  for (const el of kdata) {
    maxprice = !maxprice ? el.high : Math.max(maxprice, el.high);
    minprice = !minprice ? el.low : Math.min(minprice, el.low);
  }

  const accuracy = Math.max(0.01, (maxprice - minprice) / (FACTOR - 1));
  const yrange: number[] = [];
  for (let i = 0; i < FACTOR; i++) {
    yrange.push(Number((minprice + accuracy * i).toFixed(2)));
  }

  const xdata = createNumberArray(FACTOR);

  for (const eles of kdata) {
    const open = eles.open;
    const close = eles.close;
    const high = eles.high;
    const low = eles.low;
    const avg = (open + close + high + low) / 4;
    const hsl = eles.turnover != null && !Number.isNaN(eles.turnover) ? eles.turnover : 0;
    const turnoverRate = Math.min(1, hsl / 100 || 0);

    const H = Math.floor((high - minprice) / accuracy);
    const L = Math.ceil((low - minprice) / accuracy);
    const gX = high === low ? FACTOR - 1 : 2 / (high - low);
    const gY = Math.floor((avg - minprice) / accuracy);

    for (let n = 0; n < xdata.length; n++) {
      xdata[n] *= 1 - turnoverRate;
    }

    if (high === low) {
      if (gY >= 0 && gY < FACTOR) {
        xdata[gY] += (gX * turnoverRate) / 2;
      }
    } else {
      for (let j = L; j <= H; j++) {
        if (j < 0 || j >= FACTOR) continue;
        const curprice = minprice + accuracy * j;
        if (curprice <= avg) {
          if (Math.abs(avg - low) < 1e-8) {
            xdata[j] += gX * turnoverRate;
          } else {
            xdata[j] += ((curprice - low) / (avg - low)) * gX * turnoverRate;
          }
        } else if (Math.abs(high - avg) < 1e-8) {
          xdata[j] += gX * turnoverRate;
        } else {
          xdata[j] += ((high - curprice) / (high - avg)) * gX * turnoverRate;
        }
      }
    }
  }

  let totalChips = 0;
  for (let i = 0; i < FACTOR; i++) {
    const x = Number(xdata[i].toPrecision(12));
    xdata[i] = x;
    totalChips += x;
  }

  const getCostByChip = (chip: number): number => {
    let result = 0;
    let sum = 0;
    for (let i = 0; i < FACTOR; i++) {
      const x = Number(xdata[i].toPrecision(12));
      if (sum + x > chip) {
        result = minprice + i * accuracy;
        break;
      }
      sum += x;
    }
    return result;
  };

  const getBenefitPart = (price: number): number => {
    let below = 0;
    for (let i = 0; i < FACTOR; i++) {
      const x = Number(xdata[i].toPrecision(12));
      if (price >= minprice + i * accuracy) below += x;
    }
    return totalChips === 0 ? 0 : below / totalChips;
  };

  const computePercentChips = (percent: number): CyqPercentChip => {
    const ps = [(1 - percent) / 2, (1 + percent) / 2];
    const pr0 = getCostByChip(totalChips * ps[0]);
    const pr1 = getCostByChip(totalChips * ps[1]);
    return {
      priceRange: [Number(pr0.toFixed(2)), Number(pr1.toFixed(2))],
      concentration: pr0 + pr1 === 0 ? 0 : (pr1 - pr0) / (pr0 + pr1),
    };
  };

  const currentprice = bars[index].close;
  return {
    chips: xdata,
    prices: yrange,
    benefitPart: getBenefitPart(currentprice),
    avgCost: Number(getCostByChip(totalChips * 0.5).toFixed(2)),
    percentChips: {
      "90": computePercentChips(0.9),
      "70": computePercentChips(0.7),
    },
  };
}
