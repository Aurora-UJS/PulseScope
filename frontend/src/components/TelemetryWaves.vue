<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useMonitorStore } from '../store/monitor';
import * as echarts from 'echarts';

const store = useMonitorStore();
const chartRef = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;

const dataHistory: Record<string, number[]> = {};
const MAX_POINTS = 100;

const initChart = () => {
  if (!chartRef.value) return;
  chart = echarts.init(chartRef.value, 'dark', { renderer: 'canvas' });
  
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    grid: { left: '3%', right: '4%', bottom: '3%', top: '10%', containLabel: true },
    xAxis: { type: 'category', boundaryGap: false, data: Array.from({length: MAX_POINTS}, (_, i) => i) },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#333' } } },
    series: []
  });
};

watch(() => store.telemetry, (newTel) => {
  if (!chart || !newTel) return;

  // Extract numeric values for plotting
  const series: any[] = [];
  
  // Recursively find numbers in telemetry
  const extractNumbers = (obj: any, prefix = '') => {
    for (const key in obj) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof obj[key] === 'number') {
        if (!dataHistory[fullKey]) dataHistory[fullKey] = new Array(MAX_POINTS).fill(0);
        dataHistory[fullKey].push(obj[key]);
        if (dataHistory[fullKey].length > MAX_POINTS) dataHistory[fullKey].shift();
        
        series.push({
          name: fullKey,
          type: 'line',
          showSymbol: false,
          data: [...dataHistory[fullKey]],
          animation: false
        });
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        extractNumbers(obj[key], fullKey);
      }
    }
  };

  extractNumbers(newTel);

  chart.setOption({
    legend: { data: series.map(s => s.name), textStyle: { color: '#888', fontSize: 10 } },
    series: series
  });
}, { deep: true });

onMounted(() => {
  initChart();
  window.addEventListener('resize', () => chart?.resize());
});

onUnmounted(() => {
  chart?.dispose();
});
</script>

<template>
  <div ref="chartRef" class="w-full h-full min-h-[200px]"></div>
</template>
