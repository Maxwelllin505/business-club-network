// Fetches a URL server-side and scrapes basic Open Graph / meta tags for a link preview card.
// Runs server-side (not in the browser) specifically to avoid CORS restrictions that would block
// a client-side fetch of an arbitrary third-party page.
//
// Handles both quoted ("...", '...') and unquoted meta attribute values, since real-world pages are
// inconsistent about quoting — a regex that only matched quoted values silently dropped otherwise-valid
// og:image tags, which is one of the ways a link preview could come back with no picture.
function extractMeta(html, attr, key) {
  const valuePattern = `(?:["']([^"']*)["']|([^\\s>]+))`;
  const patterns = [
    new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*content=${valuePattern}`, 'i'),
    new RegExp(`<meta[^>]+content=${valuePattern}[^>]*${attr}=["']${key}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const val = m[1] !== undefined ? m[1] : m[2];
      if (val) return val;
    }
  }
  return null;
}

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
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

  const minimalFallback = () => ({
    ok: true,
    url: target.toString(),
    domain: target.hostname.replace(/^www\./, ''),
    title: target.hostname,
    description: '',
    image: ''
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(target.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // A standard desktop browser UA gets meta tags served correctly by far more sites than an
        // explicitly-labeled bot UA does — some sites quietly skip og: tags (or block outright) for
        // anything identifying itself as a scraper, even for public, non-authenticated metadata.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    clearTimeout(timeout);

    // A non-2xx response (blocked, gated, gone, etc.) often still returns an HTML error page with its
    // own unrelated meta tags — better to fall back to a plain link card than show the wrong picture/title.
    if (!response.ok) {
      res.status(200).json(minimalFallback());
      return;
    }

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
    // Try the usual og:image variants, then twitter:image, then a plain <link rel="image_src"> tag
    // that some older/simpler sites still use instead of Open Graph.
    let image =
      extractMeta(html, 'property', 'og:image:secure_url') ||
      extractMeta(html, 'property', 'og:image') ||
      extractMeta(html, 'name', 'twitter:image') ||
      extractMeta(html, 'name', 'twitter:image:src') || '';
    if (!image) {
      const linkMatch = html.match(/<link[^>]+rel=["']image_src["'][^>]*href=(?:["']([^"']*)["']|([^\s>]+))/i);
      if (linkMatch) image = linkMatch[1] || linkMatch[2] || '';
    }
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
    // Fetch failed (site blocked bots, timed out, DNS error, etc.) — still return a minimal card from
    // the URL itself, so the post can be published as a plain link rather than erroring out entirely.
    res.status(200).json(minimalFallback());
  }
}
