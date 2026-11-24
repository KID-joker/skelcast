<script setup lang="ts">
import { LoadingBoundary } from 'skelcast/vue';
import listSkeleton from 'virtual:skelcast/products.list';
import ProductGrid from './ProductGrid.vue';
defineProps<{ items: any[]; mode: string; pending: boolean }>();
const emit = defineEmits(['mode', 'refresh']);
</script>
<template>
  <div class="shell">
    <aside class="sidebar"><div class="brand">◈ &nbsp; Formspace</div><small>Workspace</small><a class="active">▦ &nbsp; Overview</a><a>◇ &nbsp; My projects</a><a>▤ &nbsp; Team documents</a><a>☆ &nbsp; Favorites</a><div class="sideFooter">DEVELOPMENT<br/>Vue · Source-derived skeletons</div></aside>
    <main class="main">
      <header class="topbar"><span>Workspace <span class="muted"> / Overview</span></span><span class="avatar">J</span></header>
      <section class="intro"><span class="eyebrow">YOUR CREATIVE WORKSPACE</span><h1>A home for good ideas<span> ✳</span></h1><p>Your team’s design assets, documents, and inspiration. All in one place.</p></section>
      <div class="stats"><div><span>Total assets</span><strong>224 <small>↗ 12.8%</small></strong></div><div><span>Active projects</span><strong>18 <small>4 new this month</small></strong></div><div><span>Team members</span><strong>12 <small>Creating together</small></strong></div></div>
      <section class="library"><div class="sectionHead"><div><h2>Recently updated</h2><p>Explore the latest work from your team</p></div><div class="controls"><input aria-label="Search assets" placeholder="Search assets…"/><button @click="emit('refresh')">Refresh assets</button><button :aria-pressed="mode === 'grid'" @click="emit('mode', 'grid')">Grid</button><button :aria-pressed="mode === 'list'" @click="emit('mode', 'list')">List</button></div></div>
      <LoadingBoundary :artifact="listSkeleton" :pending="pending" :variant="mode"><ProductGrid :items="items" :mode="mode"/></LoadingBoundary></section>
      <footer class="footer">FORM FOLLOWS IDEAS <span>Real request loading · React / Vue · Static artifacts</span></footer>
    </main>
  </div>
</template>
<style src="./catalog.css" scoped></style>
