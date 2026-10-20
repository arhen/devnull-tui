// @ts-check
// Prints the pane id of an open /dev/null feed in the pane list on stdin, if any.
let raw = "";

process.stdin.on("data", (chunk) => {
  raw += String(chunk);
});

process.stdin.on("end", () => {
  try {
    /** @type {{result?: {panes?: {label?: string, pane_id?: string}[]}}} */
    const parsed = JSON.parse(raw);
    const pane = (parsed.result?.panes ?? []).find((entry) => entry.label === "/dev/null");
    if (pane?.pane_id) process.stdout.write(pane.pane_id);
  } catch {
    // No pane list, no focus: the caller opens a new pane.
  }
});
