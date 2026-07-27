// Extracts a complete HTML document from a model's raw text output. The agent is
// instructed to return only the document, but providers occasionally wrap it in
// ```html fences or add stray commentary — strip those and return the document
// from <!DOCTYPE html>/<html> through the final </html>.
export function extractHtml(raw: string): string | null {
    let text = raw.trim();
    const fenceMatch = text.match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const docStart = text.search(/<!DOCTYPE html|<html/i);
    if (docStart === -1) return null;
    text = text.slice(docStart);

    // Drop any trailing commentary after the closing tag so it never leaks into
    // the iframe.
    const closeIdx = text.toLowerCase().lastIndexOf('</html>');
    if (closeIdx !== -1) text = text.slice(0, closeIdx + '</html>'.length);

    return text;
}
