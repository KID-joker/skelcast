<script setup>
import {ref} from 'vue';
import {catalog} from '@/data';
import Tile from '@/components/Tile';
const pending=ref(false);
</script>
<template><main><h1>Catalog</h1><input aria-label="Catalog filter" placeholder="Filter catalog"/><section v-loading="pending" class="catalog"><Tile v-for="item in catalog" :key="item.id" :height="item.height" class="tile"><h2>{{item.title}}</h2><template #footer><button>Open</button></template></Tile></section><footer>End of catalog</footer></main></template>
<style scoped>
.catalog{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.tile{display:flex;flex-direction:column;justify-content:space-between;padding:16px;background:#edf2f7;border-radius:8px}.tile h2{font-size:16px;line-height:24px;margin:0}footer{margin-top:16px}@media(max-width:600px){.catalog{grid-template-columns:1fr}}
</style>
