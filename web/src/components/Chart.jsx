import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts/core";
import { PieChart, BarChart, RadarChart } from "echarts/charts";
import {
  TooltipComponent, LegendComponent, GridComponent, PolarComponent,
  RadarComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { cssVar } from "../lib/theme";

echarts.use([
  PieChart, BarChart, RadarChart,
  TooltipComponent, LegendComponent, GridComponent, PolarComponent, RadarComponent,
  CanvasRenderer,
]);

/** 全站统一图表主题参数（颜色全部从 CSS 变量取，三套主题自动跟随）。 */
function base() {
  return {
    backgroundColor: "transparent",
    textStyle: { color: cssVar("ink-900", 0.72), fontFamily: "Inter, Segoe UI, sans-serif" },
    tooltip: {
      backgroundColor: cssVar("white", 0.97),
      borderColor: cssVar("ink-950", 0.1),
      borderWidth: 1,
      textStyle: { color: cssVar("ink-900"), fontSize: 12 },
      extraCssText:
        "backdrop-filter:blur(12px);border-radius:12px;padding:8px 10px;"
        + "box-shadow:0 8px 26px -10px rgba(0,0,0,.22);",
    },
  };
}

export default function Chart({ option, height = 260, className = "" }) {
  const ref = useRef(null);
  const inst = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    inst.current = echarts.init(ref.current, null, { renderer: "canvas" });
    const onResize = () => inst.current && inst.current.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      inst.current && inst.current.dispose();
      inst.current = null;
    };
  }, []);

  useEffect(() => {
    if (!inst.current || !option) return;
    inst.current.setOption({ ...base(), ...option }, true);
  }, [option]);

  // 换主题/字号时 ECharts 里的颜色是算出来的，不会跟着 CSS 变，得手动重画
  useEffect(() => {
    if (!option) return;
    const redraw = () => {
      if (!inst.current) return;
      inst.current.setOption({ ...base(), ...option }, true);
      inst.current.resize();
    };
    const obs = new MutationObserver(redraw);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-font"],
    });
    return () => obs.disconnect();
    // option 变了也要用最新的一份重画，所以把 option 也放进依赖
  }, [option]);

  return <div ref={ref} className={className} style={{ height, width: "100%" }} />;
}

/** 南丁格尔玫瑰图：章节错题占比。 */
export function roseOption(items) {
  const palette = [
    "apple-blue", "apple-purple", "apple-green", "apple-orange", "apple-teal",
    "apple-red", "apple-yellow", "apple-blue", "apple-purple", "apple-teal",
  ];
  const data = items.map((x, i) => ({
    name: x.name,
    value: x.value,
    itemStyle: { color: cssVar(palette[i % palette.length]), opacity: 0.9 },
  }));
  return {
    tooltip: {
      ...base().tooltip,
      trigger: "item",
      formatter: (p) => `${p.name}<br/>错 ${p.value} 次（${p.percent}%）`,
    },
    legend: {
      type: "scroll",
      bottom: 0,
      icon: "circle",
      itemWidth: 7,
      itemHeight: 7,
      textStyle: { color: cssVar("ink-900", 0.55), fontSize: 10.5 },
      pageTextStyle: { color: cssVar("ink-900", 0.45) },
    },
    series: [
      {
        type: "pie",
        roseType: "radius",
        radius: ["22%", "78%"],
        center: ["50%", "44%"],
        itemStyle: {
          borderRadius: 6,
          borderColor: cssVar("white", 0.9),
          borderWidth: 2,
        },
        label: { show: false },
        labelLine: { show: false },
        data,
      },
    ],
  };
}

/** 水平柱状图：高频失分知识点 Top N。 */
export function rankOption(items) {
  const sorted = [...items].sort((a, b) => a.value - b.value);
  return {
    grid: { left: 4, right: 34, top: 8, bottom: 4, containLabel: true },
    tooltip: { ...base().tooltip, trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: {
      type: "value",
      splitLine: { lineStyle: { color: cssVar("ink-950", 0.07) } },
      axisLabel: { color: cssVar("ink-900", 0.42), fontSize: 10 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "category",
      data: sorted.map((x) => x.name),
      axisLabel: {
        color: cssVar("ink-900", 0.68),
        fontSize: 11,
        width: 96,
        overflow: "truncate",
      },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar",
        data: sorted.map((x) => x.value),
        barWidth: 11,
        itemStyle: {
          borderRadius: [0, 6, 6, 0],
          color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
            { offset: 0, color: cssVar("apple-red", 0.62) },
            { offset: 1, color: cssVar("apple-orange", 0.95) },
          ]),
        },
        label: {
          show: true,
          position: "right",
          color: cssVar("ink-900", 0.55),
          fontSize: 10.5,
        },
      },
    ],
  };
}
