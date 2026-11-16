/** Shape of the generated dataset modules (see scripts/build_datasets.py). */
export interface RawHistoricalData {
  firstYear: number;
  lastYear: number;
  series: {
    stocks: number[];
    dividendYield: number[];
    bonds: number[];
    bondYield: number[];
    cash: (number | null)[];
    inflation: number[];
  };
}
