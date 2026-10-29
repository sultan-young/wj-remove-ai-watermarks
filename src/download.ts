import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { saveLimited } from './images.js';
import { ServiceError } from './errors.js';
import type { Config } from './config.js';

export function isPublicAddress(address: string) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export async function resolveTarget(url: URL, config: Config) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new ServiceError(400, 'INVALID_URL', 'Only HTTP(S) URLs without credentials are accepted');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!config.urlPorts.includes(port)) throw new ServiceError(400, 'URL_PORT_BLOCKED', 'URL port is not allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!addresses.length || (!config.urlAllowPrivate && addresses.some(a => !isPublicAddress(a.address))))
    throw new ServiceError(400, 'URL_ADDRESS_BLOCKED', 'URL must resolve exclusively to public addresses');
  return addresses[0]!;
}

export async function downloadImage(input: string, dest: string, config: Config) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.urlTimeoutMs);
  try {
    let url: URL;
    try { url = new URL(input); } catch { throw new ServiceError(400, 'INVALID_URL', 'Invalid URL'); }
    for (let hop = 0; hop <= config.urlMaxRedirects; hop++) {
      let onAbort: () => void = () => {};
      const target = await Promise.race([
        resolveTarget(url, config),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error('Download timeout'));
          abort.signal.addEventListener('abort', onAbort, { once: true });
          if (abort.signal.aborted) onAbort();
        }),
      ]).finally(() => abort.signal.removeEventListener('abort', onAbort));
      if (abort.signal.aborted) throw new Error('Download timeout');
      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
          signal: abort.signal, agent: false,
          headers: { 'Accept': 'image/png,image/jpeg,image/webp', 'Accept-Encoding': 'identity', 'User-Agent': 'gpu-image-service/1.0' },
          // Pin the checked address; retain original hostname for Host and TLS certificate verification.
          lookup: (_host, options, callback) => {
            if (typeof options === 'object' && options.all) callback(null, [target]);
            else callback(null, target.address, target.family);
          },
        }, resolve);
        request.on('error', reject);
        request.end();
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        const location = response.headers.location;
        response.destroy();
        if (!location || hop === config.urlMaxRedirects) throw new ServiceError(400, 'URL_REDIRECT_LIMIT', 'Redirect limit exceeded');
        url = new URL(location, url);
        continue;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        throw new ServiceError(502, 'URL_HTTP_ERROR', 'Image origin did not return HTTP 200');
      }
      if (Number(response.headers['content-length']) > config.maxBytes) {
        response.destroy(); throw new ServiceError(413, 'IMAGE_TOO_LARGE', 'Remote image exceeds byte limit');
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.destroy(); throw new ServiceError(400, 'URL_ENCODING_UNSUPPORTED', 'Compressed HTTP bodies are not accepted');
      }
      await saveLimited(response, dest, config.maxBytes);
      return;
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(502, 'URL_FETCH_FAILED', 'Image URL could not be downloaded within the limit');
  } finally { clearTimeout(timer); }
}
