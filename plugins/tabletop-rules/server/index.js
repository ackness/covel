import { validateAllocation } from "../lib/rules.js";

export default function (covel) {
  covel.registerFormValidator("point-buy", validateAllocation);
}
