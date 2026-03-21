<template>
  <div class="settings-config-view">
    <AIConfigPage :initial-tab="initialTab" />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AIConfigPage from '../components/ai/AIConfigPage.vue'

const route = useRoute()
const initialTab = computed(() => {
  const t = route.query.tab
  const allowed = ['config', 'proxy', 'usage', 'feishu', 'backup', 'doctor', 'webapps']
  return t && allowed.includes(t) ? t : 'config'
})
</script>

<style scoped>
.settings-config-view {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
</style>
