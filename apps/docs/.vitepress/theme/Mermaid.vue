<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useData } from "vitepress";

// A ```mermaid block of a page (see `markdown.config` in ../config.ts). The
// library is large, so it is loaded in the browser and only on a page that has
// a diagram. Until it has drawn, and when it cannot, the source is shown.
const props = defineProps<{ code: string }>();
// Labels written with `\n` for GitHub get a real line break here.
const source = decodeURIComponent(props.code).replaceAll("\\n", "<br/>");
const svg = ref("");
const { isDark } = useData();
let serial = 0;

async function draw() {
  try {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: isDark.value ? "dark" : "neutral",
    });
    const id = `mermaid-${Date.now()}-${serial++}`;
    svg.value = (await mermaid.render(id, source)).svg;
  } catch {
    svg.value = "";
  }
}

onMounted(draw);
watch(isDark, draw);
</script>

<template>
  <div v-if="svg" class="mermaid-diagram" v-html="svg" />
  <pre v-else class="mermaid-source"><code>{{ source }}</code></pre>
</template>

<style scoped>
.mermaid-diagram {
  margin: 16px 0;
  overflow-x: auto;
  text-align: center;
}
.mermaid-source {
  margin: 16px 0;
  padding: 16px;
  overflow-x: auto;
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  font-size: 13px;
}
</style>
