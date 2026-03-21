<template>
  <div class="wah-root">
    <!-- 独立「应用库」页：与 Skills/MCP 解耦，侧栏直达 -->
    <WebAppsManager />
  </div>
</template>

<script setup>
import WebAppsManager from '../components/ai/WebAppsManager.vue'

defineOptions({ name: 'WebAppsHomeView' })
</script>

<style scoped>
.wah-root {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--ou-bg-main);
}
</style>
