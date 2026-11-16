<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';

  export let title: string;
  export let books: Array<{ isbn: string; title: string; pages: number }> = [];

  const dispatch = createEventDispatcher<{ pick: string }>();
  let query = '';
  let started: Date | null = null;

  $: filtered = books.filter((b) => b.title.toLowerCase().includes(query.toLowerCase()));
  $: total = filtered.reduce((n, b) => n + b.pages, 0);

  onMount(() => {
    started = new Date();
    return () => console.log(`open for ${Date.now() - (started?.getTime() ?? 0)} ms`);
  });
</script>

<section class="shelf" class:empty={books.length === 0}>
  <h2>{title} ({filtered.length} of {books.length}, {total} pages)</h2>
  <input bind:value={query} placeholder="Search" on:keydown={(e) => e.key === 'Escape' && (query = '')} />

  {#if filtered.length > 0}
    <ul>
      {#each filtered as book, i (book.isbn)}
        <li on:click={() => dispatch('pick', book.isbn)}>{i + 1}. {book.title}</li>
      {/each}
    </ul>
  {:else if query}
    <p>Nothing matches "{query}".</p>
  {:else}
    <p>No books yet.</p>
  {/if}

  {#await Promise.resolve(total) then pages}
    <footer>{pages} pages in all</footer>
  {/await}
</section>

<style>
  .shelf {
    display: grid;
    gap: 0.5rem;
  }
  .empty h2 {
    color: #888;
  }
</style>
