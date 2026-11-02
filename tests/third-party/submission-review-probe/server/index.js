import { instructionLocaleFor } from "@covel/plugin-handlers-utils";
import register from "./injections.js";

export default function (covel) {
  register(covel, instructionLocaleFor);
}
