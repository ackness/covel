/**
 * Covel component catalog for json-render.
 *
 * These are the UI primitives available to plugin JSON specs.
 * Plugins can only use components registered here — the framework
 * controls the vocabulary, plugins compose from it.
 *
 * The Button selection feedback wires through the V1 session store's
 * `pendingInteractionDrafts` so plugin-declared click bindings echo back
 * a visual selection marker when the user picks a choice.
 */

import type { ComponentRenderer } from "@json-render/react";
import { GraphCanvas } from "./graph-canvas.js";
import {
  filterItems,
  resolvePath,
  valueToHaystack,
} from "./catalog/helpers.js";
import {
  Accordion,
  Badge,
  Card,
  CardList,
  EntryCard,
  Grid,
  Icon,
  JsonView,
  Progress,
  Row,
  Section,
  Separator,
  Stack,
  StatBar,
  TagList,
  Text,
} from "./catalog/core-renderers.js";
import {
  CharacterBlueprintList,
  CharacterFieldsView,
  SceneCastList,
} from "./catalog/character-renderers.js";
import {
  Button,
  FilterBar,
  Input,
  SearchInput,
  Select,
  Switch,
  Tabs,
  Textarea,
  createFilterContainer,
} from "./catalog/interactive-renderers.js";
import {
  Alert,
  FormField,
  PlayerMessage,
  Prose,
  SubmitButton,
} from "./catalog/message-form-renderers.js";
import {
  AudioPlayerCatalogComponent,
  ImageComponent,
  ImageGallery,
  ImageJobs,
  MediaCatalogComponent,
  Source,
} from "./catalog/media-renderers.js";
import { BranchReplyCandidates } from "./catalog/branch-reply-renderer.js";
import {
  AssetRenderCatalog,
  AssetTurnSidebarCatalog,
  Form,
  FormHeader,
  WorldDimensions,
} from "./catalog/session-renderers.js";

export {
  resolveI18n,
  resolveIcon,
  useI18nResolver,
} from "./catalog/helpers.js";

const FilterContainer = createFilterContainer((name) => covelRegistry[name]);

/**
 * Test-only export of internal pure helpers. Not part of the public catalog.
 * Exposed so unit tests can exercise filter logic without driving React.
 */
export const __filterContainerInternals = {
  resolvePath,
  valueToHaystack,
  filterItems,
};

export const covelRegistry: Record<string, ComponentRenderer> = {
  // Layout
  Stack,
  Row,
  Grid,
  Separator,
  // Display
  Text,
  Badge,
  Icon,
  TagList,
  Source,
  BranchReplyCandidates,
  Image: ImageComponent,
  Media: MediaCatalogComponent,
  AudioPlayer: AudioPlayerCatalogComponent,
  ImageGallery,
  ImageJobs,
  // Data
  Card,
  CardList,
  EntryCard,
  StatBar,
  Progress,
  Accordion,
  Section,
  JsonView,
  CharacterBlueprintList,
  SceneCastList,
  CharacterFieldsView,
  // Interactive
  Button,
  Input,
  Textarea,
  SearchInput,
  Select,
  Switch,
  FilterBar,
  Tabs,
  FilterContainer,
  // Form
  Form,
  FormHeader,
  FormField,
  SubmitButton,
  // Message (chat area)
  Prose,
  PlayerMessage,
  Alert,
  // Visualization
  GraphCanvas,
  WorldDimensions,
  // Multimodal (P0-b — SPEC §5.7)
  AssetRender: AssetRenderCatalog,
  AssetTurnSidebar: AssetTurnSidebarCatalog,
};
