document.getElementById("script-status").textContent =
  "Notebook browser script loaded";
window.covel.subscribe((snapshot) => {
  document.getElementById("session-status").textContent =
    JSON.stringify(snapshot);
});
