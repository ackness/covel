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
  "CandidateList",
  "Image",
  "Media",
  "AudioPlayer",
  "MediaGallery",
  "JobList",
  "PortraitGallery",
  "Card",
  "CardList",
  "EntryCard",
  "StatBar",
  "Progress",
  "Accordion",
  "Section",
  "JsonView",
  "EntryList",
  "SceneCastList",
  "CharacterFieldsView",
  "CharacterAvatar",
  "Button",
  "ChoiceList",
  "Choice",
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

/**
 * The components a segment template (`contributes.ui.segment`) may use: the
 * ones that draw only their own props. A template is display-only, so
 * anything that sends a message, invokes a runtime, takes input or reads
 * session data beyond the template's own state is left out. Validation and
 * the renderer's registry both read this list.
 */
export const SEGMENT_TEMPLATE_COMPONENT_NAMES = [
  "Stack",
  "Row",
  "Grid",
  "Separator",
  "Text",
  "Badge",
  "Icon",
  "TagList",
  "Source",
  "Image",
  "Media",
  "AudioPlayer",
  "Card",
  "CardList",
  "EntryCard",
  "StatBar",
  "Progress",
  "Accordion",
  "Section",
  "JsonView",
  "EntryList",
  "Prose",
  "PlayerMessage",
  "Alert",
] as const satisfies readonly PluginUiComponentName[];

export type SegmentTemplateComponentName =
  (typeof SEGMENT_TEMPLATE_COMPONENT_NAMES)[number];
