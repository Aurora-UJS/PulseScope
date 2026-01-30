import { defineStore } from 'pinia';
import { ref, onMounted, onUnmounted } from 'vue';

export const useMonitorStore = defineStore('monitor', () => {
  const isConnected = ref(false);
  const currentSeq = ref(0);
  const telemetry = ref<any>({});
  const logs = ref<string[]>([]);
  const ws = ref<WebSocket | null>(null);

  const connect = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname === 'localhost' ? 'localhost:8080' : window.location.host;
    
    ws.value = new WebSocket(`${protocol}//${host}/ws`);

    ws.value.onopen = () => {
      isConnected.value = true;
      addLog('System', 'Connected to PulseScope Bridge');
    };

    ws.value.onclose = () => {
      isConnected.value = false;
      addLog('System', 'Disconnected from Bridge. Retrying...');
      setTimeout(connect, 2000);
    };

    ws.value.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'telemetry') {
          telemetry.value = data.payload;
          currentSeq.value = data.seq;
        } else if (data.type === 'log') {
          addLog('Serial', data.payload);
        }
      } catch (e) {
        console.error('Failed to parse WS message', e);
      }
    };
  };

  const addLog = (tag: string, msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    logs.value.push(`[${timestamp}] [${tag}] ${msg}`);
    if (logs.value.length > 500) logs.value.shift();
  };

  // Poll debug seq for fallback
  const pollTimer = setInterval(async () => {
    try {
      const resp = await fetch('/debug/seq');
      const text = await resp.text();
      if (text !== 'OFFLINE') {
        currentSeq.value = parseInt(text);
        isConnected.value = true;
      }
    } catch (e) {
      // isConnected.value = false;
    }
  }, 1000);

  onMounted(connect);
  onUnmounted(() => {
    ws.value?.close();
    clearInterval(pollTimer);
  });

  return { isConnected, currentSeq, telemetry, logs };
});
