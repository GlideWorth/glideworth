/**
 * ECharts runtime: tree-shaken registration of only the charts and components Glideworth uses.
 * Loaded with a dynamic import from the Chart wrapper so ECharts is its own lazy chunk.
 */
import { BarChart, BoxplotChart, LineChart, SankeyChart, ScatterChart } from "echarts/charts";
import {
  AriaComponent,
  AxisPointerComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { LegacyGridContainLabel } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  SankeyChart,
  ScatterChart,
  BoxplotChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  MarkLineComponent,
  MarkPointComponent,
  MarkAreaComponent,
  AxisPointerComponent,
  AriaComponent,
  CanvasRenderer,
  LegacyGridContainLabel,
]);

export const init = echarts.init;
