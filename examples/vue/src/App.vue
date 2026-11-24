<script setup lang="ts">
import { onMounted, ref, watchEffect } from 'vue';
import { LoadingBoundary } from 'skelcast/vue';
import { releasePageSkeleton } from 'skelcast/runtime';
import pageSkeleton from 'virtual:skelcast/products.page';
import CatalogPage from './CatalogPage.vue';
const loggedIn = ref(sessionStorage.getItem('demo-login') === 'yes');
const items = ref<any[]>([]);
const pending = ref(false);
const mode = ref('grid');
const reload = ref(0);
const error = ref('');
onMounted(() => releasePageSkeleton({ preview: loggedIn.value }));
watchEffect(onCleanup => {
  if (!loggedIn.value) return;
  void reload.value;
  const controller = new AbortController(); onCleanup(() => controller.abort());
  pending.value = true; error.value = '';
  fetch('/api/products', { signal: controller.signal }).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }).then(data => { items.value = data.items; }).catch(e => { if (e.name !== 'AbortError') error.value = String(e); }).finally(() => { if (!controller.signal.aborted) pending.value = false; });
});
function login() { sessionStorage.setItem('demo-login', 'yes'); loggedIn.value = true; releasePageSkeleton(); }
</script>
<template>
  <main v-if="!loggedIn" class="login"><div><span class="logo">◈</span><p>FORM SPACE / LOCAL DEMO</p><h1>Welcome to your workspace</h1><p>Sign in to explore real loading states and skeleton previews.</p><button @click="login">Enter demo workspace</button><small>Local demo sign-in. No account required.</small></div></main>
  <template v-else><LoadingBoundary :artifact="pageSkeleton" :pending="pending && items.length === 0"><CatalogPage :items="items" :mode="mode" :pending="pending && items.length > 0" @mode="mode = $event" @refresh="reload++"/></LoadingBoundary><div v-if="error" role="alert">{{ error }}</div></template>
</template>
