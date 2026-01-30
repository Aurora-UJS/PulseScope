<script setup lang="ts">
import { ref } from 'vue'
import { useMonitorStore } from './store/monitor'
import TelemetryWaves from './components/TelemetryWaves.vue'
import { 
  Activity, 
  Terminal, 
  Settings, 
  Maximize2, 
  Menu, 
  Cpu, 
  Layers,
  ChevronRight,
  ChevronDown
} from 'lucide-vue-next'

const store = useMonitorStore()
const isSidebarOpen = ref(true)
const isTerminalOpen = ref(true)
const videoSrc = '/video'

const sidebarItems = [
  { id: 'overview', icon: Layers, label: 'Overview' },
  { id: 'waves', icon: Activity, label: 'Waves' },
  { id: 'settings', icon: Settings, label: 'Parameters' },
]

const activeTab = ref('overview')
</script>

<template>
  <div class="flex h-screen bg-background overflow-hidden">
    <!-- Sidebar -->
    <aside 
      class="border-r border-white/5 bg-surface transition-all duration-300 flex flex-col items-center py-4 gap-6"
      :class="isSidebarOpen ? 'w-48 px-4 items-start' : 'w-16'"
    >
      <div class="flex items-center gap-2 mb-4">
        <div class="w-8 h-8 bg-primary rounded flex items-center justify-center text-white font-bold">P</div>
        <span v-if="isSidebarOpen" class="font-bold text-lg tracking-tight">PulseScope</span>
      </div>

      <nav class="flex-1 w-full flex flex-col gap-2">
        <button 
          v-for="item in sidebarItems" 
          :key="item.id"
          @click="activeTab = item.id"
          class="flex items-center gap-3 p-2 rounded transition-colors w-full"
          :class="activeTab === item.id ? 'bg-primary/10 text-primary' : 'hover:bg-white/5 text-gray-400'"
        >
          <component :is="item.icon" :size="20" />
          <span v-if="isSidebarOpen" class="text-sm font-medium">{{ item.label }}</span>
        </button>
      </nav>
      
      <button @click="isSidebarOpen = !isSidebarOpen" class="p-2 text-gray-500 hover:text-white">
        <component :is="isSidebarOpen ? Menu : ChevronRight" :size="20" />
      </button>
    </aside>

    <!-- Main Content -->
    <main class="flex-1 flex flex-col relative min-w-0">
      <!-- Header -->
      <header class="h-12 border-b border-white/5 px-6 flex items-center justify-between bg-surface/50 backdrop-blur-md">
        <div class="flex items-center gap-4 text-xs font-medium">
          <div class="flex items-center gap-2">
            <div 
              class="w-2 h-2 rounded-full" 
              :class="store.isConnected ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-red-500'"
            ></div>
            <span>{{ store.isConnected ? 'CONNECTED' : 'OFFLINE' }}</span>
          </div>
          <div class="h-4 w-px bg-white/10"></div>
          <div class="flex items-center gap-2">
            <Cpu :size="14" class="text-gray-400" />
            <span class="text-gray-400 uppercase tracking-widest">Seq:</span>
            <span>{{ store.currentSeq }}</span>
          </div>
        </div>

        <div class="flex items-center gap-3">
          <button class="p-1.5 hover:bg-white/5 rounded text-gray-400 transition-colors">
            <Maximize2 :size="16" />
          </button>
        </div>
      </header>

      <!-- Dashboard Body -->
      <div class="flex-1 flex overflow-hidden p-4 gap-4">
        <!-- Center: Video Feed -->
        <section class="flex-[3] flex flex-col bg-surface rounded-xl border border-white/5 overflow-hidden shadow-2xl relative group">
          <div class="absolute top-4 left-4 z-10 bg-black/50 px-3 py-1 rounded-full backdrop-blur-md border border-white/10 flex items-center gap-2">
            <div class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></div>
            <span class="text-[10px] font-bold tracking-widest uppercase">Live Raw Feed</span>
          </div>
          <div class="flex-1 bg-black flex items-center justify-center overflow-hidden">
            <img :src="videoSrc" class="max-w-full max-h-full object-contain" alt="Live Feed" />
          </div>
        </section>

        <!-- Right: Telemetry & Info -->
        <aside class="flex-1 flex flex-col gap-4 min-w-[320px]">
          <!-- Telemetry Values (Collapsible/Tabs) -->
          <div v-if="activeTab === 'overview'" class="flex-1 bg-surface rounded-xl border border-white/5 p-4 flex flex-col overflow-hidden">
             <h3 class="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-4 flex items-center gap-2">
               <Activity :size="12" /> Telemetry Data
             </h3>
             <div class="flex-1 overflow-y-auto space-y-4 pr-2">
                <div v-for="(val, key) in store.telemetry" :key="key" class="bg-white/5 rounded-lg p-3 border border-white/5">
                  <div class="text-[10px] text-gray-500 uppercase mb-1">{{ key }}</div>
                  <div class="font-mono text-sm break-all">{{ typeof val === 'object' ? JSON.stringify(val) : val }}</div>
                </div>
                <div v-if="!store.telemetry || Object.keys(store.telemetry).length === 0" class="h-full flex flex-col items-center justify-center text-gray-600 italic text-sm">
                  <Activity :size="48" class="mb-4 opacity-10" />
                  No telemetry data...
                </div>
             </div>
          </div>

          <!-- Real-time Waves -->
          <div v-if="activeTab === 'waves' || activeTab === 'overview'" 
               :class="activeTab === 'overview' ? 'h-64' : 'flex-1'"
               class="bg-surface rounded-xl border border-white/5 p-4 flex flex-col overflow-hidden">
             <h3 class="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-4 flex items-center gap-2">
               <Activity :size="12" /> Real-time Waves
             </h3>
             <div class="flex-1 min-h-0">
               <TelemetryWaves />
             </div>
          </div>
        </aside>
      </div>

      <!-- Bottom: Terminal -->
      <div 
        class="border-t border-white/5 bg-surface transition-all duration-300"
        :class="isTerminalOpen ? 'h-64' : 'h-10'"
      >
        <div class="px-4 h-10 flex items-center justify-between border-b border-white/5 cursor-pointer hover:bg-white/5" @click="isTerminalOpen = !isTerminalOpen">
          <div class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-gray-400">
            <Terminal :size="14" /> Serial Logs Mirror
          </div>
          <ChevronDown :size="16" class="transition-transform duration-300" :class="!isTerminalOpen && 'rotate-180'" />
        </div>
        <div v-if="isTerminalOpen" class="p-4 h-[calc(100%-40px)] overflow-y-auto font-mono text-[11px] text-gray-400 bg-black/30">
          <div v-for="(log, idx) in store.logs" :key="idx" class="mb-1">
            <span class="text-primary/70">»</span> {{ log }}
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
</style>
