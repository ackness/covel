<script setup lang="ts">
import { onMounted, ref, useId, watch } from "vue";
import { useData } from "vitepress";

// A ```mermaid block of a page (see `markdown.config` in ../config.ts). The
// library is large, so it is loaded in the browser and only on a page that has
// a diagram. Until it has drawn, and when it cannot, the source is shown.
const props = defineProps<{ code: string }>();
// Labels written with `\n` for GitHub get a real line break here.
const source = decodeURIComponent(props.code).replaceAll("\\n", "<br/>");
const svg = ref("");
const { isDark } = useData();
// Mermaid's render queue shares the document; timestamps can collide across blocks.
const diagramId = useId();
let serial = 0;

async function draw() {
  try {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: isDark.value ? "dark" : "neutral",
      // Preserve the authored diagrams' spacing and flat shapes across major upgrades.
      layout: "dagre",
      look: "classic",
      flowchart: { wrappingWidth: 200, minNodeWidth: 0 },
      state: { wrappingWidth: 200, minNodeWidth: 0 },
    });
    const id = `mermaid-${diagramId}-${serial++}`;
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
/* Keep labels at the line height Mermaid measured outside VitePress's prose. */
.mermaid-diagram :deep(p) {
  line-height: inherit;
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
