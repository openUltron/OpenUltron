<template>
  <div class="skills-view">
    <AISkillsPage :initial-tab="initialTab" />
  </div>
</template>

<script setup>
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AISkillsPage from '../components/ai/AISkillsPage.vue'

const route = useRoute()
const router = useRouter()

/** 应用库已迁至侧栏「应用」/web-apps，旧链接 ?tab=webapps 重定向 */
function redirectWebappsTab() {
  if (route.query.tab === 'webapps') {
    router.replace({ path: '/web-apps' })
  }
}

const initialTab = computed(() => {
  const t = route.query.tab
  if (t === 'skills') return 'skills'
  return 'mcp'
})

onMounted(redirectWebappsTab)
watch(() => route.query.tab, redirectWebappsTab)
</script>

<style scoped>
.skills-view {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
</style>
