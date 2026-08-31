/**
 * Host-rendered components available to declarative plugin UI specs.
 *
 * This list is shared by the server-side untrusted-spec validator and the
 * React registry. Keeping one source of truth prevents a spec from passing
 * discovery only to fail later because its component is not renderable.
 */
export const PLUGIN_UI_COMPONENT_NAMES = [
  "Stack",
  "Row",
  "Grid",
  "Separator",
  "Text",
  "Badge",
  "Icon",
  "TagList",
  "Source",
  "BranchReplyCandidates",
  "Image",
  "Media",
  "AudioPlayer",
  "ImageGallery",
  "ImageJobs",
  "PortraitGallery",
  "Card",
  "CardList",
  "EntryCard",
  "StatBar",
  "Progress",
  "Accordion",
  "Section",
  "JsonView",
  "CharacterBlueprintList",
  "SceneCastList",
  "CharacterFieldsView",
  "CharacterAvatar",
  "Button",
  "Input",
  "Textarea",
  "SearchInput",
  "Select",
  "Switch",
  "FilterBar",
  "Tabs",
  "FilterContainer",
  "Form",
  "FormHeader",
  "FormField",
  "SubmitButton",
  "Prose",
  "PlayerMessage",
  "Alert",
  "GraphCanvas",
  "WorldDimensions",
  "AssetRender",
  "AssetTurnSidebar",
] as const;

export type PluginUiComponentName = (typeof PLUGIN_UI_COMPONENT_NAMES)[number];
