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
  // an address (Task 9b fix rounds 1-2). -> null (nothing typed), { kind: "url", url }, { kind: "search", alt? } (alt: an
  // intranet address a bare word may also mean, a later row), or { kind: "native" }: left to Vivaldi's own field, shown
  // there UNSUBMITTED for the user to confirm: a script scheme (javascript:, vbscript:), or address-shaped text that is not
  // a valid address (a bracketed host that is not IPv6, "a::b::c", 999.1.1.1, a port over 65535, a space inside the host
  // of an http address). Address-shaped text is never a search, so it never reaches a search engine. `editing`: the address
  // being edited, whose own scheme always reads as an address.
  // The text is split into its authority (up to the first / ? #) and the rest; a space is allowed in the rest (encoded as
  // %20) but not in the authority. Hosts: localhost, IPv4 (each part 0-255), IPv6 (in brackets, with an optional %zone, or
  // bare when it has "::" or eight groups, IPv4-embedded included), and DNS names (Unicode / punycode labels; the ideographic
  // and fullwidth dots read as "."; one trailing dot allowed). A name with a top-level domain of letters (or xn--, or
  // Unicode) is https://; localhost, an IP, or an intranet name with a path or port is http://.
  const SCHEMES = new Set(['http', 'https', 'ftp', 'file', 'about', 'view-source', 'chrome', 'vivaldi', 'data', 'blob', 'chrome-extension',
    'mailto', 'tel', 'sms', 'magnet', 'ws', 'wss', 'news', 'nntp', 'irc', 'ircs', 'geo', 'webcal', 'sftp', 'ssh', 'callto', 'xmpp', 'bitcoin', 'git']);
  const SCRIPT_SCHEMES = new Set(['javascript', 'vbscript']);
  const AUTHORITY_SCHEMES = new Set(['http', 'https', 'ftp', 'ws', 'wss', 'sftp', 'ssh', 'git']);
  const SPACED = new Set(['data', 'javascript', 'vbscript', 'file', 'view-source', 'mailto']); // may hold spaces and still be one address
  const DOTS = /[\u3002\uff0e\uff61]/g;
  const LABEL_RE = /^[a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]*[a-z0-9\u00a1-\uffff])?$/iu;
  const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]+|[\u00a1-\uffff]{2,})$/iu;
  const DRIVE_PATH = /^[a-z]:[\\/]/i; // C:\Users\x or C:/Users/x: a file on this computer, as Vivaldi's field reads it
  const isIPv4 = (s) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s) && s.split('.').every((n) => Number(n) <= 255);
  const isIPv6 = (raw) => {
    const [addr, zone, extra] = String(raw).split('%');
    if (extra !== undefined || (zone !== undefined && !/^[\w.-]+$/.test(zone)) || !addr) return false;
    let a = addr;
    const v4 = /^(.*:)(\d+(?:\.\d+){3})$/.exec(a);
    if (v4) { if (!isIPv4(v4[2])) return false; a = `${v4[1]}0:0`; }
    const halves = a.split('::');
    if (halves.length > 2) return false;
    const groups = (x) => (x === '' ? [] : x.split(':'));
    const parts = halves.length === 2 ? [...groups(halves[0]), ...groups(halves[1])] : groups(a);
    if (!parts.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false;
    return halves.length === 2 ? parts.length <= 7 : parts.length === 8;
  };
  // -> { type: "local" | "ip" | "domain" | "label" } for a host, { type: "bad" } for an address-shaped host that is not
  // valid, null for text that is not a host at all.
  const hostKind = (raw) => {
    const h = raw.replace(DOTS, '.');
    if (h.startsWith('[')) {
      if (!h.endsWith(']')) return { type: 'bad' };
      return isIPv6(h.slice(1, -1).replace(/%25/g, '%')) ? { type: 'ip' } : { type: 'bad' };
    }
    const plain = h.endsWith('.') ? h.slice(0, -1) : h;
    if (!plain) return null;
    if (plain.toLowerCase() === 'localhost') return { type: 'local' };
    if (/^\d+(?:\.\d+){3}$/.test(plain)) return isIPv4(plain) ? { type: 'ip' } : { type: 'bad' };
    if (/^[\d.]+$/.test(plain)) return null; // 1.5, 2026: numbers
    const labels = plain.split('.');
    if (!labels.every((l) => LABEL_RE.test(l))) return null;
    if (labels.length === 1) return { type: 'label' };
    return { type: 'domain', tld: TLD_RE.test(labels[labels.length - 1]) && !/^\d+$/.test(labels[labels.length - 1]) };
  };
  const encodeSpaces = (s) => s.replace(/\s/g, (c) => (c === ' ' ? '%20' : encodeURIComponent(c)));
  // "host:..." whose host is an address (localhost, an IP or an invalid one, a name with a top-level domain; user@ before it
  // allowed): address-shaped. A word, or dotted words without a top-level domain (e.g., Ch.3, v1.2), and a colon are words.
  const hostWithPort = (authority) => {
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    if (hostPort.startsWith('[')) return false; // a bracket is IPv6's, read by its own rules ("[12:30 meeting]" is words)
    const kind = hostKind(hostPort.slice(0, hostPort.indexOf(':')));
    return !!kind && (kind.type === 'local' || kind.type === 'ip' || kind.type === 'bad' || (kind.type === 'domain' && kind.tld));
  };
  // An explicit scheme's authority ([user[:pass]@]host[:port]): the host is not malformed and the port is 0-65535 digits
  // (or empty). A host Vivarc does not know the shape of (an underscore, say) is left to Vivaldi.
  const authorityValid = (authority) => {
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    if (hostPort.startsWith('[')) {
      const m = /^(\[[^\]]*\])(?::(\d*))?$/.exec(hostPort);
      return !!m && hostKind(m[1]).type === 'ip' && !(m[2] && Number(m[2]) > 65535);
    }
    const parts = hostPort.split(':');
    if (parts.length > 2) return false; // a bare IPv6 needs its brackets after a scheme
    if (parts.length === 2 && !/^\d*$/.test(parts[1])) return false;
    if (parts.length === 2 && parts[1] && Number(parts[1]) > 65535) return false;
    return !!parts[0] && hostKind(parts[0])?.type !== 'bad'; // an empty host (http://:80/) is malformed too
  };
  const NATIVE = { kind: 'native' };
  const resolve = (raw, { editing = null } = {}) => {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    if (DRIVE_PATH.test(text)) return { kind: 'url', url: `file:///${text.replace(/\\/g, '/')}` };
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1].toLowerCase() || null;
    if (scheme && SCRIPT_SCHEMES.has(scheme)) return NATIVE;
    if (scheme && (SCHEMES.has(scheme) || scheme.startsWith('web+') || text.slice(scheme.length + 1).startsWith('//'))) {
      const rest = text.slice(scheme.length + 1);
      if (!rest) return { kind: 'search' };
      if ((scheme === 'chrome' || scheme === 'vivaldi') && !rest.startsWith('//')) return /\s/.test(rest) ? NATIVE : { kind: 'url', url: `${scheme}://${rest}` };
      if (AUTHORITY_SCHEMES.has(scheme) && rest.startsWith('//')) {
        const tail = rest.slice(2);
        const cut = tail.search(/[/?#]/);
        const authority = cut < 0 ? tail : tail.slice(0, cut);
        if (!authority || /\s/.test(authority)) return NATIVE; // a space in the host: malformed, never a search
        if (!authorityValid(authority)) return NATIVE; // http://host:99999/x, http://[::1/x, http://999.1.1.1
        return { kind: 'url', url: `${scheme}://${authority.replace(DOTS, '.')}${encodeSpaces(cut < 0 ? '' : tail.slice(cut))}` };
      }
      if (/\s/.test(rest) && !SPACED.has(scheme)) return NATIVE;
      return { kind: 'url', url: text };
    }
    if (editing && scheme) {
      const own = /^([a-z][a-z0-9+.-]*):/i.exec(editing)?.[1].toLowerCase();
      if (own === scheme && !/\s/.test(text)) return { kind: 'url', url: text };
    }
    const cut = text.search(/[/?#]/);
    const authority = cut < 0 ? text : text.slice(0, cut);
    const path = cut < 0 ? '' : text.slice(cut);
    if (/^\[[0-9a-f.%]*(?::[0-9a-f.%]*){2,}(?:\s|$)/i.test(text)) return NATIVE; // "[::1 x": an IPv6 bracket left open
    // Text whose first word is an address with a port, or a host and a colon and no port ("192.168.1.1:8080 admin",
    // "nas.local:abc private plan", "[::1]:80 x"): address-shaped whatever follows the space, shown, never searched.
    const first = text.split(/\s/)[0];
    const firstAuthority = first.slice(0, (first.search(/[/?#]/) + 1 || first.length + 1) - 1);
    if (first !== text && (/^\[[^\]]*\]:/.test(firstAuthority) || (firstAuthority.includes(':') && hostWithPort(firstAuthority)))) return NATIVE;
    if (!authority || /\s/.test(authority)) return { kind: 'search' }; // words ("what is 2/3", "localhost is down")
    const at = (host) => `${host.replace(DOTS, '.')}`;
    // user@host:port: an address with its credentials when the port is one, else a malformed one (user@nas.local:abc)
    const userAt = authority.lastIndexOf('@');
    if (userAt > 0 && authority.slice(userAt + 1).includes(':')) {
      const m = /^(.+):(\d+)$/.exec(authority.slice(userAt + 1));
      const kind = m && hostKind(m[1]);
      if (m && kind && kind.type !== 'bad' && Number(m[2]) <= 65535) return { kind: 'url', url: `http://${at(authority)}${encodeSpaces(path)}` };
      return NATIVE;
    }
    // [v6] or [v6]:port
    const bracket = /^(\[[^\]]*\])(?::(\d+))?$/.exec(authority);
    if (bracket || authority.startsWith('[')) {
      if (!bracket || hostKind(bracket[1]).type !== 'ip' || (bracket[2] && Number(bracket[2]) > 65535)) return NATIVE;
      return { kind: 'url', url: `http://${authority}${encodeSpaces(path)}` };
    }
    // bare IPv6 (more than one colon)
    if ((authority.match(/:/g) || []).length > 1) {
      if (isIPv6(authority)) return { kind: 'url', url: `http://[${authority}]/${encodeSpaces(path.replace(/^\//, ''))}` };
      return authority.includes('::') || hostWithPort(authority) ? NATIVE : { kind: 'search' }; // 12:00:00 is a time
    }
    const port = /^(.+):(\d+)$/.exec(authority);
    if (port) {
      const kind = hostKind(port[1]);
      if (!kind || /^\d+$/.test(port[1])) return { kind: 'search' }; // 10:30, re:1
      if (kind.type === 'bad' || Number(port[2]) > 65535) return NATIVE;
      return { kind: 'url', url: `http://${at(port[1])}:${port[2]}${encodeSpaces(path)}` };
    }
    // A host (localhost, an IP, a dotted name) then a colon and no port: a malformed address, whatever follows in its path
    // (nas.local:abc/private plan). A single word and a colon is words (note:abc, re:x).
    if (authority.includes(':')) return hostWithPort(authority) ? NATIVE : { kind: 'search' };
    const kind = hostKind(authority);
    if (!kind) return { kind: 'search' };
    if (kind.type === 'bad') return NATIVE;
    if (kind.type === 'local' || kind.type === 'ip') return { kind: 'url', url: `http://${at(authority)}${encodeSpaces(path)}` };
    if (kind.type === 'domain') {
      if (kind.tld) return { kind: 'url', url: `https://${at(authority)}${encodeSpaces(path)}` };
      return path ? { kind: 'url', url: `http://${at(authority)}${encodeSpaces(path)}` } : { kind: 'search' }; // a.b/x is an intranet page; x.y alone is words
    }
    // a single label: with a path it is an intranet page (not 1/2 or 2026/11/15: numbers); alone, a search with its address
    if (path) return /^\d+$/.test(authority) ? { kind: 'search' } : { kind: 'url', url: `http://${at(authority)}${encodeSpaces(path)}` };
    return /^\d+$/.test(authority) ? { kind: 'search' } : { kind: 'search', alt: `http://${at(authority)}/` };
  };
  // Address-shaped: what must not go to a search engine's suggestions while it is typed (an address, an intranet name with
  // a path, anything Vivaldi's field would treat as one).
  const addressShaped = (text) => { const r = resolve(text); return !!r && (r.kind !== 'search' || (!/\s/.test(String(text).trim()) && /[./:\\[\]@]/.test(String(text)))); };
  // A text whose submission could run a script in the page (javascript:, vbscript:, and data:, whose page can hold one):
  // never submitted automatically, whatever path brought it (review rounds 2-3). Read as the URL parser reads it: leading
  // spaces (Unicode ones too: the ideographic space, a no-break space, a BOM) and control characters dropped, tabs and line
  // breaks removed anywhere (java\tscript: is javascript:), and the line breaks a text field drops on its own.
  const NEVER_SUBMIT = new Set([...SCRIPT_SCHEMES, 'data']);
  const neverSubmit = (text) => {
    const read = String(text ?? '').replace(/[\t\n\r]/g, '').replace(/^[\s\u0000-\u0020]+/, '');
    return NEVER_SUBMIT.has(/^([a-z][a-z0-9+.-]*):/i.exec(read)?.[1].toLowerCase() || '');
  };
  window.__vm.search = { templates, defaultEngine, expand, request, phrases, suggestions, resolve, addressShaped, neverSubmit, isIPv6 };
})();
