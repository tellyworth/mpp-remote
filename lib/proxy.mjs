/*
 * Build an HTTP(S)/SOCKS proxy agent from a URL string. socks5:// and
 * socks5h:// route through socks-proxy-agent; everything else through
 * https-proxy-agent (which handles both http:// and https:// upstreams).
 */

import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

export function makeAgent(url) {
	if (!url) return undefined;
	if (url.startsWith('socks')) return new SocksProxyAgent(url);
	return new HttpsProxyAgent(url);
}
