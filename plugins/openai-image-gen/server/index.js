import makeSubmitImagePromptTools from "../tools/submit-image-prompt.js";

export default function (covel) {
  for (const imagePromptTool of makeSubmitImagePromptTools(covel.toolkit)) {
    covel.registerTool(imagePromptTool);
  }
}
