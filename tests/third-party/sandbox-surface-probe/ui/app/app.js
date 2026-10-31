(() => {
  const find = (id) => document.getElementById(id);
  const draft = find("draft"),
    outcome = find("outcome");
  let session;
  const invoke = async (method, params) => {
    try {
      const result = await window.covel.invoke(method, params);
      outcome.textContent = JSON.stringify(result);
      return result;
    } catch {
      outcome.textContent = "Request unavailable; draft retained.";
      return { status: "unavailable" };
    }
  };
  let pendingKey = "";
  window.covel.subscribe((state) => {
    session = state.session;
    find("story").textContent = (session?.messages ?? [])
      .map((row) => row.text)
      .concat(session?.streaming?.text ?? [])
      .join("\n");
    find("input").textContent = JSON.stringify(session?.input ?? {});
    const next = JSON.stringify(session?.pending ?? []);
    if (next === pendingKey) return;
    pendingKey = next;
    find("interactions").replaceChildren();
    for (const item of session?.pending ?? []) {
      const interaction = item.interaction;
      const section = document.createElement("section");
      const title = document.createElement("h2");
      title.textContent =
        interaction.title ?? interaction.prompt ?? "Pending interaction";
      section.append(title);
      const fields = new Map();
      if (interaction.type === "form")
        for (const field of interaction.fields) {
          const label = document.createElement("label");
          label.textContent = field.label;
          const input = document.createElement(
            field.type === "select"
              ? "select"
              : field.type === "textarea"
                ? "textarea"
                : "input",
          );
          if (input.tagName === "INPUT")
            input.type =
              field.type === "checkbox"
                ? "checkbox"
                : field.type === "number"
                  ? "number"
                  : "text";
          if (field.type === "select")
            for (const option of field.options ?? []) {
              const node = document.createElement("option");
              node.value = typeof option === "string" ? option : option.value;
              node.textContent =
                typeof option === "string" ? option : option.label;
              input.append(node);
            }
          if (field.type === "checkbox")
            input.checked = field.defaultValue === true;
          else input.value = String(field.defaultValue ?? "");
          fields.set(field.name, { field, input });
          label.append(input);
          section.append(label);
        }
      const answer = (label, values) => {
        const button = document.createElement("button");
        button.textContent = label;
        button.disabled = !item.handle;
        button.onclick = () =>
          invoke("submitInteraction", {
            handle: item.handle,
            values: values(),
          });
        section.append(button);
      };
      if (interaction.type === "form")
        answer(interaction.submitLabel ?? "Answer", () =>
          Object.fromEntries(
            [...fields].map(([name, { field, input }]) => [
              name,
              field.type === "checkbox"
                ? input.checked
                : field.type === "number"
                  ? Number(input.value)
                  : input.value,
            ]),
          ),
        );
      if (interaction.type === "choice")
        for (const choice of interaction.choices)
          answer(choice.label, () => ({ selectedId: choice.id }));
      if (interaction.type === "confirmation") {
        answer(interaction.confirmLabel ?? "Confirm", () => ({
          confirmed: true,
        }));
        answer(interaction.cancelLabel ?? "Cancel", () => ({
          confirmed: false,
        }));
      }
      if (interaction.type === "unavailable")
        section.append("Open this interaction with the host return control.");
      find("interactions").append(section);
    }
  });
  find("submit").onclick = async () => {
    const seat = session?.input.seats.find((item) =>
      item.allowed.includes("say"),
    );
    const result = await invoke("submitAction", {
      kind: "say",
      text: draft.value,
      ...(seat ? { seatId: seat.id } : {}),
    });
    if (result.status === "accepted") draft.value = "";
  };
  find("write").onclick = () =>
    invoke("invokeRuntime", {
      runtimeId: "sandbox-surface-probe/write",
      payload: { text: "Written from the sandbox" },
    });
  for (const type of ["form", "choice", "confirmation"])
    find("ask-" + type).onclick = () =>
      invoke("invokeRuntime", {
        runtimeId: "sandbox-surface-probe/write",
        payload: { ask: type },
      });
  find("stop").onclick = () => invoke("abortExecution", {});
  find("panel").onclick = () => invoke("openPanel", { panelId: "notes" });
})();
