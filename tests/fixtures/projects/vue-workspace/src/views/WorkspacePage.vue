<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import WorkspacePanel from '@/components/WorkspacePanel.vue';
const pending = ref(true);
const rows = ref();
let timer;
onMounted(() => { timer = setTimeout(() => { rows.value = [{ id:1, title:'Planning' },{ id:2, title:'Design' },{ id:3, title:'Review' },{ id:4, title:'Release' }]; pending.value = false; }, 400); });
onBeforeUnmount(() => clearTimeout(timer));
</script>
<template><main><nav>Workspace / Activity</nav><h1>Team workspace</h1><WorkspacePanel><template #header>Recent activity</template><input aria-label="Activity filter" placeholder="Filter activity"/><section v-loading="pending" class="activity"><article v-for="row in rows" :key="row.id"><span>{{ row.title }}</span><button>View</button></article></section></WorkspacePanel></main></template>
<style scoped lang="less">
@gap:12px;
.activity { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:@gap; }
article { display:flex; align-items:center; justify-content:space-between; gap:8px; height:88px; padding:16px; background:#edf2f7; border-radius:8px; }
@media(max-width:600px) { .activity { grid-template-columns:1fr; } }
</style>
