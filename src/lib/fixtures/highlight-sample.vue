<template>
  <section class="shelf" :class="{ empty: books.length === 0 }">
    <h2>{{ title }} ({{ books.length }})</h2>
    <input v-model.trim="query" placeholder="Search" @keydown.enter="search" />
    <ul v-if="filtered.length">
      <li v-for="(book, i) in filtered" :key="book.isbn" @click="$emit('pick', book)">
        <span class="index">{{ i + 1 }}.</span> {{ book.title.toUpperCase() }}
      </li>
    </ul>
    <p v-else>Nothing matches "{{ query }}".</p>
    <slot name="footer" :count="books.length" />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

interface Book {
  isbn: string;
  title: string;
  pages: number;
}

const props = defineProps<{ title: string; books: Book[] }>();
const emit = defineEmits<{ (e: 'pick', book: Book): void }>();
const query = ref('');

const filtered = computed(() =>
  props.books.filter((b) => b.title.toLowerCase().includes(query.value.toLowerCase())),
);

watch(query, (now, before) => {
  if (now.length > 40) query.value = before; // keep it short
});

function search(): void {
  if (filtered.value.length === 1) emit('pick', filtered.value[0]!);
}
</script>

<style scoped>
.shelf {
  display: grid;
  gap: 0.5rem;
}
.shelf.empty h2::after {
  content: ' (empty)';
  color: #888;
}
.index {
  font-variant-numeric: tabular-nums;
}
</style>
