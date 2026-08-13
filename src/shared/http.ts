type HeadersMap = Record<string, string>;

interface RequestOptions {
  method: "GET" | "POST";
  url: string;
  headers: HeadersMap;
  timeoutMs: number;
  body?: string;
}

export async function getJson<T>(
  url: string,
  headers: HeadersMap,
  timeoutMs: number,
): Promise<T> {
  const text = await request({ method: "GET", url, headers, timeoutMs });
  return parseJson<T>(text);
}

export async function postJson(
  url: string,
  headers: HeadersMap,
  body: unknown,
  timeoutMs: number,
): Promise<void> {
  await request({
    method: "POST",
    url,
    headers,
    timeoutMs,
    body: JSON.stringify(body),
  });
}

/**
 * Like postJson, but returns the parsed response. postJson discards the body,
 * which is right for fire-and-forget audit writes but not for /api/resolve, whose
 * answer drives checks 2 and 3.
 */
export async function postJsonReturning<T>(
  url: string,
  headers: HeadersMap,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const text = await request({
    method: "POST",
    url,
    headers,
    timeoutMs,
    body: JSON.stringify(body),
  });
  return JSON.parse(text) as T;
}

function request(options: RequestOptions): Promise<string> {
  if (typeof XMLHttpRequest !== "undefined") {
    return requestWithXhr(options);
  }

  return requestWithFetch(options);
}

function requestWithXhr(options: RequestOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method, options.url, true);
    xhr.timeout = options.timeoutMs;

    Object.entries(options.headers).forEach(([key, value]) => {
      xhr.setRequestHeader(key, value);
    });

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText || "");
      } else {
        reject(new Error(`API returned ${xhr.status}: ${xhr.statusText}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network request failed"));
    xhr.ontimeout = () => reject(new Error("Network request timed out"));
    xhr.send(options.body);
  });
}

async function requestWithFetch(options: RequestOptions): Promise<string> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Network request timed out")), options.timeoutMs);
  });

  const response = await Promise.race([
    fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
    }),
    timeout,
  ]);

  if (!response.ok) {
    throw new Error(`API returned ${response.status}: ${response.statusText}`);
  }

  return response.text();
}

function parseJson<T>(text: string): T {
  if (!text) {
    throw new Error("API returned an empty response");
  }

  return JSON.parse(text) as T;
}
