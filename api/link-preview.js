// Fetches a URL server-side and scrapes basic Open Graph / meta tags for a link preview card.
// Runs server-side (not in the browser) specifically to avoid CORS restrictions that would block
// a client-side fetch of an arbitrary third-party page.
function extractMeta(html, attr, key) {
  const patterns = [
    new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${key}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export default async function handler(req, res) {
  const url = req.query && req.query.url;
  if (!url) {
    res.status(400).json({ ok: false, error: 'Missing url parameter' });
    return;
  }

  let target;
  try {
    target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Unsupported protocol');
  } catch (e) {
    res.status(200).json({ ok: false, error: 'That doesn\'t look like a valid link.' });
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(target.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClubNetworkLinkPreview/1.0; +https://business-club-network.vercel.app)' }
    });
    clearTimeout(timeout);

    const html = (await response.text()).slice(0, 300000); // cap how much HTML we parse

    const titleTagMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = decodeEntities(
      extractMeta(html, 'property', 'og:title') ||
      extractMeta(html, 'name', 'twitter:title') ||
      (titleTagMatch ? titleTagMatch[1].trim() : target.hostname)
    );
    const description = decodeEntities(
      extractMeta(html, 'property', 'og:description') ||
      extractMeta(html, 'name', 'description') ||
      extractMeta(html, 'name', 'twitter:description') || ''
    );
    let image = extractMeta(html, 'property', 'og:image') || extractMeta(html, 'name', 'twitter:image') || '';
    if (image && !/^https?:\/\//i.test(image)) {
      try { image = new URL(image, target).toString(); } catch (e) { image = ''; }
    }

    res.status(200).json({
      ok: true,
      url: target.toString(),
      domain: target.hostname.replace(/^www\./, ''),
      title: title || target.hostname,
      description,
      image
    });
  } catch (err) {
    // Fetch failed (site blocked bots, timed out, etc.) — still return a minimal card from the URL itself.
    res.status(200).json({
      ok: true,
      url: target.toString(),
      domain: target.hostname.replace(/^www\./, ''),
      title: target.hostname,
      description: '',
      image: ''
    });
  }
}
