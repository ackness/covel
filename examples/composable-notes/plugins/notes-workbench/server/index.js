export default function (covel) {
  covel.registerRpc("open-notes", async (_payload, ctx) => ({
    ok: true,
    message: ctx.locale?.startsWith("zh")
      ? "已打开记录面板。"
      : "Notes panel opened.",
    clientAction: {
      type: "open-plugin-panel",
      panelId: "notes-workbench",
    },
  }));
}
