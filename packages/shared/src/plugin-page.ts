import { parse, type DefaultTreeAdapterTypes } from "parse5";

/** Inject the bridge and enable error reporting without reserializing the page. */
export function pluginPageDocument(html: string, bridgeUrl: string): string {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element =>
      "tagName" in node && node.tagName === "html",
  );
  const head = root?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element =>
      "tagName" in node && node.tagName === "head",
  );
  const doctype = document.childNodes.find(
    (node) => node.nodeName === "#documentType",
  );
  const offset =
    (
      head?.sourceCodeLocation?.startTag ??
      root?.sourceCodeLocation?.startTag ??
      doctype?.sourceCodeLocation
    )?.endOffset ?? 0;
  const escapedUrl = bridgeUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const edits = [
    {
      start: offset,
      end: offset,
      text: `<script crossorigin="anonymous" src="${escapedUrl}"></script>`,
    },
  ];
  const nodes: DefaultTreeAdapterTypes.Node[] = [...document.childNodes];
  for (let node = nodes.pop(); node; node = nodes.pop()) {
    if ("childNodes" in node)
      for (const child of node.childNodes) nodes.push(child);
    if ("content" in node) nodes.push(node.content);
    if (
      !("tagName" in node) ||
      node.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
      node.tagName !== "script" ||
      !node.attrs.some((attribute) => attribute.name === "src")
    )
      continue;
    const location = node.sourceCodeLocation;
    if (!location?.startTag) continue;
    // Opaque origins make even local no-CORS scripts mute promise rejections.
    // Change the fetch mode before parsing/execution, including defer/async scripts.
    const attribute = location.attrs?.crossorigin;
    edits.push(
      attribute
        ? {
            start: attribute.startOffset,
            end: attribute.endOffset,
            text: 'crossorigin="anonymous"',
          }
        : {
            start: location.startTag.startOffset + "<script".length,
            end: location.startTag.startOffset + "<script".length,
            text: ' crossorigin="anonymous"',
          },
    );
  }
  edits.sort((left, right) => left.start - right.start);
  const chunks: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    chunks.push(html.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  chunks.push(html.slice(cursor));
  return chunks.join("");
}
