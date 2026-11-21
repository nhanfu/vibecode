# EasyList (https://easylist.to, GPLv3 or CC BY-SA 3.0) -> WebKit content-blocker rules.
# Usage: curl -L -o easylist.txt https://easylist.to/easylist/easylist.txt && python3 convert_easylist.py easylist.txt rules.json
# Known gaps: exception rules (@@) and regex rules are skipped; the separator ^ is dropped.
"""EasyList (Adblock Plus syntax) -> WebKit content-blocker JSON (block rules + element hiding)."""
import json, re, sys

RESOURCE = {'script': 'script', 'image': 'image', 'stylesheet': 'style-sheet', 'subdocument': 'document',
            'xmlhttprequest': 'raw', 'font': 'font', 'media': 'media', 'websocket': 'websocket', 'popup': None,
            'other': 'other', 'document': 'document'}
SKIP_OPTS = ('redirect', 'csp', 'removeparam', 'replace', 'rewrite', 'badfilter', 'important', 'denyallow', 'ping',
             'object', 'match-case', 'elemhide', 'generichide', 'specifichide', 'genericblock', 'urlskip', 'empty',
             'cookie', 'stealth', 'header', 'to', 'method', 'permissions', 'webrtc', 'all', 'inline-script',
             'inline-font', 'document', 'popunder', 'reputation', 'queryprep')

def esc(ch):
    return '\\' + ch if ch in '.+?()[]{}|^$\\/' else ch

# WebKit's url-filter is a small regex: no character classes, groups or alternation, so ABP's
# separator '^' is dropped (slightly broader matching than ABP).
ALLOWED = set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-&=%:@~\'",;!<>#')

def url_filter(pat):
    """ABP URL pattern -> WebKit url-filter, or None when WebKit cannot express it."""
    anchor_domain = pat.startswith('||')
    start_anchor = pat.startswith('|') and not anchor_domain
    end_anchor = pat.endswith('|') and len(pat) > 1
    if anchor_domain: pat = pat[2:]
    elif start_anchor: pat = pat[1:]
    if end_anchor: pat = pat[:-1]
    pat = pat.replace('^', '')
    out = []
    for ch in pat:
        if ch == '*': out.append('.*')
        elif ch == '.': out.append(r'\.')
        elif ch == '/': out.append(r'\/')
        elif ch in ALLOWED: out.append(ch)
        else: return None
    body = ''.join(out)
    if anchor_domain:
        return r'^https?://(.*\.)?' + body + ('$' if end_anchor else '')
    if start_anchor:
        return '^' + body + ('$' if end_anchor else '')
    return body + ('$' if end_anchor else '')

def domains_of(value):
    inc, exc = [], []
    for d in value.split('|'):
        if not d: continue
        (exc if d.startswith('~') else inc).append(d[1:] if d.startswith('~') else d)
    return inc, exc

def convert(lines):
    rules, hiding = [], {}
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith('!') or line.startswith('['): continue
        if '#@#' in line or '#@?#' in line or '#?#' in line or '#$#' in line or '#%#' in line: continue
        if '##' in line or '#?#' in line:
            dom, _, sel = line.partition('##')
            if not sel or any(c in sel for c in '\\') : continue
            d = hiding.setdefault(sel, set())
            if dom: d.update(dom.split(','))
            continue
        if line.startswith('@@'): continue          # exception rules: not supported yet
        pat, _, opts = line.partition('$') if '$' in line and not line.startswith('/') else (line, '', '')
        if pat.startswith('/') and pat.endswith('/') and len(pat) > 1: continue   # raw regex rules
        if any(o.split('=')[0].lstrip('~') in SKIP_OPTS for o in opts.split(',')) if opts else False: continue
        uf = url_filter(pat)
        if uf is None or not uf: continue
        trigger = {'url-filter': uf}
        types, load, if_d, unless_d, ok = [], None, [], [], True
        for o in (opts.split(',') if opts else []):
            name, _, val = o.partition('=')
            neg = name.startswith('~')
            name = name.lstrip('~')
            if name == 'third-party': load = ['first-party'] if neg else ['third-party']
            elif name == 'domain':
                inc, exc = domains_of(val)
                if_d += ['*' + d for d in inc]; unless_d += ['*' + d for d in exc]
            elif name in RESOURCE:
                if RESOURCE[name] and not neg: types.append(RESOURCE[name])
            else: ok = False
        if not ok: continue
        if if_d and unless_d: continue   # WebKit can't mix both lists in one rule
        if if_d: trigger['if-domain'] = if_d
        if unless_d: trigger['unless-domain'] = unless_d
        if types: trigger['resource-type'] = types
        if load: trigger['load-type'] = load
        rules.append({'trigger': trigger, 'action': {'type': 'block'}})
    for sel, doms in hiding.items():
        rule = {'trigger': {'url-filter': '.*'}, 'action': {'type': 'css-display-none', 'selector': sel}}
        if doms:
            inc = ['*' + d for d in doms if not d.startswith('~')]
            if inc: rule['trigger']['if-domain'] = inc
        rules.append(rule)
    return rules

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, encoding='utf-8', errors='replace') as f:
        rules = convert(f)
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(rules, f, separators=(',', ':'))
    print(len(rules), 'rules')
