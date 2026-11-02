<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ msg: string }>()
const count = ref(0)
</script>

<template>
  <div class="card">
    <h2>{{ msg }}</h2>
    <button type="button" @click="count++">count is {{ count }}</button>
    <p>Testing speed-measure-vite-plugin with Vue 3 SFC</p>
  </div>
</template>

<style scoped>
.card {
  padding: 2em;
  border: 1px solid #ccc;
  border-radius: 8px;
}
button {
  background-color: #42b883;
  color: white;
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
</style>
