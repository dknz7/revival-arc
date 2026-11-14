// Vivaldi's UI exposes its search engines directly; chrome.search is an extension API
// and is not reliably available in this context. Keep search and suggestions on one engine.
(() => {
  const api = () => vivaldi.searchEngines;
  const templates = async () => {
    const reply = await api().getTemplateUrls();
    return { reply, engines: Array.isArray(reply) ? reply : reply.templateUrls || [] };
  };
  const defaultEngine = async () => {
    const [{ reply, engines }, win] = await Promise.all([templates(), chrome.windows.getCurrent()]);
    const guid = win.incognito ? reply.defaultPrivate : reply.defaultSearch;
    const engine = engines.find((item) => item.guid === guid);
    if (!engine) throw new Error('Vivaldi did not expose the default search engine.');
    return engine;
  };
  // Only expand known template parameters. Unknown required parameters must never
  // produce a malformed URL or send the query to a different provider.
  const expand = (template, query) => {
    if (!template) return null;
    let unknown = false;
    const value = template.replace(/\{([^}]+)\}|%s/g, (token, key) => {
      if (token === '%s' || key === 'searchTerms') return encodeURIComponent(query);
      if (key === 'inputEncoding' || key === 'outputEncoding') return 'UTF-8';
      if (key === 'language') return encodeURIComponent(globalThis.navigator?.language || 'en');
      if (key?.endsWith('?')) return '';
      unknown = true;
      return '';
    });
    return !unknown && /^https?:\/\//i.test(value) ? value : null;
  };
  const request = async (engine, query) => {
    if (engine.guid) {
      // Native expansion also handles provider-specific placeholders and POST engines.
      return api().getSearchRequest(engine.guid, query);
    }
    const url = expand(engine.url, query);
    if (!url) throw new Error('Unsupported search URL template.');
    return { url };
  };
  const phrases = (data) => {
    const values = Array.isArray(data?.[1]) ? data[1] : Array.isArray(data) ? data : data?.suggestions || [];
    return values.map((value) => typeof value === 'string' ? value : value?.phrase || value?.value)
      .filter((value) => typeof value === 'string' && value.trim());
  };
  const suggestions = async (engine, query) => {
    // Vivaldi no longer supports Suggest POST Parameters. Do not silently use GET.
    if (engine.suggestPostParams) return [];
    const url = expand(engine.suggestUrl, query);
    if (!url) return [];
    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(2500) });
    if (!response.ok) return [];
    return phrases(await response.json());
  };
  // What typed text means, the way Vivaldi's own address field reads it, now that the command bar is the only place to type
  // an address (Task 9b fix round 1). -> null (nothing typed), { kind: "url", url }, { kind: "search", alt? } (alt: an
  // address it may also mean, offered as a second row), or { kind: "native" } (left to Vivaldi's own field: javascript:,
  // whose running in the page is Vivaldi's own decision to make). `editing`: the address being edited, whose own scheme
  // always reads as an address.
  // Order matters: "localhost:3000" and "intranet:8080" also parse as a scheme, so host:port comes first.
  const SCHEMES = new Set(['http', 'https', 'ftp', 'file', 'about', 'view-source', 'chrome', 'vivaldi', 'data', 'blob', 'chrome-extension',
    'mailto', 'tel', 'sms', 'magnet', 'ws', 'wss', 'news', 'nntp', 'irc', 'ircs', 'geo', 'webcal', 'sftp', 'ssh', 'callto', 'xmpp', 'bitcoin', 'git']);
  const NATIVE_SCHEMES = new Set(['javascript']);
  const SPACED = new Set(['data', 'javascript', 'file', 'view-source', 'mailto']); // may hold spaces and still be one address
  const LABEL = '[a-z0-9\\u00a1-\\uffff](?:[a-z0-9\\u00a1-\\uffff-]*[a-z0-9\\u00a1-\\uffff])?';
  const IPV4 = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}';
  const HOST = `(?:localhost|${IPV4}|\\[[0-9a-f:.]+\\]|${LABEL}(?:\\.${LABEL})*)`;
  const TAIL = '(?:[/?#]\\S*)?';
  const HOST_PORT = new RegExp(`^${HOST}:\\d{1,5}${TAIL}$`, 'iu');
  const LOCAL = new RegExp(`^(?:localhost|${IPV4}|\\[[0-9a-f:.]+\\])${TAIL}$`, 'iu');
  const BARE_IPV6 = /^(?=.*:.*:)[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i;
  const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})*\\.(?:[a-z]{2,63}|xn--[a-z0-9-]+|[\\u00a1-\\uffff]{2,})\\.?${TAIL}$`, 'iu');
  const LABEL_PATH = new RegExp(`^${LABEL}/\\S*$`, 'iu');
  const BARE_LABEL = new RegExp(`^${LABEL}$`, 'iu');
  const resolve = (raw, { editing = null } = {}) => {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1].toLowerCase() || null;
    if (/\s/.test(text) && !(scheme && SPACED.has(scheme))) return { kind: 'search' };
    if (BARE_IPV6.test(text)) return { kind: 'url', url: `http://[${text}]/` };
    if (HOST_PORT.test(text)) return { kind: 'url', url: `http://${text}` };
    if (scheme) {
      const rest = text.slice(scheme.length + 1);
      if (editing) {
        const own = /^([a-z][a-z0-9+.-]*):/i.exec(editing)?.[1].toLowerCase();
        if (own === scheme && !NATIVE_SCHEMES.has(scheme)) return { kind: 'url', url: text };
      }
      if (NATIVE_SCHEMES.has(scheme)) return { kind: 'native' };
      if ((scheme === 'chrome' || scheme === 'vivaldi') && rest && !rest.startsWith('//')) return { kind: 'url', url: `${scheme}://${rest}` };
      if (SCHEMES.has(scheme) || scheme.startsWith('web+') || rest.startsWith('//')) return rest ? { kind: 'url', url: text } : { kind: 'search' };
      return { kind: 'search' };
    }
    if (LOCAL.test(text)) return { kind: 'url', url: `http://${text}` };
    if (DOMAIN.test(text)) return { kind: 'url', url: `https://${text}` };
    if (LABEL_PATH.test(text)) return { kind: 'url', url: `http://${text}` };
    if (BARE_LABEL.test(text) && !/^\d+$/.test(text)) return { kind: 'search', alt: `http://${text}/` };
    return { kind: 'search' };
  };
  window.__vm.search = { templates, defaultEngine, expand, request, phrases, suggestions, resolve };
})();
