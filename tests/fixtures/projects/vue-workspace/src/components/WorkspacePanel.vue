<script setup lang="ts">
const props = withDefaults(defineProps<{ padding?: number }>(), { padding: 16 });
</script>
<template><section class="panel"><header><slot name="header"/></header><slot/></section></template>
<style scoped lang="less">
@edge: #dce3ed;
.panel { border:1px solid @edge; border-radius:12px; background:white; padding:v-bind('props.padding + "px"'); min-width:0; }
header { margin-bottom:16px; font-weight:600; }
</style>
