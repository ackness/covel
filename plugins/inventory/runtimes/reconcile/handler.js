export default async function reconcile() {
  return {
    outcome: "success",
    effects: { events: [{ topic: "inventory.reconcile", data: {} }] },
  };
}
