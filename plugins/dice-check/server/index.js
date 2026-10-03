import roll from "../rpc/roll.js";
import verifyCheckReceipt from "../hooks/verify-check-receipt.js";

export default function (covel) {
  covel.registerRpc("roll", roll, {
    description: "Roll bounded NdM dice notation",
  });
  covel.on("PreToolUse", verifyCheckReceipt);
}
