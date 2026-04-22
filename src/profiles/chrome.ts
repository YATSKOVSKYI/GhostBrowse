export const CHROME_VER = '130';

const SEC_CH_UA = `"Chromium";v="${CHROME_VER}", "Google Chrome";v="${CHROME_VER}", "Not?A_Brand";v="99"`;

export const CHROME_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER}.0.0.0 Safari/537.36`;

export const CHROME_MOBILE_UA =
  `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER}.0.0.0 Mobile Safari/537.36`;

/** Headers for initial Chrome navigation (no prior page / direct URL). */
export const NAV_NONE: ReadonlyArray<[string, string]> = [
  ['sec-ch-ua', SEC_CH_UA],
  ['sec-ch-ua-mobile', '?0'],
  ['sec-ch-ua-platform', '"Windows"'],
  ['upgrade-insecure-requests', '1'],
  ['user-agent', CHROME_UA],
  ['accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'],
  ['sec-fetch-site', 'none'],
  ['sec-fetch-mode', 'navigate'],
  ['sec-fetch-user', '?1'],
  ['sec-fetch-dest', 'document'],
  ['accept-encoding', 'gzip, deflate, br, zstd'],
  ['accept-language', 'en-US,en;q=0.9'],
  ['priority', 'u=0, i'],
];

/** Headers when navigating to same origin (e.g. redirect within same host). */
export const NAV_SAME_ORIGIN: ReadonlyArray<[string, string]> = [
  ['sec-ch-ua', SEC_CH_UA],
  ['sec-ch-ua-mobile', '?0'],
  ['sec-ch-ua-platform', '"Windows"'],
  ['upgrade-insecure-requests', '1'],
  ['user-agent', CHROME_UA],
  ['accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'],
  ['sec-fetch-site', 'same-origin'],
  ['sec-fetch-mode', 'navigate'],
  ['sec-fetch-user', '?1'],
  ['sec-fetch-dest', 'document'],
  ['accept-encoding', 'gzip, deflate, br, zstd'],
  ['accept-language', 'en-US,en;q=0.9'],
  ['priority', 'u=0, i'],
];

/** Headers when navigating to same-site (different subdomain). */
export const NAV_SAME_SITE: ReadonlyArray<[string, string]> = [
  ['sec-ch-ua', SEC_CH_UA],
  ['sec-ch-ua-mobile', '?0'],
  ['sec-ch-ua-platform', '"Windows"'],
  ['upgrade-insecure-requests', '1'],
  ['user-agent', CHROME_UA],
  ['accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'],
  ['sec-fetch-site', 'same-site'],
  ['sec-fetch-mode', 'navigate'],
  ['sec-fetch-user', '?1'],
  ['sec-fetch-dest', 'document'],
  ['accept-encoding', 'gzip, deflate, br, zstd'],
  ['accept-language', 'en-US,en;q=0.9'],
  ['priority', 'u=0, i'],
];

/** Headers when navigating cross-site. */
export const NAV_CROSS_SITE: ReadonlyArray<[string, string]> = [
  ['sec-ch-ua', SEC_CH_UA],
  ['sec-ch-ua-mobile', '?0'],
  ['sec-ch-ua-platform', '"Windows"'],
  ['upgrade-insecure-requests', '1'],
  ['user-agent', CHROME_UA],
  ['accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'],
  ['sec-fetch-site', 'cross-site'],
  ['sec-fetch-mode', 'navigate'],
  ['sec-fetch-user', '?1'],
  ['sec-fetch-dest', 'document'],
  ['accept-encoding', 'gzip, deflate, br, zstd'],
  ['accept-language', 'en-US,en;q=0.9'],
  ['priority', 'u=0, i'],
];

/** Mobile Chrome (Android). */
export const NAV_MOBILE_NONE: ReadonlyArray<[string, string]> = [
  ['sec-ch-ua', SEC_CH_UA],
  ['sec-ch-ua-mobile', '?1'],
  ['sec-ch-ua-platform', '"Android"'],
  ['upgrade-insecure-requests', '1'],
  ['user-agent', CHROME_MOBILE_UA],
  ['accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'],
  ['sec-fetch-site', 'none'],
  ['sec-fetch-mode', 'navigate'],
  ['sec-fetch-user', '?1'],
  ['sec-fetch-dest', 'document'],
  ['accept-encoding', 'gzip, deflate, br, zstd'],
  ['accept-language', 'zh-CN,zh;q=0.9,en;q=0.8'],
  ['priority', 'u=0, i'],
];

export type SecFetchSite = 'none' | 'same-origin' | 'same-site' | 'cross-site';

export function getSecFetchSite(from: string | null, to: string): SecFetchSite {
  if (!from) return 'none';
  try {
    const a = new URL(from);
    const b = new URL(to);
    if (a.origin === b.origin) return 'same-origin';
    const aDomain = getRegistrableDomain(a.hostname);
    const bDomain = getRegistrableDomain(b.hostname);
    if (aDomain && aDomain === bDomain) return 'same-site';
    return 'cross-site';
  } catch {
    return 'none';
  }
}

/** Best-effort eTLD+1 — handles common TLDs without a full PSL library. */
function getRegistrableDomain(host: string): string {
  const parts = host.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : host;
}

export function selectNavHeaders(
  from: string | null,
  to: string,
  mobile: boolean,
): ReadonlyArray<[string, string]> {
  if (mobile) return NAV_MOBILE_NONE;
  const site = getSecFetchSite(from, to);
  switch (site) {
    case 'same-origin': return NAV_SAME_ORIGIN;
    case 'same-site':   return NAV_SAME_SITE;
    case 'cross-site':  return NAV_CROSS_SITE;
    default:            return NAV_NONE;
  }
}
