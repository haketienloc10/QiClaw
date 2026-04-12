import * as dnsPromises from 'node:dns/promises';
import { isIP } from 'node:net';

import type { Tool } from './tool.js';

type WebFetchInput = {
  url: string;
};

const WEB_FETCH_TIMEOUT_MS = 10_000;
const WEB_FETCH_MAX_BODY_BYTES = 1_000_000;
const PRIVATE_HOST_ERROR_PREFIX = 'web_fetch does not allow local or private hosts';

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  const [first, second] = parts;
  return first === 10
    || first === 127
    || first === 0
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function isPrivateIpv6(hostname: string): boolean {
  return hostname === '::1'
    || hostname === '::'
    || hostname.startsWith('fc')
    || hostname.startsWith('fd')
    || hostname.startsWith('fe80:')
    || hostname.startsWith('fe90:')
    || hostname.startsWith('fea0:')
    || hostname.startsWith('feb0:');
}

function isPrivateIpAddress(hostname: string): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  const ipVersion = isIP(normalizedHostname);

  if (ipVersion === 4) {
    return isPrivateIpv4(normalizedHostname);
  }

  if (ipVersion === 6) {
    return isPrivateIpv6(normalizedHostname);
  }

  return false;
}

function validateWebFetchUrl(rawUrl: string): URL {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL for web_fetch: ${rawUrl}`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`web_fetch only supports http and https URLs: ${rawUrl}`);
  }

  const hostname = normalizeHostname(parsedUrl.hostname);
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isPrivateIpAddress(hostname)) {
    throw new Error(`${PRIVATE_HOST_ERROR_PREFIX}: ${rawUrl}`);
  }

  return parsedUrl;
}

async function validateResolvedAddresses(parsedUrl: URL): Promise<void> {
  const hostname = normalizeHostname(parsedUrl.hostname);
  if (isIP(hostname)) {
    return;
  }

  const results = await dnsPromises.lookup(hostname, { all: true, order: 'verbatim' });
  if (results.some((result) => isPrivateIpAddress(result.address))) {
    throw new Error(`${PRIVATE_HOST_ERROR_PREFIX}: ${parsedUrl.toString()}`);
  }
}

async function validateFetchTarget(rawUrl: string): Promise<URL> {
  const parsedUrl = validateWebFetchUrl(rawUrl);
  await validateResolvedAddresses(parsedUrl);
  return parsedUrl;
}

async function validateRedirectTarget(response: Pick<Response, 'redirected' | 'url'>): Promise<void> {
  if (!response.redirected || !response.url) {
    return;
  }

  await validateFetchTarget(response.url);
}

function assertBodySizeWithinLimit(content: string): void {
  const bodyBytes = Buffer.byteLength(content, 'utf8');
  if (bodyBytes > WEB_FETCH_MAX_BODY_BYTES) {
    throw new Error(`web_fetch response body too large: ${bodyBytes} bytes`);
  }
}

function formatWebFetchActivityLabel(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return 'web fetch';
  }

  const url = typeof (input as { url?: unknown }).url === 'string'
    ? (input as { url: string }).url.trim()
    : '';

  return url.length > 0 ? `web fetch ${url}` : 'web fetch';
}

export const webFetchTool: Tool<WebFetchInput> = {
  name: 'web_fetch',
  description: 'Fetch a web resource by URL and return the response body.',
  formatActivityLabel: formatWebFetchActivityLabel,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' }
    },
    required: ['url'],
    additionalProperties: false
  },
  async execute(input) {
    const parsedUrl = await validateFetchTarget(input.url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(parsedUrl, { signal: controller.signal });
      await validateRedirectTarget(response);
      const content = await response.text();
      assertBodySizeWithinLimit(content);

      return {
        content,
        data: {
          url: input.url,
          status: response.status,
          ok: response.ok
        }
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`web_fetch timed out after ${WEB_FETCH_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
};
