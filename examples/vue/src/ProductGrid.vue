<script setup lang="ts">
defineProps<{ items: { id: number; title: string; description: string; category: string; color: string; symbol: string }[]; mode: string }>();
</script>
<template>
  <div :class="mode === 'grid' ? 'grid' : 'list'">
    <article v-for="item in items" :key="item.id" class="card">
      <div class="cover" :style="{ backgroundColor: item.color }"><span class="symbol">{{ item.symbol }}</span><span class="tag">{{ item.category }}</span></div>
      <div class="cardBody"><h3>{{ item.title }}</h3><p>{{ item.description }}</p></div>
    </article>
  </div>
</template>
<style src="./catalog.css" scoped></style>
