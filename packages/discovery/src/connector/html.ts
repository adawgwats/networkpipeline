/**
 * Minimal HTML -> plain-text helper for connector use. Intentionally
 * dumb: removes tags, collapses whitespace, decodes a small set of
 * common entities (&amp; &lt; &gt; &quot; &#39; &nbsp;). Does NOT
 * attempt to render lists or preserve structure — connectors only
 * need a description excerpt for the pre-extraction phrase scan.
 */
export function htmlToText(html: string, maxLength = 1500): string {
  if (!html) return "";
  const noTags = html.replace(/<[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  const collapsed = decoded.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, maxLength);
}
