import roll from "../rpc/roll.js";

export default function (covel) {
  covel.registerRpc("roll", roll, {
    description: "Roll bounded NdM dice notation",
  });
}
